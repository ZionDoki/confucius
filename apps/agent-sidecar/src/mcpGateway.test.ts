import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { MCP_SUPPORTED_PROTOCOL_VERSIONS } from "@confucius/protocol";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { CapabilityStore } from "./capabilities";
import { handleMcp } from "./mcpGateway";

describe("task MCP gateway", () => {
  const capabilities = new CapabilityStore();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const host = {
    async rpc(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      return method === "task/toolList"
        ? { tools: [] }
        : { content: [{ type: "text", text: "ok" }] };
    },
  };
  let origin = "";
  let close: (() => Promise<void>) | undefined;

  before(async () => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        void handleMcp(
          request,
          response,
          Buffer.concat(chunks).toString("utf8"),
          capabilities,
          host as never,
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    origin = `http://127.0.0.1:${address.port}`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  after(async () => close?.());

  it("tracks the protocol versions in the pinned MCP SDK", () => {
    assert.deepEqual(
      [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
      SUPPORTED_PROTOCOL_VERSIONS,
    );
  });

  it("binds each bearer to exactly one task and honors revocation", async () => {
    const capability = capabilities.issue("task_a");
    const response = await fetch(origin, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${capability.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "artifact_upsert", arguments: { taskId: "task_b" } },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1)?.params.taskId, "task_a");
    capabilities.revoke("task_a");
    const revoked = await fetch(origin, {
      method: "POST",
      headers: { Authorization: `Bearer ${capability.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(revoked.status, 401);
  });

  it("implements stateless Streamable HTTP initialization", async () => {
    const capability = capabilities.issue("task_init");
    const response = await fetch(origin, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${capability.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    const body = (await response.json()) as {
      result?: {
        protocolVersion?: string;
        capabilities?: unknown;
        instructions?: string;
      };
    };
    assert.equal(body.result?.protocolVersion, "2025-06-18");
    assert.ok(body.result?.capabilities);
    assert.match(
      String(body.result?.instructions),
      /only for a durable research product/,
    );
    assert.doesNotMatch(
      String(body.result?.instructions),
      /before completing the task/,
    );

    for (const protocolVersion of ["2025-11-25", "2024-10-07"]) {
      const negotiated = await fetch(origin, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${capability.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "initialize",
          params: { protocolVersion },
        }),
      });
      const negotiatedBody = (await negotiated.json()) as {
        result?: { protocolVersion?: string };
      };
      assert.equal(negotiatedBody.result?.protocolVersion, protocolVersion);
    }

    const unsupported = await fetch(origin, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${capability.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "initialize",
        params: { protocolVersion: "unsupported" },
      }),
    });
    const unsupportedBody = (await unsupported.json()) as {
      result?: { protocolVersion?: string };
    };
    assert.equal(unsupportedBody.result?.protocolVersion, "2025-11-25");
  });

  it("authenticates every method and distinguishes id zero from notifications", async () => {
    const capability = capabilities.issue("task_protocol");
    const unauthenticated = await fetch(origin, { method: "DELETE" });
    assert.equal(unauthenticated.status, 401);

    const ping = await fetch(origin, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${capability.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    });
    assert.deepEqual(await ping.json(), {
      jsonrpc: "2.0",
      id: 0,
      result: {},
    });

    const notification = await fetch(origin, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${capability.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    assert.equal(notification.status, 202);
    assert.equal(await notification.text(), "");
  });

  it("returns JSON-RPC parse and invalid-request errors", async () => {
    const capability = capabilities.issue("task_invalid");
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${capability.token}`,
    };
    const malformed = await fetch(origin, {
      method: "POST",
      headers,
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal(
      ((await malformed.json()) as { error: { code: number } }).error.code,
      -32700,
    );
    const invalid = await fetch(origin, {
      method: "POST",
      headers,
      body: JSON.stringify([]),
    });
    assert.equal(
      ((await invalid.json()) as { error: { code: number } }).error.code,
      -32600,
    );
  });
});
