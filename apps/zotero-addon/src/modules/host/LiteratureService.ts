import type {
  LiteraturePool,
  LiteratureSearch,
  LiteratureWork,
  LiteraturePage,
  LiteratureSummary,
  LiteratureConfirmation,
  LockedItemContext,
} from "@confucius/protocol";
import {
  ResourceLocks,
  runtimeJsonStorage,
  type JsonStorage,
} from "./RuntimeStorage";
import { LiteratureError, type OpenAlexClient } from "./OpenAlexClient";
import { createAbortController } from "../../utils/webPlatform";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function literatureSummary(pool: LiteraturePool): LiteratureSummary {
  const selected = pool.works.filter((w) => w.decision.selected);
  const latest = pool.queries.at(-1);
  return {
    id: pool.taskId,
    revision: pool.revision,
    candidateRevision: pool.candidateRevision,
    pool: pool.works.length,
    evaluated: pool.works.filter((w) => w.decision.evaluated).length,
    candidates: selected.length,
    pendingFulltext: selected.filter(
      (w) => w.acquisition.status !== "available",
    ).length,
    available: pool.works.filter((w) => w.acquisition.status === "available")
      .length,
    read: pool.works.filter((w) => w.reads?.length).length,
    awaitingFulltext: !!pool.waitingFulltext,
    awaitingConfirmation: !!pool.waiting,
    latestQuery: latest && {
      id: latest.id,
      query: latest.query,
      createdAt: latest.createdAt,
      total: latest.total,
      fromYear: latest.fromYear,
      toYear: latest.toYear,
      openAccess: latest.openAccess,
    },
    hasCandidateChanges:
      (pool.confirmedRevision ?? 0) !== pool.candidateRevision,
    acquiring: pool.works.filter((w) =>
      ["queued", "downloading"].includes(w.acquisition.status),
    ).length,
  };
}
export interface LiteratureAcquirer {
  ensureItem(work: LiteratureWork): Promise<LockedItemContext>;
  acquire(
    work: LiteratureWork,
    signal: AbortSignal,
    stage: (stage: "existing" | "open_access" | "cache") => Promise<void>,
  ): Promise<{
    attachmentKey: string;
    stage: "existing" | "open_access" | "cache";
  }>;
  attach(work: LiteratureWork, path: string): Promise<string>;
}
interface Options {
  client: OpenAlexClient;
  storage?: JsonStorage;
  acquire: LiteratureAcquirer;
  /** Must reject during active research; user confirmation is an execution boundary. */
  canConfirm(taskId: string): void;
  bind(
    taskId: string,
    items: LockedItemContext[],
    removed: LockedItemContext[],
  ): Promise<void>;
  changed(taskId: string, summary: LiteratureSummary): Promise<void>;
  exists(taskId: string): boolean;
}
/** All UI and model mutations share this versioned domain. Large pools never enter the task index. */
export class LiteratureService {
  private readonly storage: JsonStorage;
  private readonly locks = new ResourceLocks();
  private readonly jobs = new Map<
    string,
    { abort: AbortController; work: Promise<void> }
  >();
  private readonly batches = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly confirmationWaits = new Map<
    string,
    { runId?: string; signal?: AbortSignal }
  >();
  private readonly removed = new Set<string>();
  constructor(private readonly options: Options) {
    this.storage = options.storage ?? runtimeJsonStorage("literature");
  }
  private assert(taskId: string) {
    if (this.removed.has(taskId) || !this.options.exists(taskId))
      throw new Error("Research task no longer exists");
  }
  async load(taskId: string): Promise<LiteraturePool> {
    this.assert(taskId);
    return (
      (await this.storage.read<LiteraturePool>(taskId)) ?? {
        version: 1,
        taskId,
        revision: 0,
        candidateRevision: 0,
        confirmedIds: [],
        works: [],
        queries: [],
        updatedAt: Date.now(),
      }
    );
  }
  private async save(pool: LiteraturePool) {
    this.assert(pool.taskId);
    pool.revision++;
    pool.updatedAt = Date.now();
    await this.storage.write(`${pool.taskId}_r${pool.revision}`, pool);
    await this.storage.write(pool.taskId, pool);
    await this.options.changed(pool.taskId, literatureSummary(pool));
    for (const wake of this.listeners.get(pool.taskId) ?? []) wake();
  }
  private mutate<T>(
    taskId: string,
    work: (pool: LiteraturePool) => Promise<T> | T,
  ) {
    return this.locks.run([taskId], async () => {
      const pool = await this.load(taskId);
      const result = await work(pool);
      await this.save(pool);
      return result;
    });
  }
  async list(
    taskId: string,
    options: {
      offset?: number;
      limit?: number;
      filter?: string;
      selected?: boolean;
      queryOffset?: number;
    } = {},
  ): Promise<LiteraturePage> {
    const pool = await this.load(taskId),
      offset = Math.max(0, Math.floor(options.offset || 0)),
      limit = Math.min(25, Math.max(1, Math.floor(options.limit || 20)));
    const filter = (options.filter ?? "").toLocaleLowerCase();
    const rows = pool.works.filter(
      (w) =>
        (options.selected === undefined ||
          w.decision.selected === options.selected) &&
        (!filter ||
          [w.title, w.abstract, ...w.authors, w.decision.reason]
            .join(" ")
            .toLocaleLowerCase()
            .includes(filter)),
    );
    return {
      summary: literatureSummary(pool),
      queries: [...pool.queries]
        .reverse()
        .slice(
          Math.max(0, Math.floor(options.queryOffset ?? 0)),
          Math.max(0, Math.floor(options.queryOffset ?? 0)) + 10,
        ),
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    };
  }
  async get(taskId: string, id: string) {
    const work = (await this.load(taskId)).works.find(
      (w) => w.id === id || w.openAlexIds.includes(id),
    );
    if (!work) throw new Error("Paper is not in this task's pool");
    return work;
  }
  async search(taskId: string, input: LiteratureSearch, signal?: AbortSignal) {
    // Serialize page requests so repeated load-more clicks cannot skip a cursor.
    await this.locks.run([taskId], async () => {
      const pool = await this.load(taskId);
      const existing = input.queryId
        ? pool.queries.find((q) => q.id === input.queryId)
        : undefined;
      if (input.queryId && !existing) throw new Error("Unknown query");
      if (existing && !existing.cursor) return;
      const id =
        existing?.id ??
        `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await this.options.client.search(
        existing ?? input,
        id,
        existing?.cursor ?? "*",
        signal,
      );
      this.assert(taskId);
      if (signal?.aborted) throw new LiteratureError("cancelled", "Cancelled");
      for (const incoming of result.works) {
        const same = pool.works.filter(
          (w) =>
            w.openAlexIds.some((i) => incoming.openAlexIds.includes(i)) ||
            (incoming.doi && w.doi === incoming.doi),
        );
        const found = same.sort(
          (a, b) =>
            Number(b.decision.actor === "user") -
              Number(a.decision.actor === "user") ||
            b.decision.revision - a.decision.revision,
        )[0];
        if (found) {
          for (const duplicate of same.filter((w) => w !== found)) {
            found.queryIds.push(...duplicate.queryIds);
            found.openAlexIds.push(...duplicate.openAlexIds);
            found.pdfUrls.push(...duplicate.pdfUrls);
            found.reads = [...(found.reads ?? []), ...(duplicate.reads ?? [])];
            if (
              !found.acquisition.item ||
              duplicate.acquisition.status === "available"
            )
              found.acquisition = duplicate.acquisition;
            pool.confirmedIds = [
              ...new Set(
                pool.confirmedIds.map((id) =>
                  id === duplicate.id ? found.id : id,
                ),
              ),
            ];
            if (pool.waitingFulltext)
              pool.waitingFulltext.ids = pool.waitingFulltext.ids.map((id) =>
                id === duplicate.id ? found.id : id,
              );
            pool.works = pool.works.filter((w) => w !== duplicate);
            pool.candidateRevision++;
          }
          found.doi = incoming.doi ?? found.doi;
          found.queryIds = [...new Set([...found.queryIds, id])];
          found.openAlexIds = [
            ...new Set([...found.openAlexIds, ...incoming.openAlexIds]),
          ];
          found.pdfUrls = [...new Set([...found.pdfUrls, ...incoming.pdfUrls])];
          found.cachedPdfUrl ??= incoming.cachedPdfUrl;
          found.abstract ??= incoming.abstract;
          // Identity joins never replace a user decision or durable acquisition.
        } else pool.works.push(incoming);
      }
      if (existing)
        Object.assign(existing, {
          total: result.total,
          cursor: result.cursor,
          pages: existing.pages + 1,
        });
      else
        pool.queries.push({
          ...input,
          queryId: undefined,
          id,
          createdAt: Date.now(),
          total: result.total,
          cursor: result.cursor,
          pages: 1,
        });
      await this.save(pool);
    });
    return this.list(taskId);
  }
  async updateCandidates(
    taskId: string,
    revision: number,
    changes: Array<{ id: string; selected: boolean; reason?: string }>,
    actor: "agent" | "user",
  ) {
    if (
      !Array.isArray(changes) ||
      changes.length > 100 ||
      changes.some(
        (c) => typeof c.id !== "string" || typeof c.selected !== "boolean",
      )
    )
      throw new Error("Invalid candidate changes");
    await this.mutate(taskId, (pool) => {
      if (pool.candidateRevision !== revision)
        throw new Error(
          "Candidate revision conflict; reload and respect the latest user choices",
        );
      for (const change of changes)
        if (!pool.works.some((w) => w.id === change.id))
          throw new Error("Unknown paper");
      pool.candidateRevision++;
      for (const change of changes) {
        const work = pool.works.find((w) => w.id === change.id)!;
        work.decision = {
          selected: change.selected,
          evaluated: true,
          reason: change.reason?.slice(0, 4000),
          actor,
          revision: pool.candidateRevision,
        };
      }
    });
    return this.list(taskId);
  }
  async preview(taskId: string): Promise<LiteratureConfirmation> {
    const p = await this.load(taskId),
      selected = p.works.filter((w) => w.decision.selected);
    return {
      candidateRevision: p.candidateRevision,
      added: selected
        .filter((w) => !p.confirmedIds.includes(w.id))
        .map((w) => w.id),
      removed: p.confirmedIds.filter(
        (id) => !selected.some((w) => w.id === id),
      ),
      acquire: selected
        .filter((w) => w.acquisition.status !== "available")
        .map((w) => w.id),
    };
  }
  async requestConfirmation(taskId: string) {
    await this.mutate(taskId, (p) => {
      if (p.confirmedRevision !== p.candidateRevision || p.waiting)
        p.waiting = {
          candidateRevision: p.candidateRevision,
          requestedAt: Date.now(),
        };
    });
    return this.preview(taskId);
  }
  async waitForConfirmation(
    taskId: string,
    revision: number,
    signal?: AbortSignal,
    runId?: string,
  ) {
    const owner = { runId, signal };
    this.confirmationWaits.set(taskId, owner);
    try {
      while (!signal?.aborted) {
        let wake!: () => void;
        const ready = new Promise<void>((resolve) => {
          wake = resolve;
        });
        const listeners = this.listeners.get(taskId) ?? new Set();
        this.listeners.set(taskId, listeners);
        listeners.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
        try {
          const p = await this.load(taskId);
          if (
            p.confirmedRevision !== undefined &&
            p.confirmedRevision >= revision &&
            !p.waiting
          )
            return this.list(taskId);
          if (!p.waiting) throw new Error("Confirmation was dismissed");
          await ready;
        } finally {
          listeners.delete(wake);
          signal?.removeEventListener("abort", wake);
        }
      }
      throw new LiteratureError("cancelled", "Cancelled");
    } finally {
      if (this.confirmationWaits.get(taskId) === owner)
        this.confirmationWaits.delete(taskId);
    }
  }
  isWaitingForConfirmation(taskId: string, runId: string) {
    const owner = this.confirmationWaits.get(taskId);
    return !!owner && owner.runId === runId && !owner.signal?.aborted;
  }
  async waitForFulltext(taskId: string, runId?: string, signal?: AbortSignal) {
    await this.mutate(taskId, (p) => {
      p.waitingFulltext = {
        ids: [...p.confirmedIds],
        runId,
        requestedAt: Date.now(),
      };
    });
    while (!signal?.aborted) {
      let wake!: () => void;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const listeners = this.listeners.get(taskId) ?? new Set();
      this.listeners.set(taskId, listeners);
      listeners.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
      try {
        const p = await this.load(taskId),
          waiting = p.waitingFulltext;
        if (!waiting || waiting.runId !== runId)
          throw new Error("Fulltext wait was replaced");
        if (
          waiting.ids.every(
            (id) =>
              !p.confirmedIds.includes(id) ||
              p.works.find((w) => w.id === id)?.acquisition.status ===
                "available",
          )
        ) {
          await this.mutate(taskId, (p) => {
            delete p.waitingFulltext;
          });
          return this.list(taskId);
        }
        await changed;
      } finally {
        listeners.delete(wake);
        signal?.removeEventListener("abort", wake);
      }
    }
    throw new LiteratureError(
      "cancelled",
      "Fulltext wait cancelled; saved papers remain available",
    );
  }
  async recordRead(
    taskId: string,
    receipt: {
      libraryID: number;
      keys: string[];
      attachmentKey?: string;
      sourceContent?: boolean;
    },
    agent: string,
    contentVersion: string,
    pages?: number[],
  ) {
    if (!receipt.sourceContent) return;
    const p = await this.load(taskId);
    const match = (w: LiteratureWork) =>
      w.acquisition.status === "available" &&
      w.acquisition.item?.libraryID === receipt.libraryID &&
      [w.acquisition.item.key, w.acquisition.attachmentKey].some(
        (k) => !!k && receipt.keys.includes(k),
      );
    if (!p.works.some(match)) return;
    await this.mutate(taskId, (p) => {
      for (const w of p.works.filter(match)) {
        w.reads ??= [];
        w.reads.push({
          agent,
          attachmentKey: receipt.attachmentKey ?? w.acquisition.attachmentKey!,
          contentVersion,
          pages,
          at: Date.now(),
        });
      }
    });
  }
  async confirm(taskId: string, revision: number) {
    this.options.canConfirm(taskId);
    await this.locks.run([taskId], async () => {
      const batch = createAbortController();
      this.batches.set(taskId, batch);
      try {
        const p = await this.load(taskId);
        if (p.candidateRevision !== revision)
          throw new Error(
            "Candidate revision conflict; review the changed selection before confirming",
          );
        const selected = p.works.filter((w) => w.decision.selected);
        // A durable confirmation precedes every library write. Save each item receipt
        // before attempting the next item, so a partial batch is restartable.
        p.confirmedRevision = revision;
        await this.save(p);
        for (const w of selected) {
          this.assert(taskId);
          if (batch.signal.aborted)
            throw new LiteratureError(
              "cancelled",
              "Confirmation batch cancelled; saved items are retained",
            );
          if (!w.acquisition.item) {
            try {
              w.acquisition.item = await this.options.acquire.ensureItem(
                clone(w),
              );
            } catch (error) {
              w.acquisition.status = "failed";
              w.acquisition.error = "unavailable";
              w.acquisition.message = String(error);
            }
            await this.save(p);
          }
        }
        if (batch.signal.aborted)
          throw new LiteratureError(
            "cancelled",
            "Confirmation batch cancelled",
          );
        this.options.canConfirm(taskId);
        const removed = p.works
          .filter((w) => p.confirmedIds.includes(w.id) && !w.decision.selected)
          .flatMap((w) => (w.acquisition.item ? [w.acquisition.item] : []));
        await this.options.bind(
          taskId,
          selected.flatMap((w) =>
            w.acquisition.item ? [w.acquisition.item] : [],
          ),
          removed,
        );
        p.confirmedIds = selected.map((w) => w.id);
        delete p.waiting;
        for (const w of selected)
          if (
            w.acquisition.item &&
            !["available", "downloading"].includes(w.acquisition.status)
          )
            w.acquisition.status = "queued";
        await this.save(p);
      } finally {
        this.batches.delete(taskId);
      }
    });
    this.start(taskId);
    return this.list(taskId);
  }
  private start(taskId: string) {
    if (this.jobs.has(taskId)) return;
    const abort = createAbortController();
    const work = this.download(taskId, abort.signal)
      .catch(() => undefined)
      .finally(async () => {
        this.jobs.delete(taskId);
        if (
          !abort.signal.aborted &&
          !this.removed.has(taskId) &&
          this.options.exists(taskId)
        ) {
          const pool = await this.load(taskId);
          if (
            pool.works.some(
              (w) =>
                pool.confirmedIds.includes(w.id) &&
                w.acquisition.status === "queued",
            )
          )
            this.start(taskId);
        }
      });
    this.jobs.set(taskId, { abort, work });
  }
  private async download(taskId: string, signal: AbortSignal) {
    const worker = async () => {
      while (!signal.aborted) {
        let work: LiteratureWork | undefined;
        await this.mutate(taskId, (p) => {
          const w = p.works.find(
            (w) =>
              p.confirmedIds.includes(w.id) &&
              w.acquisition.status === "queued",
          );
          if (w) {
            w.acquisition.status = "downloading";
            work = clone(w);
          }
        });
        if (!work) return;
        const id = work.id;
        try {
          const result = await this.options.acquire.acquire(
            work,
            signal,
            async (stage) => {
              await this.mutate(taskId, (p) => {
                const acquisition = p.works.find(
                  (w) => w.id === id || w.openAlexIds.includes(id),
                )!.acquisition;
                if (acquisition.status !== "available")
                  acquisition.stage = stage;
              });
            },
          );
          await this.mutate(taskId, (p) => {
            const a = p.works.find(
              (w) => w.id === id || w.openAlexIds.includes(id),
            )!.acquisition;
            if (a.status === "available") return;
            a.status = "available";
            a.attachmentKey = result.attachmentKey;
            a.stage = result.stage;
            if (a.item) a.item.attachmentKey = result.attachmentKey;
            delete a.error;
            delete a.message;
          });
        } catch (error) {
          await this.mutate(taskId, (p) => {
            const a = p.works.find(
              (w) => w.id === id || w.openAlexIds.includes(id),
            )!.acquisition;
            if (a.status === "available") return;
            a.status = "failed";
            a.error = signal.aborted
              ? "cancelled"
              : error instanceof LiteratureError
                ? error.code
                : "network";
            a.message =
              error instanceof LiteratureError
                ? error.message
                : "全文获取失败 / Fulltext acquisition failed";
          });
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }
  async retry(taskId: string, id: string) {
    await this.mutate(taskId, async (p) => {
      if (!p.confirmedIds.includes(id))
        throw new Error("Confirm this candidate first");
      const w = p.works.find((w) => w.id === id || w.openAlexIds.includes(id))!;
      if (["available", "queued", "downloading"].includes(w.acquisition.status))
        return;
      if (!w.acquisition.item) {
        this.options.canConfirm(taskId);
        w.acquisition.item = await this.options.acquire.ensureItem(clone(w));
        await this.save(p);
        this.options.canConfirm(taskId);
        await this.options.bind(
          taskId,
          p.works
            .filter((w) => p.confirmedIds.includes(w.id))
            .flatMap((w) => (w.acquisition.item ? [w.acquisition.item] : [])),
          [],
        );
      }
      w.acquisition.status = "queued";
    });
    this.start(taskId);
    return this.list(taskId);
  }
  async attach(taskId: string, id: string, path: string) {
    const w = await this.get(taskId, id),
      p = await this.load(taskId);
    if (!p.confirmedIds.includes(id) || !w.acquisition.item)
      throw new Error("Confirm this candidate first");
    const key = await this.options.acquire.attach(w, path);
    await this.mutate(taskId, (p) => {
      const a = p.works.find(
        (w) => w.id === id || w.openAlexIds.includes(id),
      )!.acquisition;
      a.status = "available";
      a.attachmentKey = key;
      a.stage = "browser";
      if (a.item) a.item.attachmentKey = key;
      delete a.error;
      delete a.message;
    });
    return this.list(taskId);
  }
  async cancel(taskId: string) {
    this.batches.get(taskId)?.abort();
    const job = this.jobs.get(taskId);
    job?.abort.abort();
    await job?.work;
    if (job && !this.removed.has(taskId) && this.options.exists(taskId))
      await this.mutate(taskId, (p) => {
        for (const work of p.works)
          if (work.acquisition.status === "queued") {
            work.acquisition.status = "failed";
            work.acquisition.error = "cancelled";
            work.acquisition.message =
              "下载已停止，可重试 / Download stopped; retry available";
          }
      });
  }
  async recover(taskId: string) {
    await this.mutate(taskId, (p) => {
      for (const w of p.works)
        if (
          w.acquisition.status === "downloading" ||
          w.acquisition.status === "queued"
        ) {
          w.acquisition.status = "failed";
          w.acquisition.error = "cancelled";
          w.acquisition.message =
            "下载中断，可重试 / Download interrupted; retry available";
        }
    });
  }
  async branch(source: string, target: string, revision?: number) {
    const original = revision
      ? await this.storage.read<LiteraturePool>(`${source}_r${revision}`)
      : null;
    if (!original) return;
    // Preserve revision numbers referenced by earlier replies in the branch.
    for (
      let revisionNumber = 1;
      revisionNumber <= original.revision;
      revisionNumber++
    ) {
      const prior = await this.storage.read<LiteraturePool>(
        `${source}_r${revisionNumber}`,
      );
      if (!prior) continue;
      const copy = clone(prior);
      copy.taskId = target;
      delete copy.waiting;
      delete copy.waitingFulltext;
      for (const w of copy.works)
        if (
          w.acquisition.status === "queued" ||
          w.acquisition.status === "downloading"
        )
          w.acquisition.status = "missing";
      await this.storage.write(`${target}_r${revisionNumber}`, copy);
      if (revisionNumber === original.revision) {
        await this.storage.write(target, copy);
        await this.options.changed(target, literatureSummary(copy));
      }
    }
  }
  async remove(taskId: string) {
    this.removed.add(taskId);
    await this.cancel(taskId);
    await this.locks.run([taskId], async () => {
      for (const key of (await this.storage.keys?.(taskId)) ?? [])
        if (key === taskId || key.startsWith(`${taskId}_r`))
          await this.storage.remove?.(key);
    });
    for (const wake of this.listeners.get(taskId) ?? []) wake();
  }
}
