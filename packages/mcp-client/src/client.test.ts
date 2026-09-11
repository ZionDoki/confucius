import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpHttpClient } from "./index";

for (const stage of ["fetch", "body"] as const) {
  it(`bounds discovery while ${stage} is unresponsive and aborts the transport`, async () => {
    let signal: AbortSignal | null | undefined;
    const client = new McpHttpClient(
      { id: "offline", url: "http://example.test" },
      (async (_url, init) => {
        signal = init?.signal;
        if (stage === "fetch") return new Promise<Response>(() => {});
        return {
          ok: true,
          text: () => new Promise<string>(() => {}),
        } as Response;
      }) as typeof fetch,
    );
    await assert.rejects(client.listTools(undefined, 10), /timed out/);
    assert.equal(signal?.aborted, true);
  });
}

it("cancels discovery promptly when the host reloads or shuts down", async () => {
  const controller = new AbortController();
  const client = new McpHttpClient(
    { id: "offline", url: "http://example.test" },
    (async () => new Promise<Response>(() => {})) as typeof fetch,
  );
  const discovery = client.listTools(controller.signal);
  controller.abort();
  await assert.rejects(discovery, /cancelled/);
});

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
