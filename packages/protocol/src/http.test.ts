import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONFUCIUS_PROTOCOL_VERSION,
  buildHealthResponse,
  isConfuciusHealthResponse,
} from "./http";
import { itemRefKey, parseItemRefKey } from "./item";
import { mcpToolName } from "./tools";

describe("health", () => {
  it("builds a protocol-1 payload", () => {
    const body = buildHealthResponse("0.1.0");
    assert.equal(body.ok, true);
    assert.equal(body.name, "confucius");
    assert.equal(body.version, "0.1.0");
    assert.equal(body.protocol, CONFUCIUS_PROTOCOL_VERSION);
    assert.equal(isConfuciusHealthResponse(body), true);
  });

  it("rejects unrelated json", () => {
    assert.equal(isConfuciusHealthResponse({ ok: true }), false);
  });
});

describe("item ref", () => {
  it("round-trips libraryID:key", () => {
    const ref = { libraryID: 1, key: "ABCD1234" };
    assert.deepEqual(parseItemRefKey(itemRefKey(ref)), ref);
  });

  it("rejects key-only values", () => {
    assert.equal(parseItemRefKey("ABCD1234"), null);
  });
});

describe("mcp names", () => {
  it("prefixes server and tool", () => {
    assert.equal(mcpToolName("scholar", "search"), "mcp.scholar.search");
  });
});
