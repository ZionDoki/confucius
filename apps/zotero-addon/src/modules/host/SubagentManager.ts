import {
  initialContextWindow,
  contextTextSlice,
  withLockedContextFingerprint,
  MAX_CONCURRENT_SUBAGENTS,
  type SubagentRecord,
  type SubagentSummary,
  type ResearchTaskRecord,
  type ConfuciusEvent,
  type LockedContextSnapshot,
} from "@confucius/protocol";
import type {
  BudgetAccountant,
  ToolProvider,
  TurnCheckpoint,
} from "@confucius/harness";
import {
  ResourceLocks,
  runtimeJsonStorage,
  type JsonStorage,
} from "./RuntimeStorage";
import { createAbortController } from "../../utils/webPlatform";

export interface SubagentDocument {
  record: SubagentRecord;
  task: ResearchTaskRecord;
  archive: Record<string, string>;
  events: ConfuciusEvent[];
  checkpoint?: TurnCheckpoint;
}
export interface SubagentRun {
  document: SubagentDocument;
  task: ResearchTaskRecord;
  tools: ToolProvider;
  abort: AbortController;
  budget: BudgetAccountant;
  prompt: string;
  capacity: number;
  maxOutput: number;
  current?(): boolean;
  delivered?(
    result: import("@confucius/protocol").ToolResult,
    args?: Record<string, unknown>,
  ): Promise<void>;
  event(event: ConfuciusEvent): void;
  save(): Promise<void>;
}
export interface SubagentSpawn {
  goal: string;
  title?: string;
  sourceIds?: string[];
  background?: string;
}
interface Options {
  storage?: JsonStorage;
  references?(parent: string): string[];
  parent(id: string): {
    task: ResearchTaskRecord;
    turnId: string;
    budget: BudgetAccountant;
    nativeConfig?: SubagentRecord["nativeConfig"];
  };
  current(record: SubagentRecord): boolean;
  sources(
    parent: ResearchTaskRecord,
    ids: string[],
  ): Promise<LockedContextSnapshot>;
  tools(run: SubagentRun): ToolProvider;
  execute(run: SubagentRun): Promise<{ text: string; error?: string }>;
  stop(run: SubagentRun): Promise<void>;
  changed(record: SubagentSummary): Promise<void>;
  charge(run: SubagentRun): Promise<void>;
}
export function subagentSummary(record: SubagentRecord): SubagentSummary {
  const {
    id,
    parentTaskId,
    parentRunId,
    intentRevision,
    parentTurnId,
    title,
    status,
    createdAt,
    updatedAt,
    attempt,
    error,
    activity,
  } = record;
  return {
    id,
    parentTaskId,
    parentRunId,
    intentRevision,
    parentTurnId,
    title,
    status,
    createdAt,
    updatedAt,
    attempt,
    error,
    activity: activity ? { ...activity } : undefined,
  };
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
class SubagentCancelled extends Error {}
/** Durable scheduler. Its synthetic tasks are never registered in the sidebar. */
export class SubagentManager {
  private readonly store: JsonStorage;
  private readonly locks = new ResourceLocks();
  private readonly documents = new Map<string, SubagentDocument>();
  private readonly running = new Map<string, SubagentRun>();
  private readonly queued: string[] = [];
  private readonly waiters = new Set<() => void>();
  private scheduling = false;
  private readonly cancellingParents = new Map<string, number>();
  private readonly parentEpochs = new Map<string, number>();
  private removedParents = new Set<string>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly options: Options) {
    this.store = options.storage ?? runtimeJsonStorage("subagents");
  }
  private async save(doc: SubagentDocument) {
    const written = await this.locks.run([doc.record.id], async () => {
      if (
        this.removedParents.has(doc.record.parentTaskId) ||
        this.documents.get(doc.record.id) !== doc
      )
        return false;
      doc.record.updatedAt = Date.now();
      await this.store.write(doc.record.id, copy(doc));
      return true;
    });
    if (
      !written ||
      this.removedParents.has(doc.record.parentTaskId) ||
      this.documents.get(doc.record.id) !== doc
    )
      return;
    try {
      await this.options.changed(subagentSummary(doc.record));
    } finally {
      for (const wake of this.waiters) wake();
    }
  }
  private async document(id: string): Promise<SubagentDocument> {
    const cached = this.documents.get(id);
    if (cached) return cached;
    return this.locks.run([id], async () => {
      const cached = this.documents.get(id);
      if (cached) return cached;
      const doc = await this.store.read<SubagentDocument>(id);
      if (!doc) throw new Error("Subagent not found");
      if (doc.record.status === "running" || doc.record.status === "queued") {
        doc.record.status = "interrupted";
        doc.record.error = "Host restarted; resume with the original budget";
        await this.store.write(id, doc);
      }
      this.documents.set(id, doc);
      return doc;
    });
  }
  private async ids(parent: string): Promise<string[]> {
    return [
      ...new Set([
        ...((await this.store.read<string[]>(`${parent}_index`)) ?? []),
        ...(this.options.references?.(parent) ?? []),
        ...[...this.documents.values()]
          .filter((doc) => doc.record.parentTaskId === parent)
          .map((doc) => doc.record.id),
      ]),
    ];
  }
  async list(parent: string) {
    if (this.removedParents.has(parent)) return [];
    return Promise.all(
      (await this.ids(parent)).map(async (id) =>
        subagentSummary((await this.document(id)).record),
      ),
    );
  }
  async read(
    parent: string,
    id: string,
    offset = 0,
    limit = 20,
    archive: { ref?: string; offset?: number; indexOffset?: number } = {},
  ) {
    const doc = await this.document(id);
    if (doc.record.parentTaskId !== parent)
      throw new Error("Subagent belongs to another task");
    const start = Math.max(0, Math.floor(offset)),
      count = Math.min(25, Math.max(1, Math.floor(limit)));
    // Expose source/tool receipts, never internal model messages or reasoning.
    const refs = Object.keys(doc.archive).filter((ref) =>
      /^(tool:|literature:)/.test(ref),
    );
    const archiveStart = Math.max(0, Math.floor(archive.indexOffset ?? 0));
    if (archive.ref && !refs.includes(archive.ref))
      throw new Error(
        "Reference is outside this child's public evidence archive",
      );
    return {
      record: copy(doc.record),
      events: copy(doc.events.slice(start, start + count)),
      totalEvents: doc.events.length,
      nextOffset: start + count < doc.events.length ? start + count : null,
      archiveRefs: refs.slice(archiveStart, archiveStart + 10),
      nextArchiveOffset:
        archiveStart + 10 < refs.length ? archiveStart + 10 : null,
      passage: archive.ref
        ? contextTextSlice(doc.archive[archive.ref], 2000, archive.offset ?? 0)
        : undefined,
    };
  }
  /** Full public process for diagnostics; private model context is not exported. */
  async trace(parent: string, id: string) {
    const doc = await this.document(id);
    if (doc.record.parentTaskId !== parent)
      throw new Error("Subagent belongs to another task");
    return copy({
      record: doc.record,
      events: doc.events,
      archive: Object.fromEntries(
        Object.entries(doc.archive).filter(([ref]) =>
          /^(tool:|literature:)/.test(ref),
        ),
      ),
    });
  }
  async spawn(parentId: string, input: SubagentSpawn, signal?: AbortSignal) {
    if (this.removedParents.has(parentId))
      throw new Error("Parent task was deleted");
    if (
      !input.goal?.trim() ||
      input.goal.length > 8000 ||
      (input.background?.length ?? 0) > 16000 ||
      !Array.isArray(input.sourceIds ?? [])
    )
      throw new Error(
        "Provide a bounded research goal and explicit source IDs",
      );
    const parent = this.options.parent(parentId),
      taskSnapshot = copy(parent.task),
      owner = taskSnapshot.run,
      nativeConfig = copy(parent.nativeConfig ?? null) ?? undefined,
      epoch = this.parentEpochs.get(parentId);
    if (!owner || !parent.budget.canStartIteration())
      throw new Error("Parent research budget is unavailable");
    input = copy(input);
    const assertCurrent = () => {
      if (this.removedParents.has(parentId))
        throw new SubagentCancelled("Parent task was deleted");
      const current = this.options.parent(parentId).task.run;
      if (
        signal?.aborted ||
        this.cancellingParents.has(parentId) ||
        this.parentEpochs.get(parentId) !== epoch ||
        current?.id !== owner.id ||
        current.intentRevision !== owner.intentRevision ||
        current.generation !== owner.generation
      )
        throw new SubagentCancelled(
          "Subagent submission was cancelled or superseded",
        );
    };
    assertCurrent();
    const sources = await this.options.sources(
      taskSnapshot,
      input.sourceIds ?? [],
    );
    assertCurrent();
    const now = Date.now(),
      id = `sub_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const record: SubagentRecord = {
      version: 1,
      id,
      parentTaskId: parentId,
      parentRunId: owner.id,
      intentRevision: owner.intentRevision,
      parentTurnId: parent.turnId,
      title: (input.title ?? input.goal).slice(0, 100),
      goal: input.goal,
      background: input.background ?? "",
      sourceIds: input.sourceIds ?? [],
      sources: copy(sources),
      backend: taskSnapshot.backend,
      runtimeModel: taskSnapshot.runtimeModel,
      nativeConfig,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      attempt: 1,
      result: "",
      evidence: [],
      usageObservable: taskSnapshot.backend === "native",
      allowSearch: !taskSnapshot.templateId,
    };
    const task: ResearchTaskRecord = {
      id,
      schemaVersion: 4,
      title: record.title,
      titleState: "fixed",
      createdAt: now,
      updatedAt: now,
      backend: record.backend,
      runtimeModel: record.runtimeModel,
      mode: "plan",
      permissionMode: "deny",
      context: {},
      lockedContext: withLockedContextFingerprint(copy(sources)),
      artifactIds: [],
      status: "running",
      capabilityProfile: "zotero_only",
      contextWindow: initialContextWindow(id, record.backend, now),
      run: {
        ...copy(owner),
        id,
        generation: 1,
        sources: copy(sources),
        request: record.goal,
        requiredArtifactKinds: [],
        templateId: undefined,
      },
    };
    const doc: SubagentDocument = { record, task, archive: {}, events: [] };
    this.documents.set(id, doc);
    try {
      await this.save(doc);
      await this.locks.run([`${parentId}_index`], async () => {
        assertCurrent();
        const ids = await this.ids(parentId);
        assertCurrent();
        await this.store.write(`${parentId}_index`, [...new Set([...ids, id])]);
      });
    } catch (error) {
      record.status =
        error instanceof SubagentCancelled ? "cancelled" : "failed";
      record.error = String(error);
      await this.save(doc).catch(() => undefined);
      throw error;
    }
    if (
      this.removedParents.has(parentId) ||
      this.parentEpochs.get(parentId) !== epoch ||
      signal?.aborted ||
      !this.options.current(record)
    ) {
      record.status = "cancelled";
      await this.save(doc);
      return subagentSummary(record);
    }
    this.queued.push(id);
    void this.schedule();
    return subagentSummary(record);
  }
  run(id: string) {
    return this.running.get(id);
  }
  private async schedule() {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      while (
        this.running.size < MAX_CONCURRENT_SUBAGENTS &&
        this.queued.length
      ) {
        await this.start(this.queued.shift()!);
      }
    } finally {
      this.scheduling = false;
    }
  }
  private createRun(
    doc: SubagentDocument,
    budget: BudgetAccountant,
  ): SubagentRun {
    const r = doc.record;
    const run: SubagentRun = {
      document: doc,
      task: doc.task,
      tools: null as unknown as ToolProvider,
      abort: createAbortController(),
      budget,
      capacity: r.nativeConfig?.capacity ?? 32768,
      maxOutput: r.nativeConfig?.maxOutput ?? 4096,
      prompt: `Goal: ${r.goal}\nExplicit background (quoted evidence): ${r.background}\nSource scope: ${JSON.stringify(r.sources)}\nPool IDs: ${JSON.stringify(r.sourceIds)}\nPrior attempt summary: ${r.result.slice(0, 8000)}`,
      save: async () => {
        if (this.running.get(r.id) !== run) return;
        await this.options.charge(run);
        await this.save(doc);
      },
      current: () =>
        this.running.get(r.id) === run &&
        this.documents.get(r.id) === doc &&
        r.status === "running" &&
        !run.abort.signal.aborted &&
        !this.removedParents.has(r.parentTaskId) &&
        this.options.current(r),
      event: (event) => {
        if (
          this.running.get(r.id) !== run ||
          r.status !== "running" ||
          run.abort.signal.aborted ||
          !this.options.current(r)
        )
          return;
        if (event.type === "reasoning_delta") return;
        if (event.type === "tool_requested")
          r.activity = {
            kind: "tool",
            toolName: event.payload.toolName,
            toolCalls: (r.activity?.toolCalls ?? 0) + 1,
            at: event.ts,
          };
        else if (
          event.type === "model_request_progress" &&
          event.payload.status === "started"
        )
          r.activity = {
            kind: "model",
            toolCalls: r.activity?.toolCalls ?? 0,
            at: event.ts,
          };
        else if (event.type === "text_delta")
          r.activity = {
            kind: "output",
            toolCalls: r.activity?.toolCalls ?? 0,
            at: event.ts,
          };
        if (event.type === "text_delta" && event.payload.phase !== "commentary")
          r.result += event.payload.text;
        if (event.type === "model_usage_updated" && !r.usageObservable)
          run.budget.recordUsage({
            promptTokens: event.payload.inputTokens,
            completionTokens: event.payload.outputTokens,
            totalTokens: event.payload.totalTokens,
          });
        doc.events.push(copy(event));
        if (!this.saveTimers.has(r.id))
          this.saveTimers.set(
            r.id,
            setTimeout(() => {
              this.saveTimers.delete(r.id);
              void run.save().catch(() => undefined);
            }, 500),
          );
      },
    };
    return run;
  }
  private async start(id: string) {
    let doc: SubagentDocument | undefined;
    try {
      doc = await this.document(id);
      const r = doc.record;
      if (r.status !== "queued") return;
      if (
        this.removedParents.has(r.parentTaskId) ||
        this.cancellingParents.has(r.parentTaskId) ||
        !this.options.current(r)
      ) {
        r.status = "cancelled";
        await this.save(doc);
        return;
      }
      let parent: ReturnType<Options["parent"]>;
      try {
        parent = this.options.parent(r.parentTaskId);
      } catch (error) {
        r.status = "interrupted";
        r.error = String(error);
        await this.save(doc);
        return;
      }
      if (!parent.budget.canStartIteration()) {
        r.status = "failed";
        r.error = "Parent budget exhausted";
        await this.save(doc);
        return;
      }
      const run = this.createRun(doc, parent.budget);
      run.tools = this.options.tools(run);
      this.running.set(id, run);
      r.status = "running";
      r.result = "";
      if (r.backend !== "native") {
        run.budget.recordIteration();
        run.budget.recordModelAttempt();
      }
      await run.save();
      void this.perform(run);
    } catch (error) {
      this.running.delete(id);
      if (doc) {
        if (doc.record.status !== "cancelled") doc.record.status = "failed";
        doc.record.error = String(error);
        await this.save(doc).catch(() => undefined);
      }
      for (const wake of this.waiters) wake();
    }
  }
  private async perform(run: SubagentRun) {
    const r = run.document.record;
    try {
      if (!run.current?.()) {
        r.status = "cancelled";
        return;
      }
      const result = await this.options.execute(run);
      if (run.current?.()) {
        r.result = result.text;
        r.error = result.error;
        r.status = result.error ? "failed" : "completed";
      } else r.status = "cancelled";
    } catch (error) {
      r.status = run.abort.signal.aborted ? "cancelled" : "failed";
      r.error = String(error);
    } finally {
      clearTimeout(this.saveTimers.get(r.id));
      this.saveTimers.delete(r.id);
      try {
        await run.save();
      } catch (error) {
        if (r.status !== "cancelled") r.status = "failed";
        r.error = `Failed to persist subagent result: ${String(error)}`;
        await this.save(run.document).catch(() => undefined);
      }
      this.running.delete(r.id);
      for (const wake of this.waiters) wake();
      void this.schedule();
    }
  }
  async wait(parent: string, ids?: string[], signal?: AbortSignal) {
    while (!signal?.aborted) {
      let wake!: () => void;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      this.waiters.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
      try {
        const all = await this.list(parent);
        const selected = ids?.length
          ? all.filter((r) => ids.includes(r.id))
          : all;
        if (ids?.some((id) => !all.some((r) => r.id === id)))
          throw new Error("Unknown subagent");
        if (signal?.aborted) throw new Error("Subagent wait cancelled");
        if (
          selected.every(
            (r) =>
              !["queued", "running"].includes(r.status) &&
              !this.running.has(r.id),
          )
        )
          return selected;
        await changed;
      } finally {
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", wake);
      }
    }
    throw new Error("Subagent wait cancelled");
  }
  async cancel(parent: string, id?: string) {
    // Block dequeue before the first await: aborting one running child frees a
    // slot and must not start another child while the parent is being stopped.
    const release = !id ? this.beginCancellation(parent) : undefined;
    try {
      const rows = await this.list(parent);
      if (id && !rows.some((r) => r.id === id))
        throw new Error("Subagent belongs to another task");
      for (const row of rows) {
        if (id && row.id !== id) continue;
        if (!["queued", "running"].includes(row.status)) continue;
        const doc = await this.document(row.id);
        if (!["queued", "running"].includes(doc.record.status)) continue;
        doc.record.status = "cancelled";
        const queued = this.queued.indexOf(row.id);
        if (queued >= 0) this.queued.splice(queued, 1);
        const run = this.running.get(row.id);
        run?.abort.abort();
        if (run) await this.options.stop(run).catch(() => undefined);
        await this.save(doc);
      }
      return this.list(parent);
    } finally {
      release?.();
    }
  }
  private beginCancellation(parent: string) {
    this.cancellingParents.set(
      parent,
      (this.cancellingParents.get(parent) ?? 0) + 1,
    );
    this.parentEpochs.set(parent, (this.parentEpochs.get(parent) ?? 0) + 1);
    return () => {
      const remaining = this.cancellingParents.get(parent)! - 1;
      if (remaining) this.cancellingParents.set(parent, remaining);
      else this.cancellingParents.delete(parent);
    };
  }
  async retry(parent: string, id: string) {
    const previous = await this.document(id),
      r = previous.record;
    if (this.removedParents.has(parent) || this.cancellingParents.has(parent))
      throw new Error("Parent task was deleted or cancelled");
    if (r.parentTaskId !== parent || !this.options.current(r))
      throw new Error(
        "This request was superseded; delegate again from the current request",
      );
    if (
      this.documents.get(id) !== previous ||
      this.running.has(id) ||
      !["failed", "interrupted", "cancelled"].includes(r.status)
    )
      throw new Error("Subagent cannot be retried now");
    this.options.parent(parent); // No new budget is created by the scheduler.
    // Late tool/adapter callbacks retain the previous attempt's document only.
    const doc = copy(previous);
    doc.record.status = "queued";
    doc.record.attempt++;
    delete doc.record.error;
    this.documents.set(id, doc);
    doc.task.run!.generation++;
    delete doc.task.externalSessionId;
    delete doc.task.externalTurnId;
    try {
      await this.save(doc);
    } catch (error) {
      if ((doc.record.status as SubagentRecord["status"]) !== "cancelled")
        doc.record.status = "failed";
      doc.record.error = String(error);
      await this.save(doc).catch(() => undefined);
      throw error;
    }
    if (
      doc.record.status !== "queued" ||
      this.documents.get(id) !== doc ||
      this.removedParents.has(parent)
    )
      return subagentSummary(doc.record);
    this.queued.push(id);
    void this.schedule();
    return subagentSummary(doc.record);
  }
  async branch(source: string, target: string, completedIds: string[]) {
    const ids: string[] = [],
      mapping = new Map<string, SubagentSummary>();
    for (const id of completedIds) {
      const doc = await this.document(id);
      if (
        doc.record.parentTaskId !== source ||
        doc.record.status !== "completed"
      )
        continue;
      const fork = copy(doc);
      fork.record.id = `${id}_${target}`;
      fork.record.parentTaskId = target;
      fork.task.id = fork.record.id;
      await this.store.write(fork.record.id, fork);
      ids.push(fork.record.id);
      mapping.set(id, subagentSummary(fork.record));
    }
    await this.store.write(`${target}_index`, ids);
    return mapping;
  }
  async remove(parent: string) {
    const release = this.beginCancellation(parent);
    try {
      await this.cancel(parent);
      const ids = await this.ids(parent);
      this.removedParents.add(parent);
      for (const id of ids) {
        clearTimeout(this.saveTimers.get(id));
        this.saveTimers.delete(id);
        await this.locks.run([id], async () => {
          await this.store.remove?.(id);
          this.documents.delete(id);
        });
      }
      await this.locks.run([`${parent}_index`], async () => {
        await this.store.remove?.(`${parent}_index`);
      });
    } finally {
      release();
    }
  }
}
