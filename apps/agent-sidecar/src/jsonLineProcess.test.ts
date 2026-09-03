import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { JsonLineProcess } from "./jsonLineProcess";

const fixture = fileURLToPath(
  new URL("./test-fixtures/fake-jsonrpc.mjs", import.meta.url),
);

describe("JsonLineProcess", () => {
  it("accepts fragmented JSONL and ignores malformed lines", async () => {
    const rpc = new JsonLineProcess(process.execPath, [fixture]);
    try {
      const result = await rpc.request<{ pong: boolean }>("ping", {});
      assert.equal(result.pong, true);
    } finally {
      rpc.close();
    }
  });
});
