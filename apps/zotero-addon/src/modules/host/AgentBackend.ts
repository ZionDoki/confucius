import type {
  AgentBackendKind,
  ApprovalResolution,
  CapabilityProfile,
  ConfuciusEvent,
  ResearchTaskRecord,
  RuntimeStatus,
  SessionMode,
  PromptContextOptions,
} from "@confucius/protocol";
import type { SidecarClient } from "./SidecarClient";
import { sidecarAbortController } from "./SidecarClient";

export interface BackendTurnInput {
  task: ResearchTaskRecord;
  turnId: string;
  prompt: string;
  mode: SessionMode;
  capabilityProfile: CapabilityProfile;
  workingDirectory?: string;
  promptContext?: PromptContextOptions;
}

export interface BackendTurnHandle {
  externalSessionId?: string;
  externalTurnId?: string;
  cwd?: string;
  superseded?: boolean;
}

export interface BackendCallbacks {
  event(event: ConfuciusEvent): void;
  handle(handle: BackendTurnHandle): void;
  disconnected(error: Error): void;
}

export interface AgentBackend {
  readonly kind: AgentBackendKind;
  probe(): Promise<RuntimeStatus>;
  startTurn(
    input: BackendTurnInput,
    callbacks: BackendCallbacks,
  ): Promise<BackendTurnHandle>;
  interrupt(taskId: string): Promise<void>;
  analyze(prompt: string): Promise<string>;
  dispose(taskId: string): Promise<void>;
  resolveApproval?(resolution: ApprovalResolution): Promise<unknown>;
}

/** Adapter boundary around the existing in-process TurnLoop. */
export class NativeBackend implements AgentBackend {
  readonly kind = "native" as const;

  constructor(
    private readonly start: (
      input: BackendTurnInput,
      callbacks: BackendCallbacks,
    ) => Promise<BackendTurnHandle>,
    private readonly stop: (taskId: string) => Promise<void> | void,
    private readonly release: (taskId: string) => Promise<void> | void,
    private readonly inspect: () => Promise<RuntimeStatus> | RuntimeStatus,
    private readonly quietAnalyze: (prompt: string) => Promise<string>,
  ) {}

  async probe(): Promise<RuntimeStatus> {
    return this.inspect();
  }

  startTurn(
    input: BackendTurnInput,
    callbacks: BackendCallbacks,
  ): Promise<BackendTurnHandle> {
    return this.start(input, callbacks);
  }

  async interrupt(taskId: string): Promise<void> {
    await this.stop(taskId);
  }

  analyze(prompt: string): Promise<string> {
    return this.quietAnalyze(prompt);
  }

  async dispose(taskId: string): Promise<void> {
    await this.release(taskId);
  }
}

/** One provider-specific view over the shared local sidecar connection. */
export class ExternalBackend implements AgentBackend {
  private readonly polls = new Map<string, AbortController>();

  constructor(
    readonly kind: Exclude<AgentBackendKind, "native">,
    private readonly sidecar: SidecarClient,
  ) {}

  async probe(): Promise<RuntimeStatus> {
    const listed = await this.sidecar.listRuntimes(true);
    return (
      listed.runtimes.find((runtime) => runtime.backend === this.kind) ?? {
        backend: this.kind,
        state: "unavailable",
        message: "Runtime did not report a status.",
        checkedAt: Date.now(),
      }
    );
  }

  async startTurn(
    input: BackendTurnInput,
    callbacks: BackendCallbacks,
  ): Promise<BackendTurnHandle> {
    this.polls.get(input.task.id)?.abort();
    const controller = sidecarAbortController();
    this.polls.set(input.task.id, controller);

    // Establish a cursor before starting so retained events from an earlier
    // turn are not appended a second time after resume.
    const before = await this.sidecar.events(input.task.id, undefined, 0);
    const cursor = before.events.at(-1)?.id;
    let handle: BackendTurnHandle;
    try {
      handle = await this.sidecar.rpc<BackendTurnHandle>("task/startTurn", {
        backend: this.kind,
        taskId: input.task.id,
        turnId: input.turnId,
        prompt: input.prompt,
        mode: input.mode,
        capabilityProfile: input.capabilityProfile,
        workingDirectory: input.workingDirectory,
        externalSessionId: input.task.externalSessionId,
      });
    } catch (error) {
      // Runtime startup failures are buffered by the sidecar before the RPC
      // error is returned. Deliver them so the host can distinguish an auth
      // or provider failure from a disconnected companion.
      const failed = await this.sidecar
        .events(input.task.id, cursor, 0)
        .catch(() => null);
      for (const event of failed?.events ?? []) {
        callbacks.event(event);
      }
      throw error;
    }
    callbacks.handle(handle);
    void this.poll(input.task.id, input.turnId, cursor, controller, callbacks);
    return handle;
  }

  async interrupt(taskId: string): Promise<void> {
    this.polls.get(taskId)?.abort();
    this.polls.delete(taskId);
    await this.sidecar.rpc("task/interrupt", {
      backend: this.kind,
      taskId,
    });
  }

  async analyze(prompt: string): Promise<string> {
    const result = await this.sidecar.rpc<{ text?: string }>(
      "runtime/analyze",
      { backend: this.kind, prompt },
    );
    return result.text ?? "";
  }

  async dispose(taskId: string): Promise<void> {
    this.polls.get(taskId)?.abort();
    this.polls.delete(taskId);
    await this.sidecar.rpc("task/dispose", {
      backend: this.kind,
      taskId,
    });
  }

  resolveApproval(resolution: ApprovalResolution): Promise<unknown> {
    return this.sidecar.resolveApproval(resolution);
  }

  private async poll(
    taskId: string,
    turnId: string,
    initialCursor: string | undefined,
    controller: AbortController,
    callbacks: BackendCallbacks,
  ): Promise<void> {
    let cursor = initialCursor;
    try {
      while (!controller.signal.aborted) {
        const page = await this.sidecar.events(
          taskId,
          cursor,
          25_000,
          controller.signal,
        );
        for (const event of page.events) {
          cursor = event.id;
          callbacks.event(event);
          if (
            event.turnId === turnId &&
            (event.type === "turn_completed" ||
              event.type === "turn_failed" ||
              event.type === "turn_aborted")
          ) {
            this.polls.delete(taskId);
            return;
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.polls.delete(taskId);
        callbacks.disconnected(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }
}
