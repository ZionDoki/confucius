import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryToolProvider, jsonObjectSchema } from "./MemoryToolProvider";
import { HookedToolProvider } from "./ToolProvider";

describe("HookedToolProvider", () => {
  it("observes every tool call and still returns the inner result", async () => {
    const inner = new MemoryToolProvider();
    inner.register(
      {
        name: "conversation_log_search",
        description: "Search logs",
        inputSchema: jsonObjectSchema({ query: { type: "string" } }, ["query"]),
      },
      {
        name: "conversation_log_search",
        catalog: "memory.read",
        concurrency: "parallel_safe",
        mutatesState: false,
      },
      (args) => ({
        results: [{ sessionId: "ses_1", excerpt: String(args.query) }],
      }),
    );
    const seen: Array<{ toolName: string; query: unknown }> = [];
    const hooked = new HookedToolProvider(inner, (info) => {
      seen.push({
        toolName: info.toolName,
        query: info.result.ok
          ? (info.result.data as { results: unknown }).results
          : null,
      });
    });
    const result = await hooked.call("conversation_log_search", {
      query: "survey",
    });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].toolName, "conversation_log_search");
  });

  it("swallows hook failures so the tool still succeeds", async () => {
    const inner = new MemoryToolProvider();
    inner.register(
      {
        name: "memory_search",
        description: "Search memory",
        inputSchema: jsonObjectSchema({ query: { type: "string" } }, ["query"]),
      },
      {
        name: "memory_search",
        catalog: "memory.read",
        concurrency: "parallel_safe",
        mutatesState: false,
      },
      () => ({ results: [] }),
    );
    const hooked = new HookedToolProvider(inner, () => {
      throw new Error("hook exploded");
    });
    const result = await hooked.call("memory_search", { query: "x" });
    assert.equal(result.ok, true);
  });
});
