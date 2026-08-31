import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitBatches } from "./ConcurrencyScheduler";
import { MemoryToolProvider, jsonObjectSchema } from "./MemoryToolProvider";

describe("ConcurrencyScheduler", () => {
  it("batches adjacent parallel_safe reads and isolates writes", () => {
    const batches = splitBatches(
      [
        { callId: "1", toolName: "search_items", args: {} },
        { callId: "2", toolName: "get_item", args: {} },
        { callId: "3", toolName: "create_collection", args: {} },
        { callId: "4", toolName: "search_items", args: {} },
      ],
      (name) => {
        if (name === "create_collection") {
          return {
            name: "create_collection",
            catalog: "library.write",
            concurrency: "serial",
            mutatesState: true,
          };
        }
        return {
          name: name as "search_items",
          catalog: "library.read",
          concurrency: "parallel_safe",
          mutatesState: false,
        };
      },
    );

    assert.equal(batches.length, 3);
    assert.deepEqual(
      batches[0].map((call) => call.callId),
      ["1", "2"],
    );
    assert.deepEqual(
      batches[1].map((call) => call.callId),
      ["3"],
    );
    assert.deepEqual(
      batches[2].map((call) => call.callId),
      ["4"],
    );
  });

  it("runs parallel_safe handlers concurrently", async () => {
    const tools = new MemoryToolProvider();
    let started = 0;
    let overlap = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const hang = async (label: string) => {
      started += 1;
      if (started === 2) {
        overlap += 1;
        release();
      }
      await gate;
      return { label };
    };

    tools.register(
      {
        name: "search_items",
        description: "a",
        inputSchema: jsonObjectSchema({}),
      },
      {
        name: "search_items",
        catalog: "library.read",
        concurrency: "parallel_safe",
        mutatesState: false,
      },
      () => hang("a"),
    );
    tools.register(
      {
        name: "get_item",
        description: "b",
        inputSchema: jsonObjectSchema({}),
      },
      {
        name: "get_item",
        catalog: "library.read",
        concurrency: "parallel_safe",
        mutatesState: false,
      },
      () => hang("b"),
    );

    const results = await Promise.all([
      tools.call("search_items", {}),
      tools.call("get_item", {}),
    ]);

    assert.equal(overlap, 1);
    assert.equal(results.every((result) => result.ok), true);
  });
});
