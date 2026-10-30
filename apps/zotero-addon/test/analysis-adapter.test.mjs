import assert from "node:assert/strict";
import { test } from "node:test";
const { AbortController } = globalThis;

test("external analysis forwards cancellation to its own isolated request", async () => {
  const { ExternalBackend } =
    await import("../src/modules/host/AgentBackend.ts");
  const controller = new AbortController(),
    calls = [];
  const backend = new ExternalBackend("codex", {
    rpc: async (method, params) => {
      calls.push({ method, params });
      if (method === "runtime/analyze") return new Promise(() => {});
      return { ok: true };
    },
  });
  const pending = backend.analyze(
    "edit",
    { modelId: "selected", reasoningEffort: "high" },
    { preserveSettings: true, timeoutMs: 5000 },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["runtime/analyze", "runtime/cancelAnalysis"],
  );
  assert.equal(calls[0].params.analysisId, calls[1].params.analysisId);
});

test("plugin Codex revision preserves effort and uses an ephemeral session", async () => {
  const { PluginCodexAdapter } =
    await import("../src/modules/host/PluginCodexAdapter.ts");
  const adapter = new PluginCodexAdapter();
  const calls = [];
  let notify,
    closed = 0;
  adapter.configuredMcpServers = async () => [];
  adapter.openRpc = async () => ({
    onNotification: (fn) => {
      notify = fn;
    },
    onFailure: () => {},
    close: () => {},
    closeAndWait: async () => {
      closed++;
    },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "model/list")
        return {
          data: [
            {
              model: "chosen",
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
              ],
            },
          ],
        };
      if (method === "thread/start") return { thread: { id: "isolated" } };
      if (method === "turn/start")
        notify({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
      return {};
    },
  });
  await adapter.analyze(
    "edit",
    "/tmp",
    { modelId: "chosen", reasoningEffort: "high" },
    { preserveSettings: true },
  );
  assert.equal(
    calls.find((c) => c.method === "thread/start").params.ephemeral,
    true,
  );
  for (const c of calls.filter((c) =>
    ["thread/start", "turn/start"].includes(c.method),
  ))
    assert.equal(c.params.effort, "high");
  assert.equal(closed, 1);
});

test("plugin Kimi revision preserves its advertised thinking setting", async () => {
  const { PluginKimiAdapter } =
    await import("../src/modules/host/PluginKimiAdapter.ts");
  const adapter = new PluginKimiAdapter();
  const calls = [];
  let closed = 0;
  const config = {
    sessionId: "isolated",
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "chosen",
        options: [{ value: "chosen", name: "chosen" }],
      },
      {
        id: "thinking",
        category: "thought_level",
        currentValue: "low",
        options: [
          { value: "low", name: "low" },
          { value: "high", name: "high" },
        ],
      },
    ],
  };
  adapter.openConnection = async () => ({
    rpc: {
      close: () => {},
      closeAndWait: async () => {
        closed++;
      },
      request: async (method, params) => {
        calls.push({ method, params });
        return method === "session/prompt"
          ? { stopReason: "end_turn" }
          : config;
      },
    },
  });
  await adapter.analyze(
    "edit",
    "/tmp",
    { modelId: "chosen", reasoningEffort: "high" },
    { preserveSettings: true },
  );
  const efforts = calls.filter(
    (c) =>
      c.method === "session/set_config_option" &&
      c.params.configId === "thinking",
  );
  assert.ok(efforts.length > 0);
  assert.ok(efforts.every((c) => c.params.value === "high"));
  assert.equal(calls.filter((c) => c.method === "session/new").length, 1);
  assert.equal(closed, 1);
});
