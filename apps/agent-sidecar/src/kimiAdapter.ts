import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  ApprovalRequest,
  ApprovalResolution,
  PlanStep,
  RuntimeStatus,
} from "@confucius/protocol";
import type {
  ApprovalBrokerLike,
  RuntimeAdapter,
  RuntimeEventSink,
  RuntimeTurnHandle,
  RuntimeTurnInput,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface KimiSession {
  taskId: string;
  profile: RuntimeTurnInput["capabilityProfile"];
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  sessionId: string;
  sink: RuntimeEventSink;
  approvals: ApprovalBrokerLike;
  turnId?: string;
  cwd: string;
  toolCalls: Map<
    string,
    { kind: string; name: string; command?: string; path?: string }
  >;
  policyViolationTurnId?: string;
}

export class KimiAdapter implements RuntimeAdapter {
  readonly kind = "kimi" as const;
  private readonly sessions = new Map<string, KimiSession>();

  constructor(
    private executable = process.env.CONFUCIUS_KIMI_PATH || "kimi",
    private readonly executableArgs: string[] = [],
  ) {}

  configure(executable?: string): void {
    this.executable = executable?.trim() || "kimi";
  }

  async probe(): Promise<RuntimeStatus> {
    const checkedAt = Date.now();
    let version: string | undefined;
    let opened: KimiSession | undefined;
    let probeCwd: string | undefined;
    try {
      const { stdout, stderr } = await execFileAsync(
        this.executable,
        [...this.executableArgs, "--version"],
        {
          timeout: 8_000,
          windowsHide: true,
        },
      );
      version = `${stdout}\n${stderr}`.match(/\d+\.\d+\.\d+/)?.[0];
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
      probeCwd = await mkdtemp(join(tmpdir(), "confucius-kimi-probe-"));
      opened = await this.openConnection({
        taskId: "probe",
        profile: "zotero_only",
        sink: noopSink,
        approvals: denyApprovals,
      });
      // Authentication can succeed during ACP initialization but fail only
      // when a real session is created. Probe that boundary so the settings
      // page never advertises an installed-but-signed-out CLI as ready.
      const created = await opened.connection.newSession({
        cwd: probeCwd,
        additionalDirectories: [],
        mcpServers: [],
      });
      opened.sessionId = created.sessionId;
      await opened.connection
        .closeSession({ sessionId: created.sessionId })
        .catch(() => undefined);
      opened.sessionId = "";
      return {
        backend: "kimi",
        state: "ready",
        version,
        executable: this.executable,
        checkedAt,
      };
    } catch (error) {
      const message = errorMessage(error);
      return {
        backend: "kimi",
        state: isAuthenticationError(error) ? "auth_required" : "error",
        version,
        message,
        executable: this.executable,
        checkedAt,
      };
    } finally {
      if (opened?.sessionId) {
        await opened.connection
          .closeSession({ sessionId: opened.sessionId })
          .catch(() => undefined);
      }
      opened?.child.kill();
      if (probeCwd) {
        await rmdir(probeCwd).catch(() => undefined);
      }
    }
  }

  async startTurn(
    input: RuntimeTurnInput,
    sink: RuntimeEventSink,
    approvals: ApprovalBrokerLike,
  ): Promise<RuntimeTurnHandle> {
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
      const request = {
        cwd: input.cwd,
        additionalDirectories:
          input.capabilityProfile === "workspace" ? [input.cwd] : [],
        mcpServers: [
          {
            type: "http" as const,
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
      };
      let sessionId = externalSessionId;
      if (sessionId) {
        try {
          await opened.connection.resumeSession({ sessionId, ...request });
        } catch {
          await opened.connection.loadSession({ sessionId, ...request });
        }
      } else {
        const created = await opened.connection.newSession(request);
        sessionId = created.sessionId;
      }
      // Kimi's ACP contract defines "default" as manual approval mode and
      // "plan" as read-only. Set it explicitly so user-level yolo/auto
      // preferences can never leak into this embedded runtime.
      await opened.connection.setSessionMode({
        sessionId,
        modeId: input.mode === "plan" ? "plan" : "default",
      });
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
    void active.connection
      .prompt({
        sessionId: active.sessionId,
        prompt: [
          {
            type: "text",
            text: `${input.developerInstructions}\n\n${input.prompt}`,
          },
        ],
      })
      .then((response) => {
        if (active.policyViolationTurnId === input.turnId) {
          active.policyViolationTurnId = undefined;
          active.turnId = undefined;
          return;
        }
        if (response.stopReason === "cancelled") {
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
        } else if (response.stopReason === "refusal") {
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
    await session.connection.cancel({ sessionId: session.sessionId });
  }

  async dispose(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session) return;
    try {
      await session.connection.closeSession({ sessionId: session.sessionId });
    } catch {
      // Older Kimi ACP builds need only process teardown.
    }
    session.child.kill();
    this.sessions.delete(taskId);
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
      const created = await opened.connection.newSession({
        cwd,
        additionalDirectories: [],
        mcpServers: [],
      });
      opened.sessionId = created.sessionId;
      await opened.connection.setSessionMode({
        sessionId: created.sessionId,
        modeId: "plan",
      });
      await opened.connection.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      return text;
    } finally {
      if (opened.sessionId) {
        await opened.connection
          .closeSession({ sessionId: opened.sessionId })
          .catch(() => undefined);
      }
      opened.child.kill();
    }
  }

  private async openConnection(input: {
    taskId: string;
    profile: RuntimeTurnInput["capabilityProfile"];
    sink: RuntimeEventSink;
    approvals: ApprovalBrokerLike;
  }): Promise<KimiSession> {
    const child = spawn(this.executable, [...this.executableArgs, "acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    let holder: KimiSession;
    const client: Client = {
      requestPermission: (request) => this.onPermission(holder, request),
      sessionUpdate: (notification) => this.onUpdate(holder, notification),
    };
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(() => client, stream);
    holder = {
      ...input,
      child,
      connection,
      sessionId: "",
      cwd: "",
      toolCalls: new Map(),
    };
    const stderr: string[] = [];
    child.stderr.on("data", (chunk: Buffer) =>
      stderr.push(chunk.toString("utf8")),
    );
    try {
      await withTimeout(
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            terminal: false,
            fs: { readTextFile: false, writeTextFile: false },
            plan: {},
          },
          clientInfo: { name: "confucius-zotero", version: "0.3.3" },
        }),
        10_000,
        () =>
          `Kimi ACP initialization timed out${
            stderr.length ? `: ${stderr.join("").trim()}` : ""
          }`,
      );
    } catch (error) {
      child.kill();
      throw error;
    }
    return holder;
  }

  private async onPermission(
    session: KimiSession,
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const toolName = params.toolCall.name || params.toolCall.title || "";
    if (toolName.startsWith("mcp__confucius__")) {
      const allowOnce = params.options.find(
        (option) => option.kind === "allow_once",
      );
      return allowOnce
        ? { outcome: { outcome: "selected", optionId: allowOnce.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    const reject =
      params.options.find((option) => option.kind === "reject_once") ??
      params.options.find((option) => option.kind === "reject_always");
    if (session.profile === "zotero_only") {
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    const allowOnce = params.options.find(
      (option) => option.kind === "allow_once",
    );
    const allowAlways = params.options.find(
      (option) => option.kind === "allow_always",
    );
    const turnId = session.turnId ?? "";
    const id = `approval_kimi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const request: ApprovalRequest = {
      id,
      sessionId: session.taskId,
      turnId,
      toolName: params.toolCall.name || params.toolCall.title || "runtime.tool",
      args: asRecord(params.toolCall.rawInput),
      riskLevel: params.toolCall.kind === "execute" ? "command" : "file_write",
      createdAt: Date.now(),
      summary: params.toolCall.title ?? undefined,
      origin: "kimi",
      kind:
        params.toolCall.kind === "execute" ? "command" : "runtime_permission",
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
      ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  private onUpdate(
    session: KimiSession,
    notification: SessionNotification,
  ): void {
    const update = notification.update;
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
      const name = update.name || update.title;
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
      session.toolCalls.set(update.toolCallId, { kind, name, command, path });
      session.sink.emit(
        "tool_requested",
        {
          callId: update.toolCallId,
          toolName: update.name || update.title,
          args: asRecord(update.rawInput),
        },
        turnId,
      );
      if (kind === "execute") {
        session.sink.emit(
          "command_execution",
          {
            callId: update.toolCallId,
            command,
            status: "started",
          },
          turnId,
        );
      } else if (isFileToolKind(kind)) {
        session.sink.emit(
          "file_change",
          {
            path: path ?? update.title ?? "unknown",
            status: "proposed",
            diff: toolDiff(rawInput),
          },
          turnId,
        );
      }
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      const tracked = session.toolCalls.get(update.toolCallId);
      const updateName = update.name || update.title || "";
      if (!tracked && updateName.startsWith("mcp__confucius__")) return;
      if (tracked?.kind === "execute") {
        session.sink.emit(
          "command_execution",
          {
            callId: update.toolCallId,
            command: tracked.command || tracked.name,
            status:
              update.status === "completed"
                ? "completed"
                : update.status === "failed"
                  ? "failed"
                  : "started",
            output:
              update.status === "completed" || update.status === "failed"
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
              update.status === "completed"
                ? "applied"
                : update.status === "failed"
                  ? "rejected"
                  : "proposed",
            diff: toolDiff(asRecord(update.rawInput)),
          },
          turnId,
        );
      }
      if (update.status === "completed" || update.status === "failed") {
        const toolName = updateName || "runtime.tool";
        session.sink.emit(
          "tool_result",
          {
            callId: update.toolCallId,
            result:
              update.status === "completed"
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
        session.toolCalls.delete(update.toolCallId);
      } else {
        session.sink.emit(
          "tool_progress",
          {
            callId: update.toolCallId,
            message: update.title || update.status || "running",
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
      const entries =
        "entries" in update && Array.isArray(update.entries)
          ? update.entries
          : [];
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
    if (!session.sessionId) return;
    void session.connection
      .cancel({ sessionId: session.sessionId })
      .catch(() => undefined);
  }
}

function contentText(content: unknown): string {
  const value = asRecord(content);
  return value.type === "text" ? String(value.text ?? "") : "";
}

function isFileToolKind(kind: string): boolean {
  return kind === "edit" || kind === "delete" || kind === "move";
}

function toolPath(
  update: { locations?: unknown },
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
  if (typeof diff === "string" && diff) return diff;
  return undefined;
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
  message: () => string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message())), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const noopSink: RuntimeEventSink = { emit: () => undefined };
const denyApprovals: ApprovalBrokerLike = {
  request: async (request): Promise<ApprovalResolution> => ({
    id: request.id,
    verdict: "deny",
    scope: "once",
  }),
};
