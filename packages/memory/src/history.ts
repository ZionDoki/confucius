import type {
  ContextWindowState,
  HistoryItem,
  HistoryItemRef,
  HistoryTask,
} from "@confucius/protocol";
import type { MemoryFileSystem } from "./fs";
import { tokenize } from "./tokenize";

interface Manifest {
  version: 1;
  deleted?: boolean;
  migrated?: boolean;
  prunedAt?: number;
  cleanupPending?: boolean;
  terms?: Record<string, string[]>;
  windows: ContextWindowState[];
  items: HistoryItem[];
  notes: Array<{
    name: string;
    revision: number;
    updatedAt: number;
    characters: number;
    sourceIds?: string[];
    terms?: string[];
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

const safeId = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error("Invalid history identifier");
  return id;
};
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
    if (cached) return cached;
    const dir = this.path(taskId, "");
    const files = await this.fs.listFiles(dir);
    const path = this.path(taskId, "index.json");
    const value: Manifest = files.includes(path)
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
    this.manifests.set(taskId, value);
    return value;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work, work);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  private async commit(taskId: string, manifest: Manifest): Promise<void> {
    await this.fs.makeDirectory(this.path(taskId, ""));
    await this.fs.writeFile(
      this.path(taskId, "index.json"),
      JSON.stringify(manifest),
    );
    this.manifests.set(taskId, manifest);
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
      const item: HistoryItem = {
        ...metadata,
        ...ref,
        createdAt: input.createdAt ?? Date.now(),
        characters: content.length,
        excerpt: content.slice(0, 300),
      };
      const dir = this.path(ref.taskId, `windows/${ref.windowId}`);
      await this.fs.makeDirectory(dir);
      await this.fs.writeFile(`${dir}/${ref.itemId}.txt`, content);
      await this.commit(ref.taskId, {
        ...index,
        items: [...index.items, item],
        terms: {
          ...index.terms,
          [item.itemId]:
            item.purpose === "diagnostic"
              ? []
              : [...new Set(tokenize(content))],
        },
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
    items: Array<HistoryItem & { title: string; score: number }>;
    total: number;
    nextOffset: number | null;
  }> {
    await this.queue;
    const terms = tokenize(query.query ?? "");
    const results: Array<HistoryItem & { title: string; score: number }> = [];
    for (const task of this.tasks.values()) {
      if (query.taskId && task.id !== query.taskId) continue;
      if (query.taskIds && !query.taskIds.includes(task.id)) continue;
      let index = await this.load(task.id);
      if (index.deleted) continue;
      if (
        query.query?.trim() &&
        index.items.some(
          (item) =>
            item.purpose !== "diagnostic" && !index.terms?.[item.itemId],
        )
      ) {
        await this.serial(async () => {
          const current = await this.load(task.id);
          const terms = { ...current.terms };
          for (const item of current.items) {
            if (item.purpose !== "diagnostic" && !terms[item.itemId])
              terms[item.itemId] = [
                ...new Set(tokenize(await this.body(item))),
              ];
          }
          await this.commit(task.id, { ...current, terms });
        });
        index = await this.load(task.id);
      }
      for (const item of index.items) {
        if (item.purpose === "diagnostic") continue;
        if (query.windowId && query.windowId !== item.windowId) continue;
        // A scoped evidence workflow may only see records wholly inside its sources.
        if (
          query.sourceIds &&
          (!item.sourceIds.length ||
            item.sourceIds.some((id) => !query.sourceIds!.includes(id)))
        )
          continue;
        let score = 0;
        let excerpt = item.excerpt;
        if (query.query?.trim()) {
          const lower = item.excerpt.toLocaleLowerCase();
          const literal = lower.indexOf(query.query.toLocaleLowerCase());
          const tokens = new Set(index.terms?.[item.itemId] ?? []);
          score =
            terms.reduce((n, term) => n + Number(tokens.has(term)), 0) +
            (literal >= 0 ? 5 : 0);
          if (!score) continue;
        }
        score += query.preferredTaskIds?.includes(task.id) ? 10 : 0;
        results.push({ ...item, excerpt, title: task.title, score });
      }
    }
    results.sort(
      (a, b) =>
        b.score - a.score ||
        b.createdAt - a.createdAt ||
        a.itemId.localeCompare(b.itemId),
    );
    const offset = bound(query.offset, 0, 1e9),
      limit = Math.max(1, bound(query.limit, 20, 50));
    const selected = results.slice(offset, offset + limit);
    if (query.query?.trim()) {
      for (const item of selected) {
        const content = await this.body(item);
        const lower = content.toLocaleLowerCase();
        let pos = lower.indexOf(query.query.toLocaleLowerCase());
        if (pos < 0)
          pos = terms.reduce((found, term) => {
            const at = lower.indexOf(term);
            return at >= 0 ? Math.min(found, at) : found;
          }, content.length);
        item.excerpt = content.slice(
          Math.max(0, pos - 80),
          Math.max(0, pos - 80) + 400,
        );
      }
    }
    return {
      items: selected,
      total: results.length,
      nextOffset: offset + limit < results.length ? offset + limit : null,
    };
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
  ): Promise<{
    item: HistoryItem;
    content: string;
    nextOffset: number | null;
  }> {
    await this.queue;
    const index = await this.load(ref.taskId);
    const item =
      !index.deleted &&
      index.items.find(
        (i) => i.itemId === ref.itemId && i.windowId === ref.windowId,
      );
    if (!item && index.prunedAt)
      throw new Error(
        "History was cleared after distillation; use retained memory or original sources",
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
    const start = bound(offset, 0, content.length),
      size = Math.max(1, bound(limit, 8000, 20000));
    return {
      item: { ...item },
      content: content.slice(start, start + size),
      nextOffset: start + size < content.length ? start + size : null,
    };
  }
  async listNotes(taskId: string) {
    await this.queue;
    const index = await this.load(taskId);
    return index.deleted ? [] : index.notes.map((note) => ({ ...note }));
  }
  async searchNotes(query: HistoryQuery) {
    await this.queue;
    const queryTerms = tokenize(query.query ?? "");
    const matches = [];
    for (const task of this.tasks.values()) {
      if (
        (query.taskId && task.id !== query.taskId) ||
        (query.taskIds && !query.taskIds.includes(task.id))
      )
        continue;
      let index = await this.load(task.id);
      if (index.deleted) continue;
      if (index.notes.some((note) => !note.terms)) {
        await this.serial(async () => {
          const current = await this.load(task.id);
          const notes = [];
          for (const note of current.notes)
            notes.push(
              note.terms
                ? note
                : {
                    ...note,
                    terms: [
                      ...new Set(
                        tokenize(
                          note.name +
                            " " +
                            (await this.fs.readFile(
                              this.path(
                                task.id,
                                `notes/${safeId(note.name)}_${note.revision}.txt`,
                              ),
                            )),
                        ),
                      ),
                    ],
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
        const score = queryTerms.reduce(
          (sum, term) => sum + Number(note.terms?.includes(term)),
          0,
        );
        if (queryTerms.length && !score) continue;
        matches.push({
          taskId: task.id,
          name: note.name,
          title: task.title,
          score: score + 5,
        });
      }
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, query.limit ?? 8);
  }
  async readNote(
    taskId: string,
    name: string,
    offset = 0,
    limit = 8000,
    sourceIds?: string[],
  ) {
    await this.queue;
    const index = await this.load(taskId);
    const note = !index.deleted && index.notes.find((n) => n.name === name);
    if (!note)
      throw new Error(
        index.prunedAt
          ? "Working note was cleared after distillation"
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
    const start = bound(offset, 0, content.length),
      size = Math.max(1, bound(limit, 8000, 20000));
    return {
      ...note,
      content: content.slice(start, start + size),
      nextOffset: start + size < content.length ? start + size : null,
    };
  }
  async writeNote(
    taskId: string,
    name: string,
    content: string,
    sourceIds?: string[],
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
        terms: [...new Set(tokenize(name + " " + content))],
      };
      await this.fs.makeDirectory(this.path(taskId, "notes"));
      await this.fs.writeFile(
        this.path(taskId, `notes/${name}_${note.revision}.txt`),
        content,
      );
      await this.commit(taskId, {
        ...index,
        notes: [...index.notes.filter((n) => n.name !== name), note],
      });
      return note;
    });
  }
  async isMigrated(taskId: string): Promise<boolean> {
    return Boolean((await this.load(taskId)).migrated);
  }

  async retentionInfo(taskId: string) {
    await this.queue;
    const index = await this.load(taskId);
    let bytes = 0;
    const visit = async (dir: string): Promise<void> => {
      const prefix = dir.replace(/\/+$/, "") + "/";
      for (const path of await this.fs.listFiles(dir)) {
        if (!path.startsWith(prefix)) continue;
        if (path.endsWith(".txt"))
          bytes += this.fs.fileSize
            ? await this.fs.fileSize(path)
            : new TextEncoder().encode(await this.fs.readFile(path)).length;
        else if (!path.slice(prefix.length).includes("/")) await visit(path);
      }
    };
    await visit(this.path(taskId, "windows"));
    await visit(this.path(taskId, "notes"));
    return {
      bytes,
      characters:
        index.items.reduce((sum, item) => sum + item.characters, 0) +
        index.notes.reduce((sum, note) => sum + note.characters, 0),
      prunedAt: index.prunedAt,
      cleanupPending: index.cleanupPending === true,
      items: index.items.length,
      retrievableItems: index.items.filter(
        (item) => item.purpose !== "diagnostic",
      ).length,
      notes: index.notes.length,
    };
  }

  /** Caller has already durably committed distillation and its cleanup intent.
   * Publish the tombstone first so a crash never exposes partially deleted history. */
  async prune(taskId: string, now = Date.now()): Promise<void> {
    await this.serial(async () => {
      const index = await this.load(taskId);
      const cleared: Manifest = {
        ...index,
        items: [],
        notes: [],
        windows: [],
        terms: {},
        migrated: true,
        prunedAt: index.prunedAt ?? now,
        cleanupPending: true,
      };
      await this.commit(taskId, cleared);
      const removeText = async (dir: string): Promise<void> => {
        const prefix = dir.replace(/\/+$/, "") + "/";
        for (const path of await this.fs.listFiles(dir)) {
          if (!path.startsWith(prefix)) continue;
          if (path.endsWith(".txt")) await this.fs.deleteFile(path);
          else if (!path.slice(prefix.length).includes("/"))
            await removeText(path);
        }
      };
      await removeText(this.path(taskId, "windows"));
      await removeText(this.path(taskId, "notes"));
      await this.commit(taskId, { ...cleared, cleanupPending: false });
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
    await this.queue;
    safeId(taskId);
    if (!this.tasks.has(taskId)) throw new Error("History task is unavailable");
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
    }
    if (manifest?.deleted) throw new Error("History task was deleted");
    if (manifest?.prunedAt && !manifest.items.length) {
      result.issues.push("Original history was cleared after distillation.");
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
          throw new Error("History item belongs to another task or is invalid");
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
      if (window && typeof window.id === "string" && /^[\w-]+$/.test(window.id))
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
  }
}
