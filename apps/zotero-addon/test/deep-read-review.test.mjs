import assert from "node:assert/strict";
import { test } from "node:test";
import { initialContextWindow } from "@confucius/protocol";
import { WindowContext } from "@confucius/harness";
import { budgetToolResult } from "../../../packages/harness/src/truncate.ts";
import {
  deepReadReviewState,
  deepReadReviewNextAction,
} from "../src/modules/host/DeepReadReview.ts";
import { deepReadReviewMessages } from "../src/modules/host/DeepReadReviewContext.ts";
import {
  sourceReadEvidence,
  sourceReviewBinding,
} from "../src/modules/host/SourceReadEvidence.ts";
import { compactTaskEvents } from "../src/modules/host/TaskEventHistory.ts";

function fixture() {
  const execution = {
    runId: "run",
    intentRevision: 1,
    sourceFingerprint: "sources",
  };
  const draft = {
    id: "report",
    taskId: "task",
    kind: "deep_read",
    status: "draft",
    revision: 1,
    title: "Report",
    body: { type: "markdown", markdown: "Fallible draft" },
    sourceContextIds: ["item:1:PAPER"],
    citations: [],
    execution,
  };
  const events = [];
  const emit = (type, payload) =>
    events.push({
      id: String(events.length),
      sessionId: "task",
      turnId: "turn",
      ts: 100,
      type,
      payload,
    });
  const save = () =>
    emit("artifact_upserted", { artifact: globalThis.structuredClone(draft) });
  const read = (result, args = {}, delivered = result) => {
    const callId = `read-${events.length}`;
    emit("tool_requested", { callId, toolName: result.toolName, args });
    emit("tool_result", { callId, result });
    deliver(callId, delivered, args);
    return callId;
  };
  const deliver = (callId, result, args = {}) => {
    const evidence = sourceReadEvidence(result, args);
    if (evidence)
      emit("source_read_delivered", {
        callId,
        evidence,
        delivery: "native-request",
        review: sourceReviewBinding(draft, callId, events),
      });
  };
  const state = () => deepReadReviewState(draft, execution, events);
  const next = () => deepReadReviewNextAction(draft, execution, events);
  return { draft, execution, events, read, deliver, save, state, next };
}
const page = {
  ok: true,
  toolName: "get_pages",
  data: {
    libraryID: 1,
    key: "PAPER",
    attachmentKey: "PDF",
    pages: [{ page: 2, text: "Decisive evidence" }],
  },
};
const comments = (offset, count, total = 41, snapshot = "v1", extra = {}) => ({
  ok: true,
  toolName: "get_annotations",
  data: {
    libraryID: 1,
    key: "PDF",
    attachmentKey: "PDF",
    offset,
    totalAnnotations: total,
    snapshot,
    annotations: Array.from({ length: count }, (_, i) => ({
      key: `mark-${offset + i}`,
      comment: "Saved evidence. ".repeat(150),
    })),
    nextOffset: offset + count < total ? offset + count : null,
    ...extra,
  },
});

test("large annotation pages restored into review inputs count as delivered, with complete pagination required", async () => {
  const f = fixture();
  f.save();
  f.read(page);
  const window = new WindowContext({
    window: initialContextWindow("task", "native"),
    contextWindowTokens: 200000,
    maxOutputTokens: 4096,
    nextId: () => "history",
    archive: async ({ id, windowId }) => ({
      taskId: "task",
      windowId,
      itemId: id,
    }),
    switchWindow: async () => assert.fail("the full read fits"),
    hint: async () => "",
  });
  window.start({ turnId: "turn", userText: "Review" }, []);
  for (const [offset, count] of [
    [0, 16],
    [16, 16],
    [32, 9],
  ]) {
    const raw = comments(offset, count);
    const ref = {
      taskId: "task",
      windowId: "window",
      itemId: `annotations-${offset}`,
    };
    const bounded = budgetToolResult(raw, 4000, ref);
    assert.equal(bounded.data.truncated, true);
    const callId = f.read(raw, { offset }, bounded);
    assert.equal(
      f.state(),
      "evidence_required",
      "archiving alone is not reading",
    );
    await window.toolResult(
      callId,
      "get_annotations",
      JSON.stringify(raw),
      { offset },
      `model-${offset}`,
    );
    const messages = [
      { role: "system", content: "Review the draft" },
      { role: "tool", toolCallId: "pages", content: JSON.stringify(page) },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: `model-${offset}`, name: "get_annotations", args: { offset } },
        ],
      },
      {
        role: "tool",
        toolCallId: `model-${offset}`,
        content: JSON.stringify(bounded),
      },
    ];
    await window.prepare(messages, []);
    const provided = [];
    const projected = deepReadReviewMessages(messages, f.draft, (message) =>
      provided.push(message),
    );
    const input = JSON.parse(
      projected
        .find((message) => message.content.startsWith("Review inputs"))
        .content.split("\n")
        .slice(1)
        .join("\n"),
    );
    assert.equal(input.savedAnnotations[0].annotations.length, count);
    const actual = provided.find(
      (message) => message.toolCallId === `model-${offset}`,
    );
    f.deliver(callId, JSON.parse(actual.content), { offset });
    assert.equal(f.state(), offset === 32 ? "reviewed" : "evidence_required");
    if (offset < 32)
      assert.match(f.next(), new RegExp(`offset=${offset + count}`));
  }
  const restored = JSON.parse(JSON.stringify(f.events));
  assert.equal(deepReadReviewState(f.draft, f.execution, restored), "reviewed");
  // The compact delivery receipts still establish this revision after old UI
  // events and their raw contents have been evicted.
  assert.equal(
    deepReadReviewState(
      f.draft,
      f.execution,
      restored.filter((event) => event.type === "source_read_delivered"),
    ),
    "reviewed",
  );
});

test("review rejects gaps, duplicates, mixed snapshots, filters, foreign sources and older revisions", () => {
  const f = fixture();
  const before = f.read(comments(0, 41));
  f.save();
  f.read(page);
  f.deliver(before, comments(0, 41));
  assert.equal(
    f.state(),
    "evidence_required",
    "reinjecting a pre-draft read cannot bind it to a later draft",
  );
  f.read(comments(32, 9));
  f.read(comments(32, 9));
  assert.match(f.next(), /offset=0/);
  f.read(comments(0, 16));
  assert.match(f.next(), /offset=16/);
  f.read(comments(16, 16, 41, "v2"));
  assert.match(f.next(), /offset=0/);
  f.read(comments(0, 16, 41, "v2"));
  assert.match(f.next(), /offset=32/);
  f.read(comments(0, 41, 41, "v2", { filtered: true }));
  const foreign = comments(0, 41);
  foreign.data.key = foreign.data.attachmentKey = "OTHER";
  f.read(foreign);
  assert.equal(f.state(), "evidence_required");
  f.read(comments(32, 9, 41, "v2"));
  assert.equal(f.state(), "reviewed");
  f.draft.revision++;
  f.save();
  assert.equal(f.state(), "evidence_required");
  assert.match(f.next(), /get_pages and get_annotations/);
  f.read(page);
  f.read(comments(0, 0, 0));
  assert.equal(
    f.state(),
    "reviewed",
    "an explicitly empty complete set is a valid audit",
  );
});

test("review handoff retains every rejected candidate for the current draft, without treating it as applied", () => {
  const f = fixture();
  const edits = Array.from({ length: 5 }, (_, i) => ({
    oldText: `original-${i}`,
    newText: `candidate-${i}`,
  }));
  const messages = [
    { role: "system", content: "Review" },
    {
      role: "assistant",
      content: "BIASED EARLIER REASONING",
      toolCalls: [{ id: "draft", name: "artifact_upsert", args: f.draft }],
    },
    {
      role: "tool",
      toolCallId: "draft",
      content: JSON.stringify({
        ok: true,
        toolName: "artifact_upsert",
        data: { artifact: f.draft },
      }),
    },
  ];
  for (const [id, revision, effect] of [
    ["report", 1, "none"],
    ["other", 1, "none"],
    ["report", 0, "none"],
    ["report", 1, "unknown"],
  ]) {
    const callId = `patch-${messages.length}`;
    messages.push(
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: callId,
            name: "artifact_patch",
            args: { id, expectedRevision: revision, edits, status: "ready" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: callId,
        content: JSON.stringify({
          ok: false,
          toolName: "artifact_patch",
          code: "invalid_args",
          effect,
          message: "Read the annotations first",
        }),
      },
    );
  }
  messages.push({
    role: "tool",
    toolCallId: "annotations",
    content: JSON.stringify(comments(0, 16)),
  });
  const original = globalThis.structuredClone(messages);
  const view = deepReadReviewMessages(messages, f.draft);
  const inputs = JSON.parse(
    view
      .find((m) => m.content.startsWith("Review inputs"))
      .content.split("\n")
      .slice(1)
      .join("\n"),
  );
  assert.equal(inputs.pendingCorrections.length, 1);
  assert.equal(inputs.pendingCorrections[0].applied, false);
  assert.deepEqual(inputs.pendingCorrections[0].args.edits, edits);
  assert.deepEqual(inputs.draft.body, f.draft.body);
  assert.doesNotMatch(JSON.stringify(view), /BIASED EARLIER REASONING/);
  assert.deepEqual(messages, original);
});

test("image availability without delivered media cannot satisfy a source read", () => {
  const result = {
    ok: true,
    toolName: "inspect_pdf_page",
    data: {
      libraryID: 1,
      key: "PDF",
      visualAvailable: true,
      lineAnchors: [],
    },
  };
  assert.equal(sourceReadEvidence(result), undefined);
  assert.equal(
    sourceReadEvidence({
      ...result,
      transientMedia: [{ type: "image", data: "image", mimeType: "image/png" }],
    }).sourceContent,
    true,
  );
});

test("a stopped draft retains its revision boundary so fresh reads can finish review after event compaction", () => {
  const f = fixture();
  f.save();
  for (let i = 0; i < 100; i++)
    f.events.push({
      id: `noise-${i}`,
      sessionId: "task",
      type: "tool_progress",
      ts: 100,
      payload: { callId: "work", message: "Working" },
    });
  const retained = compactTaskEvents(f.events, 10);
  assert.deepEqual(compactTaskEvents(f.events, 1), [f.events.at(-1)]);
  assert.equal(retained.length, 10);
  assert.equal(retained[0].type, "artifact_upserted");
  f.events.splice(0, f.events.length, ...JSON.parse(JSON.stringify(retained)));
  f.read(page);
  f.read(comments(0, 41));
  assert.equal(f.state(), "reviewed");
});
