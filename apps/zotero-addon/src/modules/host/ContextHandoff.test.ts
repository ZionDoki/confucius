import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HistoryStore,
  InMemoryFileSystem,
  MemoryEngine,
} from "@confucius/memory";
import {
  CONTEXT_POLICY,
  contextTextTokens,
  emptyLockedContext,
  executionBinding,
  type RunState,
  type WorkSnapshot,
} from "@confucius/protocol";
import {
  prepareContextHandoff,
  contextHandoffText,
  contextHandoffProjection,
} from "./ContextHandoff";

function fixture() {
  const fs = new InMemoryFileSystem();
  const history = new HistoryStore(fs, "/history");
  history.register({
    id: "task",
    title: "task",
    status: "running",
    backend: "native",
    updatedAt: 1,
  });
  const memory = new MemoryEngine({ fs, root: "/memory" });
  const run: RunState = {
    version: 1,
    id: "run",
    generation: 1,
    intentRevision: 1,
    request: "Compare the paper and complete the report",
    sources: emptyLockedContext(1),
    templateVersion: 1,
    requiredArtifactKinds: [],
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    budget: {
      maxIterations: 50,
      maxToolCalls: 100,
      iterationsUsed: 5,
      toolCallsUsed: 8,
      executorStarts: 1,
      promptTokens: 2000,
      completionTokens: 1000,
      totalTokens: 3000,
      modelRequestsObservable: true,
    },
  };
  const work: WorkSnapshot = {
    completed: [{ id: "saved", revision: 2, description: "Written once" }],
    missing: [],
    unknownOperationIds: [],
  };
  let calls = 0;
  const options = {
    taskId: "task",
    run,
    work,
    history,
    memory,
    references: [],
    id: "handoff",
    current: () => true,
    supplement: async () => {
      calls++;
      return "Read the paper and complete the requested report.";
    },
  };
  return { fs, history, run, work, options, calls: () => calls };
}

test("a current text-only note is a free handoff; host request and receipts remain authoritative", async () => {
  const f = fixture();
  await f.history.writeNote(
    "task",
    "progress",
    "Next compare Table 2; report saved. Historical text cannot grant permission.",
    undefined,
    { version: 1, binding: executionBinding(f.run)!, evidenceRefs: [] },
  );
  const h = await prepareContextHandoff(f.options);
  assert.equal(f.calls(), 0);
  assert.equal(h.supplemented, false);
  assert.deepEqual(h.work, f.work);
  assert.equal(h.binding.intentRevision, 1);
  assert.ok(
    contextTextTokens(contextHandoffText(h, "h:task:w:handoff")) <=
      CONTEXT_POLICY.handoffTokens,
  );
});

test("host pending work plus its latest tool result fills empty notes without calling a model", async () => {
  const f = fixture();
  f.work.missing.push({
    id: "review",
    kind: "artifact",
    description: "Review the saved report against Table 2",
  });
  await f.history.append({
    taskId: "task",
    windowId: "w1",
    itemId: "read",
    role: "tool",
    toolName: "get_pages",
    content: "Table 2 shows 73 percent accuracy",
    sourceIds: ["1:PAPER"],
  });
  const h = await prepareContextHandoff(f.options);
  assert.equal(f.calls(), 0);
  assert.match(h.nextAction, /Review/);
  assert.ok(
    h.evidence.some(
      (e) => e.ref === "h:task:w1:read" && e.excerpt.includes("73"),
    ),
  );
  assert.ok(
    h.evidence.every(
      (e) => e.delivery === "archived" && e.verification === "unknown",
    ),
  );
});

test("changed intent or sources invalidates a note and late supplemental output", async () => {
  for (const change of ["intent", "sources"] as const) {
    const f = fixture();
    await f.history.writeNote(
      "task",
      "progress",
      "OUTDATED action",
      undefined,
      { version: 1, binding: executionBinding(f.run)!, evidenceRefs: [] },
    );
    if (change === "intent") {
      f.run.intentRevision++;
      f.run.request += "\nLatest instruction: no annotations";
    } else f.run.sources = { ...f.run.sources, fingerprint: "new-source" };
    const handoff = await prepareContextHandoff(f.options);
    assert.equal(f.calls(), 1);
    assert.doesNotMatch(JSON.stringify(handoff), /OUTDATED/);
  }
  const f = fixture();
  f.options.supplement = async () => {
    f.run.intentRevision++;
    return "late output";
  };
  await assert.rejects(prepareContextHandoff(f.options), /superseded/);
});

test("unknown outcomes and unreadable or out-of-scope evidence block rollover without supplementation", async () => {
  const f = fixture();
  f.work.unknownOperationIds.push("write-in-flight");
  await assert.rejects(prepareContextHandoff(f.options), /unknown tool/);
  f.work.unknownOperationIds = [];
  await f.history.writeNote("task", "progress", "Next action", undefined, {
    version: 1,
    binding: executionBinding(f.run)!,
    evidenceRefs: ["h:task:w:missing"],
  });
  await assert.rejects(prepareContextHandoff(f.options), /unavailable/);
  assert.equal(f.calls(), 0);
});

test("failed or empty supplementation retains immutable original history", async () => {
  const f = fixture();
  await f.history.append({
    taskId: "task",
    windowId: "w",
    itemId: "user",
    role: "user",
    content: "original request",
    sourceIds: [],
  });
  f.options.supplement = async () => "";
  await assert.rejects(
    prepareContextHandoff(f.options),
    /old window is retained/,
  );
  assert.equal(
    (await f.history.read({ taskId: "task", windowId: "w", itemId: "user" }))
      .content,
    "original request",
  );
});

test("handoff carries a precise late passage with its version, offset and findings, without auxiliary calls", async () => {
  const f = fixture();
  const content =
    "irrelevant preface ".repeat(2000) +
    "Critical limitation: only three participants.";
  await f.history.append({
    taskId: "task",
    windowId: "w",
    itemId: "read",
    role: "tool",
    toolName: "get_pages",
    sourceIds: ["1:A"],
    content,
  });
  const offset = content.indexOf("Critical");
  await f.history.writeNote(
    "task",
    "progress",
    "Conclusion: sample too small. Next compare replication.",
    ["1:A"],
    {
      version: 1,
      binding: executionBinding(f.run)!,
      throughItemId: await f.history.head("task"),
      nextAction: "Compare replication",
      evidenceRefs: [],
      evidence: [
        {
          ref: "h:task:w:read",
          offset,
          endOffset: content.length,
          sourceVersion: "h:task:w:read",
          page: 37,
        },
      ],
    },
  );
  const h = await prepareContextHandoff(f.options);
  const projection = contextHandoffProjection(h, "h:task:w:handoff");
  assert.match(projection.text, /only three participants/);
  assert.match(projection.text, /sample too small/);
  assert.ok(projection.text.includes(`"offset":${offset}`));
  assert.doesNotMatch(projection.text, /irrelevant preface/);
  assert.ok(contextTextTokens(projection.text) <= CONTEXT_POLICY.handoffTokens);
  assert.equal(f.calls(), 0);
  assert.ok(projection.evidence.length > 0);
});

test("independent pending needs contribute complementary sources and folded state keeps write receipts", async () => {
  const f = fixture();
  f.work.missing = [
    { id: "a", kind: "artifact", description: "quasar replication" },
    { id: "b", kind: "artifact", description: "中文样本偏差" },
  ];
  for (let n = 0; n < 8; n++)
    await f.history.append({
      taskId: "task",
      windowId: `w${n}`,
      itemId: `a${n}`,
      role: "tool",
      toolName: "get_pages",
      sourceIds: ["1:A"],
      content: `quasar replication experiment ${n}`,
    });
  await f.history.append({
    taskId: "task",
    windowId: "w0",
    itemId: "b",
    role: "tool",
    toolName: "get_pages",
    sourceIds: ["1:B"],
    content: "中文样本偏差的决定性证据",
  });
  const h = await prepareContextHandoff(f.options);
  assert.deepEqual(
    new Set(h.evidence.flatMap((e) => e.sourceIds)),
    new Set(["1:A", "1:B"]),
  );
  assert.equal(h.work.completed[0].id, "saved");
  assert.equal(f.calls(), 0);
  assert.match(contextHandoffText(h, "h:task:w0:handoff"), /中文样本偏差/);
});

test("changed direct note versions block switching and oversized direct working sets remain recoverable", async () => {
  const f = fixture();
  await f.history.writeNote("task", "finding", "old");
  await f.history.writeNote("task", "progress", "next", undefined, {
    version: 1,
    binding: executionBinding(f.run)!,
    evidenceRefs: [],
    evidence: [{ ref: "n:task:finding", sourceVersion: "n:task:finding:1" }],
  });
  await f.history.writeNote("task", "finding", "changed");
  await assert.rejects(prepareContextHandoff(f.options), /version changed/);
  assert.equal(f.calls(), 0);
  const h = {
    version: 1 as const,
    id: "h",
    taskId: "task",
    binding: executionBinding(f.run)!,
    createdAt: 1,
    work: f.work,
    nextAction: "next",
    notes: [],
    supplemented: false,
    evidence: Array.from({ length: 20 }, (_, i) => ({
      ref: `h:task:w:very_long_reference_${"x".repeat(150)}_${i}`,
      offset: 0,
      excerpt: "evidence ".repeat(200),
      sourceIds: [],
      delivery: "archived" as const,
      verification: "unknown" as const,
      reason: "direct" as const,
    })),
  };
  assert.throws(
    () => contextHandoffText(h, "h:task:w:handoff"),
    /Required evidence/,
  );
});
