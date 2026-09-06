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
  it("preserves every proposal issue and candidate mapping without echoing authored prose", () => {
    const annotations = [
      {
        id: "a",
        type: "highlight",
        page: 2,
        quote: "Evidence",
        comment: "中文说明",
        status: "pending",
      },
      {
        id: "b",
        type: "underline",
        page: 3,
        quote: "Invalid",
        status: "skipped",
        error: "Repair page",
        reviewIssue: "Explain the evidence",
      },
    ];
    const raw = {
      ok: true as const,
      toolName: "propose_annotations",
      data: {
        proposalId: "p",
        count: 1,
        annotations,
        issues: [{ path: "b", message: "Repair page" }],
        persisted: true,
      },
    };
    const result = truncateToolResult(raw);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data as typeof raw.data;
    assert.equal(data.proposalId, "p");
    assert.deepEqual(data.issues, raw.data.issues);
    assert.deepEqual(JSON.parse(JSON.stringify(data.annotations)), [
      { inputIndex: 1, id: "a", type: "highlight", page: 2, status: "pending" },
      {
        inputIndex: 2,
        id: "b",
        type: "underline",
        page: 3,
        status: "skipped",
        error: "Repair page",
        reviewIssue: "Explain the evidence",
      },
    ]);
    assert.equal(raw.data.annotations[0].comment, "中文说明");
  });

  it("keeps whole PDF pages and exposes the first unread physical page", () => {
    const pages = [7, 8, 9].map((page) => ({
      page,
      text: "evidence".repeat(300),
    }));
    const raw = {
      ok: true as const,
      toolName: "get_pages",
      data: { attachmentKey: "PDF", pageCount: 16, pages },
    };
    const result = truncateToolResult(raw, 4000);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, {
      attachmentKey: "PDF",
      pageCount: 16,
      pages: [pages[0]],
      truncated: true,
      nextPage: 8,
    });
    assert.equal(raw.data.pages.length, 3);
  });

  it("preserves a single large page and existing continuation instead of cutting evidence", () => {
    const page = { page: 3, text: "evidence".repeat(1000) };
    const result = truncateToolResult(
      {
        ok: true,
        toolName: "get_pages",
        data: { pages: [page], truncated: true, nextPage: 4 },
      },
      1000,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, {
      pages: [page],
      truncated: true,
      nextPage: 4,
    });
  });

  it("returns an artifact receipt while retaining the full durable result", () => {
    const artifact = {
      id: "a",
      title: "阅读报告",
      body: "完整正文",
      citations: [{ page: 2 }],
      revisions: [{ body: "obsolete draft", citations: [{ page: 1 }] }],
      status: "ready",
      revision: 3,
    };
    const result = truncateToolResult({
      ok: true,
      toolName: "artifact_upsert",
      data: { artifact },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, {
      artifact: { id: "a", title: "阅读报告", status: "ready", revision: 3 },
      citationCount: 1,
      contentStored: true,
    });
    assert.equal(artifact.body, "完整正文");
    assert.equal(artifact.citations.length, 1);
    assert.equal(artifact.revisions[0].body, "obsolete draft");
    assert.doesNotMatch(JSON.stringify(result), /obsolete draft|revisions/);
  });

  it("preserves annotation review text, pagination and draft follow-up without geometry or historical echoes", () => {
    const raw = {
      ok: true as const,
      toolName: "get_annotations",
      data: {
        libraryID: 1,
        key: "PAPER",
        nextOffset: 25,
        totalAnnotations: 40,
        annotations: [
          {
            key: "MARK",
            comment: "保留限定",
            text: "actual source",
            position: { rects: [[1, 2, 3, 4]] },
          },
        ],
        proposals: [
          {
            proposalId: "p",
            entries: [
              {
                id: "a",
                annotationKey: "MARK",
                status: "completed",
                draft: { comment: "old explanation" },
              },
            ],
          },
        ],
      },
    };
    const projected = truncateToolResult(raw);
    assert.equal(projected.ok, true);
    if (!projected.ok) return;
    const data = projected.data as typeof raw.data;
    assert.equal(data.nextOffset, 25);
    assert.equal(data.annotations[0].comment, "保留限定");
    assert.equal(data.annotations[0].key, "MARK");
    assert.equal(data.annotations[0].position, undefined);
    assert.equal(data.proposals[0].entries[0].draft, undefined);
    assert(raw.data.annotations[0].position);
    const receipt = truncateToolResult({
      ok: true,
      toolName: "artifact_upsert",
      data: {
        artifact: { id: "r", status: "draft", body: "draft" },
        reviewRequired: true,
        nextAction: "Reread sources",
      },
    });
    assert(receipt.ok);
    assert.equal(
      (receipt.data as { nextAction: string }).nextAction,
      "Reread sources",
    );
  });

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

describe("reasoning request parameters", () => {
  for (const [model, effort, expected] of [
    ["gpt-5.5", "off", { reasoning_effort: "none" }],
    ["gpt-6-astra", "max", { reasoning_effort: "max" }],
    ["gpt-6-astra", "off", {}],
    ["kimi-k2.6", "off", { thinking: { type: "disabled" } }],
    ["kimi-k2.6", "on", { thinking: { type: "enabled" } }],
    [
      "deepseek-v4-pro",
      "max",
      { thinking: { type: "enabled" }, reasoning_effort: "max" },
    ],
    ["custom", "high", {}],
  ] as const) {
    it(`sends only supported ${model}/${effort} parameters`, async () => {
      let body: Record<string, unknown> = {};
      const adapter = new OpenAICompatibleAdapter({
        apiKey: "test",
        baseUrl: "https://provider.example.test/v1",
        model,
        reasoningEffort: effort,
        stream: false,
        fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          body = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "done" } }] }),
          );
        }) as typeof fetch,
      });
      await adapter.complete({ messages: [{ role: "user", content: "test" }] });
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(body).filter(([key]) =>
            ["reasoning_effort", "thinking", "think"].includes(key),
          ),
        ),
        expected,
      );
    });
  }
});
