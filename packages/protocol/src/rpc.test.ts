import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { RPC_METHODS } from "./rpc";

/**
 * Derive the dispatched method names from AgentHost's `rpc` switch instead of
 * copying a second literal list here. A handler added without a protocol
 * constant, or a constant nobody dispatches, now fails this test.
 */
function hostDispatch() {
  const source = readFileSync(
    new URL(
      "../../../apps/zotero-addon/src/modules/host/AgentHost.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const start = source.indexOf("  async rpc(");
  const end = source.indexOf("\n  configGet()", start);
  assert.ok(start >= 0 && end > start, "AgentHost rpc dispatch was not found");
  const block = source.slice(start, end);
  const literals: string[] = [];
  const constants: string[] = [];
  for (const match of block.matchAll(
    /case\s+(?:"([^"]+)"|RPC_METHODS\.([A-Za-z0-9_]+))\s*:/g,
  )) {
    if (match[1]) literals.push(match[1]);
    else constants.push(match[2]);
  }
  assert.ok(
    literals.length + constants.length > 100,
    "AgentHost rpc dispatch could not be parsed",
  );
  return { literals, constants };
}

const dispatch = hostDispatch();
const tableMethods = new Set<string>(Object.values(RPC_METHODS));

describe("RPC_METHODS", () => {
  it("declares every method AgentHost dispatches", () => {
    for (const method of dispatch.literals) {
      assert.ok(
        tableMethods.has(method),
        `dispatched method ${method} is missing from RPC_METHODS`,
      );
    }
  });

  it("resolves every constant AgentHost dispatches", () => {
    for (const name of dispatch.constants) {
      assert.ok(
        name in RPC_METHODS,
        `dispatch case RPC_METHODS.${name} has no constant`,
      );
    }
  });

  it("declares no constant that AgentHost never dispatches", () => {
    const dispatched = new Set(dispatch.literals);
    for (const name of dispatch.constants) {
      dispatched.add(
        RPC_METHODS[name as keyof typeof RPC_METHODS] as unknown as string,
      );
    }
    for (const method of tableMethods) {
      assert.ok(
        dispatched.has(method),
        `RPC_METHODS value ${method} is not dispatched by AgentHost`,
      );
    }
  });

  it("keeps method strings unique", () => {
    const values = Object.values(RPC_METHODS);
    assert.equal(new Set(values).size, values.length);
  });
});
