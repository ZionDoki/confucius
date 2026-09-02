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
 * Facade over the store and retriever. Owns the Mem0-style decision pipeline:
 * - tool-driven saves run a cheap lexical near-duplicate check first
 * - LLM extraction ops are applied with revision history retained on update
 * - every mutation regenerates the MEMORY.md overview
 */
export class MemoryEngine {
  readonly store: FileMemoryStore;
  private readonly retriever = new MemoryRetriever();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private loaded = false;
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
    if (!this.loaded) {
      await this.store.load();
      this.reindex();
      this.loaded = true;
    }
  }

  private reindex(): void {
    this.retriever.index(this.store.all());
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(work);
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
    for (const result of results) {
      this.store.touch(result.record.id, timestamp);
    }
    this.reindex();
    return results;
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
    content: string;
    type?: MemoryType;
    title?: string;
    tags?: string[];
    confidence?: number;
    sourceSessionId?: string;
  }): Promise<MemoryRecord> {
    await this.ensureLoaded();
    const timestamp = this.now();
    const content = input.content.trim();
    const record: MemoryRecord = {
      id: this.idFactory(),
      type: input.type ?? "fact",
      title: (input.title ?? content.slice(0, 64)).trim(),
      content,
      tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
      sourceSessionId: input.sourceSessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAccessedAt: timestamp,
      accessCount: 0,
      confidence: clamp01(input.confidence ?? 0.9),
      history: [],
    };
    await this.serialize(() =>
      this.store.put(record).then(() => this.store.rebuildIndex()),
    );
    this.reindex();
    return record;
  }

  async update(input: {
    id: string;
    type?: MemoryType;
    content?: string;
    title?: string;
    tags?: string[];
    confidence?: number;
  }): Promise<MemoryRecord | null> {
    await this.ensureLoaded();
    const existing = this.store.get(input.id);
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
      updatedAt: this.now(),
      history:
        content === existing.content
          ? existing.history
          : [
              { at: existing.updatedAt, content: existing.content },
              ...existing.history,
            ].slice(0, 10),
    };
    await this.serialize(() =>
      this.store.put(next).then(() => this.store.rebuildIndex()),
    );
    this.reindex();
    return next;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const existed = await this.serialize(() =>
      this.store
        .remove(id)
        .then((removed) =>
          removed
            ? this.store.rebuildIndex().then(() => true)
            : Promise.resolve(false),
        ),
    );
    this.reindex();
    return existed;
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
            await this.store.put(next);
            changes.push({ op: "update", id: next.id, title: next.title });
            continue;
          }
          const record: MemoryRecord = {
            id: this.idFactory(),
            type: op.type,
            title: op.title.trim() || op.content.slice(0, 64),
            content: op.content.trim(),
            tags: op.tags ?? [],
            sourceSessionId,
            createdAt: this.now(),
            updatedAt: this.now(),
            lastAccessedAt: this.now(),
            accessCount: 0,
            confidence: clamp01(op.confidence ?? 0.7),
            history: [],
          };
          await this.store.put(record);
          changes.push({ op: "add", id: record.id, title: record.title });
        } else if (op.op === "update") {
          const existing = this.store.get(op.id);
          if (!existing) {
            continue;
          }
          const next: MemoryRecord = {
            ...existing,
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
          await this.store.put(next);
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

  /** Persist any deferred access counters (call at turn end). */
  async flush(): Promise<void> {
    await this.serialize(() => this.store.flushAccess());
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.6;
  }
  return Math.min(1, Math.max(0, value));
}
