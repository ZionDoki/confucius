import type {
  ApprovalRequest,
  ApprovalResolution,
  PlanStep,
  RuntimeStatus,
} from "@confucius/protocol";
import {
  RuntimeJsonLineProcess,
  runRuntimeCommand,
  type RuntimeJsonRpcMessage,
} from "./RuntimeProcess";
import type {
  PluginApprovalBrokerLike,
  PluginRuntimeAdapter,
  PluginRuntimeEventSink,
  PluginRuntimeTurnHandle,
  PluginRuntimeTurnInput,
} from "./PluginRuntimeTypes";

interface KimiSession {
  taskId: string;
  profile: PluginRuntimeTurnInput["capabilityProfile"];
  rpc: RuntimeJsonLineProcess;
  sessionId: string;
  sink: PluginRuntimeEventSink;
  approvals: PluginApprovalBrokerLike;
  turnId?: string;
  cwd: string;
  toolCalls: Map<
    string,
    { kind: string; name: string; command?: string; path?: string }
  >;
  policyViolationTurnId?: string;
}

/** ACP v1 client hosted inside Zotero without a Node transport process. */
export class PluginKimiAdapter implements PluginRuntimeAdapter {
  readonly kind = "kimi" as const;
  private readonly sessions = new Map<string, KimiSession>();

  constructor(private executable = "") {}

  configure(executable?: string): void {
    this.executable = executable?.trim() ?? "";
  }

  async probe(): Promise<RuntimeStatus> {
    const checkedAt = Date.now();
    let version: string | undefined;
    let resolvedExecutable: string;
    let opened: KimiSession | undefined;
    let probeCwd: string | undefined;
    try {
      const command = await runRuntimeCommand(
        this.executable,
        "kimi",
        ["--version"],
        8_000,
      );
      resolvedExecutable = command.executable;
      version = `${command.stdout}\n${command.stderr}`.match(
        /\d+\.\d+\.\d+/,
      )?.[0];
    } catch (error) {
      return {
        backend: "kimi",
        state: "unavailable",
        message: errorMessage(error),
        executable: this.executable,
        checkedAt,
      };
    }

    try {
      probeCwd = await makeTemporaryDirectory("kimi-probe");
      opened = await this.openConnection({
        taskId: "probe",
        profile: "zotero_only",
        sink: noopSink,
        approvals: denyApprovals,
      });
      const created = await withTimeout(
        opened.rpc.request<Record<string, unknown>>(
          "session/new",
          sessionSetup(probeCwd),
        ),
        12_000,
        "Kimi ACP session probe timed out",
      );
      opened.sessionId = String(created.sessionId ?? "");
      if (!opened.sessionId)
        throw new Error("Kimi did not return a session id");
      await withTimeout(
        opened.rpc.request("session/close", { sessionId: opened.sessionId }),
        1_500,
        "Kimi ACP probe cleanup timed out",
      ).catch(() => undefined);
      opened.sessionId = "";
      return {
        backend: "kimi",
        state: "ready",
        version,
        executable: resolvedExecutable,
        checkedAt,
      };
    } catch (error) {
      return {
        backend: "kimi",
        state: isAuthenticationError(error) ? "auth_required" : "error",
        version,
        message: errorMessage(error),
        executable: resolvedExecutable,
        checkedAt,
      };
    } finally {
      opened?.rpc.close();
      if (probeCwd) {
        await IOUtils.remove(probeCwd, { recursive: true }).catch(
          () => undefined,
        );
      }
    }
  }

  async startTurn(
    input: PluginRuntimeTurnInput,
    sink: PluginRuntimeEventSink,
    approvals: PluginApprovalBrokerLike,
  ): Promise<PluginRuntimeTurnHandle> {
    let session = this.sessions.get(input.taskId);
    let externalSessionId = input.externalSessionId;
    if (
      session &&
      (session.profile !== input.capabilityProfile || session.cwd !== input.cwd)
    ) {
      if (session.turnId) {
        throw new Error(
          "Cannot change Kimi capabilities during an active turn",
        );
      }
      externalSessionId ??= session.sessionId;
      await this.dispose(input.taskId);
      session = undefined;
    }
    if (!session) {
      const opened = await this.openConnection({
        taskId: input.taskId,
        profile: input.capabilityProfile,
        sink,
        approvals,
      });
      const request = sessionSetup(
        input.cwd,
        input.capabilityProfile === "workspace" ? [input.cwd] : [],
        [
          {
            type: "http",
            name: "confucius",
            url: input.mcp.url,
            headers: [
              {
                name: "Authorization",
                value: `Bearer ${input.mcp.token}`,
              },
            ],
          },
        ],
      );
      let sessionId = externalSessionId;
      if (sessionId) {
        try {
          await withTimeout(
            opened.rpc.request("session/resume", { sessionId, ...request }),
            15_000,
            "Kimi session resume timed out",
          );
        } catch {
          await withTimeout(
            opened.rpc.request("session/load", { sessionId, ...request }),
            15_000,
            "Kimi session load timed out",
          );
        }
      } else {
        const created = await withTimeout(
          opened.rpc.request<Record<string, unknown>>("session/new", request),
          15_000,
          "Kimi session creation timed out",
        );
        sessionId = String(created.sessionId ?? "");
      }
      if (!sessionId) {
        opened.rpc.close();
        throw new Error("Kimi did not return a session id");
      }
      // Kimi's default mode requests approval; plan mode remains read-only.
      await withTimeout(
        opened.rpc.request("session/set_mode", {
          sessionId,
          modeId: input.mode === "plan" ? "plan" : "default",
        }),
        5_000,
        "Kimi mode selection timed out",
      );
      opened.sessionId = sessionId;
      opened.cwd = input.cwd;
      session = opened;
      this.sessions.set(input.taskId, session);
    } else {
      session.profile = input.capabilityProfile;
      session.sink = sink;
      session.approvals = approvals;
    }

    session.turnId = input.turnId;
    const active = session;
    void active.rpc
      .request<Record<string, unknown>>("session/prompt", {
        sessionId: active.sessionId,
        prompt: [
          {
            type: "text",
            text: `${input.developerInstructions}\n\n${input.prompt}`,
          },
        ],
      })
      .then((response) => {
        if (active.turnId !== input.turnId) return;
        if (active.policyViolationTurnId === input.turnId) {
          active.policyViolationTurnId = undefined;
          active.turnId = undefined;
          return;
        }
        const stopReason = String(response.stopReason ?? "end_turn");
        if (stopReason === "cancelled") {
          active.sink.emit(
            "task_status_changed",
            { status: "interrupted" },
            input.turnId,
          );
          active.sink.emit(
            "turn_aborted",
            { reason: "runtime interrupted" },
            input.turnId,
          );
        } else if (stopReason === "refusal") {
          active.sink.emit(
            "task_status_changed",
            { status: "failed" },
            input.turnId,
          );
          active.sink.emit(
            "turn_failed",
            { message: "Kimi refused the task" },
            input.turnId,
          );
        } else {
          active.sink.emit(
            "task_status_changed",
            { status: "completed" },
            input.turnId,
          );
          active.sink.emit("turn_completed", { phase: "done" }, input.turnId);
        }
        active.turnId = undefined;
      })
      .catch((error) => {
        if (active.turnId !== input.turnId) return;
        if (active.policyViolationTurnId === input.turnId) {
          active.policyViolationTurnId = undefined;
          active.turnId = undefined;
          return;
        }
        active.sink.emit(
          "task_status_changed",
          { status: "failed" },
          input.turnId,
        );
        active.sink.emit(
          "turn_failed",
          { message: errorMessage(error) },
          input.turnId,
        );
        active.turnId = undefined;
      });
    return {
      externalSessionId: active.sessionId,
      externalTurnId: input.turnId,
    };
  }

  async interrupt(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session) return;
    session.rpc.notify("session/cancel", { sessionId: session.sessionId });
  }

  async dispose(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session) return;
    session.turnId = undefined;
    try {
      await withTimeout(
        session.rpc.request("session/close", {
          sessionId: session.sessionId,
        }),
        1_500,
        "Kimi session close timed out",
      );
    } catch {
      // Older Kimi ACP builds need only process teardown.
    }
    session.rpc.close();
    this.sessions.delete(taskId);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.dispose(id)));
  }

  async analyze(prompt: string, cwd: string): Promise<string> {
    let text = "";
    const opened = await this.openConnection({
      taskId: "analysis",
      profile: "zotero_only",
      sink: {
        emit(type, payload) {
          if (type === "text_delta" && "text" in payload) text += payload.text;
        },
      },
      approvals: denyApprovals,
    });
    try {
      const created = await opened.rpc.request<Record<string, unknown>>(
        "session/new",
        sessionSetup(cwd),
      );
      opened.sessionId = String(created.sessionId ?? "");
      if (!opened.sessionId)
        throw new Error("Kimi did not return a session id");
      await opened.rpc.request("session/set_mode", {
        sessionId: opened.sessionId,
        modeId: "plan",
      });
      await opened.rpc.request("session/prompt", {
        sessionId: opened.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      return text;
    } finally {
      opened.rpc.close();
    }
  }

  private async openConnection(input: {
    taskId: string;
    profile: PluginRuntimeTurnInput["capabilityProfile"];
    sink: PluginRuntimeEventSink;
    approvals: PluginApprovalBrokerLike;
  }): Promise<KimiSession> {
    const rpc = await RuntimeJsonLineProcess.open(this.executable, "kimi", [
      "acp",
    ]);
    const holder: KimiSession = {
      ...input,
      rpc,
      sessionId: "",
      cwd: "",
      toolCalls: new Map(),
    };
    rpc.onNotification((message) => this.onNotification(holder, message));
    rpc.onRequest((message) => void this.onRequest(holder, message));
    rpc.onFailure((error) => {
      if (this.sessions.get(input.taskId) !== holder) return;
      this.sessions.delete(input.taskId);
      const turnId = holder.turnId;
      holder.turnId = undefined;
      if (!turnId) return;
      holder.sink.emit(
        "task_status_changed",
        { status: "failed", reason: "runtime process exited" },
        turnId,
      );
      holder.sink.emit("turn_failed", { message: error.message }, turnId);
    });
    try {
      const initialized = await withTimeout(
        rpc.request<Record<string, unknown>>("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            terminal: false,
            fs: { readTextFile: false, writeTextFile: false },
            plan: {},
          },
          clientInfo: { name: "confucius-zotero", version: "0.3.2" },
        }),
        10_000,
        "Kimi ACP initialization timed out",
      );
      if (Number(initialized.protocolVersion) !== 1) {
        throw new Error("Kimi must support ACP v1");
      }
    } catch (error) {
      rpc.close();
      throw error;
    }
    return holder;
  }

  private async onRequest(
    session: KimiSession,
    message: RuntimeJsonRpcMessage,
  ): Promise<void> {
    const id = message.id ?? null;
    if (message.method !== "session/request_permission") {
      session.rpc.respondError(
        id,
        -32601,
        "Confucius does not expose terminal or filesystem client methods",
      );
      return;
    }
    try {
      session.rpc.respond(
        id,
        await this.onPermission(session, asRecord(message.params)),
      );
    } catch (error) {
      session.rpc.respondError(id, -32000, errorMessage(error));
    }
  }

  private async onPermission(
    session: KimiSession,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const toolCall = asRecord(params.toolCall);
    const toolName = String(toolCall.name ?? toolCall.title ?? "");
    const options = Array.isArray(params.options)
      ? params.options.map(asRecord)
      : [];
    const option = (kind: string) =>
      options.find((entry) => entry.kind === kind);
    if (toolName.startsWith("mcp__confucius__")) {
      const allowOnce = option("allow_once");
      return allowOnce
        ? {
            outcome: {
              outcome: "selected",
              optionId: String(allowOnce.optionId ?? ""),
            },
          }
        : { outcome: { outcome: "cancelled" } };
    }
    const reject = option("reject_once") ?? option("reject_always");
    if (session.profile === "zotero_only") {
      return reject
        ? {
            outcome: {
              outcome: "selected",
              optionId: String(reject.optionId ?? ""),
            },
          }
        : { outcome: { outcome: "cancelled" } };
    }
    const allowOnce = option("allow_once");
    const allowAlways = option("allow_always");
    const turnId = session.turnId ?? "";
    const id = `approval_kimi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const request: ApprovalRequest = {
      id,
      sessionId: session.taskId,
      turnId,
      toolName: toolName || "runtime.tool",
      args: asRecord(toolCall.rawInput),
      riskLevel: toolCall.kind === "execute" ? "command" : "file_write",
      createdAt: Date.now(),
      summary: typeof toolCall.title === "string" ? toolCall.title : undefined,
      origin: "kimi",
      kind: toolCall.kind === "execute" ? "command" : "runtime_permission",
    };
    session.sink.emit("approval_required", { request }, turnId);
    const resolution = await session.approvals.request(request);
    session.sink.emit("approval_resolved", { resolution }, turnId);
    const chosen =
      resolution.verdict === "allow"
        ? resolution.scope === "session"
          ? (allowAlways ?? allowOnce)
          : (allowOnce ?? allowAlways)
        : reject;
    return chosen
      ? {
          outcome: {
            outcome: "selected",
            optionId: String(chosen.optionId ?? ""),
          },
        }
      : { outcome: { outcome: "cancelled" } };
  }

  private onNotification(
    session: KimiSession,
    message: RuntimeJsonRpcMessage,
  ): void {
    if (message.method !== "session/update") return;
    const params = asRecord(message.params);
    if (params.sessionId && params.sessionId !== session.sessionId) return;
    this.onUpdate(session, asRecord(params.update));
  }

  private onUpdate(
    session: KimiSession,
    update: Record<string, unknown>,
  ): void {
    const turnId = session.turnId ?? "";
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = contentText(update.content);
      if (text) session.sink.emit("text_delta", { text }, turnId);
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      const text = contentText(update.content);
      if (text) session.sink.emit("reasoning_delta", { text }, turnId);
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      const rawInput = asRecord(update.rawInput);
      const kind = String(update.kind ?? "other");
      const name = String(update.name ?? update.title ?? "runtime.tool");
      if (name.startsWith("mcp__confucius__")) return;
      const path = toolPath(update, rawInput);
      const command = String(
        rawInput.command ?? rawInput.cmd ?? update.title ?? "",
      );
      if (
        session.profile === "zotero_only" &&
        (kind === "execute" || isFileToolKind(kind))
      ) {
        this.stopForbiddenRuntimeAction(session, kind, turnId);
        return;
      }
      const callId = String(update.toolCallId ?? "runtime_tool");
      session.toolCalls.set(callId, { kind, name, command, path });
      session.sink.emit(
        "tool_requested",
        { callId, toolName: name, args: rawInput },
        turnId,
      );
      if (kind === "execute") {
        session.sink.emit(
          "command_execution",
          { callId, command, status: "started" },
          turnId,
        );
      } else if (isFileToolKind(kind)) {
        session.sink.emit(
          "file_change",
          {
            path: path ?? String(update.title ?? "unknown"),
            status: "proposed",
            diff: toolDiff(rawInput),
          },
          turnId,
        );
      }
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      const callId = String(update.toolCallId ?? "runtime_tool");
      const tracked = session.toolCalls.get(callId);
      const updateName = String(update.name ?? update.title ?? "");
      if (!tracked && updateName.startsWith("mcp__confucius__")) return;
      const status = String(update.status ?? "in_progress");
      if (tracked?.kind === "execute") {
        session.sink.emit(
          "command_execution",
          {
            callId,
            command: tracked.command || tracked.name,
            status:
              status === "completed"
                ? "completed"
                : status === "failed"
                  ? "failed"
                  : "started",
            output:
              status === "completed" || status === "failed"
                ? outputText(update.rawOutput ?? update.content)
                : undefined,
          },
          turnId,
        );
      } else if (tracked && isFileToolKind(tracked.kind)) {
        session.sink.emit(
          "file_change",
          {
            path: tracked.path ?? tracked.name ?? "unknown",
            status:
              status === "completed"
                ? "applied"
                : status === "failed"
                  ? "rejected"
                  : "proposed",
            diff: toolDiff(asRecord(update.rawInput)),
          },
          turnId,
        );
      }
      if (status === "completed" || status === "failed") {
        const toolName = updateName || tracked?.name || "runtime.tool";
        session.sink.emit(
          "tool_result",
          {
            callId,
            result:
              status === "completed"
                ? {
                    ok: true,
                    toolName,
                    data: update.rawOutput ?? update.content ?? null,
                  }
                : {
                    ok: false,
                    toolName,
                    code: "internal",
                    message: String(update.rawOutput ?? "Kimi tool failed"),
                  },
          },
          turnId,
        );
        session.toolCalls.delete(callId);
      } else {
        session.sink.emit(
          "tool_progress",
          {
            callId,
            message: String(update.title ?? status ?? "running"),
          },
          turnId,
        );
      }
      return;
    }
    if (
      update.sessionUpdate === "plan" ||
      update.sessionUpdate === "plan_update"
    ) {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      session.sink.emit(
        "plan_updated",
        { steps: entries.map((entry, index) => acpPlanStep(entry, index)) },
        turnId,
      );
    }
  }

  private stopForbiddenRuntimeAction(
    session: KimiSession,
    kind: string,
    turnId: string,
  ): void {
    if (session.policyViolationTurnId === turnId) return;
    session.policyViolationTurnId = turnId;
    const action = kind === "execute" ? "command" : "file change";
    session.sink.emit(
      "task_status_changed",
      { status: "failed", reason: "Zotero-only runtime policy violation" },
      turnId,
    );
    session.sink.emit(
      "turn_failed",
      { message: `Kimi attempted a forbidden ${action} in Zotero-only mode` },
      turnId,
    );
    if (session.sessionId) {
      session.rpc.notify("session/cancel", { sessionId: session.sessionId });
    }
  }
}

function sessionSetup(
  cwd: string,
  additionalDirectories: string[] = [],
  mcpServers: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return { cwd, additionalDirectories, mcpServers };
}

async function makeTemporaryDirectory(label: string): Promise<string> {
  const root = PathUtils.join(Zotero.DataDirectory.dir, "confucius", "tmp");
  await IOUtils.makeDirectory(root, {
    ignoreExisting: true,
    permissions: 0o700,
  });
  return IOUtils.createUniqueDirectory(root, `${label}-`, 0o700);
}

function contentText(content: unknown): string {
  const value = asRecord(content);
  return value.type === "text" ? String(value.text ?? "") : "";
}

function isFileToolKind(kind: string): boolean {
  return kind === "edit" || kind === "delete" || kind === "move";
}

function toolPath(
  update: Record<string, unknown>,
  rawInput: Record<string, unknown>,
): string | undefined {
  const locations = Array.isArray(update.locations) ? update.locations : [];
  const first = asRecord(locations[0]);
  const value =
    first.path ??
    rawInput.path ??
    rawInput.filePath ??
    rawInput.file_path ??
    rawInput.destination;
  return typeof value === "string" && value ? value : undefined;
}

function toolDiff(value: Record<string, unknown>): string | undefined {
  const diff = value.diff ?? value.patch ?? value.content;
  return typeof diff === "string" && diff ? diff : undefined;
}

function outputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function acpPlanStep(value: unknown, index: number): PlanStep {
  const entry = asRecord(value);
  const status = String(entry.status ?? "pending");
  return {
    id: `kimi_plan_${index}`,
    label: String(entry.content ?? "Step"),
    status:
      status === "completed"
        ? "done"
        : status === "in_progress"
          ? "running"
          : "pending",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthenticationError(error: unknown): boolean {
  const value = error as
    { code?: unknown; status?: unknown; message?: unknown } | undefined;
  const code = String(value?.code ?? value?.status ?? "").toLowerCase();
  const message = errorMessage(error);
  return (
    code === "401" ||
    code === "unauthenticated" ||
    /auth(?:entication|orization)?|login|log in|sign in|credential|unauthorized|登录|认证|凭据|未授权/i.test(
      message,
    )
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const noopSink: PluginRuntimeEventSink = { emit: () => undefined };
const denyApprovals: PluginApprovalBrokerLike = {
  request: async (request): Promise<ApprovalResolution> => ({
    id: request.id,
    verdict: "deny",
    scope: "once",
  }),
};
