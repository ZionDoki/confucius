import type { MemoryFileSystem } from "./fs";
import { MemoryRetriever } from "./retrieval";
import { FileMemoryStore } from "./store";
import type {
  MemoryOp,
  MemoryListOptions,
  MemoryQuery,
  MemoryRecord,
  MemorySearchResult,
  MemoryStats,
  MemoryType,
} from "./types";
import { jaccard } from "./tokenize";
import {
  CONTEXT_POLICY,
  contextTextHead,
  contextTextTokens,
} from "@confucius/protocol";

const NEAR_DUPLICATE_THRESHOLD = 0.8;

export interface AppliedChange {
  op: "add" | "update" | "delete";
  id: string;
  title?: string;
}

export interface MemoryEngineOptions {
  fs: MemoryFileSystem;
  root: string;
  now?: () => number;
  idFactory?: () => string;
  onWarn?: (message: string) => void;
}

/**
 * Bounded work memory with explicit-read retention and protected user records.
 * Ordinary updates discard old bodies; automatic de-duplication requires exact
 * text. Retrieval indexes change with storage, never with search activity.
 */
export class MemoryEngine {
  readonly store: FileMemoryStore;
  private readonly retriever = new MemoryRetriever();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private loaded = false;
  private loading?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: MemoryEngineOptions) {
    this.store = new FileMemoryStore(options.fs, options.root, {
      onWarn: options.onWarn,
    });
    this.now = options.now ?? Date.now;
    this.idFactory =
      options.idFactory ??
      (() => `mem_${Math.random().toString(16).slice(2, 10)}`);
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading)
      this.loading = (async () => {
        await this.store.load();
        for (const record of this.store.all()) {
          if (record.retentionVersion === 1) continue;
          await this.store.put({
            ...record,
            retentionVersion: 1,
            lastUsedAt: undefined,
            retentionStartedAt: this.now(),
            accessCount: 0,
            protection: record.tags.includes("promoted-from-log")
              ? "none"
              : "user",
            sourceRefs: record.sourceSessionId
              ? [`task:${record.sourceSessionId}`]
              : [],
          });
        }
        await this.store.flushIndex();
        this.reindex();
        this.loaded = true;
      })().finally(() => {
        this.loading = undefined;
      });
    await this.loading;
  }

  private reindex(): void {
    this.retriever.index(this.store.all());
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(async () => {
      try {
        return await work();
      } finally {
        this.reindex();
        await this.store.flushIndex();
      }
    });
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async search(query: MemoryQuery): Promise<MemorySearchResult[]> {
    await this.ensureLoaded();
    const timestamp = this.now();
    const results = this.retriever.search(
      { ...query, limit: query.limit ?? 6 },
      timestamp,
    );
    return results;
  }

  /** Explicit model reads, not searches or prompt assembly, renew retention. */
  async read(id: string): Promise<MemoryRecord | undefined> {
    await this.ensureLoaded();
    return this.serialize(async () => {
      const record = this.store.get(id);
      if (!record) return undefined;
      const previous = {
        lastUsedAt: record.lastUsedAt,
        lastAccessedAt: record.lastAccessedAt,
        accessCount: record.accessCount,
      };
      this.store.touch(id, this.now());
      try {
        await this.store.flushAccess();
      } catch (error) {
        Object.assign(record, previous);
        throw error;
      }
      return {
        ...record,
        tags: [...record.tags],
        sourceRefs: [...(record.sourceRefs ?? [])],
      };
    });
  }

  async reconcile(id: string) {
    await this.ensureLoaded();
    return this.serialize(() => this.store.recover(id, true));
  }

  retentionStats() {
    const records = this.store
      .all()
      .filter((record) => !isKnowledgeRecord(record));
    return {
      entries: records.length,
      tokens: records.reduce((sum, record) => sum + memoryTokens(record), 0),
      protected: records.filter((record) => record.protection !== "none")
        .length,
      maxEntries: CONTEXT_POLICY.memoryEntries,
      maxTokens: CONTEXT_POLICY.memoryTokens,
    };
  }

  private victims(
    records: MemoryRecord[],
    incoming?: MemoryRecord,
  ): MemoryRecord[] {
    let count = records.length;
    let tokens = records.reduce((sum, record) => sum + memoryTokens(record), 0);
    const candidates = records
      .filter(
        (record) => record.id !== incoming?.id && record.protection === "none",
      )
      .sort(
        (a, b) =>
          (a.lastUsedAt ?? a.retentionStartedAt ?? a.createdAt) -
            (b.lastUsedAt ?? b.retentionStartedAt ?? b.createdAt) ||
          a.id.localeCompare(b.id),
      );
    const victims: MemoryRecord[] = [];
    for (const record of candidates) {
      const expired =
        this.now() -
          (record.lastUsedAt ??
            record.retentionStartedAt ??
            record.createdAt) >=
        CONTEXT_POLICY.memoryIdleDays * 86400000;
      if (
        !expired &&
        count <= CONTEXT_POLICY.memoryEntries &&
        tokens <= CONTEXT_POLICY.memoryTokens
      )
        continue;
      victims.push(record);
      count--;
      tokens -= memoryTokens(record);
    }
    if (
      incoming &&
      (count > CONTEXT_POLICY.memoryEntries ||
        tokens > CONTEXT_POLICY.memoryTokens)
    ) {
      throw new Error(
        "Memory capacity exceeded; protected entries must be edited or cleared before adding more memory",
      );
    }
    return victims;
  }

  /** Save first; only then evict. A failed write must never delete old memory. */
  private async putWithinBudget(record: MemoryRecord): Promise<void> {
    if (isKnowledgeRecord(record)) return this.store.put(record);
    const records = [
      ...this.store
        .all()
        .filter((entry) => entry.id !== record.id && !isKnowledgeRecord(entry)),
      record,
    ];
    const victims = this.victims(records, record);
    await this.store.put(record);
    for (const victim of victims) await this.store.remove(victim.id);
  }

  async maintain(): Promise<AppliedChange[]> {
    await this.ensureLoaded();
    return this.serialize(async () => {
      const victims = this.victims(
        this.store.all().filter((record) => !isKnowledgeRecord(record)),
      );
      const removed: AppliedChange[] = [];
      try {
        for (const record of victims) {
          if (await this.store.remove(record.id))
            removed.push({ op: "delete", id: record.id, title: record.title });
        }
      } finally {
        if (removed.length) await this.store.rebuildIndex();
        this.reindex();
      }
      return removed;
    });
  }

  async list(options: MemoryListOptions = {}): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    const all = this.store.all();
    let filtered = options.type
      ? all.filter((record) => record.type === options.type)
      : all;
    const tags = (options.tags ?? [])
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    if (tags.length > 0) {
      filtered = filtered.filter((record) => {
        const own = new Set(record.tags.map((tag) => tag.toLowerCase()));
        return options.tagsMode === "any"
          ? tags.some((tag) => own.has(tag))
          : tags.every((tag) => own.has(tag));
      });
    }
    return filtered.slice(0, Math.max(1, options.limit ?? 50));
  }

  stats(): MemoryStats {
    return this.store.stats();
  }

  get(id: string): MemoryRecord | undefined {
    return this.store.get(id);
  }

  /** Lexically similar memories; used to keep extraction honest and cheap. */
  async findNearDuplicates(content: string): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    return this.store
      .all()
      .filter(
        (record) =>
          jaccard(record.content, content) >= NEAR_DUPLICATE_THRESHOLD,
      );
  }

  async save(input: {
    /** Host-preallocated identity for an approved, replayable creation. */
    id?: string;
    content: string;
    type?: MemoryType;
    title?: string;
    tags?: string[];
    confidence?: number;
    sourceSessionId?: string;
    protection?: "user" | "none";
    sourceRefs?: string[];
  }): Promise<MemoryRecord> {
    await this.ensureLoaded();
    const timestamp = this.now();
    const content = input.content.trim();
    const record: MemoryRecord = {
      id: input.id ?? this.idFactory(),
      type: input.type ?? "fact",
      title: (input.title ?? contextTextHead(content, 64)).trim(),
      content,
      tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
      sourceSessionId: input.sourceSessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAccessedAt: timestamp,
      retentionStartedAt: timestamp,
      protection: input.protection ?? "user",
      sourceRefs:
        input.sourceRefs ??
        (input.sourceSessionId ? [`task:${input.sourceSessionId}`] : []),
      retentionVersion: 1,
      accessCount: 0,
      confidence: clamp01(input.confidence ?? 0.9),
      history: [],
    };
    const saved = await this.serialize(async () => {
      const existing = input.id
        ? await this.store.recover(input.id)
        : undefined;
      if (!existing) await this.putWithinBudget(record);
      await this.store.rebuildIndex();
      return existing ?? record;
    });
    this.reindex();
    return saved;
  }

  async update(
    input: {
      id: string;
      type?: MemoryType;
      content?: string;
      title?: string;
      tags?: string[];
      confidence?: number;
      protection?: "user" | "none";
      sourceRefs?: string[];
    },
    ordinaryOnly = false,
  ): Promise<MemoryRecord | null> {
    await this.ensureLoaded();
    return this.serialize(async () => {
      const existing = this.store.get(input.id);
      if (
        existing &&
        ordinaryOnly &&
        (existing.protection !== "none" || isKnowledgeRecord(existing))
      )
        throw new Error("Protected memory requires confirmation");
      if (!existing) {
        return null;
      }
      const content = input.content?.trim() ?? existing.content;
      const next: MemoryRecord = {
        ...existing,
        type: input.type ?? existing.type,
        title: input.title?.trim() || existing.title,
        content,
        tags:
          input.tags === undefined
            ? existing.tags
            : input.tags.map((tag) => tag.trim()).filter(Boolean),
        confidence: clamp01(input.confidence ?? existing.confidence),
        protection: input.protection ?? existing.protection,
        sourceRefs: input.sourceRefs ?? existing.sourceRefs,
        updatedAt: this.now(),
        history:
          (input.protection ?? existing.protection) === "none"
            ? []
            : content === existing.content
              ? existing.history
              : [
                  { at: existing.updatedAt, content: existing.content },
                  ...existing.history,
                ].slice(0, 10),
      };
      await this.putWithinBudget(next);
      await this.store.rebuildIndex();
      return next;
    });
  }

  async delete(id: string, ordinaryOnly = false): Promise<boolean> {
    await this.ensureLoaded();
    return this.serialize(async () => {
      const record = this.store.get(id);
      if (
        record &&
        ordinaryOnly &&
        (record.protection !== "none" || isKnowledgeRecord(record))
      )
        throw new Error("Protected memory requires confirmation");
      const removed = await this.store.remove(id);
      if (removed) await this.store.rebuildIndex();
      return removed;
    });
  }

  /**
   * Apply Mem0-style operations from the extraction pipeline. Update and
   * delete ops for unknown ids are skipped (the model must not invent ids).
   * Returns what actually changed so the host can emit events.
   */
  async applyOps(
    ops: MemoryOp[],
    sourceSessionId?: string,
  ): Promise<AppliedChange[]> {
    await this.ensureLoaded();
    const changes: AppliedChange[] = [];
    await this.serialize(async () => {
      for (const op of ops) {
        if (op.op === "add") {
          const duplicates = this.store
            .all()
            .filter(
              (record) =>
                jaccard(record.content, op.content) >= NEAR_DUPLICATE_THRESHOLD,
            );
          if (duplicates.length > 0) {
            // Near-duplicate: fold into the existing memory instead of a new file.
            const target = duplicates[0];
            const next: MemoryRecord = {
              ...target,
              content: op.content,
              confidence: clamp01(op.confidence ?? target.confidence),
              updatedAt: this.now(),
              history: [
                { at: target.updatedAt, content: target.content },
                ...target.history,
              ].slice(0, 10),
            };
            await this.putWithinBudget(next);
            changes.push({ op: "update", id: next.id, title: next.title });
            continue;
          }
          const record: MemoryRecord = {
            id: this.idFactory(),
            type: op.type,
            title: op.title.trim() || contextTextHead(op.content, 64),
            content: op.content.trim(),
            tags: op.tags ?? [],
            sourceSessionId,
            createdAt: this.now(),
            updatedAt: this.now(),
            lastAccessedAt: this.now(),
            retentionStartedAt: this.now(),
            protection: "user",
            retentionVersion: 1,
            sourceRefs: sourceSessionId ? [`task:${sourceSessionId}`] : [],
            accessCount: 0,
            confidence: clamp01(op.confidence ?? 0.7),
            history: [],
          };
          await this.putWithinBudget(record);
          changes.push({ op: "add", id: record.id, title: record.title });
        } else if (op.op === "update") {
          const existing = this.store.get(op.id);
          if (!existing) {
            continue;
          }
          const next: MemoryRecord = {
            ...existing,
            protection: op.protection ?? existing.protection,
            title: op.title?.trim() || existing.title,
            content: op.content.trim(),
            tags:
              op.tags === undefined
                ? existing.tags
                : op.tags.map((tag) => tag.trim()).filter(Boolean),
            confidence: clamp01(op.confidence ?? existing.confidence),
            updatedAt: this.now(),
            history:
              op.content.trim() === existing.content
                ? existing.history
                : [
                    { at: existing.updatedAt, content: existing.content },
                    ...existing.history,
                  ].slice(0, 10),
          };
          await this.putWithinBudget(next);
          changes.push({ op: "update", id: next.id, title: next.title });
        } else if (op.op === "delete") {
          const existing = this.store.get(op.id);
          if (!existing) {
            continue;
          }
          await this.store.remove(op.id);
          changes.push({ op: "delete", id: op.id, title: existing.title });
        }
      }
      if (changes.length > 0) {
        await this.store.rebuildIndex();
      }
    });
    this.reindex();
    return changes;
  }

  /** Automatic work memory cannot alter protected entries or user knowledge bases.
   * Stable ids make a replayed maintenance batch idempotent. */
  async applyOrdinaryOps(
    ops: MemoryOp[],
    sourceSessionId: string,
    batchId: string,
    sourceRefs: string[] = [],
  ): Promise<AppliedChange[]> {
    await this.ensureLoaded();
    const changes: AppliedChange[] = [];
    for (const [index, op] of ops.entries()) {
      if (op.op === "add") {
        const duplicate = this.store
          .all()
          .find(
            (record) =>
              !isKnowledgeRecord(record) &&
              record.content.trim() === op.content.trim(),
          );
        if (duplicate?.protection !== "none" && duplicate) continue;
        if (duplicate) {
          await this.update(
            {
              id: duplicate.id,
              content: op.content,
              sourceRefs: [
                ...new Set([...(duplicate.sourceRefs ?? []), ...sourceRefs]),
              ].slice(0, 20),
            },
            true,
          );
          changes.push({
            op: "update",
            id: duplicate.id,
            title: duplicate.title,
          });
        } else {
          const saved = await this.save({
            ...op,
            id: `mem_${batchId}_${index}`,
            sourceSessionId,
            protection: "none",
            sourceRefs,
          });
          changes.push({ op: "add", id: saved.id, title: saved.title });
        }
      } else {
        const record = this.store.get(op.id);
        if (
          !record ||
          record.protection !== "none" ||
          isKnowledgeRecord(record)
        )
          continue;
        if (op.op === "delete") {
          await this.delete(op.id, true);
          changes.push({ op: "delete", id: op.id, title: record.title });
        } else {
          await this.update(
            {
              ...op,
              protection: undefined,
              sourceRefs: [
                ...new Set([...(record.sourceRefs ?? []), ...sourceRefs]),
              ].slice(0, 20),
            },
            true,
          );
          changes.push({
            op: "update",
            id: op.id,
            title: op.title ?? record.title,
          });
        }
      }
    }
    return changes;
  }

  /** Persist any deferred access counters (call at turn end). */
  async flush(): Promise<void> {
    await this.serialize(() => this.store.flushAccess());
  }
}

export function isKnowledgeRecord(record: MemoryRecord): boolean {
  return (
    record.tags.includes("confucius:knowledge-base") ||
    record.tags.includes("confucius:knowledge-entry")
  );
}

function memoryTokens(record: MemoryRecord): number {
  return contextTextTokens(
    record.content + record.history.map((entry) => entry.content).join("\n"),
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.6;
  }
  return Math.min(1, Math.max(0, value));
}
