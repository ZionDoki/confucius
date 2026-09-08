import { runtimeFailure } from "@confucius/protocol";
import { runtimePath } from "./RuntimeStorage";
import {
  kimiModels,
  selectKimiModel,
  lowestRuntimeSelection,
} from "./RuntimeModels";
import {
  CONFUCIUS_VERSION,
  runtimeOutcome,
  RuntimeUsageCounter,
  type ApprovalRequest,
  type ApprovalResolution,
  type PlanStep,
  type RuntimeStatus,
  type RuntimeModelSelection,
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
  modelState?: unknown;
  sink: PluginRuntimeEventSink;
  approvals: PluginApprovalBrokerLike;
  turnId?: string;
  cwd: string;
  toolCalls: Map<
    string,
    { kind: string; name: string; command?: string; path?: string }
  >;
  policyViolationTurnId?: string;
  usage?: RuntimeUsageCounter;
  mcpToken?: string;
  promptCompletion?: Promise<void>;
}

/** ACP v1 client hosted inside Zotero without a Node transport process. */
export class PluginKimiAdapter implements PluginRuntimeAdapter {
  readonly kind = "kimi" as const;
  private readonly sessions = new Map<string, KimiSession>();

  constructor(private executable = "") {}

  configure(executable?: string): void {
    this.executable = executable?.trim() ?? "";
  }

  async probe(modelId?: string): Promise<RuntimeStatus> {
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
        15_000,
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
      const environment = await isolatedKimiProbeEnvironment(probeCwd);
      opened = await this.openConnection({
        taskId: "probe",
        executable: resolvedExecutable,
        profile: "zotero_only",
        sink: noopSink,
        approvals: denyApprovals,
        environment,
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
      const selectedId =
        modelId ??
        (Array.isArray(created.configOptions)
          ? kimiModels(created).find((model) => model.isDefault)?.id
          : undefined);
      const modelState = selectedId
        ? await withTimeout(
            selectKimiModel(opened.rpc, opened.sessionId, created, {
              modelId: selectedId,
            }),
            8_000,
            "Kimi model selection timed out",
          )
        : created;
      const models = kimiModels(modelState);
      await withTimeout(
        opened.rpc.request("session/close", { sessionId: opened.sessionId }),
        1_500,
        "Kimi ACP probe cleanup timed out",
      ).catch(() => undefined);
      opened.sessionId = "";
      return {
        backend: "kimi",
        state: "ready",
        models,
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
    const sessionKey = input.sessionKey ?? input.taskId;
    let session = this.sessions.get(sessionKey);
    let externalSessionId = input.externalSessionId;
    let usage = session?.usage;
    if (session?.mcpToken && session.mcpToken !== input.mcp.token) {
      externalSessionId = session.sessionId;
      await this.dispose(sessionKey);
      session = undefined;
    }
    // ACP updates identify a session, not a turn. Drain cancellation before
    // assigning the next host turn so late output cannot be relabeled.
    if (session?.turnId && session.promptCompletion) {
      await this.interrupt(sessionKey);
      try {
        await withTimeout(
          session.promptCompletion,
          5_000,
          "The previous Kimi request did not stop",
        );
      } catch {
        await this.dispose(sessionKey);
        session = undefined;
        externalSessionId = undefined;
        usage = undefined;
      }
    }
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
      await this.dispose(sessionKey);
      session = undefined;
    }
    if (!session) {
      const opened = await this.openConnection({
        taskId: input.taskId,
        sessionKey,
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
          opened.modelState = await withTimeout(
            opened.rpc.request("session/resume", { sessionId, ...request }),
            15_000,
            "Kimi session resume timed out",
          );
        } catch {
          opened.modelState = await withTimeout(
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
        opened.modelState = created;
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
      this.sessions.set(sessionKey, session);
    } else {
      session.profile = input.capabilityProfile;
      session.sink = sink;
      session.approvals = approvals;
    }

    if (input.runtimeModel) {
      session.modelState = await withTimeout(
        selectKimiModel(
          session.rpc,
          session.sessionId,
          session.modelState,
          input.runtimeModel,
          (state) => {
            session.modelState = state;
          },
        ),
        8_000,
        "Kimi model selection timed out",
      );
    }
    session.usage ??= usage ?? new RuntimeUsageCounter(!externalSessionId);
    session.mcpToken = input.mcp.token;
    if (input.prepareOnly)
      return {
        externalSessionId: session.sessionId,
        runtimeModel: input.runtimeModel
          ? {
              modelId: input.runtimeModel.modelId,
              reasoningEffort: kimiModels(session.modelState).find(
                (m) => m.id === input.runtimeModel!.modelId,
              )?.defaultReasoningEffort,
            }
          : undefined,
      };
    session.turnId = input.turnId;
    const active = session;
    active.promptCompletion = active.rpc
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
        const usage = active.usage?.observe(
          (response as unknown as Record<string, unknown>).usage,
        );
        if (usage) active.sink.emit("model_usage_updated", usage, input.turnId);
        const outcome = runtimeOutcome("kimi", response.stopReason);
        active.sink.emit(
          "task_status_changed",
          { status: outcome.status },
          input.turnId,
        );
        if (outcome.phase === "done")
          active.sink.emit(
            "turn_completed",
            { phase: "done", stopReason: outcome.stopReason },
            input.turnId,
          );
        else if (outcome.phase === "failed")
          active.sink.emit(
            "turn_failed",
            {
              message: "Kimi refused or failed to complete the request",
              stopReason: outcome.stopReason,
            },
            input.turnId,
          );
        else
          active.sink.emit(
            "turn_aborted",
            {
              reason: `Kimi stopped: ${String(response.stopReason ?? "missing terminal status")}`,
              stopReason: outcome.stopReason,
            },
            input.turnId,
          );
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
          { message: errorMessage(error), failure: runtimeFailure(error) },
          input.turnId,
        );
        active.turnId = undefined;
      });
    return {
      externalSessionId: active.sessionId,
      externalTurnId: input.turnId,
      ...(input.runtimeModel
        ? {
            runtimeModel: {
              modelId: input.runtimeModel.modelId,
              reasoningEffort: kimiModels(active.modelState).find(
                (model) => model.id === input.runtimeModel!.modelId,
              )?.defaultReasoningEffort,
            },
          }
        : {}),
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
    this.sessions.delete(taskId);
    if (session.rpc.closeAndWait) await session.rpc.closeAndWait();
    else session.rpc.close();
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.dispose(id)));
  }

  async analyze(
    prompt: string,
    cwd: string,
    selection?: RuntimeModelSelection,
  ): Promise<string> {
    const deadline = Date.now() + 60_000;
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
      return await withTimeout(
        (async () => {
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
          let modelState: unknown = created;
          if (selection)
            modelState = await selectKimiModel(
              opened.rpc,
              opened.sessionId,
              modelState,
              { modelId: selection.modelId },
            );
          const selected =
            kimiModels(modelState).find((m) => m.id === selection?.modelId) ??
            kimiModels(modelState).find((m) => m.isDefault);
          if (selected)
            await selectKimiModel(
              opened.rpc,
              opened.sessionId,
              modelState,
              lowestRuntimeSelection(selected),
            );
          await opened.rpc.request("session/prompt", {
            sessionId: opened.sessionId,
            prompt: [{ type: "text", text: prompt }],
          });
          return text;
        })(),
        Math.max(1, deadline - Date.now()),
        "Kimi analysis timed out",
      );
    } finally {
      await opened.rpc.closeAndWait();
    }
  }

  private async openConnection(input: {
    taskId: string;
    sessionKey?: string;
    profile: PluginRuntimeTurnInput["capabilityProfile"];
    sink: PluginRuntimeEventSink;
    approvals: PluginApprovalBrokerLike;
    executable?: string;
    environment?: Record<string, string>;
  }): Promise<KimiSession> {
    const rpc = await RuntimeJsonLineProcess.open(
      input.executable ?? this.executable,
      "kimi",
      ["acp"],
      undefined,
      input.environment,
    );
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
      if (this.sessions.get(input.sessionKey ?? input.taskId) !== holder)
        return;
      this.sessions.delete(input.sessionKey ?? input.taskId);
      const turnId = holder.turnId;
      holder.turnId = undefined;
      if (!turnId) return;
      holder.sink.emit(
        "task_status_changed",
        { status: "failed", reason: "runtime process exited" },
        turnId,
      );
      holder.sink.emit(
        "turn_failed",
        { message: error.message, failure: runtimeFailure(error) },
        turnId,
      );
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
          clientInfo: { name: "confucius-zotero", version: CONFUCIUS_VERSION },
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
    if (update.sessionUpdate === "usage_update") {
      const used = update.used,
        size = update.size;
      if (typeof used === "number" && Number.isFinite(used) && used >= 0)
        session.sink.emit(
          "context_usage_updated",
          {
            inputTokens: used,
            capacityTokens:
              typeof size === "number" && Number.isFinite(size) && size >= 0
                ? size
                : undefined,
          },
          turnId,
        );
      return;
    }
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

/** Catalog probing may switch a temporary ACP session. Some CLI versions also
 * persist that choice globally, so probe against a private disposable config. */
async function isolatedKimiProbeEnvironment(
  root: string,
): Promise<Record<string, string>> {
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  const environment: Record<string, string> = {};
  for (const [key, directory] of [
    ["KIMI_CODE_HOME", ".kimi-code"],
    ["KIMI_SHARE_DIR", ".kimi"],
  ]) {
    const source = Services.env.get(key) || PathUtils.join(home, directory);
    const destination = PathUtils.join(root, directory);
    await IOUtils.makeDirectory(destination, { permissions: 0o700 });
    environment[key] = destination;
    const config = PathUtils.join(source, "config.toml");
    if (await IOUtils.exists(config)) {
      const target = PathUtils.join(destination, "config.toml");
      await IOUtils.write(target, await IOUtils.read(config));
      await IOUtils.setPermissions(target, 0o600);
    }
    const credentials = PathUtils.join(source, "credentials");
    if (await IOUtils.exists(credentials)) {
      const target = PathUtils.join(destination, "credentials");
      await IOUtils.makeDirectory(target, { permissions: 0o700 });
      for (const file of await IOUtils.getChildren(credentials)) {
        if (
          !file.endsWith(".json") ||
          (await IOUtils.stat(file)).type !== "regular"
        )
          continue;
        const copied = PathUtils.join(target, PathUtils.filename(file));
        await IOUtils.write(copied, await IOUtils.read(file));
        await IOUtils.setPermissions(copied, 0o600);
      }
    }
  }
  return environment;
}

async function makeTemporaryDirectory(label: string): Promise<string> {
  const root = runtimePath("tmp");
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
