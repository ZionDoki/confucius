import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CONFUCIUS_MCP_PATH } from "@confucius/protocol";
import {
  READ_ONLY_TOOL_NAMES,
  WRITE_TOOL_NAMES,
} from "@confucius/zotero-tools";

const PAIRING_TOKEN = "pairing-token-for-test";
const endpoints = {};
const previousZotero = globalThis.Zotero;
const previousToolkit = globalThis.ztoolkit;
globalThis.Zotero = {
  Prefs: {
    get(name) {
      return name.endsWith(".pairingToken") ? PAIRING_TOKEN : undefined;
    },
  },
  Server: { Endpoints: endpoints },
};
globalThis.ztoolkit = { log() {} };

const { registerHttpBridge, unregisterHttpBridge } =
  await import("../src/modules/bridge/HttpBridge.ts");

describe("public Zotero MCP bridge", () => {
  const calls = [];
  let endpoint;

  before(() => {
    registerHttpBridge({
      health: () => ({ ok: true }),
      rpc: async () => ({}),
      async executeReadOnlyTool(name, args) {
        calls.push({ name, args });
        return { ok: true, toolName: name, data: { accepted: true } };
      },
    });
    const Endpoint = endpoints[CONFUCIUS_MCP_PATH];
    assert.ok(Endpoint, "MCP endpoint should be registered");
    endpoint = new Endpoint();
  });

  after(() => {
    unregisterHttpBridge();
    globalThis.Zotero = previousZotero;
    globalThis.ztoolkit = previousToolkit;
  });

  const request = (method, body, token = PAIRING_TOKEN) =>
    endpoint.init({
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      data: body,
    });

  it("requires the pairing bearer before any MCP operation", async () => {
    const [status] = await request(
      "POST",
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      "wrong",
    );
    assert.equal(status, 401);
  });

  it("implements stateless initialize, notifications, GET, and DELETE", async () => {
    const [initializeStatus, , initializeJson] = await request("POST", {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    assert.equal(initializeStatus, 200);
    const initialized = JSON.parse(initializeJson);
    assert.equal(initialized.result.protocolVersion, "2025-06-18");
    assert.deepEqual(initialized.result.capabilities, {
      tools: { listChanged: false },
    });

    const [, , latestJson] = await request("POST", {
      jsonrpc: "2.0",
      id: 21,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    assert.equal(JSON.parse(latestJson).result.protocolVersion, "2025-11-25");

    const [, , legacyJson] = await request("POST", {
      jsonrpc: "2.0",
      id: 22,
      method: "initialize",
      params: { protocolVersion: "2024-10-07" },
    });
    assert.equal(JSON.parse(legacyJson).result.protocolVersion, "2024-10-07");

    const [, , fallbackJson] = await request("POST", {
      jsonrpc: "2.0",
      id: 23,
      method: "initialize",
      params: { protocolVersion: "unsupported" },
    });
    assert.equal(JSON.parse(fallbackJson).result.protocolVersion, "2025-11-25");

    const [notificationStatus, , notificationBody] = await request("POST", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(notificationStatus, 202);
    assert.equal(notificationBody, "");

    const [getStatus] = await request("GET");
    assert.equal(getStatus, 405);
    const [deleteStatus, , deleteBody] = await request("DELETE");
    assert.equal(deleteStatus, 204);
    assert.equal(deleteBody, "");
  });

  it("lists only read tools and rejects writes without invoking the host", async () => {
    const [, , listJson] = await request("POST", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    const listed = JSON.parse(listJson).result.tools.map((tool) => tool.name);
    assert.ok(listed.length > 0);
    assert.equal(
      listed.every((name) => READ_ONLY_TOOL_NAMES.has(name)),
      true,
    );
    assert.equal(
      listed.some((name) => WRITE_TOOL_NAMES.has(name)),
      false,
    );

    const before = calls.length;
    const [, , deniedJson] = await request("POST", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "create_collection", arguments: { name: "No" } },
    });
    const denied = JSON.parse(deniedJson).result;
    assert.equal(denied.isError, true);
    assert.equal(calls.length, before);

    const [, , allowedJson] = await request("POST", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "search_items", arguments: { query: "evidence" } },
    });
    const allowed = JSON.parse(allowedJson).result;
    assert.equal(allowed.isError, false);
    assert.deepEqual(calls.at(-1), {
      name: "search_items",
      args: { query: "evidence" },
    });
  });
});
