import type {
  ApprovalRequest,
  ApprovalResolution,
  CapabilityProfile,
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

interface CodexSession {
  taskId: string;
  profile: PluginRuntimeTurnInput["capabilityProfile"];
  rpc: RuntimeJsonLineProcess;
  threadId: string;
  hostTurnId: string;
  turnId?: string;
  sink: PluginRuntimeEventSink;
  approvals: PluginApprovalBrokerLike;
  policyViolationTurnId?: string;
}

const ALWAYS_DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_local_automation",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "recommended_plugins",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "workspace_dependencies",
] as const;

const ZOTERO_ONLY_DISABLED_FEATURES = [
  ...ALWAYS_DISABLED_FEATURES,
  "shell_tool",
  "unified_exec",
] as const;

function disabledFeatures(profile: CapabilityProfile): readonly string[] {
  return profile === "zotero_only"
    ? ZOTERO_ONLY_DISABLED_FEATURES
    : ALWAYS_DISABLED_FEATURES;
}

/** Process flags applied before any Codex thread can inherit user settings. */
export function pluginCodexAppServerArgs(profile: CapabilityProfile): string[] {
  const args = ["app-server"];
  for (const feature of disabledFeatures(profile)) {
    args.push("--disable", feature);
  }
  args.push(
    "-c",
    "allow_login_shell=false",
    "-c",
    'web_search="disabled"',
    "-c",
    "tools.web_search=false",
    "-c",
    "tools.view_image=false",
  );
  return args;
}

export function pluginCodexRuntimeConfig(
  profile: CapabilityProfile,
  configuredMcpServers: readonly string[],
  confucius?: { url: string; token: string },
): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const name of configuredMcpServers) {
    if (name && name !== "confucius") mcpServers[name] = { enabled: false };
  }
  if (confucius) {
    mcpServers.confucius = {
      url: confucius.url,
      http_headers: { Authorization: `Bearer ${confucius.token}` },
      required: true,
      startup_timeout_sec: 10,
      tool_timeout_sec: 300,
    };
  }
  return {
    mcp_servers: mcpServers,
    allow_login_shell: false,
    web_search: "disabled",
    tools: { web_search: false, view_image: false },
    features: Object.fromEntries(
      disabledFeatures(profile).map((feature) => [feature, false]),
    ),
  };
}

/** Codex App Server hosted directly by the privileged Zotero add-on. */
export class PluginCodexAdapter implements PluginRuntimeAdapter {
  readonly kind = "codex" as const;
  private readonly sessions = new Map<string, CodexSession>();

  constructor(private executable = "") {}

  configure(executable?: string): void {
    this.executable = executable?.trim() ?? "";
  }

  async probe(): Promise<RuntimeStatus> {
    const checkedAt = Date.now();
    try {
      const command = await runRuntimeCommand(
        this.executable,
        "codex",
        ["--version"],
        8_000,
      );
      const version = command.stdout.trim().replace(/^codex-cli\s+/, "");
      const rpc = await this.openRpc();
      try {
        const account = await withTimeout(
          rpc.request<Record<string, unknown>>("account/read", {}),
          8_000,
          "Codex account probe timed out",
        );
        const ready = codexAccountReady(account);
        return {
          backend: "codex",
          state: ready ? "ready" : "auth_required",
          version,
          executable: command.executable,
          message: ready
            ? undefined
            : "Complete the official Codex login before starting a task.",
          checkedAt,
        };
      } finally {
        rpc.close();
      }
    } catch (error) {
      return {
        backend: "codex",
        state: "unavailable",
        message: errorMessage(error),
        executable: this.executable,
        checkedAt,
      };
    }
  }

  async startTurn(
    input: PluginRuntimeTurnInput,
    sink: PluginRuntimeEventSink,
    approvals: PluginApprovalBrokerLike,
  ): Promise<PluginRuntimeTurnHandle> {
    let session = this.sessions.get(input.taskId);
    if (session && session.profile !== input.capabilityProfile) {
      if (session.turnId) {
        throw new Error(
          "Cannot change capability profile during an active turn",
        );
      }
      const threadId = session.threadId;
      await this.dispose(input.taskId);
      input = {
        ...input,
        externalSessionId: input.externalSessionId ?? threadId,
      };
      session = undefined;
    }
    if (!session) {
      const rpc = await this.openRpc(input.capabilityProfile);
      const provisional: CodexSession = {
        taskId: input.taskId,
        profile: input.capabilityProfile,
        rpc,
        threadId: "",
        hostTurnId: input.turnId,
        sink,
        approvals,
      };
      rpc.onNotification((message) =>
        this.onNotification(provisional, message),
      );
      rpc.onRequest(
        (message) => void this.onServerRequest(provisional, message),
      );
      rpc.onFailure((error) => {
        if (this.sessions.get(input.taskId) !== provisional) return;
        const turnId = provisional.hostTurnId;
        provisional.sink.emit(
          "task_status_changed",
          { status: "failed", reason: "runtime process exited" },
          turnId,
        );
        provisional.sink.emit(
          "turn_failed",
          { message: error.message },
          turnId,
        );
        this.sessions.delete(input.taskId);
      });
      const params = await this.threadParams(input, rpc);
      const response = input.externalSessionId
        ? await rpc.request<Record<string, unknown>>("thread/resume", {
            threadId: input.externalSessionId,
            ...params,
            excludeTurns: true,
          })
        : await rpc.request<Record<string, unknown>>("thread/start", params);
      const threadId =
        String(asRecord(response.thread).id ?? "") || input.externalSessionId;
      if (!threadId) {
        rpc.close();
        throw new Error("Codex did not return a thread id");
      }
      provisional.threadId = threadId;
      session = provisional;
      this.sessions.set(input.taskId, session);
    } else {
      session.sink = sink;
      session.approvals = approvals;
      session.profile = input.capabilityProfile;
      session.hostTurnId = input.turnId;
    }

    const response = await session.rpc.request<Record<string, unknown>>(
      "turn/start",
      {
        threadId: session.threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: input.cwd,
        approvalPolicy: "on-request",
        sandboxPolicy:
          input.capabilityProfile === "workspace"
            ? {
                type: "workspaceWrite",
                writableRoots: [input.cwd],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              }
            : { type: "readOnly", networkAccess: false },
      },
    );
    session.turnId = String(asRecord(response.turn).id ?? "") || undefined;
    return {
      externalSessionId: session.threadId,
      externalTurnId: session.turnId,
    };
  }

  async interrupt(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session?.turnId) return;
    await session.rpc.request("turn/interrupt", {
      threadId: session.threadId,
      turnId: session.turnId,
    });
  }

  async dispose(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session) return;
    session.rpc.close();
    this.sessions.delete(taskId);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.dispose(id)));
  }

  async analyze(prompt: string, cwd: string): Promise<string> {
    const rpc = await this.openRpc("zotero_only");
    let text = "";
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    rpc.onNotification((message) => {
      const params = asRecord(message.params);
      if (message.method === "item/agentMessage/delta") {
        text += String(params.delta ?? "");
      }
      if (message.method === "turn/completed") complete();
    });
    try {
      const configuredMcpServers = await this.configuredMcpServers(rpc);
      const started = await rpc.request<Record<string, unknown>>(
        "thread/start",
        {
          cwd,
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          baseInstructions:
            "Answer only the requested analysis. Do not use tools.",
          config: pluginCodexRuntimeConfig("zotero_only", configuredMcpServers),
        },
      );
      const threadId = String(asRecord(started.thread).id ?? "");
      if (!threadId) throw new Error("Codex did not return a thread id");
      await rpc.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      await withTimeout(done, 60_000, "Codex analysis timed out");
      return text;
    } finally {
      rpc.close();
    }
  }

  private async openRpc(
    profile: CapabilityProfile = "zotero_only",
  ): Promise<RuntimeJsonLineProcess> {
    const rpc = await RuntimeJsonLineProcess.open(
      this.executable,
      "codex",
      pluginCodexAppServerArgs(profile),
    );
    await withTimeout(
      rpc.request("initialize", {
        clientInfo: {
          name: "confucius_zotero",
          title: "Confucius for Zotero",
          version: "0.3.1",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: ["rawResponseItem/completed"],
        },
      }),
      10_000,
      "Codex initialization timed out",
    );
    rpc.notify("initialized", {});
    return rpc;
  }

  private async threadParams(
    input: PluginRuntimeTurnInput,
    rpc: RuntimeJsonLineProcess,
  ): Promise<Record<string, unknown>> {
    const configuredMcpServers = await this.configuredMcpServers(rpc);
    return {
      cwd: input.cwd,
      approvalPolicy: "on-request",
      sandbox:
        input.capabilityProfile === "workspace"
          ? "workspace-write"
          : "read-only",
      baseInstructions: input.developerInstructions,
      config: pluginCodexRuntimeConfig(
        input.capabilityProfile,
        configuredMcpServers,
        input.mcp,
      ),
    };
  }

  private async configuredMcpServers(
    rpc: RuntimeJsonLineProcess,
  ): Promise<string[]> {
    const response = await withTimeout(
      rpc.request<Record<string, unknown>>("config/read", {
        includeLayers: false,
      }),
      5_000,
      "Codex config probe timed out",
    );
    return Object.keys(asRecord(asRecord(response.config).mcp_servers));
  }

  private onNotification(
    session: CodexSession,
    message: RuntimeJsonRpcMessage,
  ): void {
    const params = asRecord(message.params);
    const providerTurnId = String(params.turnId ?? session.turnId ?? "");
    if (session.turnId && providerTurnId && providerTurnId !== session.turnId) {
      return;
    }
    const turnId = session.hostTurnId;
    if (params.threadId && params.threadId !== session.threadId) return;
    switch (message.method) {
      case "item/agentMessage/delta":
        session.sink.emit(
          "text_delta",
          { text: String(params.delta ?? "") },
          turnId,
        );
        return;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        session.sink.emit(
          "reasoning_delta",
          { text: String(params.delta ?? "") },
          turnId,
        );
        return;
      case "turn/plan/updated": {
        const plan = Array.isArray(params.plan) ? params.plan : [];
        session.sink.emit(
          "plan_updated",
          { steps: plan.map((entry, index) => codexPlanStep(entry, index)) },
          turnId,
        );
        return;
      }
      case "turn/diff/updated":
        session.sink.emit(
          "turn_diff_updated",
          { diff: String(params.diff ?? "") },
          turnId,
        );
        return;
      case "item/started":
      case "item/completed":
        this.onItem(
          session,
          asRecord(params.item),
          message.method === "item/completed",
          turnId,
        );
        return;
      case "turn/completed": {
        const turn = asRecord(params.turn);
        const status = String(turn.status ?? "completed");
        if (session.policyViolationTurnId === turnId) {
          session.sink.emit(
            "task_status_changed",
            {
              status: "failed",
              reason: "Zotero-only runtime policy violation",
            },
            turnId,
          );
          session.policyViolationTurnId = undefined;
          session.turnId = undefined;
          return;
        }
        const phase =
          status === "failed"
            ? "failed"
            : status === "interrupted"
              ? "aborted"
              : "done";
        session.sink.emit(
          "task_status_changed",
          {
            status:
              phase === "done"
                ? "completed"
                : phase === "failed"
                  ? "failed"
                  : "interrupted",
          },
          turnId,
        );
        if (phase === "failed") {
          session.sink.emit(
            "turn_failed",
            { message: errorFromTurn(turn) },
            turnId,
          );
        } else if (phase === "aborted") {
          session.sink.emit(
            "turn_aborted",
            { reason: "runtime interrupted" },
            turnId,
          );
        } else {
          session.sink.emit("turn_completed", { phase }, turnId);
        }
        session.turnId = undefined;
        return;
      }
      case "error":
        session.sink.emit(
          "task_status_changed",
          { status: "failed", reason: String(params.message ?? "") },
          turnId,
        );
        session.sink.emit(
          "turn_failed",
          { message: String(params.message ?? "Codex runtime error") },
          turnId,
        );
        return;
      default:
        return;
    }
  }

  private onItem(
    session: CodexSession,
    item: Record<string, unknown>,
    completed: boolean,
    turnId: string,
  ): void {
    const type = String(item.type ?? "");
    const id = String(item.id ?? "runtime_item");
    if (
      session.profile === "zotero_only" &&
      (type === "commandExecution" || type === "fileChange")
    ) {
      this.stopForbiddenRuntimeAction(session, type, turnId);
      return;
    }
    if (type === "commandExecution") {
      session.sink.emit(
        "command_execution",
        {
          callId: id,
          command: String(item.command ?? ""),
          status: completed
            ? Number(item.exitCode ?? 0) === 0
              ? "completed"
              : "failed"
            : "started",
          output: completed ? String(item.aggregatedOutput ?? "") : undefined,
          exitCode:
            completed && item.exitCode !== null
              ? Number(item.exitCode)
              : undefined,
        },
        turnId,
      );
      return;
    }
    if (type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      for (const change of changes) {
        const row = asRecord(change);
        session.sink.emit(
          "file_change",
          {
            path: String(row.path ?? row.filePath ?? "unknown"),
            status: completed ? "applied" : "proposed",
            diff: typeof row.diff === "string" ? row.diff : undefined,
          },
          turnId,
        );
      }
      return;
    }
    if (type !== "mcpToolCall") return;
    const server = String(item.server ?? "confucius");
    // The Zotero MCP endpoint emits the authoritative tool lifecycle.
    if (server === "confucius") return;
    const toolName = `mcp.${server}.${String(item.tool ?? "unknown")}`;
    if (!completed) {
      session.sink.emit(
        "tool_requested",
        { callId: id, toolName, args: asRecord(item.arguments) },
        turnId,
      );
    } else {
      const failed = Boolean(item.error);
      session.sink.emit(
        "tool_result",
        {
          callId: id,
          result: failed
            ? {
                ok: false,
                toolName,
                code: "internal",
                message: JSON.stringify(item.error),
              }
            : { ok: true, toolName, data: item.result ?? null },
        },
        turnId,
      );
    }
  }

  private stopForbiddenRuntimeAction(
    session: CodexSession,
    type: "commandExecution" | "fileChange",
    turnId: string,
  ): void {
    if (session.policyViolationTurnId === turnId) return;
    session.policyViolationTurnId = turnId;
    const action = type === "commandExecution" ? "command" : "file change";
    session.sink.emit(
      "task_status_changed",
      { status: "failed", reason: "Zotero-only runtime policy violation" },
      turnId,
    );
    session.sink.emit(
      "turn_failed",
      { message: `Codex attempted a forbidden ${action} in Zotero-only mode` },
      turnId,
    );
    if (!session.turnId) return;
    void session.rpc
      .request("turn/interrupt", {
        threadId: session.threadId,
        turnId: session.turnId,
      })
      .catch(() => undefined);
  }

  private async onServerRequest(
    session: CodexSession,
    message: RuntimeJsonRpcMessage,
  ): Promise<void> {
    const id = message.id ?? null;
    const params = asRecord(message.params);
    const providerTurnId = String(params.turnId ?? session.turnId ?? "");
    if (session.turnId && providerTurnId && providerTurnId !== session.turnId) {
      session.rpc.respondError(id, -32602, "Approval belongs to another turn");
      return;
    }
    const turnId = session.hostTurnId;
    if (message.method === "item/commandExecution/requestApproval") {
      const allowed = await this.reviewRuntimeAction(
        session,
        id,
        turnId,
        "command",
        String(params.command ?? "Command execution"),
        params,
      );
      session.rpc.respond(id, {
        decision:
          allowed.verdict === "allow"
            ? allowed.scope === "session"
              ? "acceptForSession"
              : "accept"
            : "decline",
      });
      return;
    }
    if (message.method === "item/fileChange/requestApproval") {
      const allowed = await this.reviewRuntimeAction(
        session,
        id,
        turnId,
        "file_change",
        String(params.reason ?? params.grantRoot ?? "File change"),
        params,
      );
      session.rpc.respond(id, {
        decision:
          allowed.verdict === "allow"
            ? allowed.scope === "session"
              ? "acceptForSession"
              : "accept"
            : "decline",
      });
      return;
    }
    if (message.method === "item/permissions/requestApproval") {
      session.rpc.respond(id, { permissions: {}, scope: "turn" });
      return;
    }
    session.rpc.respondError(
      id,
      -32601,
      "Unsupported Confucius client request",
    );
  }

  private async reviewRuntimeAction(
    session: CodexSession,
    providerRequestId: string | number | null,
    turnId: string,
    kind: "command" | "file_change",
    summary: string,
    args: Record<string, unknown>,
  ): Promise<ApprovalResolution> {
    const id = `approval_codex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const request: ApprovalRequest = {
      id,
      sessionId: session.taskId,
      turnId,
      toolName: kind === "command" ? "runtime.command" : "runtime.file_change",
      args,
      riskLevel: kind === "command" ? "command" : "file_write",
      createdAt: Date.now(),
      summary,
      origin: "codex",
      kind,
      providerRequestId: providerRequestId ?? undefined,
    };
    session.sink.emit("approval_required", { request }, turnId);
    if (session.profile === "zotero_only") {
      const resolution: ApprovalResolution = {
        id,
        verdict: "deny",
        scope: "once",
      };
      session.sink.emit("approval_resolved", { resolution }, turnId);
      return resolution;
    }
    const resolution = await session.approvals.request(request);
    session.sink.emit("approval_resolved", { resolution }, turnId);
    return resolution;
  }
}

/** `account` may be null when Codex is configured not to require OpenAI auth. */
export function codexAccountReady(response: Record<string, unknown>): boolean {
  return Boolean(response.account) || response.requiresOpenaiAuth === false;
}

function codexPlanStep(value: unknown, index: number): PlanStep {
  const entry = asRecord(value);
  const status = String(entry.status ?? "pending");
  return {
    id: `codex_plan_${index}`,
    label: String(entry.step ?? entry.label ?? "Step"),
    status:
      status === "completed"
        ? "done"
        : status === "inProgress" || status === "in_progress"
          ? "running"
          : status === "failed"
            ? "failed"
            : "pending",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function errorFromTurn(turn: Record<string, unknown>): string {
  const error = asRecord(turn.error);
  return String(error.message ?? turn.error ?? "Codex turn failed");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
