import type { ExecutorResult } from "./RunCoordinator";
import type { TurnCheckpoint } from "@confucius/harness";
import type {
  AgentBackendKind,
  ApprovalResolution,
  CapabilityProfile,
  ConfuciusEvent,
  ResearchTaskRecord,
  RuntimeStatus,
  RuntimeModelSelection,
  SessionMode,
  PromptContextOptions,
} from "@confucius/protocol";
import { createAbortController } from "../../utils/webPlatform";

export interface RuntimeEventPage {
  events: ConfuciusEvent[];
  cursorFound: boolean;
}

/** Transport-neutral surface for an external Agent Runtime host. */
export interface ExternalRuntimeClient {
  listRuntimes(refresh?: boolean): Promise<{ runtimes: RuntimeStatus[] }>;
  rpc<T>(method: string, params: Record<string, unknown>): Promise<T>;
  events(
    taskId: string,
    afterId?: string,
    waitMs?: number,
    signal?: AbortSignal,
  ): Promise<RuntimeEventPage>;
  resolveApproval(resolution: ApprovalResolution): Promise<unknown>;
}

export interface BackendTurnInput {
  task: ResearchTaskRecord;
  turnId: string;
  prompt: string;
  /** Prompt enriched by the host with extracted, path-free attachment text. */
  modelPrompt?: string;
  resumeCheckpoint?: TurnCheckpoint;
  mode: SessionMode;
  capabilityProfile: CapabilityProfile;
  workingDirectory?: string;
  promptContext?: PromptContextOptions;
  /** Host source and outcome requirements installed as developer instructions. */
  workflowInstruction?: string;
  /** Compatibility switch for callers supplying their own artifact guidance. */
  includeArtifactGuidance?: boolean;
}

export interface BackendTurnHandle {
  externalSessionId?: string;
  externalTurnId?: string;
  cwd?: string;
  superseded?: boolean;
  runtimeModel?: ResearchTaskRecord["runtimeModel"];
}

export interface BackendCallbacks {
  stopped?(result: ExecutorResult): void;
  event(event: ConfuciusEvent): void;
  handle(handle: BackendTurnHandle): void;
  disconnected(error: Error): void;
}

export interface AgentBackend {
  readonly kind: AgentBackendKind;
  readonly observability?: {
    sessionPreparation: boolean;
    modelInput: "host" | "unknown";
    internalUsage: "reported" | "unknown";
  };
  prepareSession?(
    input: BackendTurnInput,
    transactionId: string,
  ): Promise<BackendTurnHandle>;
  discardSession?(taskId: string, transactionId: string): Promise<void>;
  probe(): Promise<RuntimeStatus>;
  startTurn(
    input: BackendTurnInput,
    callbacks: BackendCallbacks,
  ): Promise<BackendTurnHandle>;
  interrupt(taskId: string): Promise<void>;
  analyze(prompt: string, selection?: RuntimeModelSelection): Promise<string>;
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

/** One provider-specific view over the shared external Runtime host. */
export class ExternalBackend implements AgentBackend {
  readonly observability = {
    sessionPreparation: true,
    modelInput: "unknown",
    internalUsage: "unknown",
  } as const;
  private readonly polls = new Map<string, AbortController>();

  constructor(
    readonly kind: Exclude<AgentBackendKind, "native">,
    private readonly runtime: ExternalRuntimeClient,
  ) {}

  async probe(): Promise<RuntimeStatus> {
    const listed = await this.runtime.listRuntimes(true);
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
    const controller = createAbortController();
    this.polls.set(input.task.id, controller);

    // Establish a cursor before starting so retained events from an earlier
    // turn are not appended a second time after resume.
    const before = await this.runtime.events(input.task.id, undefined, 0);
    if (
      controller.signal.aborted ||
      this.polls.get(input.task.id) !== controller
    )
      return { superseded: true };
    const cursor = before.events.at(-1)?.id;
    let handle: BackendTurnHandle;
    try {
      handle = await this.runtime.rpc<BackendTurnHandle>(
        input.task.contextSwitch?.phase === "committed"
          ? "task/activateSession"
          : "task/startTurn",
        {
          transactionId: input.task.contextSwitch?.id,
          backend: this.kind,
          taskId: input.task.id,
          turnId: input.turnId,
          runId: input.task.run?.id,
          generation: input.task.run?.generation,
          prompt: input.prompt,
          mode: input.mode,
          capabilityProfile: input.capabilityProfile,
          workingDirectory: input.workingDirectory,
          externalSessionId: input.task.externalSessionId,
          runtimeModel: input.task.runtimeModel,
          workflowInstruction: input.workflowInstruction,
          includeArtifactGuidance: input.includeArtifactGuidance,
        },
      );
    } catch (error) {
      if (
        controller.signal.aborted ||
        this.polls.get(input.task.id) !== controller
      )
        return { superseded: true };
      // Runtime startup failures are buffered by the host before the RPC
      // error is returned. Deliver them so the host can distinguish an auth
      // or provider failure from a disconnected companion.
      const failed = await this.runtime
        .events(input.task.id, cursor, 0)
        .catch(() => null);
      if (
        controller.signal.aborted ||
        this.polls.get(input.task.id) !== controller
      )
        return { superseded: true };
      for (const event of failed?.events ?? []) {
        callbacks.event(event);
      }
      throw error;
    }
    if (
      controller.signal.aborted ||
      this.polls.get(input.task.id) !== controller
    )
      return { superseded: true };
    callbacks.handle(handle);
    void this.poll(input.task.id, input.turnId, cursor, controller, callbacks);
    return handle;
  }

  async prepareSession(
    input: BackendTurnInput,
    transactionId: string,
  ): Promise<BackendTurnHandle> {
    return this.runtime.rpc("task/prepareSession", {
      backend: this.kind,
      taskId: input.task.id,
      turnId: input.turnId,
      runId: input.task.run?.id,
      generation: input.task.run?.generation,
      transactionId,
      mode: input.mode,
      capabilityProfile: input.capabilityProfile,
      workingDirectory: input.workingDirectory,
      externalSessionId: input.task.contextSwitch?.nextExternalSessionId,
      runtimeModel: input.task.runtimeModel,
    });
  }
  async discardSession(taskId: string, transactionId: string): Promise<void> {
    await this.runtime.rpc("task/discardSession", {
      backend: this.kind,
      taskId,
      transactionId,
    });
  }

  async interrupt(taskId: string): Promise<void> {
    this.polls.get(taskId)?.abort();
    this.polls.delete(taskId);
    await this.runtime.rpc("task/interrupt", {
      backend: this.kind,
      taskId,
    });
  }

  async analyze(
    prompt: string,
    selection?: RuntimeModelSelection,
  ): Promise<string> {
    const result = await this.runtime.rpc<{ text?: string }>(
      "runtime/analyze",
      { backend: this.kind, prompt, runtimeModel: selection },
    );
    return result.text ?? "";
  }

  async dispose(taskId: string): Promise<void> {
    this.polls.get(taskId)?.abort();
    this.polls.delete(taskId);
    await this.runtime.rpc("task/dispose", {
      backend: this.kind,
      taskId,
    });
  }

  resolveApproval(resolution: ApprovalResolution): Promise<unknown> {
    return this.runtime.resolveApproval(resolution);
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
        const page = await this.runtime.events(
          taskId,
          cursor,
          25_000,
          controller.signal,
        );
        if (controller.signal.aborted || this.polls.get(taskId) !== controller)
          return;
        for (const event of page.events) {
          cursor = event.id;
          callbacks.event(event);
          if (
            event.turnId === turnId &&
            (event.type === "turn_completed" ||
              event.type === "turn_failed" ||
              event.type === "turn_aborted")
          ) {
            if (this.polls.get(taskId) === controller)
              this.polls.delete(taskId);
            return;
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (this.polls.get(taskId) === controller) this.polls.delete(taskId);
        callbacks.disconnected(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }
}
