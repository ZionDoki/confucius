import assert from "node:assert/strict";
import { test } from "node:test";
import { initialContextWindow } from "@confucius/protocol";
import { WindowContext, estimateRequestTokens } from "./WindowContext";
import { createHarness, session } from "./test-kit";
import type { ModelRequest, ModelMessage } from "./ModelAdapter";
import { SourceReadIndex } from "./SourceReadIndex";

test("rollover carries source locations and exact archive IDs without copying page text, including restart", async () => {
  const c = context();
  let round = 0;
  const requests: ModelRequest[] = [];
  const h = createHarness({
    context: c.manager,
    model: {
      async complete(request) {
        requests.push(structuredClone(request));
        if (round++ === 0) {
          c.manager.request();
          return { toolCalls: [{ id: "pages", name: "get_pages", args: {} }] };
        }
        return { text: "done" };
      },
    },
  });
  h.tools.register(
    {
      name: "get_pages",
      description: "Read source",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_pages",
      catalog: "library.read",
      mutatesState: false,
      concurrency: "parallel_safe",
    },
    () => ({
      libraryID: 1,
      key: "PAPER",
      attachmentKey: "PDF",
      pages: [
        {
          page: 4,
          pageLabel: "ii",
          text: "ORIGINAL_PASSAGE_DO_NOT_COPY",
          zoteroUri: "zotero://open-pdf/library/items/PDF?page=4",
          truncated: false,
        },
      ],
      nextPage: null,
    }),
  );
  await h.loop.run({
    session: session(),
    turnId: "turn",
    userText: "Continue this review",
  });
  const fresh = JSON.stringify(requests[1]);
  assert.match(fresh, /Archived source index/);
  assert.match(fresh, /PDF\?page=4/);
  assert.doesNotMatch(fresh, /ORIGINAL_PASSAGE_DO_NOT_COPY/);
  const snapshot = h.checkpoints.latest("turn")!;
  assert.equal(snapshot.sourceReads?.length, 1);
  const ref = snapshot.sourceReads![0];
  assert(
    c.archived.some(
      (a) =>
        a.message.toolCallId &&
        a.message.content.includes("ORIGINAL_PASSAGE_DO_NOT_COPY"),
    ),
  );
  assert.match(ref.history.itemId, /^tool_turn_/);
  const restored = context();
  restored.manager.start(
    {
      session: session(),
      turnId: "turn",
      userText: "Continue",
      resume: snapshot,
    },
    [],
  );
  assert.deepEqual(restored.manager.sourceReadSnapshot(), snapshot.sourceReads);
  const index = new SourceReadIndex(snapshot.sourceReads);
  index.record(
    JSON.stringify({
      ok: false,
      toolName: "get_pages",
      data: { libraryID: 1, key: "PAPER", pages: [{ page: 7 }] },
    }),
    ref.history,
  );
  assert.equal(index.snapshot().length, 1);
  assert.equal(index.hint(1), "");
});

function context(failSwitch = false) {
  const archived: Array<{ message: ModelMessage; windowId: string }> = [];
  let id = 0,
    switches = 0;
  const manager = new WindowContext({
    window: initialContextWindow("task", "native"),
    contextWindowTokens: 16000,
    maxOutputTokens: 2000,
    nextId: () => `ctx_${++id}`,
    archive: async (input) => {
      archived.push(input);
      return { taskId: "task", windowId: input.windowId, itemId: input.id };
    },
    switchWindow: async () => {
      if (failSwitch) throw new Error("disk full");
      switches++;
    },
    hint: async () => "Read progress note; early evidence is in history.",
  });
  return { manager, archived, switches: () => switches };
}
test("image capacity is reserved separately from its Base64 transport size", () => {
  const request = (data: string): ModelRequest => ({
    messages: [
      {
        role: "user",
        content: "Inspect this page",
        images: [{ mimeType: "image/png", data }],
      },
    ],
  });
  const small = estimateRequestTokens(request("AAAA"));
  const large = estimateRequestTokens(request("AAAA".repeat(300000)));
  assert.equal(small, large);
  assert.ok(large > 8192 && large < 9000);
  assert.ok(
    estimateRequestTokens({
      messages: [{ role: "user", content: "AAAA".repeat(300000) }],
    }) > large,
  );
});
test("multiple model-requested windows keep the task, instructions and budgets", async () => {
  const c = context();
  const requests: ModelRequest[] = [];
  let count = 0;
  const h = createHarness({
    context: c.manager,
    maxIterations: 5,
    model: {
      async complete(request) {
        requests.push(structuredClone(request));
        count++;
        if (count < 4) {
          c.manager.request();
          return {
            toolCalls: [
              {
                id: `call_${count}`,
                name: "search_items",
                args: { query: `paper_${count}` },
              },
            ],
          };
        }
        return { text: "Finished with original evidence" };
      },
    },
  });
  const result = await h.loop.run({
    session: session(),
    turnId: "turn",
    userText: "Verify paper A; do not change its annotations.",
  });
  assert.equal(result.phase, "done");
  assert.equal(c.switches(), 3);
  assert.equal(h.budget.iterationsUsed, 4);
  assert.equal(h.budget.toolCallsUsed, 3);
  for (const request of requests)
    assert.ok(
      request.messages.some((m) =>
        m.content.includes("do not change its annotations"),
      ),
    );
  assert.ok(
    c.archived.some((entry) => entry.message.content.includes("paper_1")),
  );
  assert.equal(
    requests[1].messages.some((m) => m.content.includes("hit:paper_1")),
    false,
  );
});
test("complete tool results are archived before model truncation and automatic rollover", async () => {
  const c = context();
  let step = 0;
  const h = createHarness({
    context: c.manager,
    model: {
      async complete() {
        return step++ === 0
          ? {
              toolCalls: [
                {
                  id: "large",
                  name: "search_items",
                  args: { query: "x".repeat(50000) },
                },
              ],
            }
          : { text: "done" };
      },
    },
  });
  const result = await h.loop.run({
    session: session(),
    turnId: "turn",
    userText: "Read evidence",
  });
  assert.equal(result.phase, "done");
  assert.ok(
    c.archived.some(
      (entry) =>
        entry.message.role === "tool" && entry.message.content.length > 50000,
    ),
  );
  assert.equal(c.switches(), 1);
});
test("failed rollover keeps the old window and does not execute another request", async () => {
  const c = context(true);
  let calls = 0;
  const h = createHarness({
    context: c.manager,
    model: {
      async complete() {
        calls++;
        c.manager.request();
        return {
          toolCalls: [
            { id: "read", name: "search_items", args: { query: "paper" } },
          ],
        };
      },
    },
  });
  const result = await h.loop.run({
    session: session(),
    turnId: "turn",
    userText: "Read",
  });
  assert.equal(result.phase, "failed");
  assert.match(result.failureMessage!, /disk full/);
  assert.equal(calls, 1);
  assert.equal(c.manager.window.number, 1);
  assert.ok(result.messages.some((m) => m.role === "tool"));
});
test("stopping during approval never switches windows or repeats the write", async () => {
  const c = context();
  const controller = new AbortController();
  const h = createHarness({
    context: c.manager,
    script: [
      {
        toolCalls: [
          { id: "write", name: "create_collection", args: { name: "A" } },
        ],
      },
    ],
    resolve: (request) => {
      c.manager.request();
      controller.abort();
      return { id: request.id, verdict: "deny", scope: "once" };
    },
  });
  const result = await h.loop.run({
    session: session(),
    turnId: "turn",
    userText: "Prepare a collection",
    signal: controller.signal,
  });
  assert.equal(result.phase, "aborted");
  assert.equal(c.switches(), 0);
  assert.equal(
    h.events.events.some(
      (e) => e.type === "tool_result" && e.payload.result.ok,
    ),
    false,
  );
});

test("a write that fails after changing state is left unresolved and never retried", async () => {
  const c = context();
  let writes = 0,
    requests = 0;
  const h = createHarness({
    context: c.manager,
    modeFor: () => "auto_allow",
    model: {
      async complete() {
        requests++;
        return {
          toolCalls: [
            {
              id: "commit",
              name: "create_collection",
              args: { name: "one collection" },
            },
          ],
        };
      },
    },
  });
  h.tools.call = async (name) => {
    writes++;
    return {
      ok: false,
      toolName: name,
      code: "internal",
      message: "connection closed after commit",
    };
  };
  const result = await h.loop.run({
    session: session(),
    turnId: "unknown",
    userText: "Create one collection",
  });
  assert.equal(result.phase, "failed");
  assert.equal(writes, 1);
  assert.equal(requests, 1);
  assert.equal(
    h.checkpoints.latest("unknown")?.toolExecutions[0].status,
    "started",
  );
  assert.equal(c.switches(), 0);
  assert.ok(
    c.archived.some((entry) =>
      entry.message.content.includes("connection closed after commit"),
    ),
  );
});

test("resume preserves the spent budget and reuses a completed write after a restart", async () => {
  const controller = new AbortController();
  let step = 0;
  const first = createHarness({
    context: context().manager,
    modeFor: () => "auto_allow",
    model: {
      async complete() {
        if (step++ === 0)
          return {
            toolCalls: [
              {
                id: "committed",
                name: "create_collection",
                args: { name: "Only once" },
              },
            ],
          };
        controller.abort();
        // Some HTTP transports report an ordinary network error on cancellation.
        throw new Error("HTTP request failed");
      },
    },
  });
  const interrupted = await first.loop.run({
    session: session(),
    turnId: "original",
    userText: "Create one collection; keep the original evidence.",
    signal: controller.signal,
  });
  assert.equal(interrupted.phase, "aborted");
  const checkpoint = JSON.parse(
    JSON.stringify(first.checkpoints.latest("original")),
  );
  assert.equal(checkpoint.iteration, 2);
  assert.equal(checkpoint.toolCallsUsed, 1);
  const resumed = createHarness({
    context: context().manager,
    maxIterations: 5,
    maxToolCalls: 1,
    modeFor: () => "auto_allow",
    script: [
      {
        toolCalls: [
          {
            id: "committed",
            name: "create_collection",
            args: { name: "Only once" },
          },
        ],
      },
      { text: "Completed from recorded evidence" },
    ],
  });
  let repeatedWrites = 0;
  resumed.tools.call = async () => {
    repeatedWrites++;
    throw new Error("Must not repeat this write");
  };
  const result = await resumed.loop.run({
    session: session(),
    turnId: "continued",
    userText: "Continue the original task",
    resume: checkpoint,
  });
  assert.equal(result.phase, "done");
  assert.equal(repeatedWrites, 0);
  assert.equal(resumed.budget.iterationsUsed, 4);
  assert.equal(resumed.budget.toolCallsUsed, 1);
  assert.equal(
    resumed.checkpoints.latest("continued")?.toolExecutions.length,
    1,
  );
  assert.equal(
    resumed.checkpoints.latest("continued")?.toolExecutions[0].callId,
    checkpoint.toolExecutions[0].callId,
  );
});

test("oversized base input fails once instead of cycling through windows", async () => {
  const c = context();
  let requests = 0;
  const h = createHarness({
    context: c.manager,
    model: {
      async complete() {
        requests++;
        return { text: "unexpected" };
      },
    },
  });
  const result = await h.loop.run({
    session: session(),
    turnId: "oversize",
    userText: "很长的原始指令".repeat(6000),
  });
  assert.equal(result.phase, "failed");
  assert.match(result.failureMessage!, /exceed/);
  assert.equal(requests, 0);
  assert.equal(c.switches(), 0);
});
