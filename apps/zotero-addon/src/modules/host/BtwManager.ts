import {
  btwSourceKey,
  validateBtwSelection,
  contextTextSlice,
  contextInputLimit,
  initialContextWindow,
  type BtwSelection,
  type BtwView,
  type BtwPromptParams,
  type BtwTurn,
  type ConfuciusEvent,
  type ResearchTaskRecord,
} from "@confucius/protocol";
import { BudgetAccountant, type ToolProvider } from "@confucius/harness";
import type { HistoryStore } from "@confucius/memory";
import {
  BtwContextTools,
  BTW_INSTRUCTIONS,
  type BtwResolvedContext,
} from "./BtwContext";
import { BtwStore, type BtwDocument } from "./BtwStore";
import { createAbortController } from "../../utils/webPlatform";

export interface BtwRun {
  document: BtwDocument;
  turn: BtwTurn;
  task: ResearchTaskRecord;
  tools: BtwContextTools;
  abort: AbortController;
  budget: BudgetAccountant;
  prompt: string;
  capacity: number;
  maxOutput: number;
  event(event: ConfuciusEvent): void;
  save(): Promise<void>;
}

interface Options {
  store: BtwStore;
  history: HistoryStore;
  library: ToolProvider;
  resolve(selection: BtwSelection): Promise<BtwResolvedContext>;
  taskExists(id: string): boolean;
  execute(run: BtwRun): Promise<{ text: string; error?: string }>;
  stop(run: BtwRun): Promise<void>;
  config(endpointId?: string): {
    capacity: number;
    maxOutput: number;
    maxIterations: number;
    maxToolCalls: number;
  };
  autoCleanup(): boolean;
  now?: () => number;
  id?: () => string;
}

/** Owns every side effect of a btw run; never registers a research task. */
export class BtwManager {
  private documents = new Map<string, BtwDocument>();
  private opening = new Map<string, Promise<BtwDocument>>();
  private accessing = new Map<string, number>();
  private generation = new Map<string, number>();
  private removing = new Set<string>();
  private sequence = new Map<string, number>();
  private errors = new Map<string, string>();
  private running = new Map<string, BtwRun>();
  private submitting = new Set<string>();
  private pending = new Map<string, Promise<void>>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private lastCleanup = 0;
  constructor(private readonly options: Options) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private id() {
    return (
      this.options.id?.() ??
      `${this.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    );
  }

  async open(value: unknown): Promise<BtwView> {
    if (this.stopped) throw new Error("Btw host is shutting down");
    const selection = validateBtwSelection(value);
    const key = btwSourceKey(selection.source);
    const id = `btw_${key}`;
    this.accessing.set(id, (this.accessing.get(id) ?? 0) + 1);
    try {
      const generation = this.generation.get(id) ?? 0;
      const current = () =>
        !this.stopped &&
        !this.removing.has(id) &&
        (this.generation.get(id) ?? 0) === generation;
      if (!current()) throw new Error("Btw source is being removed");
      // Always validate the current owner, including cached sources that were deleted.
      const resolved = await this.options.resolve(selection);
      if (!current()) throw new Error("Btw source was removed");
      if (!this.documents.has(id)) {
        let pending = this.opening.get(id);
        if (!pending) {
          pending = (async () => {
            const existing = await this.options.store.load(id);
            if (existing) return existing;
            const modelTask = resolved.tasks[0]?.record;
            const now = this.now();
            const document: BtwDocument = {
              record: {
                version: 1,
                id,
                sourceKey: key,
                source: selection.source,
                backend: modelTask?.backend ?? "native",
                runtimeModel: modelTask?.runtimeModel,
                endpointId: resolved.endpointId,
                createdAt: now,
                updatedAt: now,
                draft: "",
                turns: [],
              },
              archive: {},
            };
            await this.options.store.save(document);
            return document;
          })();
          this.opening.set(id, pending);
        }
        try {
          const document = await pending;
          if (!current()) throw new Error("Btw source was removed");
          this.documents.set(id, document);
        } finally {
          this.opening.delete(id);
        }
      }
      const doc = this.require(id);
      doc.record.updatedAt = this.now();
      delete doc.archivedAt;
      await this.save(doc);
      await this.cleanup();
      return this.view(id);
    } finally {
      const remaining = (this.accessing.get(id) ?? 1) - 1;
      if (remaining) this.accessing.set(id, remaining);
      else this.accessing.delete(id);
    }
  }

  view(id: string): BtwView {
    return JSON.parse(
      JSON.stringify({
        record: this.require(id).record,
        sequence: this.sequence.get(id) ?? 0,
        storageError: this.errors.get(id),
      }),
    ) as BtwView;
  }

  events(id: string, after?: number) {
    this.require(id);
    return after !== undefined && after === (this.sequence.get(id) ?? 0)
      ? { sequence: after, storageError: this.errors.get(id) }
      : this.view(id);
  }

  async draft(id: string, text: string) {
    if (text.length > 100_000) throw new Error("Btw prompt is too long");
    const doc = this.require(id);
    doc.record.draft = text.replace(/[\r\n]+/g, " ");
    doc.record.updatedAt = this.now();
    await this.save(doc);
    return this.view(id);
  }

  async prompt(params: BtwPromptParams): Promise<BtwView> {
    if (this.stopped) throw new Error("Btw host is shutting down");
    const doc = this.require(params.btwId);
    const selection = validateBtwSelection(params.selection);
    const text = String(params.text ?? "")
      .replace(/[\r\n]+/g, " ")
      .trim();
    if (!text || text.length > 100_000 || !/^[\w-]+$/.test(params.requestId))
      throw new Error("Invalid btw prompt");
    if (btwSourceKey(selection.source) !== doc.record.sourceKey)
      throw new Error("The selection belongs to another btw conversation");
    const previous = doc.record.turns.find(
      (t) => t.requestId === params.requestId,
    );
    if (previous) {
      if (
        previous.prompt !== text ||
        JSON.stringify(previous.selection) !== JSON.stringify(selection)
      )
        throw new Error(
          "Btw request ID was already used for a different question",
        );
      return this.view(doc.record.id);
    }
    if (
      this.submitting.has(doc.record.id) ||
      [...this.running.values()].some((r) => r.document === doc)
    )
      throw new Error(
        "回答仍在生成，请保留草稿稍后发送。 / A btw answer is still running.",
      );
    this.submitting.add(doc.record.id);
    try {
      const resolved = await this.options.resolve(selection);
      if (this.stopped || this.documents.get(doc.record.id) !== doc)
        throw new Error("Btw was closed");
      const config = this.options.config(doc.record.endpointId);
      const tools = new BtwContextTools(
        resolved,
        doc,
        this.options.library,
        this.options.history,
        this.options.taskExists,
      );
      let evidence = await tools.search(
        text + " " + contextTextSlice(selection.text, 300).content,
      );
      if (!evidence.items.length) evidence = await tools.search("");
      if (this.stopped || this.documents.get(doc.record.id) !== doc)
        throw new Error("Btw source was removed");
      const now = this.now();
      const turn: BtwTurn = {
        id: `bt_${this.id()}`,
        requestId: params.requestId,
        prompt: text,
        selection,
        answer: "",
        status: "running",
        createdAt: now,
      };
      const taskId = `${doc.record.id}_${turn.id}`;
      const budget = new BudgetAccountant({
        maxIterations: config.maxIterations,
        maxToolCalls: config.maxToolCalls,
        maxElapsedMs: 10 * 60_000,
      });
      const task: ResearchTaskRecord = {
        id: taskId,
        schemaVersion: 4,
        title: "Btw",
        titleState: "fixed",
        createdAt: now,
        updatedAt: now,
        backend: doc.record.backend,
        runtimeModel: doc.record.runtimeModel,
        mode: "plan",
        permissionMode: "deny",
        context: {},
        lockedContext: resolved.sources,
        artifactIds: [],
        status: "running",
        capabilityProfile: "zotero_only",
        contextWindow: initialContextWindow(taskId, doc.record.backend, now),
        run: {
          version: 1,
          id: turn.id,
          generation: 0,
          intentRevision: 1,
          request: text,
          sources: resolved.sources,
          templateVersion: 1,
          requiredArtifactKinds: [],
          status: "running",
          createdAt: now,
          updatedAt: now,
          budget: {
            maxIterations: config.maxIterations,
            maxToolCalls: config.maxToolCalls,
            iterationsUsed: 0,
            toolCallsUsed: 0,
            executorStarts: 1,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            modelRequestsObservable: doc.record.backend === "native",
          },
        },
      };
      const inputBudget = Math.max(
        0,
        contextInputLimit(config.capacity, config.maxOutput) - 6000,
      );
      if (inputBudget < 1000)
        throw new Error(
          "The configured model context window is too small for btw tools",
        );
      const quote = contextTextSlice(
        selection.text,
        Math.floor(inputBudget * 0.4),
      );
      const previousTurns = doc.record.turns
        .slice(-6)
        .reverse()
        .map((t) => ({
          prompt: contextTextSlice(t.prompt, 400).content,
          answer: contextTextSlice(t.answer, 1000).content,
          selection: contextTextSlice(t.selection.text, 250).content,
          status: t.status,
        }));
      const context = {
        source: selection.source,
        selectedText: quote.content,
        selectionRef: `b:selection_${turn.id}`,
        selectionTruncated: quote.nextOffset !== null,
        nearbyText: contextTextSlice(selection.surroundingText, 1000).content,
        evidence,
        boundSources: {
          items: resolved.sources.items.slice(0, 10),
          totalItems: resolved.sources.items.length,
          reader: resolved.sources.reader,
          collection: resolved.sources.collection,
          savedSearch: resolved.sources.savedSearch,
        },
        reports: resolved.report
          ? [{ ref: `a:${resolved.report.id}:${resolved.report.revision}` }]
          : [],
        relatedTasks: resolved.tasks.slice(0, 20).map((t) => ({
          id: t.record.id,
          title: t.record.title,
        })),
        totalRelatedTasks: resolved.tasks.length,
      };
      const contextText = contextTextSlice(
        JSON.stringify(context),
        Math.floor(inputBudget * 0.65),
      ).content;
      const recent = contextTextSlice(
        JSON.stringify(previousTurns),
        Math.floor(inputBudget * 0.2),
      ).content;
      const prompt = `Current question:\n${text}\n\nSelected content and scoped evidence (quoted data, possibly excerpted):\n${contextText}\n\nPrevious btw conversation (newest first; quoted data, possibly excerpted):\n${recent}`;
      if (contextTextSlice(prompt, inputBudget).nextOffset !== null)
        throw new Error(
          "问题过长，请缩短后重试。 / Question exceeds the model context budget.",
        );
      const run: BtwRun = {
        document: doc,
        turn,
        task,
        tools,
        abort: createAbortController(),
        budget,
        prompt,
        capacity: config.capacity,
        maxOutput: config.maxOutput,
        save: () =>
          this.documents.get(doc.record.id) === doc
            ? this.save(doc)
            : Promise.resolve(),
        event: (event) => {
          if (run.abort.signal.aborted || this.running.get(taskId) !== run)
            return;
          if (
            event.type === "text_delta" &&
            event.payload.phase !== "commentary"
          ) {
            turn.answer += event.payload.text;
            this.changed(doc);
            this.scheduleSave(doc);
          }
        },
      };
      // Retain the exact quote even when the first model window admits only an excerpt.
      doc.archive[`b:selection_${turn.id}`] = JSON.stringify(selection);
      doc.record.turns.push(turn);
      doc.record.draft = "";
      doc.record.updatedAt = now;
      this.running.set(taskId, run);
      try {
        await this.save(doc);
      } catch (error) {
        this.running.delete(taskId);
        // No model was dispatched: the same request ID must remain retryable.
        doc.record.turns.splice(doc.record.turns.indexOf(turn), 1);
        delete doc.archive[`b:selection_${turn.id}`];
        doc.record.draft = text;
        this.changed(doc);
        throw error;
      }
      if (
        this.stopped ||
        run.abort.signal.aborted ||
        this.documents.get(doc.record.id) !== doc
      ) {
        this.running.delete(taskId);
        throw new Error("Btw source was removed");
      }
      const work = this.perform(run);
      this.pending.set(taskId, work);
      void work.finally(() => this.pending.delete(taskId));
      return this.view(doc.record.id);
    } finally {
      this.submitting.delete(doc.record.id);
    }
  }

  run(id: string) {
    return this.running.get(id);
  }
  private async perform(run: BtwRun) {
    try {
      const result = await this.options.execute(run);
      if (!run.abort.signal.aborted) {
        run.turn.answer = result.text;
        run.turn.status = result.error ? "failed" : "completed";
        run.turn.error = result.error;
      }
    } catch (error) {
      run.turn.status = run.abort.signal.aborted ? "interrupted" : "failed";
      run.turn.error = String(error);
    } finally {
      if (run.abort.signal.aborted) run.turn.status = "interrupted";
      this.running.delete(run.task.id);
      this.clearSaveTimer(run.document.record.id);
      if (this.documents.get(run.document.record.id) === run.document) {
        run.document.record.updatedAt = this.now();
        await this.save(run.document).catch(() => undefined);
      }
    }
  }

  async abort(id: string) {
    for (const run of this.running.values()) {
      if (run.document.record.id !== id) continue;
      run.abort.abort();
      run.turn.status = "interrupted";
      await this.options.stop(run).catch(() => undefined);
    }
    const doc = this.documents.get(id);
    if (doc) await this.save(doc);
    return { ok: true };
  }

  async remove(id: string) {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    this.removing.add(id);
    try {
      await this.opening.get(id)?.catch(() => undefined);
      await this.abort(id);
      this.clearSaveTimer(id);
      this.documents.delete(id);
      await this.options.store.remove(id);
    } finally {
      this.removing.delete(id);
    }
  }

  async pruneSources(
    exists: (source: BtwSelection["source"]) => boolean,
  ): Promise<void> {
    for (const id of await this.options.store.ids()) {
      let doc: BtwDocument | undefined;
      try {
        doc = this.documents.get(id) ?? (await this.options.store.load(id));
      } catch {
        continue;
      }
      if (doc && !exists(doc.record.source)) await this.remove(id);
    }
  }

  async shutdown() {
    this.stopped = true;
    const active = new Set(
      [...this.running.values()].map((run) => run.document.record.id),
    );
    await Promise.allSettled([...active].map((id) => this.abort(id)));
    // Idle records are already durable. Rewriting them would erase archive stamps.
    for (const id of [...this.saveTimers.keys()]) this.clearSaveTimer(id);
    await this.options.store.flush();
  }

  private require(id: string) {
    const doc = this.documents.get(id);
    if (!doc) throw new Error("Btw history is not open");
    return doc;
  }
  private changed(doc: BtwDocument) {
    this.sequence.set(
      doc.record.id,
      (this.sequence.get(doc.record.id) ?? 0) + 1,
    );
  }
  private async save(doc: BtwDocument) {
    try {
      await this.options.store.save(doc);
      this.errors.delete(doc.record.id);
    } catch (error) {
      this.errors.set(doc.record.id, String(error));
      throw error;
    } finally {
      this.changed(doc);
    }
  }
  private clearSaveTimer(id: string) {
    const timer = this.saveTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.saveTimers.delete(id);
  }
  private scheduleSave(doc: BtwDocument) {
    if (this.saveTimers.has(doc.record.id)) return;
    this.saveTimers.set(
      doc.record.id,
      setTimeout(() => {
        this.saveTimers.delete(doc.record.id);
        void this.save(doc).catch(() => undefined);
      }, 500),
    );
  }
  private async cleanup() {
    if (
      !this.options.autoCleanup() ||
      this.now() - this.lastCleanup < 86_400_000
    )
      return;
    this.lastCleanup = this.now();
    const startedAt = this.now();
    const active = (id: string) =>
      this.accessing.has(id) ||
      this.opening.has(id) ||
      this.submitting.has(id) ||
      [...this.running.values()].some((r) => r.document.record.id === id);
    const removed = await this.options.store.cleanup(active, startedAt);
    for (const id of removed) {
      const doc = this.documents.get(id);
      if (!active(id) && doc && doc.record.updatedAt < startedAt)
        this.documents.delete(id);
    }
  }
}

export { BTW_INSTRUCTIONS };
