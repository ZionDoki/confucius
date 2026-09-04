import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OpenAICompatibleAdapter,
  normalizeOpenAICompatibleBaseUrl,
} from "./OpenAICompatibleAdapter";
import { FilteredToolProvider } from "./ToolProvider";
import { MemoryToolProvider, jsonObjectSchema } from "./MemoryToolProvider";
import { truncateToolResult } from "./truncate";

describe("normalizeOpenAICompatibleBaseUrl", () => {
  it("adds /v1 to host-only OpenAI-compatible URLs", () => {
    assert.equal(
      normalizeOpenAICompatibleBaseUrl("https://mirror.lzu.edu.cn"),
      "https://mirror.lzu.edu.cn/v1",
    );
    assert.equal(
      normalizeOpenAICompatibleBaseUrl("https://mirror.lzu.edu.cn/"),
      "https://mirror.lzu.edu.cn/v1",
    );
    assert.equal(
      normalizeOpenAICompatibleBaseUrl("https://api.openai.com/v1"),
      "https://api.openai.com/v1",
    );
    assert.equal(
      normalizeOpenAICompatibleBaseUrl(
        "https://mirror.lzu.edu.cn/v1/chat/completions",
      ),
      "https://mirror.lzu.edu.cn/v1",
    );
    assert.equal(
      normalizeOpenAICompatibleBaseUrl("http://127.0.0.1:11434/api/chat"),
      "http://127.0.0.1:11434/api/chat",
    );
  });
});

describe("OpenAICompatibleAdapter", () => {
  it("sends transient page images as OpenAI image_url content", async () => {
    let sent: Record<string, unknown> | null = null;
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test/v1",
      model: "vision-demo",
      stream: false,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "seen" } }] }),
        );
      }) as unknown as typeof fetch,
    });

    await adapter.complete({
      messages: [
        {
          role: "user",
          content: "PDF page 1",
          images: [
            { mimeType: "image/png", data: "OPENAI-PAGE", description: "p1" },
          ],
          transient: true,
        },
      ],
    });

    const messages = sent!.messages as Array<{ content: unknown }>;
    assert.deepEqual(messages[0]?.content, [
      { type: "text", text: "PDF page 1" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,OPENAI-PAGE" },
      },
    ]);
  });

  it("posts host-only Base URLs to /v1/chat/completions", async () => {
    let requested = "";
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "sk-test",
      baseUrl: "https://mirror.lzu.edu.cn",
      model: "MiniMax-M3",
      stream: false,
      fetchImpl: (async (input: RequestInfo | URL) => {
        requested = String(input);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "pong" } }],
          }),
        );
      }) as unknown as typeof fetch,
    });
    const turn = await adapter.complete({
      messages: [{ role: "user", content: "ping" }],
    });
    assert.equal(requested, "https://mirror.lzu.edu.cn/v1/chat/completions");
    assert.equal(turn.text, "pong");
  });

  it("explains HTML bodies instead of throwing a JSON SyntaxError", async () => {
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test/v1",
      model: "demo",
      stream: false,
      fetchImpl: (async () =>
        new Response(
          "<!DOCTYPE html><body><script src=/testpow/p.js?2></script>",
          { status: 200, headers: { "content-type": "text/html" } },
        )) as unknown as typeof fetch,
    });
    await assert.rejects(
      adapter.complete({ messages: [{ role: "user", content: "hi" }] }),
      /HTML instead of JSON/,
    );
  });

  it("maps tool_calls onto ModelTurn", async () => {
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test/v1",
      model: "demo",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      function: {
                        name: "search_items",
                        arguments: JSON.stringify({ query: "x" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        )) as unknown as typeof fetch,
    });
    const turn = await adapter.complete({
      messages: [{ role: "user", content: "find x" }],
      tools: [
        {
          name: "search_items",
          description: "search",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    assert.equal(turn.toolCalls?.[0]?.name, "search_items");
    assert.deepEqual(turn.toolCalls?.[0]?.args, { query: "x" });
  });

  it("separates think-tag reasoning from non-streaming content", async () => {
    const adapter = new OpenAICompatibleAdapter({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test/v1",
      model: "tagged-reasoner",
      stream: false,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    "<think>inspect the evidence</think>The claim is supported.",
                },
              },
            ],
          }),
        )) as unknown as typeof fetch,
    });
    const turn = await adapter.complete({
      messages: [{ role: "user", content: "check this" }],
    });
    assert.equal(turn.reasoning, "inspect the evidence");
    assert.equal(turn.text, "The claim is supported.");
  });
});

describe("FilteredToolProvider", () => {
  it("blocks tools outside allowed-tools", async () => {
    const inner = new MemoryToolProvider();
    inner.register(
      {
        name: "search_items",
        description: "s",
        inputSchema: jsonObjectSchema({}),
      },
      {
        name: "search_items",
        catalog: "library.read",
        concurrency: "parallel_safe",
        mutatesState: false,
      },
      () => ({ ok: true }),
    );
    inner.register(
      {
        name: "create_collection",
        description: "c",
        inputSchema: jsonObjectSchema({}),
      },
      {
        name: "create_collection",
        catalog: "library.write",
        concurrency: "serial",
        mutatesState: true,
      },
      () => ({ created: true }),
    );
    const filtered = new FilteredToolProvider(inner, new Set(["search_items"]));
    assert.deepEqual(
      filtered.listTools().map((tool) => tool.name),
      ["search_items"],
    );
    const denied = await filtered.call("create_collection", { name: "x" });
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.code, "permission_denied");
    }
  });
});

describe("truncateToolResult", () => {
  it("caps large successful payloads", () => {
    const result = truncateToolResult(
      {
        ok: true,
        toolName: "get_pages",
        data: { text: "a".repeat(50_000) },
      },
      1000,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      const data = result.data as { truncated?: boolean };
      assert.equal(data.truncated, true);
    }
  });
});
