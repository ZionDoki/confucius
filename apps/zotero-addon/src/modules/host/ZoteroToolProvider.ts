import type {
  JsonSchemaObject,
  ToolDefinition,
  ToolResult,
  ToolRuntimeMeta,
} from "@confucius/protocol";
import type { ToolProvider } from "@confucius/harness";
import { MEMORY_READ_TOOLS, MEMORY_WRITE_TOOLS } from "@confucius/protocol";
import { TOOL_DEFINITIONS, TOOL_META } from "@confucius/zotero-tools";
import type { ZoteroToolHost } from "../tools/ZoteroToolHost";

export class ZoteroToolProvider implements ToolProvider {
  constructor(private readonly host: ZoteroToolHost) {}

  listTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS.filter((tool) => !MEMORY_TOOL_NAMES.has(tool.name));
  }

  getMeta(name: string): ToolRuntimeMeta | null {
    if (MEMORY_TOOL_NAMES.has(name)) {
      return null;
    }
    return TOOL_META[name] ?? null;
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    if (MEMORY_TOOL_NAMES.has(name)) {
      return undefined;
    }
    return TOOL_DEFINITIONS.find((tool) => tool.name === name)?.inputSchema;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ToolResult> {
    return this.host.execute(name, args);
  }
}

const MEMORY_TOOL_NAMES = new Set<string>([
  ...MEMORY_READ_TOOLS,
  ...MEMORY_WRITE_TOOLS,
]);
