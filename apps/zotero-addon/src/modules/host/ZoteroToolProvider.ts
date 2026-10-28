import type {
  JsonSchemaObject,
  ToolExecutionContext,
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
    const canonicalName = ORGANIZER_TOOL_ALIASES[name] ?? name;
    return TOOL_META[canonicalName] ?? null;
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    if (MEMORY_TOOL_NAMES.has(name)) {
      return undefined;
    }
    const canonicalName = ORGANIZER_TOOL_ALIASES[name] ?? name;
    return TOOL_DEFINITIONS.find((tool) => tool.name === canonicalName)
      ?.inputSchema;
  }

  async prepare(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) {
    return this.host.prepare(name, args, context);
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    return this.host.execute(name, args, signal, context);
  }
}

const MEMORY_TOOL_NAMES = new Set<string>([
  ...MEMORY_READ_TOOLS,
  ...MEMORY_WRITE_TOOLS,
]);

const ORGANIZER_TOOL_ALIASES: Record<string, string> = {
  outline_get: "organizer_get_outline",
  annotations_list: "organizer_list_annotations",
  annotation_context: "organizer_get_annotation_context",
  annotations_assign: "organizer_assign_annotations",
  annotations_unassign: "organizer_unassign_annotations",
};
