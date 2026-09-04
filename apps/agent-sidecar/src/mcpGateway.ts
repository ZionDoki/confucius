import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MCP_TASK_GATEWAY_INSTRUCTIONS,
  negotiateMcpProtocolVersion,
} from "@confucius/protocol";
import type { CapabilityStore } from "./capabilities.js";
import type { HostClient } from "./hostClient.js";

interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function handleMcp(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
  capabilities: CapabilityStore,
  host: HostClient,
): Promise<void> {
  const token = bearer(request.headers.authorization);
  const capability = token ? capabilities.resolve(token) : null;
  if (!capability) {
    send(response, 401, { error: "invalid or expired capability" });
    return;
  }
  if (request.method === "DELETE") {
    send(response, 204, undefined);
    return;
  }
  if (request.method === "GET") {
    response.setHeader("Allow", "POST, DELETE");
    send(response, 405, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "Stateless MCP server has no SSE stream",
      },
    });
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST, DELETE");
    send(response, 405, undefined);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    send(response, 400, rpcError(null, -32700, "Parse error"));
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    send(response, 200, rpcError(null, -32600, "Invalid Request"));
    return;
  }
  const message = parsed as McpRequest;
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = hasId ? (message.id ?? null) : null;
  if (!hasId && message.method?.startsWith("notifications/")) {
    send(response, 202, undefined);
    return;
  }
  if (message.jsonrpc !== "2.0" || !message.method) {
    send(response, 200, rpcError(id, -32600, "Invalid Request"));
    return;
  }
  try {
    switch (message.method) {
      case "initialize": {
        const protocolVersion = negotiateMcpProtocolVersion(
          message.params?.protocolVersion,
        );
        send(response, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            serverInfo: { name: "confucius-task-gateway", version: "0.3.3" },
            capabilities: { tools: { listChanged: false } },
            instructions: MCP_TASK_GATEWAY_INSTRUCTIONS,
          },
        });
        return;
      }
      case "ping":
        send(response, 200, { jsonrpc: "2.0", id, result: {} });
        return;
      case "tools/list": {
        const result = await host.rpc<unknown>("task/toolList", {
          taskId: capability.taskId,
        });
        send(response, 200, { jsonrpc: "2.0", id, result });
        return;
      }
      case "tools/call": {
        const result = await host.rpc<unknown>("task/toolCall", {
          taskId: capability.taskId,
          name: String(message.params?.name ?? ""),
          arguments: asRecord(message.params?.arguments),
          callId: String(
            asRecord(message.params?._meta).progressToken ??
              `external_${Date.now().toString(36)}`,
          ),
        });
        send(response, 200, { jsonrpc: "2.0", id, result });
        return;
      }
      default:
        send(
          response,
          200,
          rpcError(id, -32601, `Unknown MCP method ${message.method}`),
        );
    }
  } catch (error) {
    send(response, 200, rpcError(id, -32000, errorMessage(error)));
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function bearer(value: string | undefined): string {
  return value?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
