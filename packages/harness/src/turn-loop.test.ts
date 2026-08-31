import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness, session } from "./test-kit";
import { MemoryToolProvider } from "./MemoryToolProvider";
import { assertParallelSafeInvariant } from "./ConcurrencyScheduler";

describe("TurnLoop", () => {
  it("runs a read-only search then delivers text", async () => {
    const { loop, events, checkpoints } = createHarness({
      script: [
        {
          toolCalls: [
            {
              id: "call_search",
              name: "search_items",
              args: { query: "transformers" },
            },
          ],
        },
        { text: "Found one matching paper." },
      ],
    });

    const result = await loop.run({
      session: session(),
      turnId: "turn_1",
      userText: "Find transformer papers",
    });

    assert.equal(result.phase, "done");
    assert.equal(result.text, "Found one matching paper.");
    assert.deepEqual(events.types(), [
      "turn_started",
      "tool_requested",
      "tool_result",
      "text_delta",
      "turn_completed",
    ]);
    assert.ok(checkpoints.count("turn_1") >= 2);
    const toolResult = events.events.find((event) => event.type === "tool_result");
    assert.equal(toolResult?.type, "tool_result");
    if (toolResult?.type === "tool_result") {
      assert.equal(toolResult.payload.result.ok, true);
    }
  });

  it("asks before a write and records structured deny", async () => {
    const { loop, events } = createHarness({
      script: [
        {
          toolCalls: [
            {
              id: "call_create",
              name: "create_collection",
              args: { name: "RLHF" },
            },
          ],
        },
        { text: "Collection was not created." },
      ],
      resolve: () => ({
        id: "ignored",
        verdict: "deny",
        scope: "once",
      }),
    });

    const result = await loop.run({
      session: session(),
      turnId: "turn_2",
      userText: "Make a collection named RLHF",
    });

    assert.equal(result.phase, "done");
    assert.ok(events.types().includes("approval_required"));
    assert.ok(events.types().includes("approval_resolved"));
    const denied = events.events.find((event) => event.type === "tool_result");
    assert.equal(denied?.type, "tool_result");
    if (denied?.type === "tool_result") {
      assert.equal(denied.payload.result.ok, false);
      if (!denied.payload.result.ok) {
        assert.equal(denied.payload.result.code, "permission_denied");
      }
    }
  });

  it("commits a write after approval", async () => {
    const { loop, events } = createHarness({
      script: [
        {
          toolCalls: [
            {
              id: "call_create",
              name: "create_collection",
              args: { name: "RLHF" },
            },
          ],
        },
        { text: "Created the collection." },
      ],
      resolve: (request) => ({
        id: request.id,
        verdict: "allow",
        scope: "once",
      }),
    });

    await loop.run({
      session: session(),
      turnId: "turn_3",
      userText: "Make a collection named RLHF",
    });

    const resultEvent = events.events.find((event) => event.type === "tool_result");
    assert.equal(resultEvent?.type, "tool_result");
    if (resultEvent?.type === "tool_result") {
      assert.equal(resultEvent.payload.result.ok, true);
    }
  });

  it("stops when the iteration budget is exhausted", async () => {
    const { loop, events, budget } = createHarness({
      maxIterations: 2,
      maxToolCalls: 10,
      script: [
        {
          toolCalls: [
            {
              id: "c1",
              name: "search_items",
              args: { query: "a" },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "c2",
              name: "search_items",
              args: { query: "b" },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "c3",
              name: "search_items",
              args: { query: "c" },
            },
          ],
        },
      ],
    });

    const result = await loop.run({
      session: session(),
      turnId: "turn_4",
      userText: "Keep searching",
    });

    assert.equal(result.phase, "done");
    assert.equal(budget.iterationsUsed, 2);
    const requested = events.types().filter((type) => type === "tool_requested");
    assert.equal(requested.length, 2);
    assert.equal(events.types().at(-1), "turn_completed");
  });

  it("rejects invalid tool arguments without calling the tool", async () => {
    const { loop, events } = createHarness({
      script: [
        {
          toolCalls: [
            { id: "bad", name: "search_items", args: {} },
          ],
        },
        { text: "Need a query." },
      ],
    });

    await loop.run({
      session: session(),
      turnId: "turn_5",
      userText: "search",
    });

    const resultEvent = events.events.find((event) => event.type === "tool_result");
    assert.equal(resultEvent?.type, "tool_result");
    if (resultEvent?.type === "tool_result" && !resultEvent.payload.result.ok) {
      assert.equal(resultEvent.payload.result.code, "invalid_args");
    }
  });

  it("aborts mid-turn when the signal fires", async () => {
    const { loop } = createHarness({
      script: [{ text: "hello" }],
    });
    const controller = new AbortController();
    controller.abort();
    const result = await loop.run({
      session: session(),
      turnId: "turn_6",
      userText: "hi",
      signal: controller.signal,
    });
    assert.equal(result.phase, "aborted");
  });
});

describe("tool invariants", () => {
  it("forbids parallel_safe writes", () => {
    assert.throws(() => {
      assertParallelSafeInvariant({
        name: "create_collection",
        catalog: "library.write",
        concurrency: "parallel_safe",
        mutatesState: true,
      });
    });
  });

  it("refuses to register a parallel_safe mutating tool", () => {
    const tools = new MemoryToolProvider();
    assert.throws(() => {
      tools.register(
        {
          name: "create_collection",
          description: "x",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "create_collection",
          catalog: "library.write",
          concurrency: "parallel_safe",
          mutatesState: true,
        },
        () => ({}),
      );
    });
  });
});
