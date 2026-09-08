import assert from "node:assert/strict";
import { it } from "node:test";
import {
  emptyLockedContext,
  migrateSessionRecord,
  withLockedContextFingerprint,
  type LockedContextSnapshot,
  type ResearchTaskRecord,
} from "@confucius/protocol";
import { AgentHost } from "./AgentHost";
import {
  contextArticles,
  followReaderContext,
  readerAttachmentIdentity,
} from "./TaskSources";
import { articleTaskGroups, timeTaskGroups } from "../ui/workspaceTasks";

function pdf(key: string, libraryID = 1, pageIndex = 0): LockedContextSnapshot {
  return withLockedContextFingerprint({
    ...emptyLockedContext(1),
    items: [
      {
        id: `item:${libraryID}:${key}`,
        libraryID,
        key,
        title: `Paper ${key}`,
        source: "reader",
        attachmentKey: `PDF${key}`,
      },
    ],
    reader: {
      id: `reader:${libraryID}:PDF${key}`,
      libraryID,
      attachmentKey: `PDF${key}`,
      parentKey: key,
      title: `Paper ${key}`,
      pageIndex,
      pageLabel: String(pageIndex + 1),
    },
  });
}

function task(id: string, context = emptyLockedContext(1)): ResearchTaskRecord {
  return {
    id,
    schemaVersion: 4,
    title: id,
    titleState: "fixed",
    createdAt: 1,
    updatedAt: 1,
    mode: "agent",
    permissionMode: "ask",
    context: {},
    backend: "codex",
    status: "ready",
    capabilityProfile: "zotero_only",
    lockedContext: context,
    artifactIds: [],
  };
}

it("attaches a PDF opened after an empty task, replaces the reader, and clears it on close", () => {
  const empty = emptyLockedContext(1);
  const a = followReaderContext(empty, pdf("A"));
  const b = followReaderContext(a, pdf("B"));
  assert.deepEqual(
    a.items.map((item) => item.key),
    ["A"],
  );
  assert.equal(readerAttachmentIdentity(b), "1:PDFB");
  assert.deepEqual(
    b.items.map((item) => item.key),
    ["B"],
  );
  const closed = followReaderContext(b, empty);
  assert.equal(closed.reader, undefined);
  assert.deepEqual(closed.items, []);
  assert.deepEqual(empty.items, []);
  assert.equal(a.reader?.attachmentKey, "PDFA");
});

it("preserves explicit mentions including a manually pinned copy of the focused article", () => {
  const a = pdf("A");
  a.items[0].source = "library";
  a.items.push({ ...pdf("M").items[0], source: "library" });
  const b = followReaderContext(a, pdf("B"));
  assert.deepEqual(
    b.items.map((item) => [item.key, item.source]),
    [
      ["B", "reader"],
      ["A", "library"],
      ["M", "library"],
    ],
  );
  const back = followReaderContext(b, pdf("A"));
  assert.equal(back.items.find((item) => item.key === "A")?.source, "library");
  assert.deepEqual(
    followReaderContext(back, emptyLockedContext()).items.map(
      (item) => item.key,
    ),
    ["A", "M"],
  );
});

it("uses library-qualified identities and recovers a reader without its parent row", () => {
  const a = pdf("A", 1);
  a.items[0].source = "library";
  const live = pdf("A", 2);
  live.items = [];
  const followed = followReaderContext(a, live);
  assert.equal(followed.items.length, 2);
  assert.deepEqual(
    contextArticles(followed).map((item) => item.libraryID),
    [2, 1],
  );
});

it("host follows idle tasks without changing recency, refreshes on Send, and preserves a running turn", async () => {
  const record = task("existing");
  const state = { record, activeTurnId: null as string | null };
  let live = pdf("A");
  let freezes = 0;
  const host = Object.assign(Object.create(AgentHost.prototype), {
    sessions: new Map([[record.id, state]]),
    captureLockedContext: () => live,
    emitSessionEvent: () => {
      record.updatedAt = 99;
    },
    persistSoon: () => undefined,
    freezeBoundAnnotations: async () => {
      freezes++;
    },
  }) as {
    detectContextDrift(current: typeof state): void;
    taskSetContext(
      params: Record<string, unknown>,
    ): Promise<ResearchTaskRecord>;
  };
  const follow = (refresh = false) =>
    host.taskSetContext({ taskId: record.id, mode: "follow_reader", refresh });
  await follow();
  assert.equal(record.lockedContext.reader?.attachmentKey, "PDFA");
  assert.deepEqual(record.articleSources, []);
  assert.deepEqual(articleTaskGroups([record]), []);
  assert.equal(record.updatedAt, 1);
  live = pdf("A", 1, 4);
  host.detectContextDrift(state);
  assert.equal(record.updatedAt, 1);
  await follow();
  assert.equal(record.lockedContext.reader?.pageIndex, 0);
  await follow(true);
  assert.equal(record.lockedContext.reader?.pageIndex, 4);
  const runningSources = record.lockedContext;
  state.activeTurnId = "running";
  live = pdf("B");
  await follow(true);
  assert.equal(record.lockedContext, runningSources);
  state.activeTurnId = null;
  await follow();
  assert.equal(record.lockedContext.reader?.attachmentKey, "PDFB");
  assert.equal(runningSources.reader?.attachmentKey, "PDFA");
  assert.equal(freezes, 0);
  // Pinning is a real change even if item identities and fingerprint match.
  await host.taskSetContext({ taskId: record.id, mode: "add", context: live });
  assert.equal(record.lockedContext.items[0].source, "library");
  live = pdf("C");
  await follow();
  assert.deepEqual(
    record.lockedContext.items.map((item) => item.key),
    ["C", "B"],
  );
});

it("groups all related conversations by article and keeps previously used papers after switching", () => {
  const first = task("first", pdf("C"));
  first.articleSources = [...pdf("A").items, ...pdf("B").items];
  const second = task("second", pdf("A"));
  second.updatedAt = 2;
  const otherLibrary = task("other-library", pdf("A", 2));
  const groups = articleTaskGroups([
    first,
    second,
    otherLibrary,
    task("no-paper"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.id),
    ["1:A", "2:A", "1:B"],
  );
  assert.deepEqual(
    groups[0].tasks.map((entry) => entry.id),
    ["second", "first"],
  );
  assert.equal(groups[0].article.attachmentKey, "PDFA");
  assert.deepEqual(
    groups[1].tasks.map((entry) => entry.id),
    ["other-library"],
  );
  assert.deepEqual(
    migrateSessionRecord(first).articleSources,
    first.articleSources,
  );
  const invalid = {
    ...first,
    articleSources: [{ key: "bad" }],
  } as unknown as ResearchTaskRecord;
  assert.equal(migrateSessionRecord(invalid).articleSources, undefined);
});

it("reader preview changes cannot move submitted or explicitly unfiled conversations", () => {
  const submitted = task("submitted", pdf("A"));
  submitted.articleSources = pdf("B").items;
  const unfiled = task("unfiled", pdf("A"));
  unfiled.articleSources = [];
  for (const key of ["C", "A", "B", "D", "C"]) {
    submitted.lockedContext = pdf(key);
    unfiled.lockedContext = pdf(key);
    assert.deepEqual(
      articleTaskGroups([submitted, unfiled]).map((group) => [
        group.id,
        group.tasks.map((row) => row.id),
      ]),
      [["1:B", ["submitted"]]],
    );
  }
});

it("article and task ordering has deterministic ties and does not depend on list response order", () => {
  const records = [
    task("b", pdf("B")),
    task("a", pdf("A")),
    task("c", pdf("A")),
  ];
  const snapshot = (rows: ResearchTaskRecord[]) =>
    articleTaskGroups(rows).map((group) => [
      group.id,
      group.tasks.map((task) => task.id),
    ]);
  const expected = snapshot(records);
  for (let n = 0; n < 20; n++) {
    records.reverse();
    records.push(records.shift()!);
    assert.deepEqual(snapshot(records), expected);
  }
  records.find((record) => record.id === "b")!.updatedAt += 10;
  assert.deepEqual(
    articleTaskGroups(records).map((group) => group.id),
    ["1:A", "1:B"],
  );
});

it("time groups cover every task once at local midnight boundaries including old and future tasks", () => {
  const now = new Date(2026, 8, 8, 12);
  const timestamp = (days: number) => new Date(2026, 8, 8 - days).getTime();
  const entries = [
    ["future", timestamp(-1)],
    ["today", timestamp(0)],
    ["yesterday", timestamp(1)],
    ["week", timestamp(7)],
    ["month", timestamp(30)],
    ["old", timestamp(31)],
    ["before-midnight", timestamp(1) - 1],
  ] as const;
  const records = entries.map(([id, updatedAt]) => ({
    ...task(id),
    updatedAt,
  }));
  const grouped = timeTaskGroups(records, now);
  assert.deepEqual(
    grouped.map((group) => [group.id, group.tasks.map((task) => task.id)]),
    [
      ["today", ["future", "today"]],
      ["yesterday", ["yesterday"]],
      ["week", ["before-midnight", "week"]],
      ["month", ["month"]],
      ["older", ["old"]],
    ],
  );
  assert.equal(
    new Set(grouped.flatMap((group) => group.tasks.map((task) => task.id)))
      .size,
    records.length,
  );
  assert.deepEqual(timeTaskGroups([], now), []);
});
