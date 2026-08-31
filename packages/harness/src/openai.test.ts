import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAICompatibleAdapter } from "./OpenAICompatibleAdapter";
import { FilteredToolProvider } from "./ToolProvider";
import { MemoryToolProvider, jsonObjectSchema } from "./MemoryToolProvider";
import { truncateToolResult } from "./truncate";

describe("OpenAICompatibleAdapter", () => {
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
    const filtered = new FilteredToolProvider(
      inner,
      new Set(["search_items"]),
    );
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
