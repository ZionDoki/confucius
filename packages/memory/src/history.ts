import type {
  ContextWindowState,
  HistoryItem,
  HistoryItemRef,
  HistoryTask,
  HistoryRetentionState,
  WorkingNoteState,
  RunState,
} from "@confucius/protocol";
import { CONTEXT_POLICY } from "@confucius/protocol";
import type { MemoryFileSystem } from "./fs";
import { tokenize } from "./tokenize";
import {
  indexPassages,
  passageExcerpt,
  rankPassages,
  type PassageIndex,
  type Passage,
} from "./passages";

import {
  projectSourceCoverage,
  sourceObservation,
  type ProgressRecord,
} from "./coverage";

type TermShard = Record<string, string[] | PassageIndex>;

interface Manifest {
  version: 1;
  deleted?: boolean;
  migrated?: boolean;
  prunedAt?: number;
  cleanupPending?: boolean;
  terms?: Record<string, string[]>;
  termShards?: true;
  passageShards?: string[];
  retainedBytes?: number;
  shardBytes?: Record<string, number>;
  backupBytes?: number;
  manifestBytes?: number;
  retention?: HistoryRetentionState;
  windows: ContextWindowState[];
  items: HistoryItem[];
  sourceProgress?: ProgressRecord[];
  notes: Array<{
    name: string;
    revision: number;
    updatedAt: number;
    characters: number;
    sourceIds?: string[];
    terms?: string[];
    passages?: PassageIndex;
    state?: WorkingNoteState;
  }>;
}
export interface HistoryAppend extends Omit<
  HistoryItem,
  "characters" | "excerpt" | "createdAt"
> {
  content: string;
  createdAt?: number;
}
export interface HistoryQuery {
  /** Host-only identity of the whole source passage, never just the search excerpt. */
  fingerprint?(content: string): Promise<string>;
  taskId?: string;
  taskIds?: string[];
  windowId?: string;
  query?: string;
  offset?: number;
  limit?: number;
  preferredTaskIds?: string[];
  sourceIds?: string[];
}

export interface HistoryExport {
  windows: ContextWindowState[];
  items: Array<HistoryItem & { content?: string; error?: string }>;
  notes: Array<{
    name: string;
    revision: number;
    current: boolean;
    content?: string;
    error?: string;
  }>;
  unindexed: Array<{ path: string; content?: string; error?: string }>;
  issues: string[];
}

const controlTools = new Set([
  "context_search",
  "context_read",
  "context_save",
  "new_context",
  "host_handoff",
]);
const retrievable = (item: Pick<HistoryItem, "purpose" | "toolName">) =>
  item.purpose !== "diagnostic" && !controlTools.has(item.toolName ?? "");
const safeId = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error("Invalid history identifier");
  return id;
};
const textOffset = (text: string, value: number) => {
  let start = bound(value, 0, text.length);
  if (
    start > 0 &&
    /[\uDC00-\uDFFF]/.test(text[start] ?? "") &&
    /[\uD800-\uDBFF]/.test(text[start - 1])
  )
    start--;
  return start;
};
const textEnd = (text: string, start: number, size: number) => {
  const end = textOffset(text, start + size);
  // A one-code-unit page must still advance over a surrogate pair.
  return end === start && start < text.length
    ? Math.min(text.length, start + 2)
    : end;
};
const byteLength = (text: string) => new TextEncoder().encode(text).length;
const bound = (value: number | undefined, fallback: number, max: number) =>
  Number.isFinite(value)
    ? Math.min(max, Math.max(0, Math.floor(value!)))
    : fallback;

/** Bodies are immutable files grouped by context window. Index replacement is atomic.
 * Only registered, non-deleted tasks participate in retrieval; orphan legacy logs do not.
 */
export class HistoryStore {
  private tasks = new Map<string, HistoryTask>();
  private manifests = new Map<string, Manifest>();
  private shards = new Map<string, TermShard>();
  private manifestSizes = new Map<string, number>();
  private shardSizes = new Map<string, number>();
  private loading = new Map<string, Promise<Manifest>>();
  private readers = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly fs: MemoryFileSystem,
    private readonly root: string,
  ) {
    this.root = root.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  register(task: HistoryTask): void {
    safeId(task.id);
    this.tasks.set(task.id, { ...task });
  }
  private path(taskId: string, suffix: string): string {
    return `${this.root}/${safeId(taskId)}/${suffix}`;
  }
  private async load(taskId: string): Promise<Manifest> {
    if (!this.tasks.has(taskId)) throw new Error("History task is unavailable");
    const cached = this.manifests.get(taskId);
    if (cached) {
      this.manifests.delete(taskId);
      this.manifests.set(taskId, cached);
      return cached;
    }
    const loading = this.loading.get(taskId);
    if (loading) return loading;
    const pending = this.loadUncached(taskId);
    this.loading.set(taskId, pending);
    try {
      return await pending;
    } finally {
      this.loading.delete(taskId);
    }
  }
  private async loadUncached(taskId: string): Promise<Manifest> {
    const dir = this.path(taskId, "");
    const files = await this.fs.listFiles(dir);
    const path = this.path(taskId, "index.json");
    let value: Manifest = files.includes(path)
      ? JSON.parse(await this.fs.readFile(path))
      : { version: 1, windows: [], items: [], notes: [] };
    if (
      value.version !== 1 ||
      !Array.isArray(value.items) ||
      !Array.isArray(value.windows) ||
      !Array.isArray(value.notes)
    ) {
      throw new Error(
        "Invalid history index; original files have been retained",
      );
    }
    if (
      !value.termShards ||
      !value.shardBytes ||
      value.retainedBytes === undefined ||
      !value.retention
    ) {
      // One-time, non-destructive migration. A crash leaves the old index usable.
      const backup = this.path(taskId, "index.pre-archive.json");
      if (files.includes(path) && !files.includes(backup))
        await this.fs.writeFile(backup, await this.fs.readFile(path));
      const windows = new Map<string, Record<string, string[]>>();
      for (const item of value.items) {
        const terms = windows.get(item.windowId) ?? {};
        terms[item.itemId] =
          value.terms?.[item.itemId] ??
          (item.purpose === "diagnostic"
            ? []
            : [...new Set(tokenize(await this.body(item)))]);
        windows.set(item.windowId, terms);
      }
      const shardBytes: Record<string, number> = {};
      for (const [window, terms] of windows)
        shardBytes[window] = await this.writeShard(taskId, window, terms);
      let retainedBytes = 0;
      const seen = new Set<string>();
      const visit = async (dir: string): Promise<void> => {
        const prefix = dir.replace(/\/+$/, "") + "/";
        for (const file of await this.fs.listFiles(dir)) {
          if (!file.startsWith(prefix) || seen.has(file)) continue;
          seen.add(file);
          if (file.endsWith(".txt"))
            retainedBytes += this.fs.fileSize
              ? await this.fs.fileSize(file)
              : new TextEncoder().encode(await this.fs.readFile(file)).length;
          else if (!file.slice(prefix.length).includes("/")) await visit(file);
        }
      };
      await visit(this.path(taskId, "windows"));
      await visit(this.path(taskId, "notes"));
      value = {
        ...value,
        terms: undefined,
        termShards: true,
        retainedBytes,
        shardBytes,
        backupBytes:
          files.includes(path) || files.includes(backup)
            ? byteLength(await this.fs.readFile(backup))
            : 0,
        retention: value.retention ?? {
          version: 1,
          tier: value.prunedAt ? "pruned" : "hot",
          prunedAt: value.prunedAt,
        },
      };
      await this.commit(taskId, value);
    }
    this.cacheManifest(taskId, value);
    return value;
  }
  private cacheManifest(taskId: string, value: Manifest): void {
    this.manifests.delete(taskId);
    this.manifests.set(taskId, value);
    this.manifestSizes.set(taskId, byteLength(JSON.stringify(value)));
    while (
      this.manifests.size > CONTEXT_POLICY.indexCacheWindows ||
      [...this.manifestSizes.values()].reduce((n, size) => n + size, 0) >
        CONTEXT_POLICY.indexCacheBytes
    ) {
      const oldest = this.manifests.keys().next().value!;
      this.manifests.delete(oldest);
      this.manifestSizes.delete(oldest);
    }
  }
  private async shard(taskId: string, windowId: string): Promise<TermShard> {
    const key = `${taskId}/${windowId}`;
    const cached = this.shards.get(key);
    if (cached) {
      this.shards.delete(key);
      this.shards.set(key, cached);
      return cached;
    }
    const path = this.path(taskId, `windows/${safeId(windowId)}/terms.json`);
    const files = await this.fs.listFiles(
      this.path(taskId, `windows/${safeId(windowId)}`),
    );
    const value = files.includes(path)
      ? JSON.parse(await this.fs.readFile(path))
      : {};
    this.cacheShard(key, value);
    return value;
  }
  private cacheShard(key: string, value: TermShard): void {
    this.shards.delete(key);
    this.shards.set(key, value);
    this.shardSizes.set(key, byteLength(JSON.stringify(value)));
    while (
      this.shards.size > CONTEXT_POLICY.indexCacheWindows ||
      [...this.shardSizes.values()].reduce((n, size) => n + size, 0) >
        CONTEXT_POLICY.indexCacheBytes
    ) {
      const oldest = this.shards.keys().next().value!;
      this.shards.delete(oldest);
      this.shardSizes.delete(oldest);
    }
  }
  private async writeShard(
    taskId: string,
    windowId: string,
    terms: TermShard,
  ): Promise<number> {
    await this.fs.makeDirectory(
      this.path(taskId, `windows/${safeId(windowId)}`),
    );
    await this.fs.writeFile(
      this.path(taskId, `windows/${safeId(windowId)}/terms.json`),
      JSON.stringify(terms),
    );
    this.cacheShard(`${taskId}/${windowId}`, terms);
    return byteLength(JSON.stringify(terms));
  }
  /** Pin an entire task while a read or handoff resolves its immutable refs. */
  acquire(taskId: string): () => void {
    this.readers.set(taskId, (this.readers.get(taskId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.readers.get(taskId) ?? 1) - 1;
      if (remaining) this.readers.set(taskId, remaining);
      else this.readers.delete(taskId);
    };
  }
  isPinned(taskId: string): boolean {
    return !!this.readers.get(taskId);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work, work);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  private async commit(taskId: string, manifest: Manifest): Promise<void> {
    manifest.manifestBytes = 0;
    // Fixed point only changes when the digit count changes; no filesystem scan.
    for (let n = 0; n < 4; n++) {
      const size = byteLength(JSON.stringify(manifest));
      if (manifest.manifestBytes === size) break;
      manifest.manifestBytes = size;
    }
    await this.fs.makeDirectory(this.path(taskId, ""));
    await this.fs.writeFile(
      this.path(taskId, "index.json"),
      JSON.stringify(manifest),
    );
    this.cacheManifest(taskId, manifest);
  }
  async isDeleted(taskId: string): Promise<boolean> {
    return Boolean((await this.load(taskId)).deleted);
  }
  async deleteTask(taskId: string): Promise<void> {
    await this.prune(taskId);
    await this.serial(async () =>
      this.commit(taskId, { ...(await this.load(taskId)), deleted: true }),
    );
    this.tasks.delete(taskId);
  }
  async addWindow(taskId: string, window: ContextWindowState): Promise<void> {
    await this.serial(async () => {
      const index = await this.load(taskId);
      if (index.deleted) throw new Error("History task was deleted");
      safeId(window.id);
      const previous = index.windows.find((w) => w.id === window.id);
      if (previous && JSON.stringify(previous) === JSON.stringify(window))
        return;
      await this.commit(taskId, {
        ...index,
        retention:
          !previous && index.retention?.tier === "archived"
            ? { version: 1, tier: "hot" }
            : index.retention,
        windows: previous
          ? index.windows.map((w) => (w.id === window.id ? { ...window } : w))
          : [...index.windows, { ...window }],
      });
    });
  }
  async windows(taskId: string): Promise<ContextWindowState[]> {
    await this.queue;
    const index = await this.load(taskId);
    return index.deleted ? [] : index.windows.map((w) => ({ ...w }));
  }
  async append(input: HistoryAppend): Promise<HistoryItemRef> {
    return this.serial(async () => {
      const index = await this.load(input.taskId);
      if (index.deleted) throw new Error("History task was deleted");
      const ref = {
        taskId: input.taskId,
        windowId: safeId(input.windowId),
        itemId: safeId(input.itemId),
      };
      if (index.items.some((item) => item.itemId === input.itemId)) return ref;
      const { content, ...metadata } = input;
      const observation = sourceObservation(input, content);
      const item: HistoryItem = {
        ...metadata,
        ...ref,
        createdAt: input.createdAt ?? Date.now(),
        characters: content.length,
        excerpt: content.slice(0, 300),
        observation,
        sourceVersions:
          observation && input.sourceVersions
            ? Object.fromEntries(
                Object.entries(input.sourceVersions).filter(([id]) =>
                  observation.sourceIds.includes(id),
                ),
              )
            : undefined,
      };
      const dir = this.path(ref.taskId, `windows/${ref.windowId}`);
      await this.fs.makeDirectory(dir);
      await this.fs.writeFile(`${dir}/${ref.itemId}.txt`, content);
      const shardBytes = await this.writeShard(ref.taskId, ref.windowId, {
        ...(await this.shard(ref.taskId, ref.windowId)),
        [item.itemId]: !retrievable(item)
          ? { version: 2, passages: [] }
          : indexPassages(content),
      });
      let sourceProgress = index.sourceProgress;
      if (
        input.role === "tool" &&
        input.toolName === "context_save" &&
        input.binding &&
        sourceProgress?.length
      ) {
        let result;
        try {
          const value = JSON.parse(content);
          result = value.result ?? value;
        } catch {
          /* Diagnostic/non-JSON content cannot link a phase. */
        }
        if (
          result?.ok &&
          result.toolName === "context_save" &&
          result.data?.name &&
          result.data?.revision
        )
          sourceProgress = sourceProgress.map((entry) =>
            entry.note === result.data.name &&
            entry.revision === result.data.revision &&
            entry.state.binding.runId === input.binding!.runId
              ? {
                  ...entry,
                  originalRef: `h:${ref.taskId}:${ref.windowId}:${ref.itemId}`,
                }
              : entry,
          );
      }
      await this.commit(ref.taskId, {
        ...index,
        sourceProgress,
        items: [...index.items, item],
        shardBytes: { ...index.shardBytes, [ref.windowId]: shardBytes },
        retainedBytes:
          (index.retainedBytes ?? 0) + new TextEncoder().encode(content).length,
      });
      return ref;
    });
  }
  async listTasks(
    query = "",
    offset = 0,
    limit = 20,
  ): Promise<{
    tasks: HistoryTask[];
    total: number;
    nextOffset: number | null;
  }> {
    await this.queue;
    const text = query.toLocaleLowerCase();
    const tasks: HistoryTask[] = [];
    for (const task of this.tasks.values()) {
      if (!task.title.toLocaleLowerCase().includes(text)) continue;
      if (!(await this.load(task.id)).deleted) tasks.push({ ...task });
    }
    tasks.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const start = bound(offset, 0, 1e9),
      size = Math.max(1, bound(limit, 20, 50));
    return {
      tasks: tasks.slice(start, start + size),
      total: tasks.length,
      nextOffset: start + size < tasks.length ? start + size : null,
    };
  }
  async search(query: HistoryQuery = {}): Promise<{
    items: Array<
      HistoryItem & { title: string; score: number; fingerprint?: string }
    >;
    total: number;
    nextOffset: number | null;
  }> {
    const releases = [...this.tasks.keys()].map((id) => this.acquire(id));
    try {
      await this.queue;
      const rows: Array<{
        item: HistoryItem;
        passage: Passage;
        background: string;
        preferred: boolean;
        at: number;
        identity: string;
      }> = [];
      const recent: Array<
        HistoryItem & { title: string; score: number; fingerprint?: string }
      > = [];
      for (const task of this.tasks.values()) {
        if (query.taskId && task.id !== query.taskId) continue;
        if (query.taskIds && !query.taskIds.includes(task.id)) continue;
        const index = await this.load(task.id);
        if (index.deleted) continue;
        for (const item of index.items) {
          if (
            !retrievable(item) ||
            (query.windowId && query.windowId !== item.windowId)
          )
            continue;
          if (
            query.sourceIds &&
            (!item.sourceIds.length ||
              item.sourceIds.some((id) => !query.sourceIds!.includes(id)))
          )
            continue;
          if (!query.query?.trim()) {
            recent.push({
              ...item,
              title: task.title,
              score: query.preferredTaskIds?.includes(task.id) ? 1 : 0,
            });
            continue;
          }
          const indexed = await this.passages(task.id, item.windowId);
          const entry = indexed[item.itemId];
          if (!entry || Array.isArray(entry)) continue;
          for (const passage of entry.passages)
            rows.push({
              item,
              passage,
              background: [
                task.title,
                item.toolName,
                ...item.sourceIds,
                passage.section,
              ]
                .filter(Boolean)
                .join(" "),
              preferred: Boolean(query.preferredTaskIds?.includes(task.id)),
              at: item.createdAt,
              identity: `${task.id}:${item.windowId}:${item.itemId}:${passage.start}`,
            });
        }
      }
      const ranked = rankPassages(rows, query.query ?? "");
      recent.sort(
        (a, b) =>
          b.score - a.score ||
          b.createdAt - a.createdAt ||
          `${a.taskId}:${a.itemId}`.localeCompare(`${b.taskId}:${b.itemId}`),
      );
      const offset = bound(query.offset, 0, 1e9),
        limit = Math.max(1, bound(query.limit, 20, 50));
      const results = query.query?.trim() ? ranked : recent;
      const selected: Array<
        HistoryItem & { title: string; score: number; fingerprint?: string }
      > = [];
      if (query.query?.trim()) {
        for (const hit of ranked.slice(offset, offset + limit)) {
          const content = await this.body(hit.item);
          selected.push({
            ...hit.item,
            title: this.tasks.get(hit.item.taskId)!.title,
            score: hit.score,
            ...passageExcerpt(content, hit.passage, query.query),
            passageStart: hit.passage.start,
            passageEnd: hit.passage.end,
            sourceVersion: `h:${hit.item.taskId}:${hit.item.windowId}:${hit.item.itemId}`,
            fingerprint: await query.fingerprint?.(
              content
                .slice(hit.passage.start, hit.passage.end)
                .replace(/\s+/g, " ")
                .trim(),
            ),
          });
        }
      } else {
        for (const item of recent.slice(offset, offset + limit)) {
          selected.push({
            ...item,
            offset: 0,
            endOffset: item.excerpt.length,
            sourceVersion: `h:${item.taskId}:${item.windowId}:${item.itemId}`,
            fingerprint: query.fingerprint
              ? await query.fingerprint(
                  (await this.body(item)).replace(/\s+/g, " ").trim(),
                )
              : undefined,
          });
        }
      }
      return {
        items: selected,
        total: results.length,
        nextOffset: offset + limit < results.length ? offset + limit : null,
      };
    } finally {
      releases.forEach((release) => release());
    }
  }
  /** Rebuild one legacy shard once, never re-read all originals during maintenance. */
  private async passages(taskId: string, windowId: string): Promise<TermShard> {
    const shard = await this.shard(taskId, windowId);
    if (
      (await this.load(taskId)).passageShards?.includes(windowId) &&
      Object.values(shard).every((value) => !Array.isArray(value))
    )
      return shard;
    return this.serial(async () => {
      const current = await this.shard(taskId, windowId);
      const index = await this.load(taskId);
      const converted: TermShard = { ...current };
      for (const item of index.items.filter((i) => i.windowId === windowId))
        if (!converted[item.itemId] || Array.isArray(converted[item.itemId]))
          converted[item.itemId] = retrievable(item)
            ? indexPassages(await this.body(item))
            : { version: 2, passages: [] };
      const bytes = await this.writeShard(taskId, windowId, converted);
      await this.commit(taskId, {
        ...index,
        passageShards: [...new Set([...(index.passageShards ?? []), windowId])],
        shardBytes: { ...index.shardBytes, [windowId]: bytes },
      });
      return converted;
    });
  }
  /** Cursor generation changes only when retrievable records change, not on access/usage updates. */
  async retrievalVersion(taskIds?: string[]): Promise<string> {
    await this.queue;
    const revisions = [];
    for (const task of this.tasks.values()) {
      if (taskIds && !taskIds.includes(task.id)) continue;
      const index = await this.load(task.id);
      revisions.push([
        task.id,
        task.title,
        index.deleted,
        index.prunedAt,
        index.items.filter(retrievable).map((i) => [i.windowId, i.itemId]),
        index.notes.map((n) => [n.name, n.revision]),
      ]);
    }
    return JSON.stringify(revisions);
  }
  private body(ref: HistoryItemRef): Promise<string> {
    return this.fs.readFile(
      this.path(
        ref.taskId,
        `windows/${safeId(ref.windowId)}/${safeId(ref.itemId)}.txt`,
      ),
    );
  }
  async read(
    ref: HistoryItemRef,
    offset = 0,
    limit = 8000,
    sourceIds?: string[],
    explicitRead = false,
  ): Promise<{
    item: HistoryItem;
    offset: number;
    content: string;
    nextOffset: number | null;
  }> {
    const release = this.acquire(ref.taskId);
    try {
      await this.queue;
      const index = await this.load(ref.taskId);
      const item =
        !index.deleted &&
        index.items.find(
          (i) => i.itemId === ref.itemId && i.windowId === ref.windowId,
        );
      if (!item && index.prunedAt)
        throw new Error(
          "History was cleared by the retention policy; use retained memory or original sources",
        );
      if (
        !item ||
        item.purpose === "diagnostic" ||
        (sourceIds &&
          (!item.sourceIds.length ||
            item.sourceIds.some((id) => !sourceIds.includes(id))))
      )
        throw new Error("History item is unavailable in this source scope");
      const content = await this.body(item);
      const start = textOffset(content, offset),
        size = Math.max(1, bound(limit, 8000, 20000)),
        end = textEnd(content, start, size);
      if (explicitRead && start < content.length) await this.touch(ref.taskId);
      return {
        item: { ...item },
        offset: start,
        content: content.slice(start, end),
        nextOffset: end < content.length ? end : null,
      };
    } finally {
      release();
    }
  }
  /** Records delivery of some content; this never claims full reading or business verification. */
  async recordDelivery(
    ref: HistoryItemRef,
    delivery: "native-request" | "host-provided",
  ): Promise<void> {
    await this.serial(async () => {
      const index = await this.load(ref.taskId);
      const item = index.items.find(
        (i) => i.windowId === ref.windowId && i.itemId === ref.itemId,
      );
      if (
        !item ||
        item.delivery === "native-request" ||
        item.delivery === delivery
      )
        return;
      await this.commit(ref.taskId, {
        ...index,
        items: index.items.map((i) => (i === item ? { ...i, delivery } : i)),
      });
    });
  }
  async listNotes(taskId: string) {
    await this.queue;
    const index = await this.load(taskId);
    return index.deleted ? [] : index.notes.map((note) => ({ ...note }));
  }
  async searchNotes(query: HistoryQuery) {
    const releases = [...this.tasks.keys()].map((id) => this.acquire(id));
    try {
      await this.queue;
      const matches: Array<{
        taskId: string;
        name: string;
        revision: number;
        title: string;
        sourceIds?: string[];
        passage: Passage;
        background: string;
        at: number;
        identity: string;
      }> = [];
      for (const task of this.tasks.values()) {
        if (
          (query.taskId && task.id !== query.taskId) ||
          (query.taskIds && !query.taskIds.includes(task.id))
        )
          continue;
        let index = await this.load(task.id);
        if (index.deleted) continue;
        if (index.notes.some((note) => !note.passages)) {
          await this.serial(async () => {
            const current = await this.load(task.id);
            const notes = [];
            for (const note of current.notes)
              notes.push(
                note.passages
                  ? note
                  : {
                      ...note,
                      terms: undefined,
                      passages: indexPassages(
                        await this.fs.readFile(
                          this.path(
                            task.id,
                            `notes/${safeId(note.name)}_${note.revision}.txt`,
                          ),
                        ),
                      ),
                    },
              );
            await this.commit(task.id, { ...current, notes });
          });
          index = await this.load(task.id);
        }
        for (const note of index.notes) {
          if (
            query.sourceIds &&
            (!note.sourceIds?.length ||
              note.sourceIds.some((id) => !query.sourceIds!.includes(id)))
          )
            continue;
          const passages = note.passages?.passages ?? [];
          for (const passage of query.query?.trim()
            ? passages
            : passages.slice(0, 1))
            matches.push({
              taskId: task.id,
              name: note.name,
              revision: note.revision,
              title: task.title,
              sourceIds: note.sourceIds,
              passage,
              background: `${task.title} ${note.name} ${(note.sourceIds ?? []).join(" ")}`,
              at: note.updatedAt,
              identity: `${task.id}:${note.name}:${passage.start}`,
            });
        }
      }
      const ranked = query.query?.trim()
        ? rankPassages(matches, query.query)
        : matches
            .map((m) => ({ ...m, score: 0 }))
            .sort(
              (a, b) => b.at - a.at || a.identity.localeCompare(b.identity),
            );
      const offset = bound(query.offset, 0, 1e9),
        limit = Math.max(1, bound(query.limit, 8, 50));
      return await Promise.all(
        ranked.slice(offset, offset + limit).map(async (match) => {
          const body = await this.fs.readFile(
            this.path(
              match.taskId,
              `notes/${safeId(match.name)}_${match.revision}.txt`,
            ),
          );
          return {
            taskId: match.taskId,
            name: match.name,
            title: match.title,
            revision: match.revision,
            score: match.score,
            sourceIds: match.sourceIds,
            ...passageExcerpt(body, match.passage, query.query ?? ""),
            passageStart: match.passage.start,
            passageEnd: match.passage.end,
            sourceVersion: `n:${match.taskId}:${match.name}:${match.revision}`,
            fingerprint: await query.fingerprint?.(
              body
                .slice(match.passage.start, match.passage.end)
                .replace(/\s+/g, " ")
                .trim(),
            ),
          };
        }),
      );
    } finally {
      releases.forEach((release) => release());
    }
  }
  async readNote(
    taskId: string,
    name: string,
    offset = 0,
    limit = 8000,
    sourceIds?: string[],
    explicitRead = false,
  ) {
    const release = this.acquire(taskId);
    try {
      await this.queue;
      const index = await this.load(taskId);
      const note = !index.deleted && index.notes.find((n) => n.name === name);
      if (!note)
        throw new Error(
          index.prunedAt
            ? "Working note was cleared by the retention policy"
            : "Working note not found",
        );
      if (
        sourceIds &&
        (!note.sourceIds?.length ||
          note.sourceIds.some((id) => !sourceIds.includes(id)))
      )
        throw new Error("Working note is unavailable in this source scope");
      const content = await this.fs.readFile(
        this.path(taskId, `notes/${safeId(name)}_${note.revision}.txt`),
      );
      const start = textOffset(content, offset),
        size = Math.max(1, bound(limit, 8000, 20000)),
        end = textEnd(content, start, size);
      if (explicitRead && start < content.length) await this.touch(taskId);
      return {
        ...note,
        terms: undefined,
        passages: undefined,
        offset: start,
        content: content.slice(start, end),
        nextOffset: end < content.length ? end : null,
      };
    } finally {
      release();
    }
  }
  async writeNote(
    taskId: string,
    name: string,
    content: string,
    sourceIds?: string[],
    state?: WorkingNoteState,
  ) {
    safeId(name);
    if (content.length > 250000)
      throw new Error("Working note is too large; create another note");
    return this.serial(async () => {
      const index = await this.load(taskId);
      if (index.deleted) throw new Error("History task was deleted");
      const previous = index.notes.find((n) => n.name === name);
      const note = {
        name,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: Date.now(),
        characters: content.length,
        sourceIds,
        state,
        passages: indexPassages(content),
      };
      await this.fs.makeDirectory(this.path(taskId, "notes"));
      await this.fs.writeFile(
        this.path(taskId, `notes/${name}_${note.revision}.txt`),
        content,
      );
      await this.commit(taskId, {
        ...index,
        notes: [...index.notes.filter((n) => n.name !== name), note],
        sourceProgress: state
          ? [
              ...(index.sourceProgress ?? []).filter(
                (entry) =>
                  entry.state.binding.runId === state.binding.runId &&
                  !state.sourceProgress?.some(
                    (p) => p.sourceId === entry.sourceId,
                  ),
              ),
              ...(state.sourceProgress ?? []).map((entry) => ({
                ...entry,
                note: name,
                revision: note.revision,
                state: {
                  ...state,
                  sourceProgress: undefined,
                  sourceVersions: state.sourceVersions?.[entry.sourceId]
                    ? { [entry.sourceId]: state.sourceVersions[entry.sourceId] }
                    : undefined,
                },
              })),
            ]
          : index.sourceProgress,
        retainedBytes:
          (index.retainedBytes ?? 0) + new TextEncoder().encode(content).length,
      });
      return { ...note, passages: undefined };
    });
  }
  async sourceCoverage(taskId: string, run: RunState) {
    await this.queue;
    const index = await this.load(taskId);
    return projectSourceCoverage(
      taskId,
      run,
      index.deleted || index.prunedAt ? [] : index.items,
      index.deleted || index.prunedAt ? [] : (index.sourceProgress ?? []),
    );
  }
  async evidenceDependencies(taskId: string): Promise<string[]> {
    await this.queue;
    const index = await this.load(taskId);
    const states = [
      ...index.notes.map((n) => n.state),
      ...(index.sourceProgress ?? []).map((p) => p.state),
    ];
    return [
      ...new Set(
        states
          .flatMap((state) => [
            ...(state?.evidenceRefs ?? []),
            ...(state?.evidence ?? []).map((e) => e.ref),
          ])
          .filter((ref) => /^[hn]:/.test(ref))
          .map((ref) => ref.split(":")[1]),
      ),
    ];
  }
  async isMigrated(taskId: string): Promise<boolean> {
    return Boolean((await this.load(taskId)).migrated);
  }

  async retentionInfo(taskId: string) {
    await this.queue;
    const index = await this.load(taskId);
    return {
      bytes:
        index.retention?.tier === "pruned"
          ? 0
          : (index.retainedBytes ?? 0) +
            (index.manifestBytes ?? 0) +
            (index.backupBytes ?? 0) +
            Object.values(index.shardBytes ?? {}).reduce((a, b) => a + b, 0),
      rawBytes: index.retainedBytes ?? 0,
      retention: { ...index.retention! },
      pinned: this.isPinned(taskId),
      characters:
        index.items.reduce((sum, item) => sum + item.characters, 0) +
        index.notes.reduce((sum, note) => sum + note.characters, 0),
      prunedAt: index.prunedAt,
      cleanupPending: index.cleanupPending === true,
      items: index.items.length,
      retrievableItems: index.items.filter((item) => retrievable(item)).length,
      notes: index.notes.length,
    };
  }

  async archive(taskId: string, now = Date.now()): Promise<void> {
    await this.serial(async () => {
      const index = await this.load(taskId);
      if (index.deleted || index.retention?.tier !== "hot") return;
      // Append/writeNote complete only after both the immutable body and its index.
      await this.commit(taskId, {
        ...index,
        retention: {
          version: 1,
          tier: "archived",
          archivedAt: now,
          projectionPending: true,
        },
      });
    });
  }
  async finishArchive(taskId: string): Promise<void> {
    await this.serial(async () => {
      const index = await this.load(taskId);
      if (index.retention?.tier !== "archived") return;
      await this.commit(taskId, {
        ...index,
        retention: { ...index.retention, projectionPending: false },
      });
    });
  }
  async touch(taskId: string, now = Date.now()): Promise<void> {
    await this.serial(async () => {
      const index = await this.load(taskId);
      if (index.retention?.tier !== "archived") return;
      await this.commit(taskId, {
        ...index,
        retention: { ...index.retention, lastReadAt: now },
      });
    });
  }
  async head(taskId: string): Promise<string | undefined> {
    await this.queue;
    return (await this.load(taskId)).items.filter((i) => retrievable(i)).at(-1)
      ?.itemId;
  }
  /** Bounded, evenly distributed windows and sources, rather than only the last transcript. */
  async sample(
    taskId: string,
    maxCharacters = 20000,
  ): Promise<Array<{ ref: string; content: string; sourceIds: string[] }>> {
    const release = this.acquire(taskId);
    try {
      await this.queue;
      const index = await this.load(taskId);
      const groups = new Map<string, HistoryItem[]>();
      for (const item of index.items.filter(retrievable)) {
        const key = `${item.windowId}:${[...item.sourceIds].sort().join(",")}`;
        const group = groups.get(key) ?? [];
        groups.set(key, [...group.slice(-3), item]);
      }
      const all = [...groups.values()];
      const maxSamples = Math.min(
        32,
        Math.max(0, Math.floor(maxCharacters / 100)),
      );
      if (!maxSamples || !all.length) return [];
      const selected =
        all.length <= maxSamples
          ? all
          : Array.from(
              { length: maxSamples },
              (_, n) =>
                all[
                  Math.floor(
                    (n * (all.length - 1)) / Math.max(1, maxSamples - 1),
                  )
                ],
            );
      const candidates: HistoryItem[] = [];
      for (let depth = 1; depth <= 4 && candidates.length < maxSamples; depth++)
        for (const group of selected) {
          const item = group.at(-depth);
          if (item && candidates.length < maxSamples) candidates.push(item);
        }
      const size = Math.max(
        1,
        Math.floor(maxCharacters / Math.max(1, candidates.length)),
      );
      const result = [];
      for (const item of candidates)
        result.push({
          ref: `h:${taskId}:${item.windowId}:${item.itemId}`,
          content: (await this.body(item)).slice(0, size),
          sourceIds: item.sourceIds,
        });
      return result;
    } finally {
      release();
    }
  }

  /** Retention policy, independent of distillation, authorizes deletion.
   * Caller has already checked active / recoverable task dependencies.
   * Publish the tombstone first so a crash never exposes partially deleted history. */
  async prune(taskId: string, now = Date.now()): Promise<void> {
    await this.serial(async () => {
      if (this.isPinned(taskId))
        throw new Error("History is pinned by an in-flight read or handoff");
      const index = await this.load(taskId);
      const cleared: Manifest = {
        ...index,
        items: [],
        notes: [],
        sourceProgress: [],
        windows: [],
        terms: {},
        migrated: true,
        prunedAt: index.prunedAt ?? now,
        cleanupPending: true,
        retention: {
          version: 1,
          tier: "pruned",
          prunedAt: index.prunedAt ?? now,
        },
      };
      await this.commit(taskId, cleared);
      const removeText = async (dir: string): Promise<void> => {
        const prefix = dir.replace(/\/+$/, "") + "/";
        for (const path of await this.fs.listFiles(dir)) {
          if (!path.startsWith(prefix)) continue;
          if (path.endsWith(".txt") || path.endsWith("/terms.json"))
            await this.fs.deleteFile(path);
          else if (!path.slice(prefix.length).includes("/"))
            await removeText(path);
        }
      };
      await removeText(this.path(taskId, "windows"));
      await removeText(this.path(taskId, "notes"));
      if (
        (index.backupBytes ?? 0) > 0 &&
        (await this.fs.listFiles(this.path(taskId, ""))).includes(
          this.path(taskId, "index.pre-archive.json"),
        )
      )
        await this.fs.deleteFile(this.path(taskId, "index.pre-archive.json"));
      for (const key of this.shards.keys())
        if (key.startsWith(`${taskId}/`)) {
          this.shards.delete(key);
          this.shardSizes.delete(key);
        }
      await this.commit(taskId, {
        ...cleared,
        retainedBytes: 0,
        shardBytes: {},
        backupBytes: 0,
        cleanupPending: false,
      });
    });
  }
  async markMigrated(taskId: string): Promise<void> {
    await this.serial(async () =>
      this.commit(taskId, { ...(await this.load(taskId)), migrated: true }),
    );
  }
  async flush(): Promise<void> {
    await this.queue;
  }

  /** Diagnostic read: full bodies and note revisions, never retrieval excerpts. */
  async exportTask(taskId: string): Promise<HistoryExport> {
    const releases = [...this.tasks.keys()].map((id) => this.acquire(id));
    try {
      await this.queue;
      safeId(taskId);
      if (!this.tasks.has(taskId))
        throw new Error("History task is unavailable");
      const result: HistoryExport = {
        windows: [],
        items: [],
        notes: [],
        unindexed: [],
        issues: [],
      };
      let manifest: Manifest | undefined;
      try {
        manifest = JSON.parse(
          JSON.stringify(await this.load(taskId)),
        ) as Manifest;
      } catch (error) {
        result.issues.push(`History index: ${String(error)}`);
        // Diagnostic export still inspects the original index if metadata migration failed.
        try {
          const original = JSON.parse(
            await this.fs.readFile(this.path(taskId, "index.json")),
          );
          if (
            original?.version === 1 &&
            Array.isArray(original.items) &&
            Array.isArray(original.notes) &&
            Array.isArray(original.windows)
          )
            manifest = original;
        } catch {
          /* Independent body files are enumerated below. */
        }
      }
      if (manifest?.deleted) throw new Error("History task was deleted");
      if (manifest?.prunedAt && !manifest.items.length) {
        result.issues.push(
          "Original history was cleared by the retention policy.",
        );
        return result;
      }
      result.windows = manifest?.windows ?? [];
      const read = async (path: string) => {
        try {
          return { content: await this.fs.readFile(path) };
        } catch (error) {
          const message = String(error);
          result.issues.push(
            `${path.slice(this.path(taskId, "").length)}: ${message}`,
          );
          return { error: message };
        }
      };
      const list = async (path: string) => {
        try {
          return await this.fs.listFiles(path);
        } catch (error) {
          result.issues.push(`${path}: ${String(error)}`);
          return [];
        }
      };
      const indexed = new Set<string>();
      for (const item of manifest?.items ?? []) {
        try {
          if (!item || item.taskId !== taskId)
            throw new Error(
              "History item belongs to another task or is invalid",
            );
          const path = this.path(
            taskId,
            `windows/${safeId(item.windowId)}/${safeId(item.itemId)}.txt`,
          );
          indexed.add(path);
          result.items.push({ ...item, ...(await read(path)) });
        } catch (error) {
          const message = `History item ${item?.itemId ?? "unknown"}: ${String(error)}`;
          result.issues.push(message);
          result.items.push({ ...item, error: message });
        }
      }
      const windowsDir = this.path(taskId, "windows/");
      const windowIds = new Set<string>();
      for (const window of result.windows) {
        if (
          window &&
          typeof window.id === "string" &&
          /^[\w-]+$/.test(window.id)
        )
          windowIds.add(window.id);
        else result.issues.push("Invalid context window in history index");
      }
      for (const path of await list(windowsDir)) {
        if (!path.startsWith(windowsDir)) continue;
        const id = path.slice(windowsDir.length).split("/")[0];
        if (/^[\w-]+$/.test(id)) windowIds.add(id);
      }
      for (const id of windowIds) {
        for (const path of await list(`${windowsDir}${id}`)) {
          if (
            indexed.has(path) ||
            !path.startsWith(`${windowsDir}${id}/`) ||
            !/^[\w-]+\.txt$/.test(path.slice(`${windowsDir}${id}/`.length))
          )
            continue;
          result.unindexed.push({
            path: path.slice(this.path(taskId, "").length),
            ...(await read(path)),
          });
        }
      }
      const notesDir = this.path(taskId, "notes/");
      const noteFiles = new Set(await list(notesDir));
      for (const note of manifest?.notes ?? []) {
        if (
          note &&
          typeof note.name === "string" &&
          /^[\w-]+$/.test(note.name) &&
          Number.isSafeInteger(note.revision) &&
          note.revision > 0
        )
          noteFiles.add(`${notesDir}${note.name}_${note.revision}.txt`);
        else result.issues.push("Invalid working note in history index");
      }
      for (const path of [...noteFiles].sort()) {
        if (!path.startsWith(notesDir)) continue;
        const match = /^([\w-]+)_(\d+)\.txt$/.exec(path.slice(notesDir.length));
        if (!match) continue;
        const [, name, revision] = match;
        result.notes.push({
          name,
          revision: Number(revision),
          current: !!manifest?.notes.some(
            (n) => n?.name === name && n.revision === Number(revision),
          ),
          ...(await read(path)),
        });
      }
      if (result.unindexed.length)
        result.issues.push(
          `${result.unindexed.length} history files were not in the index; their original contents are included.`,
        );
      return result;
    } finally {
      releases.forEach((release) => release());
    }
  }
}
