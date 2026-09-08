import { schedule } from "../tools/Deadline";
import type { ToolExecutionScope } from "@confucius/protocol";
import { runInScope } from "./ExecutionScope";
/** IOUtils on Windows still applies MAX_PATH unless given an extended path. */
export function runtimeIoPath(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path))
    return `\\\\?\\${path.replace(/\//g, "\\")}`;
  if (path.startsWith("\\\\") && !path.startsWith("\\\\?\\"))
    return `\\\\?\\UNC\\${path.slice(2)}`;
  return path;
}
export function runtimeLogicalPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}
/** Plugin execution state only. Native notes, annotations and attachments stay in Zotero. */
export function runtimePath(...parts: string[]): string {
  const root = PathUtils.localProfileDir;
  if (!root)
    throw new Error(
      "Zotero local profile directory is unavailable; runtime storage was not redirected to the data directory",
    );
  return PathUtils.join(root, "confucius", "runtime-v1", ...parts);
}

export class ResourceLocks {
  private queues = new Map<string, Promise<unknown>>();
  async run<T>(
    keys: readonly string[],
    work: () => Promise<T>,
    scope?: ToolExecutionScope,
  ): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const previous = ordered.map(
      (key) => this.queues.get(key) ?? Promise.resolve(),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const key of ordered) this.queues.set(key, gate);
    const predecessors = Promise.all(
      previous.map((entry) => entry.catch(() => undefined)),
    );
    const releaseGate = () => {
      release();
      for (const key of ordered)
        if (this.queues.get(key) === gate) this.queues.delete(key);
    };
    try {
      if (scope) await runInScope(scope, () => predecessors);
      else await predecessors;
    } catch (error) {
      // A cancelled waiter must not let a later waiter overtake its predecessors.
      void predecessors.then(releaseGate);
      throw error;
    }
    try {
      return await work();
    } finally {
      releaseGate();
    }
  }
}
const fileLocks = new ResourceLocks();
const RETRY_DELAYS = [100, 250, 500, 1000];

export interface AtomicWriter {
  write(path: string, text: string, temporary: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  parent(path: string): string;
  wait(ms: number): Promise<void>;
}
const geckoWriter: AtomicWriter = {
  write: async (path, text, tmpPath) => {
    await IOUtils.writeUTF8(runtimeIoPath(path), text, {
      tmpPath: runtimeIoPath(tmpPath),
      flush: true,
    });
  },
  mkdir: async (path) => {
    await IOUtils.makeDirectory(runtimeIoPath(path), {
      ignoreExisting: true,
      createAncestors: true,
    });
  },
  parent: (path) => PathUtils.parent(path)!,
  wait: (ms) =>
    new Promise((resolve) => {
      schedule(resolve, ms);
    }),
};
export async function writeRuntimeText(
  path: string,
  text: string,
  fs: AtomicWriter = geckoWriter,
): Promise<void> {
  await fileLocks.run([path], async () => {
    const temporary = `${path}.${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}.tmp`;
    const started = Date.now();
    const trace = (retryCount: number, saved: boolean) => {
      try {
        if (typeof ztoolkit !== "undefined")
          ztoolkit.log("[Confucius] runtime storage", {
            operationId: temporary,
            path,
            stage: "atomic_replace",
            elapsedMs: Date.now() - started,
            retryCount,
            effect: saved ? "applied" : "unknown",
            persistence: saved ? "saved" : "pending",
          });
      } catch {
        /* Diagnostics cannot change persistence semantics. */
      }
    };
    await fs.mkdir(fs.parent(path));
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.write(path, text, temporary);
        trace(attempt, true);
        return;
      } catch (error) {
        if (
          attempt >= RETRY_DELAYS.length ||
          !/ACCESS_DENIED|sharing|busy|locked|EPERM|EACCES/i.test(String(error))
        ) {
          trace(attempt, false);
          throw error;
        }
        await fs.wait(
          Math.round(RETRY_DELAYS[attempt] * (0.9 + Math.random() * 0.2)),
        );
      }
    }
  });
}

export interface JsonStorage {
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, value: T): Promise<void>;
  /** Listing makes operation indexes rebuildable. Older adapters may omit it. */
  keys?(prefix?: string): Promise<string[]>;
}
const safeKey = (key: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(key))
    throw new Error("Invalid runtime record key");
  return key;
};
export function runtimeJsonStorage(folder = "records"): JsonStorage {
  return {
    async keys(prefix = "") {
      if (prefix && !/^[a-zA-Z0-9_-]+$/.test(prefix))
        throw new Error("Invalid runtime record prefix");
      const root = runtimePath(folder);
      if (!(await IOUtils.exists(runtimeIoPath(root)))) return [];
      return (await IOUtils.getChildren(runtimeIoPath(root)))
        .map((path) => PathUtils.filename(path))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5))
        .filter((name) => name.startsWith(prefix));
    },
    async read<T>(key: string): Promise<T | null> {
      const path = runtimePath(folder, `${safeKey(key)}.json`);
      if (!(await IOUtils.exists(runtimeIoPath(path)))) return null;
      // IO failures and corrupt JSON are never interpreted as a missing record.
      return JSON.parse(await IOUtils.readUTF8(runtimeIoPath(path))) as T;
    },
    async write<T>(key: string, value: T) {
      await writeRuntimeText(
        runtimePath(folder, `${safeKey(key)}.json`),
        JSON.stringify(value),
      );
    },
  };
}
export function memoryJsonStorage(): JsonStorage {
  const values = new Map<string, string>();
  return {
    async keys(prefix = "") {
      return [...values.keys()].filter((key) => key.startsWith(prefix));
    },
    async read<T>(key: string) {
      return values.has(key) ? (JSON.parse(values.get(key)!) as T) : null;
    },
    async write<T>(key: string, value: T) {
      values.set(key, JSON.stringify(value));
    },
  };
}

export interface MigrationFs {
  exists(path: string): Promise<boolean>;
  children(path: string): Promise<string[]>;
  directory(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  copy(from: string, to: string): Promise<void>;
  digest(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  write(path: string, text: string): Promise<void>;
  join(...parts: string[]): string;
  basename(path: string): string;
  remove?(path: string): Promise<void>;
}
const migrationFs: MigrationFs = {
  exists: (path) => IOUtils.exists(runtimeIoPath(path)),
  children: async (path) =>
    (await IOUtils.getChildren(runtimeIoPath(path))).map(runtimeLogicalPath),
  directory: async (path) =>
    (await IOUtils.stat(runtimeIoPath(path))).type === "directory",
  read: (path) => IOUtils.readUTF8(runtimeIoPath(path)),
  copy: (from, to) => IOUtils.copy(runtimeIoPath(from), runtimeIoPath(to)),
  digest: (path) => IOUtils.computeHexDigest(runtimeIoPath(path), "sha256"),
  mkdir: async (path) => {
    await IOUtils.makeDirectory(runtimeIoPath(path), {
      ignoreExisting: true,
      createAncestors: true,
    });
  },
  write: writeRuntimeText,
  join: (...parts) => PathUtils.join(...parts),
  basename: (path) => PathUtils.filename(path),
  remove: (path) => IOUtils.remove(runtimeIoPath(path), { ignoreAbsent: true }),
};
interface MigrationManifest {
  version: 1;
  source: string;
  state: "copying" | "active";
  files: Record<string, string>;
}
export async function migrateRuntimeStorage(
  source = PathUtils.join(Zotero.DataDirectory.dir, "confucius"),
  destination = runtimePath(),
  fs: MigrationFs = migrationFs,
): Promise<void> {
  await fs.mkdir(destination);
  const manifestPath = fs.join(destination, "migration.json");
  const previous: MigrationManifest | null = (await fs.exists(manifestPath))
    ? JSON.parse(await fs.read(manifestPath))
    : null;
  if (
    previous &&
    (previous.version !== 1 ||
      (previous.state !== "active" && previous.source !== source) ||
      !["copying", "active"].includes(previous.state) ||
      !previous.files ||
      typeof previous.files !== "object" ||
      Array.isArray(previous.files))
  )
    throw new Error(
      "Runtime storage belongs to another data directory or its migration manifest is damaged",
    );
  if (previous?.state === "active") return;
  const historyRoot = fs.join(source, "history");
  if (
    !(await fs.exists(fs.join(source, "state.json"))) &&
    (await fs.exists(historyRoot)) &&
    (await fs.children(historyRoot)).length
  )
    throw new Error(
      "Existing history has no task index; migration was not activated as an empty state",
    );
  const manifest: MigrationManifest = previous ?? {
    version: 1,
    source,
    state: "copying",
    files: {},
  };
  await fs.write(manifestPath, JSON.stringify(manifest));
  const walk = async (relative: string): Promise<void> => {
    if (
      relative
        .split("/")
        .some(
          (part) =>
            !part || part === "." || part === ".." || part.includes("\\"),
        )
    )
      throw new Error("Unsafe runtime migration path");
    if (relative.split("/").length > 32)
      throw new Error("Runtime directory nesting exceeds migration limit");
    const from = fs.join(source, ...relative.split("/")),
      to = fs.join(destination, ...relative.split("/"));
    if (await fs.directory(from)) {
      await fs.mkdir(to);
      for (const child of await fs.children(from))
        await walk(`${relative}/${fs.basename(child)}`);
      return;
    }
    if (relative.endsWith(".tmp")) return;
    const digest = await fs.digest(from);
    if (!(await fs.exists(to)) || (await fs.digest(to)) !== digest)
      await fs.copy(from, to);
    if ((await fs.digest(to)) !== digest)
      throw new Error(`Runtime migration checksum mismatch: ${relative}`);
    if (
      relative.endsWith(".json") &&
      !relative.startsWith("runtime-workspaces")
    ) {
      const value = JSON.parse(await fs.read(to));
      if (
        relative === "state.json" &&
        (!value || !Array.isArray(value.tasks ?? value.sessions))
      )
        throw new Error(
          "Invalid saved task index; migration was not activated",
        );
      if (fs.basename(to) === "index.json" && relative.startsWith("history")) {
        if (
          !Array.isArray(value.items) ||
          !Array.isArray(value.notes) ||
          !Array.isArray(value.windows)
        )
          throw new Error(`Invalid history index: ${relative}`);
        const taskRoot = relative.replace(/[\\/]index\.json$/, "");
        const refs = [
          ...value.items.map((item: { windowId: string; itemId: string }) =>
            [taskRoot, "windows", item.windowId, `${item.itemId}.txt`].join(
              "/",
            ),
          ),
          ...value.notes.map((note: { name: string; revision: number }) =>
            [taskRoot, "notes", `${note.name}_${note.revision}.txt`].join("/"),
          ),
        ];
        for (const item of value.items)
          if (!/^[\w-]+$/.test(item.windowId) || !/^[\w-]+$/.test(item.itemId))
            throw new Error(`Invalid history reference: ${relative}`);
        for (const note of value.notes)
          if (
            !/^[\w-]+$/.test(note.name) ||
            !Number.isSafeInteger(note.revision) ||
            note.revision < 1
          )
            throw new Error(`Invalid note reference: ${relative}`);
        for (const ref of refs)
          if (!(await fs.exists(fs.join(source, ...ref.split("/")))))
            throw new Error(`History body missing: ${ref}`);
      }
    }
    manifest.files[relative] = digest;
    await fs.write(manifestPath, JSON.stringify(manifest));
  };
  for (const name of [
    "state.json",
    "history",
    "logs",
    "artifacts",
    "runtime-workspaces",
    "tmp",
  ])
    if (await fs.exists(fs.join(source, name))) await walk(name);
  manifest.state = "active";
  await fs.write(manifestPath, JSON.stringify(manifest));
}

/** Call only after the migrated host state has been successfully restored and
 * persisted. Remove unchanged, verified old context copies, never user artifacts. */
export async function clearMigratedContextCopies(
  destination = runtimePath(),
  fs: MigrationFs = migrationFs,
): Promise<void> {
  const path = fs.join(destination, "migration.json");
  if (!fs.remove || !(await fs.exists(path))) return;
  const manifest = JSON.parse(await fs.read(path)) as MigrationManifest;
  if (
    manifest.version !== 1 ||
    manifest.state !== "active" ||
    !manifest.source ||
    manifest.source === destination ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    throw new Error("Invalid migration cleanup manifest");
  const copies: Array<{ relative: string; original: string }> = [];
  for (const [relative, digest] of Object.entries(manifest.files)) {
    if (!(
      relative === "state.json" ||
      relative.startsWith("history/") ||
      relative.startsWith("logs/")
    ))
      continue;
    if (
      relative
        .split("/")
        .some(
          (part) =>
            !part || part === "." || part === ".." || part.includes("\\"),
        )
    )
      throw new Error("Unsafe migration cleanup path");
    const original = fs.join(manifest.source, ...relative.split("/"));
    if (await fs.exists(original)) {
      if ((await fs.digest(original)) !== digest)
        throw new Error(
          "An old context copy changed after migration; cleanup was deferred",
        );
      const replacement = fs.join(destination, ...relative.split("/"));
      if (!(await fs.exists(replacement)))
        throw new Error("Migrated context copy is missing; originals retained");
      // History bodies are immutable. Mutable indexes/state may have advanced,
      // but must still parse before their old copies can be removed.
      if (relative.startsWith("history/") && relative.endsWith(".txt")) {
        if ((await fs.digest(replacement)) !== digest)
          throw new Error("Migrated context body changed; originals retained");
      } else if (relative.endsWith(".json")) {
        const value = JSON.parse(await fs.read(replacement));
        if (
          relative === "state.json" &&
          !Array.isArray(value?.tasks ?? value?.sessions)
        )
          throw new Error("Invalid migrated task index; originals retained");
        if (
          relative.startsWith("history/") &&
          fs.basename(replacement) === "index.json" &&
          (!Array.isArray(value?.items) ||
            !Array.isArray(value?.notes) ||
            !Array.isArray(value?.windows))
        )
          throw new Error("Invalid migrated history index; originals retained");
      }
    }
    copies.push({ relative, original });
  }
  // Preflight the entire batch before deleting any old copy. On interruption,
  // absent originals are safe to acknowledge when the manifest is retried.
  for (const { relative, original } of copies) {
    await fs.remove(original);
    delete manifest.files[relative];
    await fs.write(path, JSON.stringify(manifest));
  }
}

export async function runtimeDigest(value: string): Promise<string> {
  const webCrypto =
    (typeof Zotero !== "undefined"
      ? Zotero.getMainWindow?.()?.crypto
      : undefined) ?? globalThis.crypto;
  const digest = await webCrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
