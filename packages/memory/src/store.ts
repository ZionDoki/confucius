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
    return [...this.records.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  stats(): MemoryStats {
    return {
      total: this.records.size,
      byType: memoryTypesOf(this.all()),
    };
  }

  async put(record: MemoryRecord): Promise<void> {
    this.records.set(record.id, record);
    await this.fs.makeDirectory(this.memoriesDir);
    await this.fs.writeFile(this.memoryPath(record.id), serializeMemory(record));
    this.accessDirty.delete(record.id);
  }

  async remove(id: string): Promise<boolean> {
    const existed = this.records.delete(id);
    if (existed) {
      await this.fs.deleteFile(this.memoryPath(id)).catch(() => undefined);
      this.accessDirty.delete(id);
    }
    return existed;
  }

  /** Record a retrieval hit in memory; persisted by flushAccess() later. */
  touch(id: string, now: number): void {
    const record = this.records.get(id);
    if (!record) {
      return;
    }
    record.lastAccessedAt = now;
    record.accessCount += 1;
    this.accessDirty.add(id);
  }

  async flushAccess(): Promise<void> {
    const dirty = [...this.accessDirty];
    this.accessDirty.clear();
    for (const id of dirty) {
      const record = this.records.get(id);
      if (record) {
        await this.fs.writeFile(this.memoryPath(id), serializeMemory(record));
      }
    }
  }

  /** Regenerate the MEMORY.md overview from the current records. */
  async rebuildIndex(): Promise<void> {
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
  }

  private memoryPath(id: string): string {
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
