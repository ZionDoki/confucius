import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  codexAccountReady,
  pluginCodexAppServerArgs,
  pluginCodexRuntimeConfig,
  PluginCodexAdapter,
} from "./PluginCodexAdapter";
import { PluginKimiAdapter } from "./PluginKimiAdapter";
import { RuntimeUsageCounter } from "@confucius/protocol";

describe("in-plugin Codex adapter", () => {
  it("delegates only the current Confucius MCP transport consent to host tool policy", async () => {
    const adapter = new PluginCodexAdapter() as unknown as {
      onServerRequest(session: unknown, message: unknown): Promise<void>;
    };
    const answers: unknown[] = [];
    const session = {
      threadId: "thread",
      turnId: "turn",
      hostTurnId: "host",
      rpc: {
        respond: (_id: unknown, result: unknown) => answers.push(result),
        respondError: () => answers.push("stale"),
      },
    };
    const params = {
      threadId: "thread",
      turnId: "turn",
      serverName: "confucius",
      mode: "form",
      _meta: { codex_approval_kind: "mcp_tool_call" },
      requestedSchema: { type: "object", properties: {} },
    };
    for (const override of [
      {},
      { serverName: "other" },
      { threadId: "other" },
      { mode: "url" },
      { _meta: {} },
      {
        requestedSchema: {
          type: "object",
          properties: { password: { type: "string" } },
        },
      },
      { turnId: "old" },
    ]) {
      await adapter.onServerRequest(session, {
        id: 1,
        method: "mcpServer/elicitation/request",
        params: { ...params, ...override },
      });
    }
    assert.deepEqual(answers, [
      { action: "accept", content: {} },
      ...Array.from({ length: 5 }, () => ({ action: "decline" })),
      "stale",
    ]);
  });
  it("binds early provider events to the returned turn and ignores stale nested turn ids", async () => {
    const adapter = new PluginCodexAdapter();
    const internals = adapter as unknown as {
      sessions: Map<string, unknown>;
      onNotification(session: unknown, message: unknown): void;
    };
    const events: Array<{ type: string; turnId?: string }> = [];
    const sink = {
      emit(type: string, _payload: unknown, turnId?: string) {
        events.push({ type, turnId });
      },
    };
    const session = {
      profile: "zotero_only",
      threadId: "provider",
      turnId: "old-provider-turn",
      sink,
      rpc: {
        request: async () => {
          for (const id of [
            "old-provider-turn",
            "new-provider-turn",
            "new-provider-turn",
          ])
            internals.onNotification(session, {
              method: "turn/completed",
              params: {
                threadId: "provider",
                turn: { id, status: "completed" },
              },
            });
          assert.deepEqual(events, []);
          return { turn: { id: "new-provider-turn" } };
        },
      },
    };
    internals.sessions.set("task", session);
    const handle = await adapter.startTurn(
      {
        taskId: "task",
        turnId: "new-host-turn",
        prompt: "test",
        mode: "agent",
        capabilityProfile: "zotero_only",
        cwd: "/tmp",
        mcp: { url: "http://localhost/mcp", token: "token" },
        developerInstructions: "test",
      },
      sink,
      {
        request: async (request) => ({
          id: request.id,
          verdict: "deny",
          scope: "once",
        }),
      },
    );
    assert.equal(handle.externalTurnId, "new-provider-turn");
    assert.deepEqual(
      events.filter((event) => event.type === "turn_completed"),
      [{ type: "turn_completed", turnId: "new-host-turn" }],
    );
  });

  it("normalizes incomplete terminals and deduplicates provider usage before forwarding", () => {
    const adapter = new PluginCodexAdapter() as unknown as {
      onNotification(session: unknown, message: unknown): void;
    };
    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const session = {
      threadId: "provider",
      hostTurnId: "host",
      turnId: "provider-turn",
      usage: new RuntimeUsageCounter(),
      sink: {
        emit(type: string, payload: Record<string, unknown>) {
          events.push({ type, payload });
        },
      },
    };
    const message = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "provider",
        turnId: "provider-turn",
        tokenUsage: {
          total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          last: { inputTokens: 7 },
        },
      },
    };
    adapter.onNotification(session, message);
    adapter.onNotification(session, message);
    adapter.onNotification(session, {
      method: "turn/completed",
      params: { threadId: "provider", turn: { id: "provider-turn" } },
    });
    assert.equal(
      events.filter((event) => event.type === "model_usage_updated").length,
      1,
    );
    assert.equal(
      events.some((event) => event.type === "turn_completed"),
      false,
    );
    assert.equal(
      events.find((event) => event.type === "turn_aborted")?.payload.stopReason,
      "incomplete",
    );
  });

  it("maps ACP completion, limits, refusal and missing markers through the same contract", async () => {
    for (const [stopReason, expected] of [
      ["end_turn", "completed"],
      ["max_tokens", "length"],
      ["max_turn_requests", "iteration_budget"],
      ["refusal", "content_filter"],
      [undefined, "incomplete"],
    ]) {
      const adapter = new PluginKimiAdapter();
      const events: Array<{ type: string; payload: Record<string, unknown> }> =
        [];
      let settle!: () => void;
      const terminal = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const sink = {
        emit(type: string, payload: unknown) {
          events.push({ type, payload: payload as Record<string, unknown> });
          if (["turn_completed", "turn_failed", "turn_aborted"].includes(type))
            settle();
        },
      };
      const sessions = (
        adapter as unknown as { sessions: Map<string, unknown> }
      ).sessions;
      sessions.set("kimi", {
        taskId: "kimi",
        profile: "zotero_only",
        cwd: "/tmp",
        sessionId: "session",
        rpc: {
          request: async () => ({
            stopReason,
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }),
        },
        sink,
        toolCalls: new Map(),
      });
      await adapter.startTurn(
        {
          taskId: "kimi",
          turnId: "turn",
          prompt: "test",
          mode: "agent",
          capabilityProfile: "zotero_only",
          cwd: "/tmp",
          mcp: { url: "http://localhost/mcp", token: "token" },
          developerInstructions: "test",
        },
        sink,
        {
          request: async (request) => ({
            id: request.id,
            verdict: "deny",
            scope: "once",
          }),
        },
      );
      await terminal;
      const stopped = events.find((event) =>
        ["turn_completed", "turn_failed", "turn_aborted"].includes(event.type),
      );
      assert.equal(stopped?.payload.stopReason, expected);
      assert.equal(
        events.filter((event) => event.type === "model_usage_updated").length,
        1,
      );
    }
  });

  it("uses the explicit requiresOpenaiAuth result instead of account presence alone", () => {
    assert.equal(
      codexAccountReady({ account: { email: "user@example.test" } }),
      true,
    );
    assert.equal(
      codexAccountReady({ account: null, requiresOpenaiAuth: false }),
      true,
    );
    assert.equal(
      codexAccountReady({ account: null, requiresOpenaiAuth: true }),
      false,
    );
  });

  it("disables shell and file-capable features in Zotero-only mode", () => {
    const args = pluginCodexAppServerArgs("zotero_only");
    assert.equal(args.includes("shell_tool"), true);
    assert.equal(args.includes("unified_exec"), true);
    assert.equal(args.includes("allow_login_shell=false"), true);

    const config = pluginCodexRuntimeConfig("zotero_only", ["user-server"], {
      url: "http://127.0.0.1:23119/confucius/v1/mcp",
      token: "memory-only-token",
    });
    const servers = config.mcp_servers as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(servers["user-server"], { enabled: false });
    assert.equal(servers.confucius.required, true);
    assert.equal(
      (config.features as Record<string, boolean>).shell_tool,
      false,
    );
  });
});

it("CLI willRetry is progress only; a terminal transient error remains structured and stale errors are ignored", () => {
  const adapter = new PluginCodexAdapter() as unknown as {
    onNotification(session: unknown, message: unknown): void;
  };
  const events: Array<{
    type: string;
    payload: { failure?: { retryable: boolean } };
  }> = [];
  const session = {
    threadId: "provider",
    hostTurnId: "host",
    turnId: "turn",
    sink: {
      emit(type: string, payload: { failure?: { retryable: boolean } }) {
        events.push({ type, payload });
      },
    },
  };
  const params = {
    threadId: "provider",
    turnId: "turn",
    willRetry: true,
    error: {
      message: "stream disconnected",
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
    },
  };
  adapter.onNotification(session, { method: "error", params });
  assert.equal(
    events.some((e) => e.type === "turn_failed"),
    false,
  );
  assert.equal(events.at(-1)?.type, "reasoning_delta");
  adapter.onNotification(session, {
    method: "error",
    params: { ...params, willRetry: false, turnId: "old" },
  });
  assert.equal(events.length, 2);
  adapter.onNotification(session, {
    method: "error",
    params: { ...params, willRetry: false },
  });
  assert.equal(
    events.find((e) => e.type === "turn_failed")?.payload.failure?.retryable,
    true,
  );
});
