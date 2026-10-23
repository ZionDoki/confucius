import type {
  JsonSchemaObject,
  ToolDefinition,
  ToolResult,
} from "@confucius/protocol";
import {
  CONFUCIUS_VERSION,
  MCP_LATEST_PROTOCOL_VERSION,
  mcpToolName,
} from "@confucius/protocol";

export interface McpServerConfig {
  id: string;
  url: string;
  headers?: Record<string, string>;
}

export interface McpClientOptions {
  /** Independent deadline for one tools/call request. */
  callTimeoutMs?: number;
  /** Hard cap for a response body, checked before and while buffering. */
  maxResponseBytes?: number;
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const MAX_MCP_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_MESSAGE_CHARACTERS = 300;

interface JsonRpcEnvelope<T> {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: T;
  error?: { message?: string; code?: number };
}

/** Host fetch implementations expose slightly different stream reader types. */
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock?(): void;
}

class McpHttpStatusError extends Error {
  constructor(
    readonly status: number,
    code?: number,
  ) {
    super(`MCP HTTP ${status}${code === undefined ? "" : ` (code ${code})`}`);
    this.name = "McpHttpStatusError";
  }
}

export class McpHttpClient {
  private sessionId?: string;
  private protocolVersion = MCP_LATEST_PROTOCOL_VERSION;
  private initialized?: Promise<void>;
  private ready = false;
  private requestId = 0;
  private readonly callTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly server: McpServerConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly createController: () => AbortController = () =>
      new AbortController(),
    options: McpClientOptions = {},
  ) {
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_MCP_RESPONSE_BYTES;
  }

  async listTools(
    signal?: AbortSignal,
    timeoutMs = 10_000,
  ): Promise<ToolDefinition[]> {
    const result = await this.withDeadline(
      signal,
      timeoutMs,
      "MCP discovery",
      async (deadlineSignal) => {
        await this.ensureInitialized(deadlineSignal);
        return this.rpc<{
          tools?: Array<{
            name: string;
            description?: string;
            inputSchema?: JsonSchemaObject;
          }>;
        }>("tools/list", {}, deadlineSignal);
      },
    );
    return (result?.tools ?? []).map((tool) => ({
      name: mcpToolName(this.server.id, tool.name),
      description: tool.description || tool.name,
      inputSchema: tool.inputSchema ?? {
        type: "object",
        properties: {},
      },
    }));
  }

  async call(
    prefixedName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const prefix = `mcp.${this.server.id}.`;
    if (!prefixedName.startsWith(prefix)) {
      return {
        ok: false,
        toolName: prefixedName,
        code: "not_found",
        message: "MCP tool prefix mismatch",
      };
    }
    const rawName = prefixedName.slice(prefix.length);
    try {
      const result = await this.withDeadline(
        signal,
        this.callTimeoutMs,
        "MCP request",
        async (deadlineSignal) => {
          await this.ensureInitialized(deadlineSignal);
          return this.rpc<{ content?: unknown; isError?: boolean }>(
            "tools/call",
            { name: rawName, arguments: args },
            deadlineSignal,
          );
        },
      );
      if (result?.isError)
        return {
          ok: false,
          toolName: prefixedName,
          code: "unavailable",
          message: "MCP tool reported an execution error",
          details: result,
          effect: "unknown",
          retryable: false,
        };
      return {
        ok: true,
        toolName: prefixedName,
        data: result,
      };
    } catch (error) {
      // A 404 means the server did not process the request. The session was
      // already dropped, so the caller can retry safely with a fresh one.
      const unprocessed =
        error instanceof McpHttpStatusError && error.status === 404;
      return {
        ok: false,
        toolName: prefixedName,
        code: "unavailable",
        effect: unprocessed ? "none" : "unknown",
        retryable: false,
        message: safeErrorMessage(error),
      };
    }
  }

  /** Bound one host-visible operation and abort its transport on expiry. */
  private async withDeadline<T>(
    signal: AbortSignal | undefined,
    timeoutMs: number,
    label: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new Error(`${label} cancelled`);
    const controller = this.createController();
    const racers: Array<Promise<T>> = [work(controller.signal)];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    if (signal) {
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          controller.abort();
          reject(new Error(`${label} cancelled`));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      racers.push(cancelled);
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timed out`));
        }, timeoutMs);
      });
      racers.push(timedOut);
    }
    try {
      return await Promise.race(racers);
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.initialize(signal).catch((error) => {
        this.initialized = undefined;
        throw error;
      });
    }
    return this.initialized;
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    try {
      const id = this.nextId();
      const { response, text } = await this.post(
        {
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "confucius", version: CONFUCIUS_VERSION },
          },
        },
        signal,
      );
      this.throwIfNotOk(response, text);
      const envelope = this.parseEnvelope<{ protocolVersion?: unknown }>(
        text,
        response,
        id,
      );
      if (envelope.error)
        throw new Error(`MCP error: ${rpcErrorMessage(envelope.error)}`);
      const negotiated = envelope.result?.protocolVersion;
      this.protocolVersion =
        typeof negotiated === "string" && negotiated
          ? negotiated
          : MCP_LATEST_PROTOCOL_VERSION;
      const sessionId = headerValue(response, "mcp-session-id");
      if (sessionId) this.sessionId = sessionId;
      this.ready = true;
      // Notifications carry no id; a compliant server answers 202 with no body.
      const notification = await this.post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        signal,
      );
      this.throwIfNotOk(notification.response, notification.text);
    } catch (error) {
      this.ready = false;
      this.sessionId = undefined;
      throw error;
    }
  }

  private async rpc<T>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await this.send<T>(method, params, signal);
    } catch (error) {
      if (!(error instanceof McpHttpStatusError) || error.status !== 404)
        throw error;
      // A saved session can expire; drop it for every method so the next
      // request reinitializes instead of replaying the stale session header.
      // A tool call may have side effects, so it is never replayed
      // automatically: the caller decides whether retrying is safe.
      this.sessionId = undefined;
      this.initialized = undefined;
      this.ready = false;
      if (method === "tools/call") throw error;
      // Read-only discovery can safely start a new session and retry.
      await this.ensureInitialized(signal);
      return await this.send<T>(method, params, signal);
    }
  }

  private async send<T>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const id = this.nextId();
    const { response, text } = await this.post(
      { jsonrpc: "2.0", id, method, params },
      signal,
    );
    this.throwIfNotOk(response, text);
    const envelope = this.parseEnvelope<T>(text, response, id);
    if (envelope.error)
      throw new Error(`MCP error: ${rpcErrorMessage(envelope.error)}`);
    return envelope.result as T;
  }

  private async post(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ response: Response; text: string }> {
    const response = await this.fetchImpl(this.server.url, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify(payload),
      signal,
    });
    const text = await readCappedText(response, this.maxResponseBytes);
    return { response, text };
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.ready) headers["MCP-Protocol-Version"] = this.protocolVersion;
    return { ...headers, ...(this.server.headers ?? {}) };
  }

  private throwIfNotOk(response: Response, text: string): void {
    if (response.ok) return;
    const code = rpcErrorCode(text, headerValue(response, "content-type"));
    throw new McpHttpStatusError(response.status, code);
  }

  private parseEnvelope<T>(
    text: string,
    response: Response,
    id: number,
  ): JsonRpcEnvelope<T> {
    const payloads = responsePayloads(
      text,
      headerValue(response, "content-type"),
    );
    for (const payload of payloads) {
      const envelopes = Array.isArray(payload) ? payload : [payload];
      for (const value of envelopes) {
        if (!value || typeof value !== "object") continue;
        const envelope = value as JsonRpcEnvelope<T>;
        if (envelope.id === id) return envelope;
      }
    }
    throw new Error("MCP response did not match the request");
  }

  private nextId(): number {
    this.requestId += 1;
    return this.requestId;
  }
}

function headerValue(response: Response, name: string): string {
  try {
    return response.headers?.get?.(name) ?? "";
  } catch {
    return "";
  }
}

function rpcErrorMessage(error: { message?: string }): string {
  return sanitizeErrorText(error.message || "MCP error");
}

function sanitizeErrorText(value: unknown): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_ERROR_MESSAGE_CHARACTERS
    ? `${text.slice(0, MAX_ERROR_MESSAGE_CHARACTERS)}…`
    : text;
}

function safeErrorMessage(error: unknown): string {
  return sanitizeErrorText(
    error instanceof Error ? error.message : String(error),
  );
}

/** Cap buffering so a hostile server cannot exhaust the host's memory. */
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(headerValue(response, "content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`MCP response exceeds ${maxBytes} bytes`);
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw new Error(`MCP response exceeds ${maxBytes} bytes`);
    return text;
  }
  const reader = body.getReader() as unknown as ByteReader;
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`MCP response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      /* The reader was already cancelled. */
    }
  }
}

function responsePayloads(text: string, contentType: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (
    contentType.includes("text/event-stream") ||
    /(^|\n)(?:data|event):/.test(trimmed)
  )
    return sseData(trimmed).map(parseJsonPayload);
  return [parseJsonPayload(trimmed)];
}

function parseJsonPayload(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Never copy a server body into an error surfaced to the model.
    throw new Error("MCP response is not valid JSON");
  }
}

/** Server-sent events: concatenate `data:` lines per blank-line-delimited event. */
function sseData(text: string): string[] {
  const output: string[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length) output.push(data.join("\n"));
    data = [];
  };
  for (const line of text.split("\n")) {
    const clean = line.replace(/\r$/, "");
    if (!clean) {
      flush();
      continue;
    }
    if (clean.startsWith(":")) continue;
    if (clean.startsWith("data:")) data.push(clean.slice(5).replace(/^ /, ""));
  }
  flush();
  return output;
}

function rpcErrorCode(text: string, contentType: string): number | undefined {
  try {
    for (const payload of responsePayloads(text, contentType)) {
      const envelopes = Array.isArray(payload) ? payload : [payload];
      for (const value of envelopes) {
        const code = (value as { error?: { code?: unknown } } | null)?.error
          ?.code;
        if (typeof code === "number" && Number.isFinite(code)) return code;
      }
    }
  } catch {
    /* Non-JSON error pages carry no safe code. */
  }
  return undefined;
}
