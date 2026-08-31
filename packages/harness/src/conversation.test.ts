import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactHistory,
  estimateChars,
  needsCompaction,
} from "./ConversationMemory";
import { OpenAICompatibleAdapter } from "./OpenAICompatibleAdapter";
import { ScriptedModel, type ModelMessage } from "./ModelAdapter";
import { PermissionGate } from "./PermissionGate";
import { validateArgs } from "./SchemaValidate";
import { TurnLoop } from "./TurnLoop";
import { createHarness, session } from "./test-kit";
import type { ModelTurn } from "./ModelAdapter";

function sseResponse(chunks: object[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OpenAICompatibleAdapter streaming", () => {
  it("accumulates text, reasoning, tool calls, and usage from SSE chunks", async () => {
    const textDeltas: string[] = [];
    const reasoningDeltas: string[] = [];
    let usageSeen: unknown = null;
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test/v1",
      model: "demo",
      stream: true,
      onTextDelta: (text) => textDeltas.push(text),
      onReasoningDelta: (text) => reasoningDeltas.push(text),
      onUsage: (usage) => {
        usageSeen = usage;
      },
      fetchImpl: (async () =>
        sseResponse([
          {
            choices: [
              { delta: { reasoning_content: "thinking " } },
            ],
          },
          {
            choices: [
              { delta: { reasoning_content: "hard" } },
            ],
          },
          { choices: [{ delta: { content: "Hello " } }] },
          { choices: [{ delta: { content: "world" } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c1",
                      function: { name: "search_items", arguments: '{"qu' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: 'ery":"x"}' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{}],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ])) as unknown as typeof fetch,
    });
    const turn = await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(turn.text, "Hello world");
    assert.equal(turn.reasoning, "thinking hard");
    assert.deepEqual(textDeltas, ["Hello ", "world"]);
    assert.deepEqual(reasoningDeltas, ["thinking ", "hard"]);
    assert.equal(turn.toolCalls?.[0]?.name, "search_items");
    assert.deepEqual(turn.toolCalls?.[0]?.args, { query: "x" });
    assert.deepEqual(usageSeen, {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it("retries a 429 once and then succeeds", async () => {
    let calls = 0;
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test/v1",
      model: "demo",
      stream: false,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate limited", { status: 429 });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const turn = await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(turn.text, "ok");
    assert.equal(calls, 2);
  });
});

describe("validateArgs types", () => {
  const schema = {
    type: "object" as const,
    properties: {
      query: { type: "string" },
      limit: { type: "integer" },
      field: { type: "string", enum: ["title", "creator"] },
      tags: { type: "array" },
    },
    required: ["query"],
  };

  it("rejects a wrong primitive type", () => {
    const failure = validateArgs("search_items", schema, {
      query: 42,
    });
    assert.equal(failure?.ok, false);
    assert.equal(failure?.code, "invalid_args");
  });

  it("rejects values outside an enum", () => {
    const failure = validateArgs("search_items", schema, {
      query: "x",
      field: "bogus",
    });
    assert.match(failure?.message ?? "", /field/);
  });

  it("accepts integer-like strings for integer fields", () => {
    const failure = validateArgs("search_items", schema, {
      query: "x",
      limit: "5",
    });
    assert.equal(failure, null);
  });

  it("rejects a non-array where an array is declared", () => {
    const failure = validateArgs("search_items", schema, {
      query: "x",
      tags: "ml",
    });
    assert.equal(failure?.ok, false);
  });
});

describe("conversation history", () => {
  function makeLoop(model: {
    complete: (
      request: Parameters<ScriptedModel["complete"]>[0],
      signal?: AbortSignal,
    ) => Promise<ModelTurn>;
  }): TurnLoop {
    const harness = createHarness({ script: [{ text: "" }] });
    return new TurnLoop({
      model,
      tools: harness.tools,
      permissions: new PermissionGate({
        ids: harness.ids,
        now: harness.now,
        modeFor: () => "auto_allow",
        riskFor: () => "read",
      }),
      budget: harness.budget,
      events: harness.events,
      checkpoints: harness.checkpoints,
      ids: harness.ids,
      now: harness.now,
    });
  }

  it("replays history before the new user message", async () => {
    const requestsSeen: ModelMessage[][] = [];
    const script = new ScriptedModel([{ text: "second answer" }]);
    const loop = makeLoop({
      complete: (request, signal) => {
        requestsSeen.push([...request.messages]);
        return script.complete(request, signal);
      },
    });
    const result = await loop.run({
      session: session("s1"),
      turnId: "t2",
      userText: "and now?",
      history: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
    });
    assert.deepEqual(
      requestsSeen[0].map((message) => message.role),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(result.messages[0].content, "first question");
    assert.equal(result.messages.at(-1)?.role, "assistant");
  });

  it("returns failed turns' partial conversation for persistence", async () => {
    const loop = makeLoop({
      complete: () => {
        throw new Error("model down");
      },
    });
    const result = await loop.run({
      session: session("s1"),
      turnId: "t1",
      userText: "hello",
    });
    assert.equal(result.phase, "failed");
    assert.deepEqual(
      result.messages.map((message) => message.role),
      ["user"],
    );
  });
});

describe("compactHistory", () => {
  it("summarizes the old prefix and keeps the tail verbatim", async () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "user", content: `question ${i} `.repeat(40) });
      messages.push({ role: "assistant", content: `answer ${i} `.repeat(40) });
    }
    assert.equal(needsCompaction(messages, 4_000), true);
    const model = new ScriptedModel([{ text: "SUMMARY." }]);
    const result = await compactHistory(model, messages, 4_000);
    assert.equal(result.compacted, true);
    assert.ok(result.messages[0].content.includes("SUMMARY."));
    assert.ok(
      result.messages
        .at(-1)
        ?.content.includes("answer 29"),
    );
    assert.equal(needsCompaction(result.messages, 4_000), false);
  });

  it("leaves short histories untouched", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = await compactHistory(
      new ScriptedModel([]),
      messages,
      10_000,
    );
    assert.equal(result.compacted, false);
    assert.equal(result.messages.length, 2);
  });

  it("estimates chars from content and tool args", () => {
    const chars = estimateChars([
      {
        role: "assistant",
        content: "12345",
        toolCalls: [{ id: "c1", name: "t", args: { a: "12345" } }],
      },
    ]);
    assert.ok(chars >= 15);
  });
});
