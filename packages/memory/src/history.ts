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
  windows: ContextWindowState[];
  items: HistoryItem[];
  notes: Array<{
    name: string;
    revision: number;
    updatedAt: number;
    characters: number;
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
  windowId?: string;
  query?: string;
  offset?: number;
  limit?: number;
  preferredTaskIds?: string[];
  sourceIds?: string[];
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
      const index = await this.load(task.id);
      if (index.deleted) continue;
      for (const item of index.items) {
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
          const content = await this.body(item);
          const lower = content.toLocaleLowerCase();
          const literal = lower.indexOf(query.query.toLocaleLowerCase());
          const tokens = new Set(tokenize(content));
          score =
            terms.reduce((n, term) => n + Number(tokens.has(term)), 0) +
            (literal >= 0 ? 5 : 0);
          if (!score) continue;
          const start =
            literal >= 0
              ? Math.max(0, literal - 80)
              : Math.max(
                  0,
                  terms.reduce((pos, t) => {
                    const i = lower.indexOf(t);
                    return i >= 0 ? Math.min(pos, i) : pos;
                  }, content.length) - 80,
                );
          excerpt = content.slice(start, start + 400);
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
    return {
      items: results.slice(offset, offset + limit),
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
    if (
      !item ||
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
  async readNote(taskId: string, name: string, offset = 0, limit = 8000) {
    await this.queue;
    const index = await this.load(taskId);
    const note = !index.deleted && index.notes.find((n) => n.name === name);
    if (!note) throw new Error("Working note not found");
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
  async writeNote(taskId: string, name: string, content: string) {
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
  async markMigrated(taskId: string): Promise<void> {
    await this.serial(async () =>
      this.commit(taskId, { ...(await this.load(taskId)), migrated: true }),
    );
  }
  async flush(): Promise<void> {
    await this.queue;
  }
}
