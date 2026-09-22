import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { BudgetAccountant, ScriptedModel } from "@confucius/harness";
import { emptyLockedContext } from "@confucius/protocol";
import { SubagentManager } from "../src/modules/host/SubagentManager.ts";
import {
  SubagentResearchTools,
  SubagentToolProvider,
} from "../src/modules/host/SubagentTools.ts";
import {
  executeNativeSubagent,
  executeExternalSubagent,
} from "../src/modules/host/SubagentExecution.ts";
import { memoryJsonStorage } from "../src/modules/host/RuntimeStorage.ts";

const emptyTools = {
  listTools: () => [],
  getMeta: () => null,
  getSchema: () => undefined,
  call: async () => ({
    ok: false,
    toolName: "unknown",
    code: "not_found",
    message: "Unknown",
  }),
};
function fixture(backend = "native", overrides = {}) {
  const sources = emptyLockedContext();
  sources.items = [
    {
      id: "item:1:PAPER",
      libraryID: 1,
      key: "PAPER",
      attachmentKey: "PDF",
      title: "Paper",
      source: "library",
    },
  ];
  const budget = new BudgetAccountant({ maxIterations: 12, maxToolCalls: 20 });
  const task = {
    id: "parent",
    schemaVersion: 4,
    title: "Parent",
    backend,
    runtimeModel: { modelId: "inherited-model", reasoningEffort: "high" },
    lockedContext: sources,
    context: {},
    artifactIds: [],
    createdAt: 1,
    updatedAt: 1,
    mode: "agent",
    permissionMode: "ask",
    status: "running",
    capabilityProfile: "zotero_only",
    run: {
      version: 1,
      id: "run1",
      generation: 1,
      intentRevision: 1,
      request: "Question",
      sources,
      templateVersion: 1,
      requiredArtifactKinds: [],
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      budget: {
        maxIterations: 12,
        maxToolCalls: 20,
        iterationsUsed: 0,
        toolCallsUsed: 0,
        executorStarts: 1,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        modelRequestsObservable: backend === "native",
      },
    },
  };
  const storage = memoryJsonStorage(),
    pending = [],
    events = [];
  let current = true;
  const options = {
    storage,
    parent: () => ({ task, turnId: "turn1", budget }),
    current: () => current,
    sources: async () => sources,
    tools: () => emptyTools,
    execute: (run) =>
      new Promise((resolve) => {
        pending.push({ run, resolve });
        run.abort.signal.addEventListener(
          "abort",
          () => resolve({ text: "late cancelled result" }),
          { once: true },
        );
      }),
    stop: async () => {},
    changed: async (r) => events.push(r),
    charge: async () => {},
    ...overrides,
  };
  const manager = new SubagentManager(options);
  return {
    manager,
    options,
    storage,
    task,
    budget,
    pending,
    events,
    expire: () => {
      current = false;
    },
  };
}
const goal = {
  title: "Compare methods",
  goal: "Compare the assigned methods and cite the evidence",
  sourceIds: ["1:PAPER"],
  background: "Only this explicitly passed evidence",
};
test("three children execute concurrently, remaining work queues, settings and context are isolated", async () => {
  const f = fixture();
  const first = await f.manager.spawn("parent", goal),
    second = await f.manager.spawn("parent", goal),
    third = await f.manager.spawn("parent", goal),
    fourth = await f.manager.spawn("parent", goal);
  await setImmediate();
  assert.equal(f.pending.length, 3);
  assert.equal(
    (await f.manager.read("parent", fourth.id)).record.status,
    "queued",
  );
  assert.equal(f.pending[0].run.task.runtimeModel.modelId, "inherited-model");
  assert.notEqual(
    f.pending[0].run.task.contextWindow.id,
    f.pending[1].run.task.contextWindow.id,
  );
  f.pending[0].run.document.archive.secret = "First child's private context";
  assert.equal(f.pending[1].run.document.archive.secret, undefined);
  f.task.lockedContext.items[0].title = "Later change";
  assert.equal(f.pending[0].run.task.lockedContext.items[0].title, "Paper");
  f.pending[0].resolve({ text: "result one" });
  await setImmediate();
  assert.equal(f.pending.length, 4);
  f.pending[1].resolve({ text: "result two" });
  f.pending[2].resolve({ text: "result three" });
  f.pending[3].resolve({ text: "result four" });
  await f.manager.wait("parent");
  assert.equal(
    (await f.manager.list("parent")).filter((r) => r.status === "completed")
      .length,
    4,
  );
  assert.equal(
    (await f.manager.read("parent", first.id)).record.result,
    "result one",
  );
  assert.equal(
    (await f.manager.read("parent", second.id)).record.background,
    goal.background,
  );
  assert.equal(
    (await f.manager.read("parent", third.id)).record.result,
    "result three",
  );
});
test("parent cancellation stops queued and running work; stale completions cannot publish a result", async () => {
  const f = fixture();
  const a = await f.manager.spawn("parent", goal);
  await f.manager.spawn("parent", goal);
  await f.manager.spawn("parent", goal);
  await f.manager.spawn("parent", goal);
  await setImmediate();
  f.expire();
  await f.manager.cancel("parent");
  await setImmediate();
  const all = await f.manager.list("parent");
  assert.ok(all.every((r) => r.status === "cancelled"));
  assert.equal(f.pending.length, 3);
  assert.equal((await f.manager.read("parent", a.id)).record.result, "");
});

test("deleting a parent removes queued work and prevents late archives from being recreated", async () => {
  const f = fixture();
  const records = [];
  for (let n = 0; n < 4; n++)
    records.push(await f.manager.spawn("parent", goal));
  await setImmediate();
  await f.manager.remove("parent");
  await setImmediate();
  assert.deepEqual(await f.manager.list("parent"), []);
  assert.equal(f.pending.length, 3);
  for (const record of records)
    assert.equal(await f.storage.read(record.id), null);
  await assert.rejects(f.manager.spawn("parent", goal), /deleted/);
});
test("restart retains results and makes unfinished work resumable without refilling budget", async () => {
  const f = fixture();
  const a = await f.manager.spawn("parent", goal);
  await setImmediate();
  f.budget.recordIteration();
  f.budget.recordToolCalls(3);
  const restarted = new SubagentManager(f.options);
  assert.equal((await restarted.list("parent"))[0].status, "interrupted");
  await restarted.retry("parent", a.id);
  await setImmediate();
  assert.equal(f.budget.toolCallsUsed, 3);
  assert.equal(f.budget.iterationsUsed, 1);
  await restarted.cancel("parent");
  await f.manager.cancel("parent");
});
test("child capability is read-only, rejects recursive delegation and out-of-scope evidence", async () => {
  const f = fixture();
  await f.manager.spawn("parent", goal);
  await setImmediate();
  const run = f.pending[0].run;
  let libraryCalls = 0;
  const library = {
    listTools: () =>
      ["get_pages", "add_item_from_identifier", "subagent_spawn"].map(
        (name) => ({
          name,
          inputSchema: {
            type: "object",
            properties: {
              libraryID: { type: "integer" },
              key: { type: "string" },
            },
            required: [],
            additionalProperties: true,
          },
        }),
      ),
    getMeta: (name) => ({
      name,
      mutatesState: name === "get_pages" ? false : true,
    }),
    call: async (name) => {
      libraryCalls++;
      return {
        ok: true,
        toolName: name,
        data: {
          libraryID: 1,
          itemKey: "PAPER",
          attachmentKey: "PDF",
          pages: [{ page: 1, text: "source evidence" }],
        },
      };
    },
  };
  const tools = new SubagentResearchTools(run, library, {});
  assert.equal(
    (await tools.call("subagent_spawn", {})).code,
    "permission_denied",
  );
  assert.equal(
    (await tools.call("add_item_from_identifier", {})).code,
    "permission_denied",
  );
  assert.equal(
    (await tools.call("get_pages", { libraryID: 1, key: "OTHER" })).code,
    "permission_denied",
  );
  const delivered = await tools.call("get_pages", { libraryID: 1, key: "PDF" });
  assert.equal(delivered.ok, true);
  assert.equal(run.document.record.evidence.length, 0);
  await tools.recordDelivered(delivered);
  assert.equal(libraryCalls, 1);
  assert.equal(run.document.record.evidence[0].reader, run.task.id);
  run.document.archive.own = "Private evidence";
  assert.equal(
    (await tools.call("context_read", { ref: "parent" })).code,
    "not_found",
  );
  assert.equal((await tools.call("context_read", { ref: "own" })).ok, true);
  await f.manager.cancel("parent");
});
test("native execution charges the shared parent budget and retains its own archive/checkpoint", async () => {
  const f = fixture("native", {
    execute: (run) =>
      executeNativeSubagent(
        run,
        new ScriptedModel([
          {
            text: "Concise evidence and limitations",
            usage: {
              promptTokens: 100,
              completionTokens: 20,
              totalTokens: 120,
            },
          },
        ]),
      ),
  });
  const a = await f.manager.spawn("parent", goal);
  await f.manager.wait("parent");
  const doc = await f.storage.read(a.id);
  assert.equal(doc.record.status, "completed");
  assert.equal(doc.record.result, "Concise evidence and limitations");
  assert.ok(Object.keys(doc.archive).length);
  assert.ok(doc.checkpoint);
  assert.equal(f.budget.tokensUsed, 120);
  assert.equal(f.budget.iterationsUsed, 1);
});
for (const backend of ["codex", "kimi"])
  test(`${backend} uses the same child tools and isolated external lifecycle`, async () => {
    let seen, disposed;
    const f = fixture(backend, {
      execute: (run) =>
        executeExternalSubagent(run, {
          startTurn: async (input, callbacks) => {
            seen = input;
            callbacks.event({
              sessionId: run.task.id,
              turnId: run.task.run.id,
              type: "text_delta",
              payload: { text: "External result" },
            });
            callbacks.event({
              sessionId: run.task.id,
              turnId: run.task.run.id,
              type: "turn_completed",
              payload: {},
            });
            return {};
          },
          dispose: async (id) => {
            disposed = id;
          },
        }),
    });
    const child = await f.manager.spawn("parent", goal);
    await f.manager.wait("parent");
    assert.equal(seen.mode, "plan");
    assert.equal(seen.capabilityProfile, "zotero_only");
    assert.equal(seen.task.runtimeModel.reasoningEffort, "high");
    assert.equal(disposed, child.id);
    assert.equal(
      (await f.manager.read("parent", child.id)).record.usageObservable,
      false,
    );
    const catalog = new SubagentToolProvider(f.manager, "parent")
      .listTools()
      .map((t) => t.name);
    assert.deepEqual(catalog, [
      "subagent_spawn",
      "subagent_list",
      "subagent_read",
      "subagent_wait",
      "subagent_cancel",
    ]);
  });
test("branch copies completed children only, and archived results are independent", async () => {
  const f = fixture();
  const a = await f.manager.spawn("parent", goal),
    b = await f.manager.spawn("parent", goal);
  await setImmediate();
  f.pending[0].resolve({ text: "Result" });
  await setImmediate();
  await f.manager.branch("parent", "branch", [a.id, b.id]);
  const rows = await f.manager.list("branch");
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, a.id);
  assert.equal(
    (await f.manager.read("branch", rows[0].id)).record.result,
    "Result",
  );
  await f.manager.cancel("parent");
});

test("parent can page child evidence archives without exposing internal model messages", async () => {
  const f = fixture();
  const child = await f.manager.spawn("parent", goal);
  await setImmediate();
  const archive = f.pending[0].run.document.archive;
  archive["tool:receipt"] = "Verified page evidence ".repeat(1000);
  archive["h:internal"] = "Internal model message";
  const page = await f.manager.read("parent", child.id);
  assert.deepEqual(page.archiveRefs, ["tool:receipt"]);
  const receipt = await f.manager.read("parent", child.id, 0, 20, {
    ref: "tool:receipt",
  });
  assert.ok(receipt.passage.content.startsWith("Verified page evidence"));
  assert.ok(receipt.passage.nextOffset > 0);
  await assert.rejects(
    f.manager.read("parent", child.id, 0, 20, { ref: "h:internal" }),
    /public evidence/,
  );
  await assert.rejects(f.manager.read("other", child.id), /another task/);
  await f.manager.cancel("parent");
});

test("native retry resumes its checkpoint and preserves prior archive identifiers and budget", async () => {
  let attempt = 0,
    resumedMessages;
  const f = fixture("native", {
    execute: async (run) => {
      attempt++;
      const result = await executeNativeSubagent(run, {
        complete: async (request) => {
          if (attempt === 2) resumedMessages = request.messages;
          return {
            end: "stop",
            text:
              attempt === 1
                ? "Earlier evidence conclusion"
                : "Recovered conclusion",
          };
        },
      });
      return attempt === 1
        ? { ...result, error: "Interrupted after checkpoint" }
        : result;
    },
  });
  const child = await f.manager.spawn("parent", goal);
  await f.manager.wait("parent");
  const original = await f.storage.read(child.id);
  await f.manager.retry("parent", child.id);
  await f.manager.wait("parent");
  const recovered = await f.storage.read(child.id);
  assert.ok(
    resumedMessages.some((m) =>
      m.content.includes("Earlier evidence conclusion"),
    ),
  );
  for (const [id, value] of Object.entries(original.archive))
    assert.equal(recovered.archive[id], value);
  assert.ok(
    Object.keys(recovered.archive).length >
      Object.keys(original.archive).length,
  );
  assert.equal(f.budget.iterationsUsed, 2);
  assert.equal(recovered.record.result, "Recovered conclusion");
});

test(
  "startup failure releases its slot and resolves wait, including a failed initial save",
  { timeout: 3000 },
  async () => {
    for (const step of ["tools", "charge"]) {
      let failures = 0;
      const f = fixture("native", {
        [step]: () => {
          if (failures++ === 0) throw new Error(`Cannot initialize ${step}`);
          return emptyTools;
        },
      });
      const failed = await f.manager.spawn("parent", goal);
      const outcome = await f.manager.wait("parent", [failed.id]);
      assert.equal(outcome[0].status, "failed");
      assert.match(outcome[0].error, /Cannot initialize/);
      assert.equal(f.manager.run(failed.id), undefined);
      for (let n = 0; n < 3; n++) await f.manager.spawn("parent", goal);
      await setImmediate();
      assert.equal(f.pending.length, 3);
      await f.manager.cancel("parent");
    }
  },
);

test(
  "wait settles only after every selected child, and cancellation wakes a pending wait",
  { timeout: 3000 },
  async () => {
    const f = fixture();
    const a = await f.manager.spawn("parent", goal);
    await f.manager.spawn("parent", goal);
    await setImmediate();
    let finished = false;
    const all = f.manager.wait("parent").then((rows) => {
      finished = true;
      return rows;
    });
    f.pending[0].resolve({ text: "First result" });
    await f.manager.wait("parent", [a.id]);
    assert.equal(finished, false);
    const abort = new globalThis.AbortController();
    const cancelled = assert.rejects(
      f.manager.wait("parent", undefined, abort.signal),
      /cancelled/,
    );
    abort.abort();
    await cancelled;
    await f.manager.cancel("parent");
    assert.deepEqual(
      (await all).map((r) => r.status),
      ["completed", "cancelled"],
    );
    await assert.rejects(f.manager.wait("parent", ["unknown"]), /Unknown/);
  },
);

test(
  "retry rejects late callbacks from the old attempt and keeps public activity complete",
  { timeout: 3000 },
  async () => {
    const f = fixture();
    const child = await f.manager.spawn("parent", goal);
    await setImmediate();
    const previous = f.pending[0].run;
    const event = (id, type, payload) => ({
      id,
      type,
      payload,
      sessionId: child.id,
      turnId: "child-turn",
      ts: Date.now(),
    });
    for (let i = 0; i < 70; i++)
      previous.event(
        event(`tool${i}`, "tool_requested", {
          callId: `call${i}`,
          toolName: "get_pages",
          args: { page: i },
        }),
      );
    previous.event(
      event("model", "model_request_progress", {
        requestId: "model-1",
        attempt: 1,
        status: "started",
      }),
    );
    previous.document.archive["tool:full"] = "Full source content".repeat(5000);
    previous.document.archive["h:private"] = "Internal model context";
    const page = await f.manager.read("parent", child.id, 50, 25);
    assert.equal(page.totalEvents, 71);
    assert.equal(page.events.length, 21);
    assert.equal(page.events.at(-1).id, "model");
    assert.equal(page.nextOffset, null);
    assert.equal(page.record.activity.kind, "model");
    assert.equal(page.record.activity.toolCalls, 70);
    const trace = await f.manager.trace("parent", child.id);
    assert.equal(trace.events.length, 71);
    assert.deepEqual(Object.keys(trace.archive), ["tool:full"]);
    assert.equal(trace.archive["tool:full"].length, 95000);
    await assert.rejects(f.manager.trace("other", child.id), /another task/);
    await f.manager.cancel("parent");
    await setImmediate();
    await f.manager.retry("parent", child.id);
    await setImmediate();
    previous.event(event("late", "text_delta", { text: "Stale result" }));
    f.pending[1].run.event(
      event("new", "text_delta", {
        text: "Current result",
        phase: "final_answer",
      }),
    );
    const current = await f.manager.read("parent", child.id, 70, 25);
    assert.equal(current.record.result, "Current result");
    assert.equal(current.record.attempt, 2);
    assert.equal(current.record.activity.kind, "output");
    assert.equal(current.totalEvents, 72);
    f.pending[1].resolve({ text: "Current result" });
    await f.manager.wait("parent");
  },
);
