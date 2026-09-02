import type {
  JsonSchemaObject,
  ToolDefinition,
  ToolResult,
  ToolRuntimeMeta,
} from "@confucius/protocol";
import type { ToolProvider } from "@confucius/harness";
import {
  ConversationLogEngine,
  MemoryEngine,
  callMemoryCatalogTool,
  type MemoryFileSystem,
} from "@confucius/memory";
import { TOOL_DEFINITIONS, TOOL_META } from "@confucius/zotero-tools";

/** IOUtils-backed filesystem so memories live as plain markdown files. */
class ZoteroMemoryFs implements MemoryFileSystem {
  async readFile(path: string): Promise<string> {
    return IOUtils.readUTF8(nativePath(path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = nativePath(path);
    await IOUtils.makeDirectory(PathUtils.parent(target)!, {
      ignoreExisting: true,
    });
    await IOUtils.writeUTF8(target, content);
  }

  async deleteFile(path: string): Promise<void> {
    await IOUtils.remove(nativePath(path));
  }

  async listFiles(dir: string): Promise<string[]> {
    const target = nativePath(dir);
    if (!(await IOUtils.exists(target))) {
      return [];
    }
    const children = await IOUtils.getChildren(target);
    return children.map((path) => path.replace(/\\/g, "/")).sort() as string[];
  }

  async makeDirectory(dir: string): Promise<void> {
    await IOUtils.makeDirectory(nativePath(dir), { ignoreExisting: true });
  }
}

function nativePath(path: string): string {
  const separator = Zotero.DataDirectory.dir.includes("\\") ? "\\" : "/";
  return path.replace(/[\\/]/g, separator);
}

export function createMemoryEngine(): MemoryEngine {
  const root = PathUtils.join(Zotero.DataDirectory.dir, "confucius", "memory");
  return new MemoryEngine({
    fs: new ZoteroMemoryFs(),
    root,
    onWarn: (message) => ztoolkit.log(`[Confucius] memory: ${message}`),
  });
}

export function createConversationLogEngine(): ConversationLogEngine {
  const root = PathUtils.join(Zotero.DataDirectory.dir, "confucius", "logs");
  return new ConversationLogEngine({
    fs: new ZoteroMemoryFs(),
    root,
    onWarn: (message) => ztoolkit.log(`[Confucius] logs: ${message}`),
  });
}

const MEMORY_TOOL_NAMES = new Set([
  "memory_search",
  "memory_list",
  "memory_save",
  "memory_update",
  "memory_delete",
  "knowledge_base_list",
  "knowledge_base_get",
  "knowledge_base_search",
  "knowledge_base_create",
  "knowledge_base_update",
  "knowledge_base_save_entry",
  "conversation_log_search",
  "conversation_log_read",
]);

/** ToolProvider over the persistent memory engine and conversation logs. */
export class ConfuciusMemoryToolProvider implements ToolProvider {
  constructor(
    private readonly engine: MemoryEngine,
    private readonly logs?: ConversationLogEngine,
  ) {}

  listTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS.filter((tool) => MEMORY_TOOL_NAMES.has(tool.name));
  }

  getMeta(name: string): ToolRuntimeMeta | null {
    return MEMORY_TOOL_NAMES.has(name) ? (TOOL_META[name] ?? null) : null;
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    return MEMORY_TOOL_NAMES.has(name)
      ? (TOOL_DEFINITIONS.find((tool) => tool.name === name)?.inputSchema ??
          undefined)
      : undefined;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ToolResult> {
    return callMemoryCatalogTool(this.engine, this.logs, name, args);
  }
}
