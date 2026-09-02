import { KNOWLEDGE_BASE_TAG, KNOWLEDGE_ENTRY_TAG } from "./knowledge";
import type { AppliedChange, MemoryEngine } from "./engine";
import type { ConversationLogEngine, LogSearchHit } from "./logs";

/** Tag applied when a repeatedly retrieved log excerpt becomes a durable memory. */
export const PROMOTED_FROM_LOG_TAG = "promoted-from-log";
/** Tag applied when a memory is retrieved often enough to stay in the system prompt. */
export const PINNED_TAG = "confucius:pinned";

/** Distinct log retrievals before an excerpt is written as a memory. */
export const LOG_PROMOTE_HITS = 3;
/** Distinct memory retrievals before a memory is pinned into the system prompt. */
export const MEMORY_PIN_HITS = 8;
const MAX_PROMOTIONS_PER_CALL = 2;
const MIN_EXCERPT_CHARS = 48;

export interface PromotionOptions {
  logPromoteHits?: number;
  memoryPinHits?: number;
}

/**
 * Rehearsal-based promotion:
 *
 * - Logs (episodic) stay on disk forever. Repeated retrieval of the same
 *   excerpt distills it into a durable memory (semantic).
 * - Memories that keep being retrieved are pinned so they always ride in
 *   the system prompt, instead of competing with one-off search hits.
 *
 * The policy is deterministic and model-free: frequency is the signal,
 * Jaccard near-duplicate checks prevent flooding the store.
 */
export class MemoryPromotion {
  private readonly logPromoteHits: number;
  private readonly memoryPinHits: number;

  constructor(
    private readonly memory: MemoryEngine,
    private readonly logs: ConversationLogEngine,
    options: PromotionOptions = {},
  ) {
    this.logPromoteHits = options.logPromoteHits ?? LOG_PROMOTE_HITS;
    this.memoryPinHits = options.memoryPinHits ?? MEMORY_PIN_HITS;
  }

  async considerLogHits(
    hits: LogSearchHit[],
    query: string,
  ): Promise<AppliedChange[]> {
    const recorded = await this.logs.recordHits(hits, query);
    const changes: AppliedChange[] = [];
    let promoted = 0;
    for (const candidate of recorded) {
      if (promoted >= MAX_PROMOTIONS_PER_CALL) {
        break;
      }
      if (candidate.count < this.logPromoteHits) {
        continue;
      }
      if (candidate.promotedId) {
        continue;
      }
      const excerpt = durableExcerpt(candidate.excerpt);
      if (excerpt.length < MIN_EXCERPT_CHARS) {
        continue;
      }
      const duplicates = await this.memory.findNearDuplicates(excerpt);
      if (duplicates.length > 0) {
        await this.logs.markPromoted(candidate.hash, duplicates[0].id);
        continue;
      }
      const record = await this.memory.save({
        type: "note",
        title: excerpt.slice(0, 64).replace(/\n/g, " "),
        content: excerpt.slice(0, 800),
        tags: [PROMOTED_FROM_LOG_TAG, `log:${candidate.sessionId}`],
        confidence: 0.75,
        sourceSessionId: candidate.sessionId,
      });
      await this.logs.markPromoted(candidate.hash, record.id);
      changes.push({ op: "add", id: record.id, title: record.title });
      promoted += 1;
    }
    return changes;
  }

  async considerMemoryHits(ids: string[]): Promise<string[]> {
    const pinned: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const record = this.memory.get(id);
      if (!record) {
        continue;
      }
      if (record.accessCount < this.memoryPinHits) {
        continue;
      }
      if (record.tags.includes(PINNED_TAG)) {
        continue;
      }
      if (
        record.tags.includes(KNOWLEDGE_BASE_TAG) ||
        record.tags.includes(KNOWLEDGE_ENTRY_TAG)
      ) {
        continue;
      }
      await this.memory.update({
        id,
        tags: [...record.tags, PINNED_TAG],
        confidence: Math.min(1, record.confidence + 0.1),
      });
      pinned.push(id);
    }
    return pinned;
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

/**
 * Access hook for every log/memory **tool** read. Repeated log excerpts
 * become durable memories; hot memories are pinned. Callers must wrap the
 * real tool provider so this runs after the shipped tool body.
 */
export async function applyToolAccessHook(
  promotion: MemoryPromotion,
  logs: ConversationLogEngine,
  info: ToolAccessInfo,
): Promise<AccessHookOutcome> {
  const promoted: AppliedChange[] = [];
  const pinned: string[] = [];
  if (!info.result.ok) {
    return { promoted, pinned };
  }
  if (isConversationLogTool(info.toolName)) {
    const hits = logHitsFromToolData(info.result.data);
    if (hits.length > 0) {
      promoted.push(
        ...(await promotion.considerLogHits(
          hits,
          String(info.args.query ?? ""),
        )),
      );
    } else if (info.toolName === "conversation_log_read") {
      const sessionId = String(info.args.sessionId ?? "");
      if (sessionId) {
        await logs.touch(sessionId);
      }
    }
  }
  if (isMemoryReadTool(info.toolName)) {
    const ids = memoryIdsFromToolData(info.result.data);
    pinned.push(...(await promotion.considerMemoryHits(ids)));
  }
  return { promoted, pinned };
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
