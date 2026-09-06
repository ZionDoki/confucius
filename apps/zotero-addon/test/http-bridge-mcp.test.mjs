import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CONFUCIUS_MCP_PATH } from "@confucius/protocol";
import {
  READ_ONLY_TOOL_NAMES,
  WRITE_TOOL_NAMES,
} from "@confucius/zotero-tools";

const PAIRING_TOKEN = "pairing-token-for-test";
const TASK_TOKEN = "task-capability-for-test";
const TASK_LEASE = {
  taskId: "task-bound",
  turnId: "turn-bound",
  runId: "run-bound",
  generation: 1,
  namespace: "test-public-namespace",
};
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
  const taskCalls = [];
  let capabilityActive = true;
  let currentToken = TASK_TOKEN;
  let currentLease = TASK_LEASE;
  let endpoint;
  let toolWait;
  let toolEntered;

  before(() => {
    registerHttpBridge({
      health: () => ({ ok: true }),
      resolveRuntimeCapability(token) {
        return capabilityActive && token === currentToken
          ? { ...currentLease }
          : null;
      },
      rpc: async (method, params) => {
        taskCalls.push({ method, params });
        if (method === "task/toolList") {
          return {
            tools: [
              { name: "search_items", inputSchema: { type: "object" } },
              { name: "artifact_upsert", inputSchema: { type: "object" } },
            ],
          };
        }
        if (method === "task/toolCall") {
          toolEntered?.();
          await toolWait;
          return {
            content: [{ type: "text", text: '{"ok":true}' }],
            isError: false,
          };
        }
        return {};
      },
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

  it("coalesces transport retries during approval and uses a stable operation identity afterwards", async () => {
    let release;
    const entered = new Promise((resolve) => {
      toolEntered = resolve;
    });
    toolWait = new Promise((resolve) => {
      release = resolve;
    });
    const body = {
      jsonrpc: "2.0",
      id: "retry-10",
      method: "tools/call",
      params: { name: "create_note", arguments: { content: "Evidence" } },
    };
    const before = taskCalls.length;
    const first = request("POST", body, TASK_TOKEN);
    const retry = request("POST", body, TASK_TOKEN);
    await entered;
    const [, , conflict] = await request(
      "POST",
      {
        ...body,
        params: { ...body.params, arguments: { content: "Changed" } },
      },
      TASK_TOKEN,
    );
    assert.equal(JSON.parse(conflict).error.code, -32602);
    assert.equal(taskCalls.length, before + 1);
    const operation = taskCalls.at(-1).params.operationId;
    assert.match(operation, /^mcp_test-public-namespace_[a-f0-9]{64}$/);
    assert.equal(operation.includes(TASK_TOKEN), false);
    release();
    assert.deepEqual(await first, await retry);
    toolWait = undefined;
    toolEntered = undefined;
    await request("POST", body, TASK_TOKEN);
    assert.equal(taskCalls.at(-1).params.operationId, operation);
  });

  it("keeps an entered request on its captured lease and separates same-id calls after rotation", async () => {
    let release;
    let entered = new Promise((resolve) => {
      toolEntered = resolve;
    });
    toolWait = new Promise((resolve) => {
      release = resolve;
    });
    const body = {
      jsonrpc: "2.0",
      id: "same-id",
      method: "tools/call",
      params: { name: "create_note", arguments: { content: "Evidence" } },
    };
    const first = request("POST", body, TASK_TOKEN);
    await entered;
    const oldCall = taskCalls.at(-1).params;
    currentToken = "next-dispatch-token";
    currentLease = { ...TASK_LEASE, namespace: "next-dispatch" };
    entered = new Promise((resolve) => {
      toolEntered = resolve;
    });
    const next = request("POST", body, currentToken);
    await entered;
    const newCall = taskCalls.at(-1).params;
    assert.notEqual(oldCall.operationId, newCall.operationId);
    assert.deepEqual(oldCall.lease, TASK_LEASE);
    assert.deepEqual(newCall.lease, currentLease);
    assert.equal((await request("POST", body, TASK_TOKEN))[0], 401);
    release();
    await Promise.all([first, next]);
    toolWait = undefined;
    toolEntered = undefined;
    currentToken = TASK_TOKEN;
    currentLease = TASK_LEASE;
  });

  it("binds task capabilities to their task and rejects them after revocation", async () => {
    const [, , listJson] = await request(
      "POST",
      { jsonrpc: "2.0", id: 6, method: "tools/list" },
      TASK_TOKEN,
    );
    const listed = JSON.parse(listJson).result.tools.map((tool) => tool.name);
    assert.deepEqual(listed, ["search_items", "artifact_upsert"]);
    assert.deepEqual(taskCalls.at(-1), {
      method: "task/toolList",
      params: { taskId: "task-bound", lease: TASK_LEASE },
    });

    const [, , callJson] = await request(
      "POST",
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          taskId: "forged-task",
          name: "artifact_upsert",
          arguments: { title: "Evidence" },
        },
      },
      TASK_TOKEN,
    );
    assert.equal(JSON.parse(callJson).result.isError, false);
    assert.equal(taskCalls.at(-1).params.taskId, "task-bound");
    assert.equal(taskCalls.at(-1).params.name, "artifact_upsert");

    capabilityActive = false;
    const [revokedStatus] = await request(
      "POST",
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
      TASK_TOKEN,
    );
    assert.equal(revokedStatus, 401);
  });
});
