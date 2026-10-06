import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  PreparedOperation,
  ToolExecutionContext,
  ToolResult,
} from "@confucius/protocol";
import {
  AnnotationReviewService,
  AnnotationReviewProvider,
} from "./AnnotationReview";
import { memoryJsonStorage } from "./RuntimeStorage";
import {
  canonical,
  ToolExecutionService,
  type OperationRecord,
} from "./ReliableToolProvider";
import type { ToolProvider } from "@confucius/harness";

function intent(...ids: string[]): PreparedOperation {
  const entries = ids.map((id) => ({
    id,
    status: "pending",
    annotationKey: `KEY${id}`,
    draft: {
      type: "highlight",
      quote: `Passage ${id}`,
      comment: `Note ${id}`,
      page: 2,
    },
    located: {
      type: "highlight",
      text: `Passage ${id}`,
      comment: `Note ${id}`,
      color: "#ffd400",
      position: { pageIndex: 1, rects: [[0, 0, 1, 1]] },
    },
  }));
  const args = {
    libraryID: 1,
    key: "PDF",
    attachmentKey: "PDF",
    proposalId: `proposal_${ids.join("_")}`,
    annotations: ids.map((id) => ({
      id,
      type: "highlight",
      page: 2,
      quote: `Passage ${id}`,
      comment: `Note ${id}`,
    })),
  };
  return {
    schemaVersion: 1,
    domain: "zotero",
    name: "commit_annotations",
    args,
    resources: ["zotero:1:PDF"],
    recovery: {
      taskId: "task",
      expectedAfter: {
        annotationArgs: canonical(args),
        annotationEntries: canonical(entries),
        annotationFingerprint: "frozen-pdf",
        annotationProposal: args.proposalId,
      },
    },
  };
}
function setup() {
  const storage = memoryJsonStorage(),
    operations = new Map<string, OperationRecord>(),
    calls: PreparedOperation[] = [];
  let next = 0;
  const execute = async (
    snapshot: PreparedOperation,
    context: ToolExecutionContext,
  ): Promise<ToolResult> => {
    calls.push(snapshot);
    const rows = JSON.parse(
      String(
        (snapshot.recovery.expectedAfter as Record<string, string>)
          .annotationEntries,
      ),
    ) as Array<{ id: string; annotationKey: string }>;
    const result: ToolResult = {
      ok: true,
      toolName: "commit_annotations",
      effect: "applied",
      data: {
        committed: rows.map((row) => ({
          id: row.id,
          annotationKey: row.annotationKey,
        })),
        alreadyPresent: [],
      },
    };
    operations.set(context.operationId!, {
      id: context.operationId!,
      name: "commit_annotations",
      request: canonical(snapshot.args),
      args: { ...snapshot.args },
      resources: [...snapshot.resources],
      context,
      startedAt: Date.now(),
      intent: snapshot,
      result,
    });
    return result;
  };
  const options = {
    storage,
    id: () => `id_${++next}`,
    execute,
    operation: async (id: string) => operations.get(id),
    reconcile: async () => {},
    changed: () => {},
  };
  const service = new AnnotationReviewService(options);
  const stage = (ids: string[], op = ids.join("_")) =>
    service.stage(intent(...ids), { taskId: "task", operationId: op });
  return { service, storage, options, stage, calls, operations };
}
it("lets unlocatable suggestions be dismissed and restored without becoming writable", async () => {
  const t = setup(),
    prepared = intent("bad");
  const after = prepared.recovery.expectedAfter as Record<string, string>;
  const rows = JSON.parse(after.annotationEntries);
  delete rows[0].located;
  rows[0].status = "skipped";
  rows[0].error = "Anchor no longer exists";
  after.annotationEntries = canonical(rows);
  await t.service.stage(prepared, { taskId: "task", operationId: "bad" });
  const batch = (await t.service.list("task")).batches[0],
    entries = [{ batchId: batch.id, entryId: "bad" }];
  const rejected = await t.service.decide({
    taskId: "task",
    action: "reject",
    entries,
  });
  assert.equal(rejected.batches[0].entries[0].status, "rejected");
  const restored = await t.service.decide({
    taskId: "task",
    action: "restore",
    entries,
  });
  assert.equal(restored.batches[0].entries[0].status, "unavailable");
  assert.equal(restored.batches[0].entries[0].error, "Anchor no longer exists");
  await t.service.decide({ taskId: "task", action: "accept", entries });
  assert.equal(t.calls.length, 0);
});
it("reconciles only unresolved entries and preserves known writes and later user decisions", async () => {
  const t = setup();
  await t.stage(["saved", "failed", "unknown"]);
  const batch = (await t.service.list("task")).batches[0];
  const execute = t.options.execute;
  t.options.execute = async (...args) => {
    await execute(...args);
    const result: ToolResult = {
      ok: false,
      toolName: "commit_annotations",
      code: "timeout",
      effect: "unknown",
      message: "One write needs verification",
      details: {
        committed: [{ id: "saved", annotationKey: "KEYsaved" }],
        failed: [{ id: "failed", error: "Source changed" }],
        unknown: [{ id: "unknown" }],
      },
    };
    t.operations.get(args[1].operationId!)!.result = result;
    return result;
  };
  const pool = await t.service.decide({
    taskId: "task",
    action: "accept",
    entries: batch.entries.map((e) => ({ batchId: batch.id, entryId: e.id })),
  });
  assert.deepEqual(
    pool.batches[0].entries.map((e) => e.status),
    ["accepted", "failed", "unknown"],
  );
  assert.equal(pool.batches[0].entries[1].error, "Source changed");
  await t.service.decide({
    taskId: "task",
    action: "reject",
    entries: [{ batchId: batch.id, entryId: "failed" }],
  });
  // The saved annotation can be removed outside Confucius while another entry
  // is unresolved. A later authoritative read must not undo known outcomes.
  for (const operation of t.operations.values())
    operation.result = {
      ok: false,
      toolName: "commit_annotations",
      code: "unavailable",
      effect: "none",
      message: "No planned annotations currently exist",
    };
  const recovered = await t.service.list("task");
  assert.deepEqual(
    recovered.batches[0].entries.map((e) => e.status),
    ["accepted", "rejected", "failed"],
  );
  assert.equal(recovered.batches[0].entries[0].annotationKey, "KEYsaved");
  assert.equal(t.calls.length, 1);
});
it("publishes multiple immutable batches without native writes, and deduplicates retried or rejected suggestions", async () => {
  const t = setup();
  await t.stage(["a", "b"]);
  await t.stage(["c"]);
  let pool = await t.service.list("task");
  assert.equal(t.calls.length, 0);
  assert.equal(pool.batches.length, 2);
  assert.equal(pool.batches[0].entries[0].annotationKey, undefined);
  await t.service.decide({
    taskId: "task",
    action: "reject",
    entries: [{ batchId: pool.batches[0].id, entryId: "a" }],
  });
  await t.stage(["a", "b"], "retried");
  await t.stage(["a", "b"]);
  pool = await t.service.list("task");
  assert.equal(pool.batches.length, 2);
  assert.equal(pool.batches[0].entries[0].status, "rejected");
  assert.equal(t.calls.length, 0);
  assert(!("intent" in pool.batches[0]));
  assert(!("context" in pool.batches[0]));
});
it("does not let an older unresolved batch overwrite an entry being retried", async () => {
  const t = setup();
  await t.stage(["retry", "unknown"]);
  const batch = (await t.service.list("task")).batches[0],
    execute = t.options.execute;
  t.options.execute = async (...args) => {
    await execute(...args);
    const result: ToolResult = {
      ok: false,
      toolName: "commit_annotations",
      code: "timeout",
      effect: "unknown",
      message: "Unconfirmed batch",
      details: { failed: [{ id: "retry" }], unknown: [{ id: "unknown" }] },
    };
    t.operations.get(args[1].operationId!)!.result = result;
    return result;
  };
  await t.service.decide({
    taskId: "task",
    action: "accept",
    entries: batch.entries.map((e) => ({ batchId: batch.id, entryId: e.id })),
  });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    running = new Promise<void>((resolve) => {
      started = resolve;
    });
  t.options.execute = async (...args) => {
    started();
    await gate;
    return execute(...args);
  };
  const retry = t.service.decide({
    taskId: "task",
    action: "accept",
    entries: [{ batchId: batch.id, entryId: "retry" }],
  });
  await running;
  try {
    const pool = await t.service.list("task");
    assert.equal(pool.batches[0].entries[0].status, "writing");
  } finally {
    release();
  }
  const pool = await retry;
  assert.equal(pool.batches[0].entries[0].status, "accepted");
  assert.equal(t.calls.length, 2);
});
it("accepts only the selected immutable entries across batches, preserving new arrivals and native recovery fields", async () => {
  const t = setup();
  await t.stage(["a", "b"]);
  await t.stage(["c", "d"]);
  const pool = await t.service.list("task");
  const selection = pool.batches.map((b, i) => ({
    batchId: b.id,
    entryId: i ? "c" : "a",
  }));
  await t.stage(["e"]);
  const result = await t.service.decide({
    taskId: "task",
    action: "accept",
    entries: selection,
  });
  assert.deepEqual(
    result.batches.flatMap((b) => b.entries.map((e) => e.status)),
    ["accepted", "pending", "accepted", "pending", "pending"],
  );
  assert.deepEqual(
    t.calls.map((c) =>
      (c.args.annotations as Array<{ id: string }>).map((e) => e.id),
    ),
    [["a"], ["c"]],
  );
  for (const c of t.calls) {
    const recovery = c.recovery.expectedAfter as Record<string, string>;
    assert.equal(recovery.annotationArgs, canonical(c.args));
    assert.equal(recovery.annotationFingerprint, "frozen-pdf");
    assert.equal(JSON.parse(recovery.annotationEntries).length, 1);
  }
  await t.service.decide({
    taskId: "task",
    action: "accept",
    entries: selection,
  });
  assert.equal(t.calls.length, 2);
  await assert.rejects(
    t.service.decide({ taskId: "other", action: "accept", entries: selection }),
    /no longer belongs/,
  );
  assert.equal(t.calls.length, 2);
});
it("serializes concurrent decisions while allowing new publications during a write", async () => {
  const t = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    original = t.options.execute;
  t.options.execute = async (...args) => {
    await gate;
    return original(...args);
  };
  await t.stage(["a"]);
  const b = (await t.service.list("task")).batches[0];
  const input = {
    taskId: "task",
    action: "accept" as const,
    entries: [{ batchId: b.id, entryId: "a" }],
  };
  const first = t.service.decide(input);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    (await t.service.list("task")).batches[0].entries[0].status,
    "writing",
  );
  await t.stage(["b"]);
  await t.service.decide(input);
  release();
  const result = await first;
  assert.equal(t.calls.length, 1);
  assert.equal(result.batches[1].entries[0].status, "pending");
});
it("reject and restore never write; acceptance failures remain retryable and unknown outcomes never become saved", async () => {
  const t = setup();
  await t.stage(["a", "b"]);
  const batch = (await t.service.list("task")).batches[0];
  const entries = batch.entries.map((e) => ({
    batchId: batch.id,
    entryId: e.id,
  }));
  await t.service.decide({ taskId: "task", action: "reject", entries });
  await t.service.decide({ taskId: "task", action: "restore", entries });
  assert.equal(t.calls.length, 0);
  t.options.execute = async () => ({
    ok: false,
    toolName: "commit_annotations",
    effect: "none",
    code: "unavailable",
    message: "PDF changed",
  });
  let pool = await t.service.decide({
    taskId: "task",
    action: "accept",
    entries,
  });
  assert(pool.batches[0].entries.every((e) => e.status === "failed"));
  t.options.execute = async () => ({
    ok: false,
    toolName: "commit_annotations",
    effect: "unknown",
    code: "timeout",
    message: "Unconfirmed",
  });
  // An unknown native receipt is retained and reconciled, never blindly retried.
  t.options.operation = async (id) => ({
    id,
    name: "commit_annotations",
    args: {},
    request: "",
    resources: [],
    context: { taskId: "task" },
    startedAt: 0,
    result: {
      ok: false,
      toolName: "commit_annotations",
      code: "timeout",
      effect: "unknown",
      message: "Unconfirmed",
    },
  });
  pool = await t.service.decide({ taskId: "task", action: "accept", entries });
  assert(pool.batches[0].entries.every((e) => e.status === "unknown"));
  let called = false;
  t.options.execute = async () => {
    called = true;
    throw new Error("must not retry unknown");
  };
  await t.service.decide({ taskId: "task", action: "accept", entries });
  assert(!called);
});
it("recovers an interrupted UI write from its native receipt after restart without writing again", async () => {
  const t = setup();
  await t.stage(["a"]);
  const batch = (await t.service.list("task")).batches[0];
  const raw = await t.storage.read<any>("review_task");
  raw.batches[0].entries[0].status = "writing";
  raw.writes.push({ id: "interrupted", batchId: batch.id, entryIds: ["a"] });
  await t.storage.write("review_task", raw);
  t.operations.set("interrupted", {
    id: "interrupted",
    name: "commit_annotations",
    args: {},
    request: "",
    resources: [],
    context: { taskId: "task" },
    startedAt: 0,
    result: {
      ok: true,
      toolName: "commit_annotations",
      effect: "applied",
      data: { committed: [{ id: "a", annotationKey: "SAVED" }] },
    },
  });
  const restored = new AnnotationReviewService(t.options);
  const pool = await restored.list("task");
  assert.equal(pool.batches[0].entries[0].status, "accepted");
  assert.equal(pool.batches[0].entries[0].annotationKey, "SAVED");
  assert.equal(t.calls.length, 0);
});
it("agent provider freezes the actual preview in a separate operation domain and never dispatches a PDF write", async () => {
  const t = setup();
  let nativeCalls = 0;
  const inner: ToolProvider = {
    listTools: () => [
      {
        name: "commit_annotations",
        description: "Annotations",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      },
    ],
    getMeta: () =>
      ({
        catalog: "paper.annotate",
        mutatesState: true,
        effectClass: "write",
        riskLevel: "write",
        timeoutMs: 120000,
      }) as any,
    getSchema: () => ({
      type: "object",
      properties: {},
      additionalProperties: true,
    }),
    prepare: async (_name, args, context) => {
      const snapshot = intent("a");
      Object.assign(args, snapshot.args);
      context!.preparedOperation = { ...snapshot, args };
      return null;
    },
    call: async () => {
      nativeCalls++;
      throw new Error("unexpected native write");
    },
  };
  const execution = new ToolExecutionService(memoryJsonStorage());
  const provider = execution.wrap(
    new AnnotationReviewProvider(inner, t.service),
    { taskId: "task", operationId: "submission" },
  );
  const args = {};
  const result = await provider.call("commit_annotations", args);
  assert(result.ok);
  assert.equal(result.effect, "none");
  assert.equal(nativeCalls, 0);
  assert.equal((await t.service.list("task")).batches.length, 1);
  assert.equal(
    (await execution.getOperation("submission"))?.intent?.domain,
    "annotation-review",
  );
});

it("pins the actual attachment when the Agent submitted a parent article key", async () => {
  const t = setup(),
    base = intent("a");
  const snapshot: PreparedOperation = {
    ...base,
    args: {
      libraryID: 1,
      key: "ARTICLE",
      proposalId: base.args.proposalId,
      annotations: base.args.annotations,
    },
    recovery: {
      ...base.recovery,
      expectedAfter: {
        ...(base.recovery.expectedAfter as Record<string, string>),
        annotationTarget: canonical({ libraryID: 1, key: "ACTUALPDF" }),
      },
    },
  };
  await t.service.stage(snapshot, {
    taskId: "task",
    operationId: "parent-request",
  });
  const batch = (await t.service.list("task")).batches[0];
  assert.equal(batch.attachmentKey, "ACTUALPDF");
  await t.service.decide({
    taskId: "task",
    action: "accept",
    entries: [{ batchId: batch.id, entryId: "a" }],
  });
  assert.equal(t.calls[0].args.attachmentKey, "ACTUALPDF");
  assert.equal(t.calls[0].args.key, "ARTICLE");
});
