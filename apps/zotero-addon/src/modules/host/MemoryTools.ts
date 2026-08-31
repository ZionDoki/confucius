import type {
  JsonSchemaObject,
  ToolDefinition,
  ToolResult,
  ToolRuntimeMeta,
} from "@confucius/protocol";
import type { ToolProvider } from "@confucius/harness";
import {
  MemoryEngine,
  type MemoryFileSystem,
  type MemoryType,
} from "@confucius/memory";
import { TOOL_DEFINITIONS, TOOL_META } from "@confucius/zotero-tools";

/** IOUtils-backed filesystem so memories live as plain markdown files. */
class ZoteroMemoryFs implements MemoryFileSystem {
  async readFile(path: string): Promise<string> {
    return IOUtils.readUTF8(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await IOUtils.makeDirectory(PathUtils.parent(path)!, {
      ignoreExisting: true,
    });
    await IOUtils.writeUTF8(path, content);
  }

  async deleteFile(path: string): Promise<void> {
    await IOUtils.remove(path);
  }

  async listFiles(dir: string): Promise<string[]> {
    if (!(await IOUtils.exists(dir))) {
      return [];
    }
    const children = await IOUtils.getChildren(dir);
    return children
      .filter((path) => path.endsWith(".md"))
      .sort() as string[];
  }

  async makeDirectory(dir: string): Promise<void> {
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  }
}

export function createMemoryEngine(): MemoryEngine {
  const root = PathUtils.join(
    Zotero.DataDirectory.dir,
    "confucius",
    "memory",
  );
  return new MemoryEngine({
    fs: new ZoteroMemoryFs(),
    root,
    onWarn: (message) => ztoolkit.log(`[Confucius] memory: ${message}`),
  });
}

const MEMORY_TOOL_NAMES = new Set([
  "memory_search",
  "memory_list",
  "memory_save",
  "memory_update",
  "memory_delete",
]);

function asMemoryType(value: unknown): MemoryType {
  return value === "preference" ||
    value === "fact" ||
    value === "project" ||
    value === "paper" ||
    value === "procedure" ||
    value === "insight"
    ? value
    : "fact";
}

function asTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map(String).filter(Boolean);
}

/** ToolProvider over the persistent memory engine. */
export class ConfuciusMemoryToolProvider implements ToolProvider {
  constructor(private readonly engine: MemoryEngine) {}

  listTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS.filter((tool) =>
      MEMORY_TOOL_NAMES.has(tool.name),
    );
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
    try {
      switch (name) {
        case "memory_search": {
          const results = await this.engine.search({
            query: String(args.query ?? ""),
            type: args.type ? asMemoryType(args.type) : undefined,
            tags: asTags(args.tags),
            limit: Number(args.limit) || undefined,
          });
          return {
            ok: true,
            toolName: name,
            data: {
              results: results.map((hit) => ({
                id: hit.record.id,
                type: hit.record.type,
                title: hit.record.title,
                content: hit.record.content,
                tags: hit.record.tags,
                score: hit.score,
              })),
            },
          };
        }
        case "memory_list": {
          const records = await this.engine.list({
            type: args.type ? asMemoryType(args.type) : undefined,
            limit: Number(args.limit) || undefined,
          });
          return {
            ok: true,
            toolName: name,
            data: {
              memories: records.map((record) => ({
                id: record.id,
                type: record.type,
                title: record.title,
                content: record.content,
                tags: record.tags,
                updatedAt: record.updatedAt,
              })),
            },
          };
        }
        case "memory_save": {
          const record = await this.engine.save({
            content: String(args.content ?? ""),
            type: args.type ? asMemoryType(args.type) : undefined,
            title: args.title ? String(args.title) : undefined,
            tags: asTags(args.tags),
          });
          return {
            ok: true,
            toolName: name,
            data: { id: record.id, title: record.title },
          };
        }
        case "memory_update": {
          const record = await this.engine.update({
            id: String(args.id ?? ""),
            content: args.content ? String(args.content) : undefined,
            title: args.title ? String(args.title) : undefined,
          });
          if (!record) {
            return {
              ok: false,
              toolName: name,
              code: "not_found",
              message: `No memory with id ${String(args.id ?? "")}`,
            };
          }
          return {
            ok: true,
            toolName: name,
            data: { id: record.id, title: record.title },
          };
        }
        case "memory_delete": {
          const removed = await this.engine.delete(String(args.id ?? ""));
          return {
            ok: removed,
            toolName: name,
            code: removed ? undefined : "not_found",
            message: removed ? undefined : `No memory with id ${String(args.id ?? "")}`,
          } as ToolResult;
        }
        default:
          return {
            ok: false,
            toolName: name,
            code: "not_found",
            message: `Unknown memory tool: ${name}`,
          };
      }
    } catch (error) {
      return {
        ok: false,
        toolName: name,
        code: "internal",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
