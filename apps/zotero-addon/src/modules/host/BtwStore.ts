import {
  CONTEXT_POLICY,
  validateBtwSelection,
  btwSourceKey,
  type BtwRecord,
} from "@confucius/protocol";
import type { MemoryFileSystem } from "@confucius/memory";
import { stringifyDurableHostState } from "./StatePersistence";

export interface BtwDocument {
  record: BtwRecord;
  archive: Record<string, string>;
  checkpoint?: unknown;
  archivedAt?: number;
}

/** Deliberately outside HistoryStore, task lists, logs and memory extraction. */
export class BtwStore {
  private queues = new Map<string, Promise<void>>();
  private revisions = new Map<string, number>();
  constructor(
    private readonly fs: MemoryFileSystem,
    private readonly root: () => string,
  ) {}

  private path(id: string): string {
    if (!/^btw_[\w-]+$/.test(id)) throw new Error("Invalid btw identifier");
    return `${this.root()}/${id}.json`;
  }

  async load(id: string): Promise<BtwDocument | undefined> {
    await this.queues.get(id);
    const path = this.path(id);
    if (!(await this.fs.listFiles(this.root())).includes(path))
      return undefined;
    const doc = JSON.parse(await this.fs.readFile(path)) as BtwDocument;
    const r = doc.record;
    if (r?.source)
      validateBtwSelection({
        source: r.source,
        text: "validation",
        surroundingText: "",
        capturedAt: 0,
      });
    if (
      !r ||
      r.version !== 1 ||
      r.id !== id ||
      !Array.isArray(r.turns) ||
      !doc.archive ||
      typeof doc.archive !== "object" ||
      Array.isArray(doc.archive) ||
      Object.values(doc.archive).some((value) => typeof value !== "string") ||
      !["native", "codex", "kimi"].includes(r.backend) ||
      typeof r.draft !== "string" ||
      !Number.isFinite(r.updatedAt) ||
      !Number.isFinite(r.createdAt) ||
      r.sourceKey !== btwSourceKey(r.source) ||
      id !== `btw_${r.sourceKey}`
    )
      throw new Error("Saved btw history is damaged; original file retained");
    for (const turn of r.turns) {
      validateBtwSelection(turn.selection);
      if (
        btwSourceKey(turn.selection.source) !== r.sourceKey ||
        !turn.id ||
        !turn.requestId ||
        typeof turn.prompt !== "string" ||
        typeof turn.answer !== "string" ||
        !["running", "completed", "failed", "interrupted"].includes(turn.status)
      )
        throw new Error("Saved btw turn is damaged; original file retained");
      if (turn.status === "running") {
        turn.status = "interrupted";
        turn.error =
          "回答因应用重启中断，可继续追问。 / Interrupted by restart.";
      }
    }
    return doc;
  }

  save(doc: BtwDocument): Promise<void> {
    const id = doc.record.id;
    const path = this.path(id);
    const content = stringifyDurableHostState(doc);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    return this.enqueue(id, async () => {
      await this.fs.makeDirectory(this.root());
      await this.fs.writeFile(path, content);
    });
  }

  private enqueue(id: string, work: () => Promise<void>): Promise<void> {
    const queued = (this.queues.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    this.queues.set(id, queued);
    return queued.finally(() => {
      if (this.queues.get(id) === queued) this.queues.delete(id);
    });
  }

  remove(id: string): Promise<void> {
    const path = this.path(id);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    return this.enqueue(id, async () => {
      if ((await this.fs.listFiles(this.root())).includes(path))
        await this.fs.deleteFile(path);
    });
  }

  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  async ids(): Promise<string[]> {
    return (await this.fs.listFiles(this.root())).flatMap((path) => {
      const match = path.match(/\/(btw_[\w-]+)\.json$/);
      return match ? [match[1]] : [];
    });
  }

  async cleanup(
    active: ReadonlySet<string> | ((id: string) => boolean),
    now: number,
  ): Promise<string[]> {
    const isActive =
      typeof active === "function" ? active : (id: string) => active.has(id);
    const docs: Array<{ doc: BtwDocument; size: number; revision: number }> =
      [];
    for (const id of await this.ids()) {
      if (isActive(id)) continue;
      // A damaged file is retained for recovery, never silently replaced or pruned.
      try {
        const revision = this.revisions.get(id) ?? 0;
        const doc = await this.load(id);
        if (doc)
          docs.push({
            doc,
            revision,
            size: this.fs.fileSize
              ? await this.fs.fileSize(this.path(id))
              : JSON.stringify(doc).length * 2,
          });
      } catch {
        /* Keep the original. */
      }
    }
    docs.sort((a, b) => b.doc.record.updatedAt - a.doc.record.updatedAt);
    const day = 86_400_000;
    let recentBytes = 0,
      archiveBytes = 0;
    const removed: string[] = [];
    for (const [index, entry] of docs.entries()) {
      const { doc, size } = entry;
      recentBytes += size;
      const recent =
        index < CONTEXT_POLICY.recentTasks &&
        now - doc.record.updatedAt < CONTEXT_POLICY.recentDays * day &&
        recentBytes <= CONTEXT_POLICY.recentBytes;
      if (recent) continue;
      const expired =
        now - (doc.archivedAt ?? now) >= CONTEXT_POLICY.archiveDays * day ||
        archiveBytes + size > CONTEXT_POLICY.archiveBytes;
      if (!expired) archiveBytes += size;
      if (!expired && doc.archivedAt !== undefined) continue;
      const id = doc.record.id;
      // Serialize retention with writes, and discard snapshots superseded by
      // a draft, reopened source, or a new run while file reads were pending.
      await this.enqueue(id, async () => {
        if (isActive(id) || (this.revisions.get(id) ?? 0) !== entry.revision)
          return;
        if (expired) {
          await this.fs.deleteFile(this.path(id));
          removed.push(id);
        } else {
          doc.archivedAt = now;
          await this.fs.writeFile(
            this.path(id),
            stringifyDurableHostState(doc),
          );
        }
      });
    }
    return removed;
  }
}
