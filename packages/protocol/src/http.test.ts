import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONFUCIUS_PROTOCOL_VERSION,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  buildHealthResponse,
  isConfuciusHealthResponse,
  negotiateMcpProtocolVersion,
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

describe("MCP protocol negotiation", () => {
  it("matches the protocol versions supported by the pinned MCP SDK", () => {
    assert.deepEqual(MCP_SUPPORTED_PROTOCOL_VERSIONS, [
      "2025-11-25",
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
      "2024-10-07",
    ]);
    assert.equal(MCP_LATEST_PROTOCOL_VERSION, "2025-11-25");
  });

  it("preserves supported requests and otherwise selects the latest version", () => {
    for (const version of MCP_SUPPORTED_PROTOCOL_VERSIONS) {
      assert.equal(negotiateMcpProtocolVersion(version), version);
    }
    assert.equal(negotiateMcpProtocolVersion("future"), "2025-11-25");
    assert.equal(negotiateMcpProtocolVersion(undefined), "2025-11-25");
  });
});
