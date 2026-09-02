import type {
  JsonSchemaObject,
  ToolDefinition,
  ToolResult,
  ToolRuntimeMeta,
} from "@confucius/protocol";
import type { ToolProvider } from "@confucius/harness";
import { McpHttpClient, type McpServerConfig } from "@confucius/mcp-client";
import { hostFetch } from "../../utils/webPlatform";

export class McpToolProvider implements ToolProvider {
  private tools: ToolDefinition[] = [];

  constructor(private readonly client: McpHttpClient) {}

  static async connect(config: McpServerConfig): Promise<McpToolProvider> {
    const provider = new McpToolProvider(new McpHttpClient(config, hostFetch));
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
      mutatesState: false,
    };
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    return this.tools.find((tool) => tool.name === name)?.inputSchema;
  }

  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    return this.client.call(name, args, signal);
  }
}
