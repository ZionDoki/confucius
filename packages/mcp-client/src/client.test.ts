import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpHttpClient } from "./index";

describe("McpHttpClient", () => {
  it("prefixes listed tools with mcp.<id>.", async () => {
    const client = new McpHttpClient(
      { id: "scholar", url: "http://example.test/mcp" },
      (async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [
                {
                  name: "search",
                  description: "Search",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          }),
        )) as unknown as typeof fetch,
    );
    const tools = await client.listTools();
    assert.equal(tools[0]?.name, "mcp.scholar.search");
  });
});

it("preserves MCP isError and uncertain transport outcomes without retrying", async () => {
  let calls = 0;
  const client = new McpHttpClient(
    { id: "external", url: "http://example.test/mcp" },
    (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: true,
            content: [{ type: "text", text: "operation failed" }],
          },
        }),
      );
    }) as typeof fetch,
  );
  const result = await client.call("mcp.external.write", {});
  assert.equal(result.ok, false);
  assert.equal(result.effect, "unknown");
  assert.equal(result.retryable, false);
  assert.equal(calls, 1);
});
