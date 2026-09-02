import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectApiStyle,
  OpenAICompatibleAdapter,
} from "./OpenAICompatibleAdapter";

function ndjsonResponse(chunks: object[]): Response {
  const body = chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n";
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

describe("detectApiStyle", () => {
  it("detects Ollama native /api/chat URLs", () => {
    assert.equal(
      detectApiStyle("http://172.30.111.252:54321/api/chat"),
      "ollama",
    );
    assert.equal(detectApiStyle("http://host:11434/api/chat/"), "ollama");
    assert.equal(detectApiStyle("http://host:11434/v1"), "openai");
    assert.equal(detectApiStyle("https://api.openai.com/v1"), "openai");
  });
});

describe("OpenAICompatibleAdapter ollama native style", () => {
  const nativeUrl = "http://172.30.111.252:54321/api/chat";

  it("parses non-streaming replies with thinking and object tool args", async () => {
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "ollama",
      baseUrl: nativeUrl,
      model: "qwen3.8-27b:latest",
      stream: false,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(sent.stream, false);
        assert.equal(
          (sent.messages as Array<{ role: string }>)[0]?.role,
          "user",
        );
        return new Response(
          JSON.stringify({
            model: "qwen3.8-27b:latest",
            message: {
              role: "assistant",
              content: "Searching now.",
              thinking: "user wants a search",
              tool_calls: [
                {
                  function: {
                    name: "search_items",
                    arguments: { query: "transformer" },
                  },
                },
              ],
            },
            done: true,
            prompt_eval_count: 12,
            eval_count: 8,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    const turn = await adapter.complete({
      messages: [{ role: "user", content: "find papers" }],
    });
    assert.equal(turn.text, "Searching now.");
    assert.equal(turn.reasoning, "user wants a search");
    assert.equal(turn.toolCalls?.[0]?.name, "search_items");
    assert.deepEqual(turn.toolCalls?.[0]?.args, { query: "transformer" });
    assert.deepEqual(turn.usage, {
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
    });
  });

  it("streams NDJSON chunks with incremental content, thinking, and tool calls", async () => {
    const textDeltas: string[] = [];
    const reasoningDeltas: string[] = [];
    let usage: unknown;
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "ollama",
      baseUrl: nativeUrl,
      model: "qwen3.8-27b:latest",
      stream: true,
      onTextDelta: (piece) => textDeltas.push(piece),
      onReasoningDelta: (piece) => reasoningDeltas.push(piece),
      onUsage: (value) => {
        usage = value;
      },
      fetchImpl: (async () =>
        ndjsonResponse([
          { message: { role: "assistant", thinking: "plan " }, done: false },
          { message: { role: "assistant", thinking: "it" }, done: false },
          { message: { role: "assistant", content: "Found " }, done: false },
          { message: { role: "assistant", content: "3 hits" }, done: false },
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { function: { name: "get_pages", arguments: { start: 1 } } },
              ],
            },
            done: false,
          },
          {
            message: { role: "assistant", content: "" },
            done: true,
            prompt_eval_count: 9,
            eval_count: 4,
          },
        ])) as unknown as typeof fetch,
    });
    const turn = await adapter.complete({
      messages: [{ role: "user", content: "read page 1" }],
    });
    assert.equal(turn.text, "Found 3 hits");
    assert.equal(turn.reasoning, "plan it");
    assert.deepEqual(textDeltas, ["Found ", "3 hits"]);
    assert.deepEqual(reasoningDeltas, ["plan ", "it"]);
    assert.equal(turn.toolCalls?.[0]?.name, "get_pages");
    assert.deepEqual(turn.toolCalls?.[0]?.args, { start: 1 });
    assert.deepEqual(usage, {
      promptTokens: 9,
      completionTokens: 4,
      totalTokens: 13,
    });
    assert.equal(turn.streamed, true);
  });

  it("parses buffered NDJSON when Response.body is missing", async () => {
    const textDeltas: string[] = [];
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "ollama",
      baseUrl: nativeUrl,
      model: "qwen3.8-27b:latest",
      stream: true,
      onTextDelta: (piece) => textDeltas.push(piece),
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => "application/x-ndjson" },
          body: null,
          async text() {
            return [
              JSON.stringify({
                message: { role: "assistant", content: "Hi " },
                done: false,
              }),
              JSON.stringify({
                message: { role: "assistant", content: "there" },
                done: true,
              }),
              "",
            ].join("\n");
          },
        }) as unknown as Response) as unknown as typeof fetch,
    });
    const turn = await adapter.complete({
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(turn.text, "Hi there");
    assert.deepEqual(textDeltas, ["Hi ", "there"]);
  });

  it("ends the turn when done:true arrives even if NDJSON never closes", async () => {
    const encoder = new TextEncoder();
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "ollama",
      baseUrl: nativeUrl,
      model: "m",
      stream: true,
      fetchImpl: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({
                    message: { role: "assistant", content: "yo" },
                    done: true,
                  })}\n`,
                ),
              );
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          },
        )) as unknown as typeof fetch,
    });
    const turn = await Promise.race([
      adapter.complete({
        messages: [{ role: "user", content: "hi" }],
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("stream did not end after done:true")),
          1000,
        );
      }),
    ]);
    assert.equal(turn.text, "yo");
  });

  it("sends tool results with tool_name resolved from the prior assistant call", async () => {
    let sent: Record<string, unknown> | null = null;
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "ollama",
      baseUrl: nativeUrl,
      model: "m",
      stream: false,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            message: { role: "assistant", content: "ok" },
            done: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    await adapter.complete({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "search_items", args: { query: "x" } },
          ],
        },
        { role: "tool", content: '{"items":[]}', toolCallId: "call_1" },
      ],
    });
    const messages = sent!.messages as Array<Record<string, unknown>>;
    const toolMessage = messages.find((entry) => entry.role === "tool");
    assert.equal(toolMessage?.tool_name, "search_items");
    assert.equal(toolMessage?.tool_call_id, "call_1");
    const assistantMessage = messages.find(
      (entry) => entry.role === "assistant" && Array.isArray(entry.tool_calls),
    ) as { tool_calls: Array<{ function: { arguments: unknown } }> };
    // Ollama native rejects string-valued arguments with a 400 — regression
    // guard for the bug caught in live testing.
    assert.equal(
      typeof assistantMessage.tool_calls[0]?.function?.arguments,
      "object",
    );
  });
});
