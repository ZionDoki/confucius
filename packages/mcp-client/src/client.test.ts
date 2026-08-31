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
