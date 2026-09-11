import type { MemoryFileSystem } from "./fs";
import { parseMemoryFile, serializeMemory } from "./markdown";
import { memoryTypesOf } from "./retrieval";
import type { MemoryRecord, MemoryStats } from "./types";
import { MEMORY_TYPES } from "./types";

const MEMORIES_DIR = "memories";
const INDEX_FILE = "MEMORY.md";

export interface MemoryStoreEvents {
  onWarn?: (message: string) => void;
}

/**
 * Plain-text store: each memory is a markdown file under `<root>/memories/`,
 * and `MEMORY.md` is a regenerated human-browsable overview. The files are
 * the only source of truth — the index is derived, so hand-editing or
 * deleting files in a file manager is always safe.
 */
export class FileMemoryStore {
  private records = new Map<string, MemoryRecord>();
  private accessDirty = new Set<string>();
  private loadPromise: Promise<void> | null = null;
  private indexDirty = true;

  constructor(
    private readonly fs: MemoryFileSystem,
    private readonly root: string,
    private readonly events: MemoryStoreEvents = {},
  ) {}

  get memoriesDir(): string {
    return joinPath(this.root, MEMORIES_DIR);
  }

  get indexPath(): string {
    return joinPath(this.root, INDEX_FILE);
  }

  async load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadNow();
    }
    return this.loadPromise;
  }

  private async loadNow(): Promise<void> {
    await this.fs.makeDirectory(this.memoriesDir);
    const files = await this.fs.listFiles(this.memoriesDir);
    const loaded = new Map<string, MemoryRecord>();
    for (const path of files) {
      if (!path.endsWith(".md")) {
        continue;
      }
      try {
        const text = await this.fs.readFile(path);
        const record = parseMemoryFile(fileName(path), text);
        if (record) {
          await this.restoreAccess(record);
          loaded.set(record.id, record);
        }
      } catch (error) {
        this.events.onWarn?.(
          `skip unreadable memory ${path}: ${String(error)}`,
        );
      }
    }
    this.records = loaded;
  }

  all(): MemoryRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  /** Reconcile a preallocated creation whose filesystem receipt was lost. */
  async recover(id: string, fresh = false): Promise<MemoryRecord | undefined> {
    const cached = this.records.get(id);
    if (cached && !fresh) return cached;
    const path = this.memoryPath(id);
    if (!(await this.containsFile(path))) {
      if (fresh && this.records.delete(id)) this.indexDirty = true;
      return undefined;
    }
    const record = parseMemoryFile(
      fileName(path),
      await this.fs.readFile(path),
    );
    if (!record || record.id !== id) {
      throw new Error(`Cannot reconcile existing memory ${id}`);
    }
    await this.restoreAccess(record);
    this.records.set(id, record);
    this.indexDirty = true;
    return record;
  }

  private async containsFile(path: string): Promise<boolean> {
    const normalized = path.replaceAll("\\", "/");
    return (await this.fs.listFiles(this.memoriesDir)).some(
      (entry) => entry.replaceAll("\\", "/") === normalized,
    );
  }

  stats(): MemoryStats {
    return {
      total: this.records.size,
      byType: memoryTypesOf(this.all()),
    };
  }

  async put(record: MemoryRecord): Promise<void> {
    await this.fs.makeDirectory(this.memoriesDir);
    const text = serializeMemory(record);
    const path = this.memoryPath(record.id);
    await this.fs.writeFile(path, text);
    if ((await this.fs.readFile(path)) !== text)
      throw new Error(
        "Memory write verification failed; originals must be retained",
      );
    this.records.set(record.id, record);
    this.indexDirty = true;
    this.accessDirty.delete(record.id);
  }

  async remove(id: string): Promise<boolean> {
    const existed = this.records.has(id);
    if (existed) {
      const path = this.memoryPath(id);
      try {
        await this.fs.deleteFile(path);
      } catch (error) {
        // A missing receipt is safe to acknowledge only after checking disk.
        if (await this.containsFile(path)) throw error;
      }
      this.records.delete(id);
      this.indexDirty = true;
      this.accessDirty.delete(id);
    }
    return existed;
  }

  /** Record a successful explicit read; searches never call this method. */
  touch(id: string, now: number): void {
    const record = this.records.get(id);
    if (!record) {
      return;
    }
    record.lastAccessedAt = now;
    record.lastUsedAt = now;
    record.accessCount += 1;
    this.accessDirty.add(id);
  }

  async flushAccess(): Promise<void> {
    const dirty = [...this.accessDirty];
    for (const id of dirty) {
      const record = this.records.get(id);
      if (record) {
        // Usage metadata must never rewrite a body that the user can edit or
        // delete independently. A stale sidecar cannot recreate a memory.
        await this.fs.makeDirectory(joinPath(this.root, "access"));
        await this.fs.writeFile(
          this.accessPath(id),
          JSON.stringify({
            createdAt: record.createdAt,
            lastAccessedAt: record.lastAccessedAt,
            lastUsedAt: record.lastUsedAt,
            accessCount: record.accessCount,
          }),
        );
        this.accessDirty.delete(id);
      }
    }
  }

  private accessPath(id: string): string {
    this.memoryPath(id); // Validate the same identifier used by the source file.
    return joinPath(this.root, `access/${id}.json`);
  }

  private async restoreAccess(record: MemoryRecord): Promise<void> {
    try {
      const access = JSON.parse(
        await this.fs.readFile(this.accessPath(record.id)),
      );
      if (access.createdAt !== record.createdAt) return;
      for (const field of [
        "lastAccessedAt",
        "lastUsedAt",
        "accessCount",
      ] as const) {
        if (typeof access[field] === "number" && Number.isFinite(access[field]))
          record[field] = Math.max(record[field] ?? 0, access[field]);
      }
    } catch {
      // Sidecars are optional; legacy files keep their embedded usage values.
    }
  }

  /** Regenerate the MEMORY.md overview from the current records. */
  async rebuildIndex(): Promise<void> {
    this.indexDirty = true;
    const records = this.all();
    const lines: string[] = [
      "# Confucius memory",
      "",
      `${records.length} memories. Files in \`${MEMORIES_DIR}/\` are the source of truth;`,
      "this index is regenerated after every change. Edit or delete any file freely.",
      "",
    ];
    if (records.length === 0) {
      lines.push("_No memories yet._");
    }
    for (const type of MEMORY_TYPES) {
      const group = records.filter((record) => record.type === type);
      if (group.length === 0) {
        continue;
      }
      lines.push(`## ${type} (${group.length})`);
      lines.push("");
      for (const record of group) {
        const date = new Date(record.updatedAt).toISOString().slice(0, 10);
        lines.push(
          `- **${record.title}** \`${record.id}\` — ${record.content} _(${date}${record.tags.length ? `, ${record.tags.join(", ")}` : ""})_`,
        );
      }
      lines.push("");
    }
    await this.fs.makeDirectory(this.root);
    await this.fs.writeFile(this.indexPath, lines.join("\n") + "\n");
    this.indexDirty = false;
  }

  async flushIndex(): Promise<void> {
    if (this.indexDirty) await this.rebuildIndex();
  }

  private memoryPath(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error("Invalid memory identifier");
    return joinPath(this.memoriesDir, `${id}.md`);
  }
}

function joinPath(base: string, rest: string): string {
  return base.endsWith("/") ? `${base}${rest}` : `${base}/${rest}`;
}

function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}
