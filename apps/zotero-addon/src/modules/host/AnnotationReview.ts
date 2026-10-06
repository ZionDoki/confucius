import type {
  AnnotationReviewBatch,
  AnnotationReviewDecision,
  AnnotationReviewPool,
  PreparedOperation,
  ToolExecutionContext,
  ToolResult,
} from "@confucius/protocol";
import type { ToolProvider } from "@confucius/harness";
import { ResourceLocks, type JsonStorage } from "./RuntimeStorage";
import { canonical, type OperationRecord } from "./ReliableToolProvider";

interface Candidate {
  id: string;
  raw?: Record<string, unknown>;
  status: string;
  annotationKey?: string;
  error?: string;
  draft?: {
    type: string;
    quote?: string;
    comment?: string;
    page?: number;
    color?: string;
  };
  located?: {
    type: string;
    text?: string;
    comment: string;
    color: string;
    position: { pageIndex: number };
  };
}
interface StoredBatch extends AnnotationReviewBatch {
  intent: PreparedOperation;
  context: ToolExecutionContext;
  identities: Record<string, string>;
  rejectedStates?: Record<
    string,
    { status: "pending" | "failed" | "unavailable"; error?: string }
  >;
}
interface Receipt {
  id: string;
  batchId: string;
  entryIds: string[];
  finished?: boolean;
}
interface ReviewRecord {
  taskId: string;
  revision: number;
  batches: StoredBatch[];
  submissions: Record<string, { proposalId: string; batchIds: string[] }>;
  writes: Receipt[];
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const candidates = (intent: PreparedOperation): Candidate[] =>
  JSON.parse(
    String(
      (intent.recovery.expectedAfter as Record<string, string>)
        ?.annotationEntries ?? "[]",
    ),
  );
const empty = (taskId: string): ReviewRecord => ({
  taskId,
  revision: 0,
  batches: [],
  submissions: {},
  writes: [],
});
const publicPool = (record: ReviewRecord): AnnotationReviewPool => ({
  taskId: record.taskId,
  revision: record.revision,
  batches: record.batches.map(
    ({
      intent: _intent,
      context: _context,
      identities: _identities,
      rejectedStates: _rejectedStates,
      ...batch
    }) => clone(batch),
  ),
});

/** Durable, immutable candidate snapshots. Only an explicit UI decision writes Zotero. */
export class AnnotationReviewService {
  private locks = new ResourceLocks();
  private activeWrites = new Set<string>();
  constructor(
    private readonly options: {
      storage: JsonStorage;
      id: () => string;
      execute: (
        intent: PreparedOperation,
        context: ToolExecutionContext,
      ) => Promise<ToolResult>;
      operation: (id: string) => Promise<OperationRecord | null | undefined>;
      reconcile: (taskId: string, ids: string[]) => Promise<unknown>;
      changed: (taskId: string, revision: number) => void;
    },
  ) {}
  private key(taskId: string) {
    return `review_${taskId}`;
  }
  private async read(taskId: string) {
    return (
      (await this.options.storage.read<ReviewRecord>(this.key(taskId))) ??
      empty(taskId)
    );
  }
  private async save(record: ReviewRecord) {
    record.revision++;
    await this.options.storage.write(this.key(record.taskId), record);
    this.options.changed(record.taskId, record.revision);
  }
  async remove(taskId: string) {
    await this.locks.run([taskId], async () => {
      const record = await this.read(taskId);
      if (record.writes.some((write) => this.activeWrites.has(write.id)))
        throw new Error(
          "Annotation writes are still finishing; retry after they complete",
        );
      if (record.revision)
        await this.options.storage.remove?.(this.key(taskId));
    });
  }
  async submittedProposalIds(taskId: string): Promise<Set<string>> {
    return new Set(
      Object.values((await this.read(taskId)).submissions).map(
        (s) => s.proposalId,
      ),
    );
  }
  async stage(
    intent: PreparedOperation,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const taskId = context.taskId,
      operationId = context.operationId;
    if (!taskId || !operationId || intent.domain !== "zotero")
      throw new Error("Missing annotation review identity");
    return this.locks.run([taskId], async () => {
      const record = await this.read(taskId);
      if (record.submissions[operationId])
        return this.submissionResult(record, operationId);
      if (context.signal?.aborted)
        throw new Error("Annotation submission cancelled");
      const rows = candidates(intent);
      if (!rows.length)
        throw new Error("Prepared annotation preview is missing");
      const target = JSON.parse(
        String(
          (intent.recovery.expectedAfter as Record<string, string>)
            ?.annotationTarget ?? "null",
        ),
      ) as { libraryID: number; key: string } | null;
      const batch: StoredBatch = {
        id: this.options.id(),
        createdAt: Date.now(),
        title: context.taskTitle ?? "",
        libraryID: target?.libraryID ?? Number(intent.args.libraryID),
        attachmentKey:
          target?.key ?? String(intent.args.attachmentKey ?? intent.args.key),
        entries: [],
        intent: clone(intent),
        context: {
          taskId,
          runId: context.runId,
          turnId: context.turnId,
          intentRevision: context.intentRevision,
          agent: context.agent,
          runtime: context.runtime,
        },
        identities: {},
      };
      const batchIds = new Set<string>();
      for (const row of rows) {
        const identity = canonical({
          libraryID: batch.libraryID,
          key: batch.attachmentKey,
          content: row.located ??
            row.draft ??
            row.raw ?? { id: row.id, error: row.error },
        });
        const duplicate = record.batches.find((b) =>
          Object.values(b.identities).includes(identity),
        );
        if (duplicate) {
          batchIds.add(duplicate.id);
          continue;
        }
        if (Object.values(batch.identities).includes(identity)) continue;
        batch.identities[row.id] = identity;
        batch.entries.push({
          id: row.id,
          type: row.located?.type ?? row.draft?.type ?? "highlight",
          page: row.located
            ? row.located.position.pageIndex + 1
            : (row.draft?.page ?? 1),
          quote: row.located?.text ?? row.draft?.quote ?? "",
          comment: row.located?.comment ?? row.draft?.comment ?? "",
          color: row.located?.color ?? row.draft?.color ?? "",
          status: ["committed", "alreadyPresent"].includes(row.status)
            ? "accepted"
            : row.status === "pending" && row.located
              ? "pending"
              : "unavailable",
          annotationKey: ["committed", "alreadyPresent"].includes(row.status)
            ? row.annotationKey
            : undefined,
          error: row.error,
        });
      }
      if (batch.entries.length) {
        record.batches.push(batch);
        batchIds.add(batch.id);
      }
      record.submissions[operationId] = {
        proposalId: String(intent.args.proposalId ?? ""),
        batchIds: [...batchIds],
      };
      await this.save(record);
      return this.submissionResult(record, operationId);
    });
  }
  private submissionResult(
    record: ReviewRecord,
    operationId: string,
  ): ToolResult {
    const submitted = record.submissions[operationId];
    const batches = record.batches.filter((b) =>
      submitted.batchIds.includes(b.id),
    );
    return {
      ok: true,
      toolName: "commit_annotations",
      effect: "none",
      data: {
        reviewRequired: true,
        reviewBatchIds: submitted.batchIds,
        proposalId: submitted.proposalId,
        saved: false,
        pending: batches
          .flatMap((b) => b.entries)
          .filter((e) => e.status === "pending").length,
        nextAction:
          "Suggestions are saved in the task's annotation review area, NOT written to the PDF. The user accepts or rejects them there. Continue the task; do not wait, resubmit these candidates, or claim they are saved annotations. Further batches can be submitted independently.",
      },
    };
  }
  async reconcileSubmission(operation: OperationRecord): Promise<ToolResult> {
    const record = await this.read(String(operation.context.taskId));
    return record.submissions[operation.id]
      ? this.submissionResult(record, operation.id)
      : {
          ok: false,
          toolName: operation.name,
          code: "unavailable",
          effect: "none",
          retryable: true,
          message: "Verified no annotation review submission was saved",
        };
  }
  async list(taskId: string): Promise<AnnotationReviewPool> {
    return this.locks.run([taskId], async () => {
      const record = await this.read(taskId);
      const interrupted = record.writes.filter(
        (w) => !w.finished && !this.activeWrites.has(w.id),
      );
      if (interrupted.length) {
        const before = canonical(record);
        await this.options.reconcile(
          taskId,
          interrupted.map((w) => w.id),
        );
        for (const write of interrupted) {
          const operation = await this.options.operation(write.id);
          this.applyReceipt(
            record,
            write,
            operation?.result ?? {
              ok: false,
              toolName: "commit_annotations",
              code: "unavailable",
              effect: operation ? "unknown" : "none",
              message: operation
                ? "Write outcome needs verification; it will not be replayed automatically"
                : "No write was started; select this suggestion to retry",
            },
          );
        }
        if (canonical(record) !== before) await this.save(record);
      }
      return publicPool(record);
    });
  }
  async decide(input: AnnotationReviewDecision): Promise<AnnotationReviewPool> {
    if (
      !input.taskId ||
      !["accept", "reject", "restore"].includes(input.action) ||
      !Array.isArray(input.entries) ||
      !input.entries.length ||
      input.entries.length > 10000 ||
      input.entries.some(
        (e) =>
          !e || typeof e.batchId !== "string" || typeof e.entryId !== "string",
      )
    )
      throw new Error("Invalid annotation review selection");
    const jobs: Array<{
      write: Receipt;
      intent: PreparedOperation;
      context: ToolExecutionContext;
    }> = [];
    await this.locks.run([input.taskId], async () => {
      const record = await this.read(input.taskId);
      // Validate the entire submitted snapshot before changing any entry.
      for (const selection of input.entries)
        if (
          !record.batches.some(
            (b) =>
              b.id === selection.batchId &&
              b.entries.some((e) => e.id === selection.entryId),
          )
        )
          throw new Error(
            "This annotation suggestion no longer belongs to the task",
          );
      let changed = false;
      for (const batch of record.batches) {
        const selected = new Set(
          input.entries
            .filter((e) => e.batchId === batch.id)
            .map((e) => e.entryId),
        );
        const entries = batch.entries.filter((e) => selected.has(e.id));
        if (input.action !== "accept") {
          for (const entry of entries) {
            if (
              input.action === "reject" &&
              (entry.status === "pending" ||
                entry.status === "failed" ||
                entry.status === "unavailable")
            ) {
              (batch.rejectedStates ??= {})[entry.id] = {
                status: entry.status,
                error: entry.error,
              };
              entry.status = "rejected";
              changed = true;
            } else if (
              input.action === "restore" &&
              entry.status === "rejected"
            ) {
              const previous = batch.rejectedStates?.[entry.id],
                candidate = candidates(batch.intent).find(
                  (row) => row.id === entry.id,
                );
              entry.status =
                previous?.status ??
                (candidate?.status === "pending" && candidate.located
                  ? "pending"
                  : "unavailable");
              entry.error = previous ? previous.error : candidate?.error;
              if (batch.rejectedStates) delete batch.rejectedStates[entry.id];
              changed = true;
            }
          }
          continue;
        }
        const eligible = entries.filter((e) =>
          ["pending", "failed"].includes(e.status),
        );
        if (!eligible.length) continue;
        const write: Receipt = {
          id: `review-write_${this.options.id()}`,
          batchId: batch.id,
          entryIds: eligible.map((e) => e.id),
        };
        const ids = new Set(write.entryIds),
          snapshot = clone(batch.intent);
        const args = {
          ...snapshot.args,
          libraryID: batch.libraryID,
          attachmentKey: batch.attachmentKey,
          annotations: (
            snapshot.args.annotations as Array<{ id: string }>
          ).filter((e) => ids.has(e.id)),
        };
        const expectedAfter = {
          ...(snapshot.recovery.expectedAfter as Record<string, string>),
          annotationArgs: canonical(args),
          annotationEntries: canonical(
            candidates(snapshot).filter((e) => ids.has(e.id)),
          ),
        };
        const intent: PreparedOperation = {
          ...snapshot,
          args,
          recovery: { ...snapshot.recovery, expectedAfter },
        };
        const context: ToolExecutionContext = {
          ...batch.context,
          ...intent.recovery,
          operationId: write.id,
          preparedOperation: intent,
        };
        eligible.forEach((e) => {
          e.status = "writing";
          e.error = undefined;
        });
        record.writes.push(write);
        jobs.push({ write, intent, context });
        changed = true;
      }
      if (changed) await this.save(record);
      jobs.forEach((job) => this.activeWrites.add(job.write.id));
    });
    // Keep arrival/other batches responsive while native writes run.
    try {
      for (const job of jobs) {
        let result: ToolResult;
        try {
          result = await this.options.execute(job.intent, job.context);
        } catch (error) {
          result = {
            ok: false,
            toolName: "commit_annotations",
            code: "unavailable",
            effect: "unknown",
            message: String(error),
          };
        }
        try {
          await this.locks.run([input.taskId], async () => {
            const record = await this.read(input.taskId);
            const write = record.writes.find((w) => w.id === job.write.id);
            if (write) {
              this.applyReceipt(record, write, result);
              await this.save(record);
            }
          });
        } finally {
          this.activeWrites.delete(job.write.id);
        }
      }
    } finally {
      jobs.forEach((job) => this.activeWrites.delete(job.write.id));
    }
    return this.list(input.taskId);
  }
  private applyReceipt(
    record: ReviewRecord,
    write: Receipt,
    result: ToolResult,
  ) {
    const batch = record.batches.find((b) => b.id === write.batchId)!;
    const data = (result.ok ? result.data : result.details) as
      Record<string, unknown> | undefined;
    const saved = [
      ...(Array.isArray(data?.committed) ? data.committed : []),
      ...(Array.isArray(data?.alreadyPresent) ? data.alreadyPresent : []),
    ] as Array<{ id: string; annotationKey?: string }>;
    const unknown = new Set(
      (Array.isArray(data?.unknown) ? data.unknown : []).map(
        (e: { id: string }) => e.id,
      ),
    );
    const failed = [
      ...(Array.isArray(data?.failed) ? data.failed : []),
      ...(Array.isArray(data?.skipped) ? data.skipped : []),
    ] as Array<{ id: string; error?: string }>;
    const latestWrites = new Map<string, string>();
    for (const receipt of record.writes)
      if (receipt.batchId === batch.id)
        for (const id of receipt.entryIds) latestWrites.set(id, receipt.id);
    for (const entry of batch.entries.filter((e) =>
      write.entryIds.includes(e.id),
    )) {
      // A partial receipt may be reconciled repeatedly. Settled entries can
      // already have a newer rejection or retry; this write no longer owns them.
      if (
        latestWrites.get(entry.id) !== write.id ||
        !["writing", "unknown"].includes(entry.status)
      )
        continue;
      const receipt = saved.find((e) => e.id === entry.id);
      if (receipt?.annotationKey) {
        entry.status = "accepted";
        entry.annotationKey = receipt.annotationKey;
        entry.error = undefined;
      } else {
        const failure = failed.find((e) => e.id === entry.id);
        entry.status =
          unknown.has(entry.id) || (!failure && result.effect === "unknown")
            ? "unknown"
            : "failed";
        entry.error =
          failure?.error ??
          (!result.ok
            ? result.message
            : "This suggestion was not saved; inspect its source and retry");
      }
    }
    write.finished = !batch.entries.some(
      (e) => latestWrites.get(e.id) === write.id && e.status === "unknown",
    );
  }
}

/** Agent calls submit snapshots; explicit UI decisions use the original native provider. */
export class AnnotationReviewProvider implements ToolProvider {
  constructor(
    private inner: ToolProvider,
    private reviews: AnnotationReviewService,
  ) {}
  listTools() {
    return this.inner.listTools().map((tool) =>
      tool.name === "commit_annotations"
        ? {
            ...tool,
            description: `${tool.description}\nSubmits a batch for human review. No PDF write occurs until the user accepts individual suggestions in the workspace; additional batches may be submitted without waiting.`,
          }
        : tool,
    );
  }
  getMeta(name: string) {
    return this.inner.getMeta(name);
  }
  getSchema(name: string) {
    return this.inner.getSchema(name);
  }
  async prepare(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ) {
    const invalid = (await this.inner.prepare?.(name, args, context)) ?? null;
    if (invalid || name !== "commit_annotations") return invalid;
    const native = context.preparedOperation;
    if (!native || native.domain !== "zotero" || !context.taskId)
      return {
        ok: false as const,
        toolName: name,
        code: "unavailable" as const,
        effect: "none" as const,
        message: "Annotation review needs a prepared task-bound snapshot",
      };
    context.preparedOperation = {
      schemaVersion: 1,
      domain: "annotation-review",
      name,
      args: clone(args),
      resources: [`annotation-review:${context.taskId}`],
      recovery: { native },
    };
    return null;
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context: ToolExecutionContext = {},
  ) {
    if (name !== "commit_annotations")
      return this.inner.call(name, args, signal, context);
    const native = context.preparedOperation?.recovery.native as
      PreparedOperation | undefined;
    if (!native) throw new Error("Missing prepared review snapshot");
    return this.reviews.stage(native, { ...context, signal });
  }
}
