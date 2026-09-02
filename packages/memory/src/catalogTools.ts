import type { ToolResult } from "@confucius/protocol";
import type { MemoryEngine } from "./engine";
import {
  KnowledgeBaseService,
  isKnowledgeEntryType,
  type KnowledgeEntryType,
} from "./knowledge";
import type { ConversationLogEngine } from "./logs";
import { isMemoryType, type MemoryType } from "./types";

function asMemoryType(value: unknown): MemoryType {
  return isMemoryType(value) ? value : "fact";
}

function asKnowledgeKind(value: unknown): KnowledgeEntryType | null {
  return isKnowledgeEntryType(value) ? value : null;
}

function asTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map(String).filter(Boolean);
}

function invalidArgs(toolName: string, message: string): ToolResult {
  return { ok: false, toolName, code: "invalid_args", message };
}

function notFound(toolName: string, message: string): ToolResult {
  return { ok: false, toolName, code: "not_found", message };
}

/**
 * Shipped memory / knowledge / conversation-log tool bodies.
 * AgentHost wraps this with HookedToolProvider so every read is visible
 * to promotion; this function itself does not record hits.
 */
export async function callMemoryCatalogTool(
  engine: MemoryEngine,
  logs: ConversationLogEngine | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const knowledge = new KnowledgeBaseService(engine);
  try {
    switch (name) {
      case "memory_search": {
        const results = await engine.search({
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
        const records = await engine.list({
          type: args.type ? asMemoryType(args.type) : undefined,
          tags: asTags(args.tags),
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
        const record = await engine.save({
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
        const record = await engine.update({
          id: String(args.id ?? ""),
          content: args.content ? String(args.content) : undefined,
          title: args.title ? String(args.title) : undefined,
          tags: asTags(args.tags),
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
        const id = String(args.id ?? "");
        const removed = await engine.delete(id);
        return removed
          ? { ok: true, toolName: name, data: { id } }
          : {
              ok: false,
              toolName: name,
              code: "not_found",
              message: `No memory with id ${id}`,
            };
      }
      case "knowledge_base_list": {
        const bases = await knowledge.list({
          query: args.query ? String(args.query) : undefined,
          limit: Number(args.limit) || undefined,
        });
        return { ok: true, toolName: name, data: { knowledgeBases: bases } };
      }
      case "knowledge_base_get": {
        const requestedKind = args.kind
          ? asKnowledgeKind(args.kind)
          : undefined;
        if (requestedKind === null) {
          return invalidArgs(name, "Unknown knowledge entry kind");
        }
        const knowledgeBase = await knowledge.get(String(args.id ?? ""), {
          kind: requestedKind,
          limit: Number(args.limit) || undefined,
        });
        return knowledgeBase
          ? { ok: true, toolName: name, data: { knowledgeBase } }
          : notFound(
              name,
              `No knowledge base with id ${String(args.id ?? "")}`,
            );
      }
      case "knowledge_base_search": {
        const requestedKind = args.kind
          ? asKnowledgeKind(args.kind)
          : undefined;
        if (requestedKind === null) {
          return invalidArgs(name, "Unknown knowledge entry kind");
        }
        const hits = await knowledge.search({
          query: String(args.query ?? ""),
          knowledgeBaseId: args.knowledgeBaseId
            ? String(args.knowledgeBaseId)
            : undefined,
          kind: requestedKind,
          limit: Number(args.limit) || undefined,
        });
        return {
          ok: true,
          toolName: name,
          data: {
            results: hits.map((hit) => ({ ...hit.entry, score: hit.score })),
          },
        };
      }
      case "knowledge_base_create": {
        const knowledgeBase = await knowledge.create({
          title: String(args.title ?? ""),
          description: args.description ? String(args.description) : undefined,
          tags: asTags(args.tags),
        });
        return { ok: true, toolName: name, data: { knowledgeBase } };
      }
      case "knowledge_base_update": {
        const knowledgeBase = await knowledge.update({
          id: String(args.id ?? ""),
          title: args.title === undefined ? undefined : String(args.title),
          description:
            args.description === undefined
              ? undefined
              : String(args.description),
          tags: asTags(args.tags),
        });
        return knowledgeBase
          ? { ok: true, toolName: name, data: { knowledgeBase } }
          : notFound(
              name,
              `No knowledge base with id ${String(args.id ?? "")}`,
            );
      }
      case "conversation_log_search": {
        if (!logs) {
          return {
            ok: false,
            toolName: name,
            code: "unavailable",
            message: "Conversation logs are not available",
          };
        }
        const results = await logs.search(
          String(args.query ?? ""),
          Number(args.limit) || undefined,
        );
        return {
          ok: true,
          toolName: name,
          data: {
            results: results.map((hit) => ({
              sessionId: hit.sessionId,
              title: hit.title,
              excerpt: hit.excerpt,
              score: hit.score,
              turnCount: hit.turnCount,
              updatedAt: hit.updatedAt,
            })),
          },
        };
      }
      case "conversation_log_read": {
        if (!logs) {
          return {
            ok: false,
            toolName: name,
            code: "unavailable",
            message: "Conversation logs are not available",
          };
        }
        const log = await logs.read(String(args.sessionId ?? ""), {
          query: args.query ? String(args.query) : undefined,
          maxChars: Number(args.maxChars) || undefined,
        });
        return log
          ? {
              ok: true,
              toolName: name,
              data: { log: { ...log, sessionId: log.id } },
            }
          : notFound(
              name,
              `No conversation log for session ${String(args.sessionId ?? "")}`,
            );
      }
      case "knowledge_base_save_entry": {
        const kind = asKnowledgeKind(args.kind);
        if (!kind) {
          return invalidArgs(name, "Unknown knowledge entry kind");
        }
        const hasSource =
          Number(args.libraryID) > 0 && String(args.key ?? "").trim();
        const entry = await knowledge.saveEntry({
          id: args.id ? String(args.id) : undefined,
          knowledgeBaseId: String(args.knowledgeBaseId ?? ""),
          kind,
          title: String(args.title ?? ""),
          content: String(args.content ?? ""),
          tags: asTags(args.tags),
          source: hasSource
            ? { libraryID: Number(args.libraryID), key: String(args.key) }
            : undefined,
          clearSource: args.clearSource === true,
        });
        return entry
          ? { ok: true, toolName: name, data: { entry } }
          : notFound(name, "Knowledge base or existing entry was not found");
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
