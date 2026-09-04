import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { SidecarService } from "./service.js";
import { handleMcp } from "./mcpGateway.js";

export interface RunningSidecar {
  baseUrl: string;
  token: string;
  close(): Promise<void>;
}

export async function startSidecar(): Promise<RunningSidecar> {
  const service = new SidecarService();
  await service.initialize();
  const token = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    void route(service, token, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Sidecar failed to bind a loopback port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  service.setMcpUrl(`${baseUrl}/mcp`);
  return {
    baseUrl,
    token,
    close: async () => {
      await service.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function route(
  service: SidecarService,
  sidecarToken: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/health" && request.method === "GET") {
      send(response, 200, {
        ok: true,
        name: "confucius-agent-sidecar",
        version: "0.3.5",
      });
      return;
    }
    const body = ["POST", "PUT", "PATCH"].includes(request.method ?? "")
      ? await readBody(request)
      : "";
    if (url.pathname === "/mcp") {
      await handleMcp(
        request,
        response,
        body,
        service.capabilities,
        service.host,
      );
      return;
    }
    if (!authorized(request, sidecarToken)) {
      send(response, 401, { error: "unauthorized" });
      return;
    }
    if (url.pathname === "/events" && request.method === "GET") {
      const result = await service.events.wait(
        url.searchParams.get("taskId") ?? "",
        url.searchParams.get("afterId") || undefined,
        Number(url.searchParams.get("waitMs") ?? 25_000),
      );
      send(response, 200, result);
      return;
    }
    if (url.pathname === "/rpc" && request.method === "POST") {
      const envelope = JSON.parse(body) as {
        id?: string | number | null;
        method?: string;
        params?: Record<string, unknown>;
      };
      const id = envelope.id ?? null;
      try {
        const result = await service.rpc(
          String(envelope.method ?? ""),
          envelope.params ?? {},
        );
        send(response, 200, { jsonrpc: "2.0", id, result });
      } catch (error) {
        send(response, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: errorMessage(error) },
        });
      }
      return;
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    if (!response.headersSent)
      send(response, 500, { error: errorMessage(error) });
    else response.end();
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(request: IncomingMessage, token: string): boolean {
  const provided =
    request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  if (provided.length !== token.length) return false;
  let diff = 0;
  for (let index = 0; index < token.length; index += 1) {
    diff |= token.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return diff === 0;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
