import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApprovalResolution, TimelineBlock } from "@confucius/protocol";
import { coalesceTimeline } from "@confucius/protocol";
import { createHarness, session } from "./test-kit";
import { MemoryToolProvider } from "./MemoryToolProvider";
import { assertParallelSafeInvariant } from "./ConcurrencyScheduler";

describe("TurnLoop", () => {
  it("persists a started tool record before executing the provider", async () => {
    const snapshots: Array<{ status?: string }> = [];
    const { loop, events } = createHarness({
      script: [
        {
          toolCalls: [
            { id: "danger", name: "search_items", args: { query: "x" } },
          ],
        },
      ],
      checkpointStore: {
        async save(checkpoint) {
          const status = checkpoint.toolExecutions.at(-1)?.status;
          snapshots.push({ status });
          if (status === "started") throw new Error("checkpoint unavailable");
        },
      },
    });

    const result = await loop.run({
      session: session(),
      turnId: "turn_durable",
      userText: "search",
    });

    assert.equal(result.phase, "failed");
    assert.equal(
      snapshots.some((entry) => entry.status === "started"),
      true,
    );
    assert.equal(
      events.events.some((event) => event.type === "tool_result"),
      false,
    );
  });

  it("checkpoints tool results after a completed call", async () => {
    const statuses: string[][] = [];
    const { loop } = createHarness({
      script: [
        {
          toolCalls: [
            { id: "read", name: "search_items", args: { query: "x" } },
          ],
        },
        { text: "done" },
      ],
      checkpointStore: {
        save(checkpoint) {
          statuses.push(checkpoint.toolExecutions.map((entry) => entry.status));
        },
      },
    });
    await loop.run({
      session: session(),
      turnId: "turn_tool_result",
      userText: "search",
    });
    assert.ok(statuses.some((entries) => entries.includes("started")));
    assert.ok(statuses.some((entries) => entries.includes("completed")));
  });

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
    const toolResult = events.events.find(
      (event) => event.type === "tool_result",
    );
    assert.equal(toolResult?.type, "tool_result");
    if (toolResult?.type === "tool_result") {
      assert.equal(toolResult.payload.result.ok, true);
    }
  });

  it("keeps model-only attachment text out of the visible turn event", async () => {
    const { loop, events } = createHarness({ script: [{ text: "done" }] });
    const result = await loop.run({
      session: session(),
      turnId: "turn_attachment",
      userText: "Summarize this file",
      modelUserText: "Summarize this file\n\nSECRET ATTACHMENT BODY",
    });
    const started = events.events.find(
      (event) => event.type === "turn_started",
    );
    assert.equal(started?.type, "turn_started");
    if (started?.type === "turn_started") {
      assert.equal(started.payload.userText, "Summarize this file");
    }
    assert.equal(
      result.messages.some(
        (message) =>
          message.content === "Summarize this file\n\nSECRET ATTACHMENT BODY",
      ),
      true,
    );
  });

  it("stamps the host summary onto approval requests", async () => {
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
        { text: "Created." },
      ],
      describeCall: (toolName, args) =>
        toolName === "create_collection"
          ? `collection:${String(args.name)}`
          : undefined,
      resolve: (request) => ({
        id: request.id,
        verdict: "allow",
        scope: "once",
      }),
    });

    await loop.run({
      session: session(),
      turnId: "turn_summary",
      userText: "Make a collection named RLHF",
    });

    const approval = events.events.find(
      (event) => event.type === "approval_required",
    );
    assert.equal(approval?.type, "approval_required");
    if (approval?.type === "approval_required") {
      assert.equal(approval.payload.request.summary, "collection:RLHF");
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

    const resultEvent = events.events.find(
      (event) => event.type === "tool_result",
    );
    assert.equal(resultEvent?.type, "tool_result");
    if (resultEvent?.type === "tool_result") {
      assert.equal(resultEvent.payload.result.ok, true);
    }
  });

  it("executes user-edited approval arguments and checkpoints that exact call", async () => {
    const { loop, events, checkpoints } = createHarness({
      script: [
        {
          toolCalls: [
            {
              id: "call_edited",
              name: "search_items",
              args: { query: "before" },
            },
          ],
        },
        { text: "Used the reviewed query." },
      ],
      modeFor: () => "ask",
      resolve: (request) => ({
        id: request.id,
        verdict: "allow",
        scope: "once",
        editedArgs: { query: "after" },
      }),
    });

    const result = await loop.run({
      session: session(),
      turnId: "turn_edited_args",
      userText: "Search after review",
    });

    const toolMessage = result.messages.find(
      (message) => message.role === "tool",
    );
    assert.match(toolMessage?.content ?? "", /hit:after/);
    const latest = checkpoints.latest("turn_edited_args");
    assert.deepEqual(latest?.toolExecutions[0]?.args, { query: "after" });
    assert.equal(
      events.events.some(
        (event) =>
          event.type === "approval_resolved" &&
          event.payload.resolution.editedArgs?.query === "after",
      ),
      true,
    );
  });

  it("publishes approval_required before waiting for an interactive decision", async () => {
    let releaseApproval: ((resolution: ApprovalResolution) => void) | undefined;
    let requestId = "";
    const { loop, events } = createHarness({
      script: [
        {
          toolCalls: [
            {
              id: "call_pending_create",
              name: "create_collection",
              args: { name: "Needs approval" },
            },
          ],
        },
        { text: "Created after approval." },
      ],
      resolve: (request) => {
        requestId = request.id;
        return new Promise<ApprovalResolution>((resolve) => {
          releaseApproval = resolve;
        });
      },
    });

    const running = loop.run({
      session: session(),
      turnId: "turn_pending_approval",
      userText: "Create a collection after I approve it",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(events.types(), [
      "turn_started",
      "tool_requested",
      "approval_required",
    ]);
    assert.ok(releaseApproval, "approval resolver should be waiting");
    assert.equal(
      events.events.some((event) => event.type === "tool_result"),
      false,
    );

    releaseApproval({
      id: requestId,
      verdict: "allow",
      scope: "once",
    });
    const result = await running;

    assert.equal(result.phase, "done");
    assert.ok(events.types().includes("approval_resolved"));
    assert.ok(events.types().includes("tool_result"));
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
    const requested = events
      .types()
      .filter((type) => type === "tool_requested");
    assert.equal(requested.length, 2);
    assert.equal(events.types().at(-1), "turn_completed");
  });

  it("rejects invalid tool arguments without calling the tool", async () => {
    const { loop, events } = createHarness({
      script: [
        {
          toolCalls: [{ id: "bad", name: "search_items", args: {} }],
        },
        { text: "Need a query." },
      ],
    });

    await loop.run({
      session: session(),
      turnId: "turn_5",
      userText: "search",
    });

    const resultEvent = events.events.find(
      (event) => event.type === "tool_result",
    );
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

  it("treats a cross-compartment AbortError as aborted", async () => {
    const { loop, events } = createHarness({
      model: {
        complete: () => Promise.reject({ name: "AbortError" }),
      },
    });
    const result = await loop.run({
      session: session(),
      turnId: "turn_abort_shape",
      userText: "hi",
    });
    assert.equal(result.phase, "aborted");
    assert.equal(
      events.events.some((event) => event.type === "turn_aborted"),
      true,
    );
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

  it("keeps tool events independent when the model restarts call ids", async () => {
    // Ollama-style backends emit call_1, call_2, then restart at call_1 on
    // the next model round. Colliding event ids would merge fold state and
    // attach later results to the first timeline tool block.
    const { loop, events } = createHarness({
      script: [
        {
          toolCalls: [
            { id: "call_1", name: "search_items", args: { query: "alpha" } },
          ],
        },
        {
          toolCalls: [
            { id: "call_1", name: "search_items", args: { query: "beta" } },
          ],
        },
        { text: "searched twice" },
      ],
    });

    const result = await loop.run({
      session: session(),
      turnId: "turn_restarted_ids",
      userText: "search twice",
    });

    assert.equal(result.phase, "done");
    const requested = events.events.filter(
      (event) => event.type === "tool_requested",
    );
    const toolResults = events.events.filter(
      (event) => event.type === "tool_result",
    );
    const callId = (event: (typeof events.events)[number]) =>
      event.type === "tool_requested" || event.type === "tool_result"
        ? event.payload.callId
        : "";
    assert.equal(requested.length, 2);
    assert.equal(toolResults.length, 2);
    assert.notEqual(callId(requested[0]), callId(requested[1]));
    assert.equal(callId(requested[0]), callId(toolResults[0]));
    assert.equal(callId(requested[1]), callId(toolResults[1]));

    // Model-facing message pairing keeps the original (repeated) ids.
    const toolMessages = result.messages.filter(
      (message) => message.role === "tool",
    );
    assert.equal(toolMessages.length, 2);
    assert.equal(toolMessages[0].toolCallId, "call_1");
    assert.equal(toolMessages[1].toolCallId, "call_1");

    // The timeline folds both rounds into one block but keeps results apart.
    const blocks = coalesceTimeline(events.events);
    const toolsBlocks = blocks.filter(
      (block) => block.kind === "tools",
    ) as Extract<TimelineBlock, { kind: "tools" }>[];
    assert.equal(toolsBlocks.length, 1);
    const calls = toolsBlocks[0].calls;
    assert.equal(calls.length, 2);
    assert.ok(calls[0].result?.ok);
    assert.ok(calls[1].result?.ok);
    assert.deepEqual(
      calls[0].result && calls[0].result.ok ? calls[0].result.data : null,
      { items: [{ title: "hit:alpha" }] },
    );
    assert.deepEqual(
      calls[1].result && calls[1].result.ok ? calls[1].result.data : null,
      { items: [{ title: "hit:beta" }] },
    );
  });
});
