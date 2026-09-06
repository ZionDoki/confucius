import type {
  JsonSchemaObject,
  ToolDefinition,
  ToolResult,
  ToolRuntimeMeta,
  ToolExecutionContext,
} from "@confucius/protocol";
import { validateArgs, type ToolProvider } from "@confucius/harness";
import { McpHttpClient, type McpServerConfig } from "@confucius/mcp-client";
import { hostFetch } from "../../utils/webPlatform";

export class McpToolProvider implements ToolProvider {
  private tools: ToolDefinition[] = [];

  constructor(
    private readonly client: McpHttpClient,
    private readonly serverId = "external",
  ) {}

  static async connect(config: McpServerConfig): Promise<McpToolProvider> {
    const provider = new McpToolProvider(
      new McpHttpClient(config, hostFetch),
      config.id,
    );
    provider.tools = await provider.client.listTools();
    return provider;
  }

  listTools(): ToolDefinition[] {
    return this.tools;
  }

  getMeta(name: string): ToolRuntimeMeta | null {
    if (!this.tools.some((tool) => tool.name === name)) {
      return null;
    }
    return {
      name: name as ToolRuntimeMeta["name"],
      catalog: "mcp",
      concurrency: "serial",
      mutatesState: true,
      effectClass: "unknown",
    };
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    return this.tools.find((tool) => tool.name === name)?.inputSchema;
  }

  async prepare(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ) {
    const invalid = validateArgs(name, this.getSchema(name), args);
    if (invalid) return invalid;
    context.resources = [`mcp.${this.serverId}`];
    context.preparedOperation = {
      schemaVersion: 1,
      domain: "mcp",
      name,
      args: { ...args },
      resources: context.resources,
      recovery: { serverId: this.serverId },
    };
    return null;
  }

  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    return this.client.call(name, args, signal);
  }
}
