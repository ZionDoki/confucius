import type { JsonSchemaObject, ToolDefinition, ToolResult } from "@confucius/protocol";
import { mcpToolName } from "@confucius/protocol";

export interface McpServerConfig {
  id: string;
  url: string;
  headers?: Record<string, string>;
}

interface JsonRpcEnvelope<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { message?: string };
}

export class McpHttpClient {
  constructor(
    private readonly server: McpServerConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.rpc<{
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: JsonSchemaObject;
      }>;
    }>("tools/list", {});
    return (result.tools ?? []).map((tool) => ({
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
      const result = await this.rpc<{ content?: unknown }>(
        "tools/call",
        { name: rawName, arguments: args },
        signal,
      );
      return {
        ok: true,
        toolName: prefixedName,
        data: result,
      };
    } catch (error) {
      return {
        ok: false,
        toolName: prefixedName,
        code: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async rpc<T>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(this.server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.server.headers ?? {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const envelope = JSON.parse(text) as JsonRpcEnvelope<T>;
    if (envelope.error) {
      throw new Error(envelope.error.message || "MCP error");
    }
    return envelope.result as T;
  }
}
