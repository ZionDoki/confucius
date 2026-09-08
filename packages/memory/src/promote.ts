import type { AppliedChange, MemoryEngine } from "./engine";
import type { ConversationLogEngine, LogSearchHit } from "./logs";

/** Tag applied when a repeatedly retrieved log excerpt becomes a durable memory. */
export const PROMOTED_FROM_LOG_TAG = "promoted-from-log";
/** Tag applied when a memory is retrieved often enough to stay in the system prompt. */
export const PINNED_TAG = "confucius:pinned";

/** Distinct log retrievals before an excerpt is proposed as a memory. */
export const LOG_PROMOTE_HITS = 3;
/** Distinct memory retrievals before a memory is pinned into the system prompt. */
export const MEMORY_PIN_HITS = 8;

export interface PromotionOptions {
  logPromoteHits?: number;
  memoryPinHits?: number;
  propose?: (op: import("./types").MemoryOp, sourceId: string) => Promise<void>;
}

/** @deprecated Search frequency no longer creates or pins memories. Kept for old integrations. */
export class MemoryPromotion {
  constructor(
    _memory: MemoryEngine,
    _logs: ConversationLogEngine,
    _options: PromotionOptions = {},
  ) {}
  async considerLogHits(
    _hits: LogSearchHit[],
    _query: string,
  ): Promise<AppliedChange[]> {
    return [];
  }
  async considerMemoryHits(_ids: string[]): Promise<string[]> {
    return [];
  }
}

export function isPinned(tags: string[] | undefined): boolean {
  return Boolean(tags?.includes(PINNED_TAG));
}

export function isPromotedFromLog(tags: string[] | undefined): boolean {
  return Boolean(tags?.includes(PROMOTED_FROM_LOG_TAG));
}

export function logHitsFromToolData(data: unknown): LogSearchHit[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
  const rows = Array.isArray(record.results)
    ? record.results
    : record.log && typeof record.log === "object"
      ? [record.log]
      : [];
  const hits: LogSearchHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const item = row as Record<string, unknown>;
    const sessionId = String(item.sessionId ?? item.id ?? "").trim();
    const excerpt = String(item.excerpt ?? "").trim();
    if (!sessionId || !excerpt) {
      continue;
    }
    hits.push({
      sessionId,
      title: String(item.title ?? ""),
      excerpt,
      score: Number(item.score) || 0,
      turnCount: Number(item.turnCount) || 0,
      updatedAt: Number(item.updatedAt) || 0,
    });
  }
  return hits;
}

export function memoryIdsFromToolData(data: unknown): string[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
  const rows = Array.isArray(record.results)
    ? record.results
    : Array.isArray(record.memories)
      ? record.memories
      : [];
  const ids: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const id = String((row as Record<string, unknown>).id ?? "").trim();
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

export function isConversationLogTool(name: string): boolean {
  return (
    name === "conversation_log_search" ||
    name === "conversation_log_read" ||
    name.startsWith("conversation_log_")
  );
}

export function isMemoryReadTool(name: string): boolean {
  return name === "memory_search" || name === "memory_list";
}

export interface ToolAccessInfo {
  toolName: string;
  args: Record<string, unknown>;
  result: { ok: boolean; data?: unknown };
}

export interface AccessHookOutcome {
  promoted: AppliedChange[];
  pinned: string[];
}

/** @deprecated Reads/searches are separated by context_read; this compatibility hook is inert. */
export async function applyToolAccessHook(
  _promotion: MemoryPromotion,
  _logs: ConversationLogEngine,
  _info: ToolAccessInfo,
): Promise<AccessHookOutcome> {
  return { promoted: [], pinned: [] };
}

/** Strip transcript markup so promoted memories read as facts, not logs. */
export function durableExcerpt(excerpt: string): string {
  return excerpt
    .replace(/\*\*(user|assistant):\*\*\s*/gi, "")
    .replace(/\*\*(tool[^*]*):\*\*\s*/gi, "$1: ")
    .replace(/^##\s+.+$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
