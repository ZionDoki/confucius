import {
  artifactBodyMatchesKind,
  isCitation,
  isArtifactKind,
  isArtifactRecord,
  type AgentBackendKind,
  type ArtifactRecord,
  type ArtifactUpsertInput,
} from "@confucius/protocol";

export interface ArtifactFileSystem {
  read(path: string): Promise<string>;
  writeAtomic(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  makeDirectory(path: string): Promise<void>;
}

class ZoteroArtifactFileSystem implements ArtifactFileSystem {
  async read(path: string): Promise<string> {
    return IOUtils.readUTF8(path);
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    const tmpPath = `${path}.tmp`;
    await IOUtils.writeUTF8(path, content, { tmpPath, flush: true });
  }

  async exists(path: string): Promise<boolean> {
    return IOUtils.exists(path);
  }

  async makeDirectory(path: string): Promise<void> {
    await IOUtils.makeDirectory(path, { ignoreExisting: true });
  }
}

export class ArtifactStore {
  private readonly cache = new Map<string, ArtifactRecord>();
  private readonly operationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly fs: ArtifactFileSystem = new ZoteroArtifactFileSystem(),
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () =>
      `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  ) {}

  async get(id: string): Promise<ArtifactRecord | null> {
    const cleanId = safeId(id);
    return this.withArtifactLock(cleanId, () => this.getUnlocked(cleanId));
  }

  private async getUnlocked(id: string): Promise<ArtifactRecord | null> {
    const cleanId = safeId(id);
    const cached = this.cache.get(cleanId);
    if (cached) return clone(cached);
    const path = this.path(cleanId);
    if (!(await this.fs.exists(path))) return null;
    try {
      const artifact = JSON.parse(await this.fs.read(path)) as ArtifactRecord;
      if (artifact.id !== cleanId || !isArtifactRecord(artifact)) {
        return null;
      }
      this.cache.set(cleanId, artifact);
      return clone(artifact);
    } catch {
      return null;
    }
  }

  async list(ids: readonly string[]): Promise<ArtifactRecord[]> {
    const artifacts = await Promise.all(ids.map((id) => this.get(id)));
    return artifacts
      .filter((artifact): artifact is ArtifactRecord => artifact !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async upsert(
    input: ArtifactUpsertInput,
    backend: AgentBackendKind,
    defaultSourceContextIds: string[] = [],
  ): Promise<ArtifactRecord> {
    if (!isArtifactKind(input.kind)) {
      throw new Error("Unknown artifact kind");
    }
    if (!artifactBodyMatchesKind(input.kind, input.body)) {
      throw new Error(`Artifact body does not match kind ${input.kind}`);
    }
    const title = String(input.title ?? "").trim();
    if (!title) throw new Error("Artifact title is required");
    const taskId = String(input.taskId ?? "").trim();
    if (!taskId) throw new Error("Artifact taskId is required");
    if (
      input.status !== undefined &&
      input.status !== "draft" &&
      input.status !== "ready"
    ) {
      throw new Error("Artifact status must be draft or ready");
    }
    if (input.citations && !input.citations.every(isCitation)) {
      throw new Error("Artifact citations are invalid");
    }
    if (
      input.sourceContextIds &&
      !input.sourceContextIds.every(
        (value) => typeof value === "string" && value.trim().length > 0,
      )
    ) {
      throw new Error("Artifact source context ids are invalid");
    }

    const id = input.id ? safeId(input.id) : safeId(this.createId());
    return this.withArtifactLock(id, async () => {
      const existing = input.id ? await this.getUnlocked(id) : null;
      if (existing && existing.taskId !== taskId) {
        throw new Error("Artifact belongs to another task");
      }
      if (existing && existing.kind !== input.kind) {
        throw new Error("Artifact kind cannot change across revisions");
      }
      const at = this.now();
      const revision = (existing?.revision ?? 0) + 1;
      const citations = (input.citations ?? []).map((citation, index) => ({
        ...citation,
        id: citation.id || `cite_${id}_${revision}_${index + 1}`,
      }));
      const sourceContextIds = unique(
        input.sourceContextIds ?? defaultSourceContextIds,
      );
      const nextRevision = {
        revision,
        body: clone(input.body),
        citations: clone(citations),
        sourceContextIds,
        createdAt: at,
        backend,
      };
      const artifact: ArtifactRecord = {
        id,
        sessionId: taskId,
        taskId,
        kind: input.kind,
        title,
        body: clone(input.body),
        status: input.status ?? "ready",
        revision,
        citations,
        sourceContextIds,
        revisions: [...(existing?.revisions ?? []), nextRevision],
        writeback:
          existing?.writeback?.state === "committed"
            ? {
                ...existing.writeback,
                state: "none",
                revision: undefined,
                committedAt: undefined,
                error: undefined,
              }
            : existing?.writeback,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      return this.writeUnlocked(artifact);
    });
  }

  async save(artifact: ArtifactRecord): Promise<ArtifactRecord> {
    if (!isArtifactRecord(artifact)) {
      throw new Error("Artifact record is invalid");
    }
    const id = safeId(artifact.id);
    return this.withArtifactLock(id, () => this.writeUnlocked(artifact));
  }

  /** Atomically merge metadata into the latest persisted revision. */
  async update(
    id: string,
    updater: (artifact: ArtifactRecord) => ArtifactRecord | null,
  ): Promise<ArtifactRecord | null> {
    const cleanId = safeId(id);
    return this.withArtifactLock(cleanId, async () => {
      const current = await this.getUnlocked(cleanId);
      if (!current) return null;
      const updated = updater(clone(current));
      if (!updated) return null;
      if (safeId(updated.id) !== cleanId || !isArtifactRecord(updated)) {
        throw new Error("Updated artifact record is invalid");
      }
      return this.writeUnlocked(updated);
    });
  }

  private async writeUnlocked(
    artifact: ArtifactRecord,
  ): Promise<ArtifactRecord> {
    const id = safeId(artifact.id);
    await this.fs.makeDirectory(this.root);
    await this.fs.writeAtomic(this.path(id), JSON.stringify(artifact, null, 2));
    this.cache.set(id, clone(artifact));
    return clone(artifact);
  }

  private async withArtifactLock<T>(
    id: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operationLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operationLocks.set(id, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.operationLocks.get(id) === current) {
        this.operationLocks.delete(id);
      }
    }
  }

  private path(id: string): string {
    const separator = this.root.includes("\\") ? "\\" : "/";
    return `${this.root.replace(/[\\/]$/, "")}${separator}${safeId(id)}.json`;
  }
}

function safeId(value: string): string {
  const clean = String(value).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) {
    throw new Error("Invalid artifact id");
  }
  return clean;
}

function unique(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map(String)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createArtifactStore(): ArtifactStore {
  return new ArtifactStore(
    PathUtils.join(Zotero.DataDirectory.dir, "confucius", "artifacts"),
  );
}
