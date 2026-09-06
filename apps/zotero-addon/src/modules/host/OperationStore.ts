import type {
  PreparedOperation,
  ToolExecutionContext,
  ToolResult,
} from "@confucius/protocol";
import {
  ResourceLocks,
  runtimeDigest,
  type JsonStorage,
} from "./RuntimeStorage";

export interface OperationRecord {
  id: string;
  name: string;
  /** Normalized public request, before domain defaults and targets are resolved. */
  request?: string;
  /** The sole durable intent. Legacy fields below remain readable during migration. */
  intent?: PreparedOperation;
  args: Record<string, unknown>;
  context: ToolExecutionContext;
  resources: string[];
  startedAt: number;
  finishedAt?: number;
  stage?: string;
  elapsedMs?: number;
  /** The canonical receipt, including per-entry outcomes for a partial batch. */
  result?: ToolResult;
}

export interface OperationQuery {
  taskId?: string;
  domain?: string;
  name?: string;
  /** Match any overlapping resource. */
  resources?: readonly string[];
}

export interface OperationReader {
  getOperation(id: string): Promise<OperationRecord | null>;
  listOperations(query?: OperationQuery): Promise<OperationRecord[]>;
}

export interface OperationRepository extends OperationReader {
  importLegacyOperation(record: OperationRecord): Promise<void>;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function freezePreparedOperation(
  value: PreparedOperation,
): PreparedOperation {
  if (
    value.schemaVersion !== 1 ||
    !value.domain ||
    !value.name ||
    !isObject(value.args) ||
    !isObject(value.recovery) ||
    !Array.isArray(value.resources) ||
    value.resources.some((key) => typeof key !== "string" || !key)
  )
    throw new Error("Invalid prepared operation");
  const frozen = copy({
    ...value,
    resources: [...new Set(value.resources)].sort(),
  });
  const freeze = (entry: unknown): void => {
    if (entry && typeof entry === "object") {
      Object.values(entry).forEach(freeze);
      Object.freeze(entry);
    }
  };
  freeze(frozen);
  return frozen;
}

function validateRecord(
  value: unknown,
  id?: string,
): asserts value is OperationRecord {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    (id !== undefined && value.id !== id) ||
    typeof value.name !== "string" ||
    !isObject(value.args) ||
    !isObject(value.context) ||
    !Array.isArray(value.resources) ||
    value.resources.some((key) => typeof key !== "string") ||
    !Number.isFinite(value.startedAt)
  )
    throw new Error("Operation journal is damaged; it was not reset");
  if (value.intent)
    freezePreparedOperation(value.intent as unknown as PreparedOperation);
  if (
    value.intent &&
    ((value.intent as unknown as PreparedOperation).name !== value.name ||
      !sameValue(
        (value.intent as unknown as PreparedOperation).args,
        value.args,
      ) ||
      !sameValue(
        [
          ...new Set((value.intent as unknown as PreparedOperation).resources),
        ].sort(),
        [...new Set(value.resources as string[])].sort(),
      ))
  )
    throw new Error(
      "Operation compatibility fields disagree with its immutable intent",
    );
  if (
    value.result &&
    (!isObject(value.result) ||
      typeof value.result.ok !== "boolean" ||
      typeof value.result.toolName !== "string" ||
      (value.result.effect !== undefined &&
        !["none", "applied", "partial", "unknown"].includes(
          String(value.result.effect),
        )))
  )
    throw new Error("Operation receipt is damaged; it was not reset");
}

function storedRecord(operation: OperationRecord): unknown {
  if (!operation.intent) return operation;
  // Compatibility fields are derived from the one intent on read, not another
  // durable copy of the arguments/resource set that could disagree with it.
  const { args: _args, resources: _resources, ...saved } = operation;
  return saved;
}

function readRecord(value: unknown): OperationRecord {
  if (!isObject(value))
    throw new Error("Operation record is damaged; it was not reset");
  const intent = value.intent as PreparedOperation | undefined;
  if (
    intent &&
    ((value.args !== undefined && !sameValue(value.args, intent.args)) ||
      (value.resources !== undefined &&
        !sameValue(value.resources, intent.resources)))
  )
    throw new Error(
      "Operation compatibility fields disagree with its immutable intent",
    );
  const operation = intent
    ? { ...value, args: copy(intent.args), resources: [...intent.resources] }
    : value;
  validateRecord(operation);
  return operation;
}

function sameValue(left: unknown, right: unknown): boolean {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : isObject(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, ordered(value[key])]),
          )
        : value;
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

/**
 * One atomically replaced file per operation. The filesystem listing is the
 * index, so losing a UI/task projection cannot hide an unfinished native write.
 * The old global journal is read and copied, never destructively rewritten.
 */
export class OperationStore implements OperationRepository {
  private entries = new Map<string, OperationRecord>();
  private dirty = new Map<string, OperationRecord>();
  private ready = false;
  private loading?: Promise<void>;
  private locks = new ResourceLocks();
  private readonly filenames = new Map<string, Promise<string>>();
  constructor(private readonly storage: JsonStorage) {}

  private async key(id: string): Promise<string> {
    let pending = this.filenames.get(id);
    if (!pending) {
      pending = runtimeDigest(id).then((digest) => `op_${digest}`);
      this.filenames.set(id, pending);
      void pending.catch(() => this.filenames.delete(id));
    }
    return pending;
  }

  private async load(): Promise<void> {
    if (this.ready) return;
    if (!this.loading) this.loading = this.loadRecords();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async loadRecords(): Promise<void> {
    const entries = new Map<string, OperationRecord>();
    const legacy = await this.storage.read<{
      version: number;
      operations: Record<string, OperationRecord>;
    }>("operations");
    if (legacy) {
      if (legacy.version !== 1 || !isObject(legacy.operations))
        throw new Error("Operation journal is damaged; it was not reset");
      for (const [id, operation] of Object.entries(legacy.operations)) {
        validateRecord(operation, id);
        entries.set(id, operation);
      }
    }
    let keys: string[];
    if (this.storage.keys) keys = await this.storage.keys("op_");
    else {
      const index = await this.storage.read<{ version: number; ids: string[] }>(
        "operation-index",
      );
      if (
        index &&
        (index.version !== 1 ||
          !Array.isArray(index.ids) ||
          index.ids.some((id) => typeof id !== "string"))
      )
        throw new Error("Operation index is damaged; it was not reset");
      keys = await Promise.all((index?.ids ?? []).map((id) => this.key(id)));
    }
    const copied = new Set<string>();
    for (const key of keys) {
      const saved = await this.storage.read<{
        version: number;
        operation: unknown;
      }>(key);
      if (!saved || saved.version !== 2)
        throw new Error("Operation record is damaged; it was not reset");
      const operation = readRecord(saved.operation);
      if ((await this.key(operation.id)) !== key)
        throw new Error("Operation record identity does not match its file");
      entries.set(operation.id, operation);
      copied.add(operation.id);
    }
    for (const operation of entries.values())
      if (!copied.has(operation.id))
        await this.storage.write(await this.key(operation.id), {
          version: 2,
          operation: storedRecord(operation),
        });
    if (!this.storage.keys && entries.size)
      await this.storage.write("operation-index", {
        version: 1,
        ids: [...entries.keys()],
      });
    this.entries = entries;
    this.ready = true;
  }

  async getOperation(id: string): Promise<OperationRecord | null> {
    await this.load();
    const operation = this.entries.get(id);
    return operation ? copy(operation) : null;
  }

  async listOperations(query: OperationQuery = {}): Promise<OperationRecord[]> {
    await this.load();
    return [...this.entries.values()]
      .filter(
        (operation) =>
          (query.taskId === undefined ||
            operation.context.taskId === query.taskId) &&
          (query.domain === undefined ||
            operation.intent?.domain === query.domain) &&
          (query.name === undefined || operation.name === query.name) &&
          (!query.resources?.length ||
            operation.resources.some((key) => query.resources!.includes(key))),
      )
      .map(copy);
  }

  async save(operation: OperationRecord): Promise<void> {
    validateRecord(operation);
    await this.load();
    await this.locks.run(["operations"], () => this.saveUnlocked(operation));
  }

  private async saveUnlocked(operation: OperationRecord): Promise<void> {
    const fresh = !this.entries.has(operation.id);
    const saved = copy(operation);
    this.entries.set(operation.id, saved);
    this.dirty.set(operation.id, saved);
    await this.storage.write(await this.key(operation.id), {
      version: 2,
      operation: storedRecord(saved),
    });
    if (fresh && !this.storage.keys)
      await this.storage.write("operation-index", {
        version: 1,
        ids: [...this.entries.keys()],
      });
    this.dirty.delete(operation.id);
  }

  async recover(): Promise<void> {
    await this.load();
    await this.locks.run(["operations"], async () => {
      for (const [id, operation] of this.dirty) {
        await this.storage.write(await this.key(id), {
          version: 2,
          operation: storedRecord(operation),
        });
        this.dirty.delete(id);
      }
      if (!this.storage.keys && this.entries.size)
        await this.storage.write("operation-index", {
          version: 1,
          ids: [...this.entries.keys()],
        });
    });
  }

  async importLegacyOperation(operation: OperationRecord): Promise<void> {
    validateRecord(operation);
    await this.load();
    await this.locks.run(["operations"], async () => {
      const previous = this.entries.get(operation.id);
      if (previous) {
        // Existing canonical facts win. An unresolved canonical intent may be
        // completed by a matching, already known legacy receipt.
        if (
          previous.name !== operation.name ||
          !sameValue(previous.args, operation.args) ||
          (previous.result && previous.result.effect !== "unknown") ||
          !operation.result ||
          operation.result.effect === "unknown"
        )
          return;
        await this.saveUnlocked({
          ...previous,
          result: operation.result,
          finishedAt: operation.finishedAt ?? Date.now(),
        });
        return;
      }
      await this.saveUnlocked(operation);
    });
  }
}
