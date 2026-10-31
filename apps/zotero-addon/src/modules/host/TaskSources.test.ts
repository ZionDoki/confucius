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
  automaticReaderContext,
  contextArticles,
  followReaderContext,
  readerAttachmentIdentity,
  taskArticles,
  taskCategory,
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

it("host binds an empty task once and preserves it when PDF tabs change", async () => {
  const record = task("existing");
  const state = { record, activeTurnId: null as string | null };
  let live = pdf("A");
  const host = Object.assign(Object.create(AgentHost.prototype), {
    sessions: new Map([[record.id, state]]),
    captureLockedContext: () => live,
    emitSessionEvent: () => {},
    persistSoon: () => {},
    freezeBoundAnnotations: async () => {},
  }) as {
    taskSetContext(
      params: Record<string, unknown>,
    ): Promise<ResearchTaskRecord>;
  };
  const follow = () =>
    host.taskSetContext({
      taskId: record.id,
      mode: "follow_reader",
      refresh: true,
    });
  await follow();
  assert.equal(record.lockedContext.reader?.attachmentKey, "PDFA");
  assert.ok(record.updatedAt > 1);
  await host.taskSetContext({ taskId: record.id, mode: "add", context: live });
  assert.equal(record.lockedContext.items[0].key, "A");
  const bound = record.lockedContext;
  live = pdf("B");
  await follow();
  assert.equal(record.lockedContext, bound);
  state.activeTurnId = "running";
  await follow();
  assert.equal(record.lockedContext, bound);
  await assert.rejects(
    host.taskSetContext({ taskId: record.id, mode: "add", context: live }),
    /Wait/,
  );
  state.activeTurnId = null;
  await host.taskSetContext({ taskId: record.id, mode: "add", context: live });
  assert.deepEqual(
    record.lockedContext.items.map((item) => item.key),
    ["A", "B"],
  );
  assert.deepEqual(record.createdFrom, []);
});

it("automatic binding ignores unrelated selections, old conversations and explicit unbinding", () => {
  const record = task("new");
  assert.equal(
    automaticReaderContext(record, emptyLockedContext(), true),
    undefined,
  );
  const live = pdf("A");
  live.items.push({ ...pdf("UNRELATED").items[0], source: "library" });
  live.collection = {
    id: "collection:1:C",
    libraryID: 1,
    key: "C",
    name: "Other collection",
  };
  const seeded = automaticReaderContext(record, live, false)!;
  assert.deepEqual(
    seeded.items.map((item) => item.key),
    ["A"],
  );
  assert.equal(seeded.collection, undefined);
  record.pdfBinding = "manual";
  assert.equal(automaticReaderContext(record, live, true), undefined);
  assert.equal(migrateSessionRecord(record).pdfBinding, "manual");
  record.pdfBinding = undefined;
  record.status = "completed";
  assert.equal(automaticReaderContext(record, live, true), undefined);
  record.status = "ready";
  record.run = { id: "completed-run" } as ResearchTaskRecord["run"];
  assert.equal(automaticReaderContext(record, live, true), undefined);
});

it("Send refreshes only the bound PDF's page and selection", () => {
  const record = task("bound", pdf("A"));
  const live = pdf("A", 1, 4);
  assert.equal(automaticReaderContext(record, live, false), undefined);
  assert.equal(automaticReaderContext(record, pdf("B"), true), undefined);
  assert.equal(
    automaticReaderContext(record, emptyLockedContext(), true),
    undefined,
  );
  const refreshed = automaticReaderContext(record, live, true)!;
  assert.equal(refreshed.reader?.pageIndex, 4);
  assert.equal(record.lockedContext.reader?.pageIndex, 0);
});

it("manual PDF switching and clearing preserve mentions and survive poll/reload", async () => {
  const record = task("switch", pdf("A"));
  record.lockedContext.items.push({ ...pdf("M").items[0], source: "library" });
  const state = { record, activeTurnId: null as string | null };
  const host = Object.assign(Object.create(AgentHost.prototype), {
    sessions: new Map([[record.id, state]]),
    pdfContext: (value: unknown) =>
      value === null ? emptyLockedContext() : pdf("B"),
    captureLockedContext: () => pdf("A"),
    emitSessionEvent: () => {},
    persistSoon: () => {},
    freezeBoundAnnotations: async () => {},
  }) as {
    taskSetContext(
      params: Record<string, unknown>,
    ): Promise<ResearchTaskRecord>;
  };
  await host.taskSetContext({
    taskId: record.id,
    mode: "reader",
    pdf: { libraryID: 1, key: "PDFB" },
  });
  assert.equal(record.lockedContext.reader?.attachmentKey, "PDFB");
  assert.deepEqual(
    record.lockedContext.items.map((item) => item.key),
    ["B", "M"],
  );
  await host.taskSetContext({ taskId: record.id, mode: "reader", pdf: null });
  assert.equal(record.lockedContext.reader, undefined);
  assert.deepEqual(
    record.lockedContext.items.map((item) => item.key),
    ["M"],
  );
  state.record = migrateSessionRecord(record);
  await host.taskSetContext({
    taskId: record.id,
    mode: "follow_reader",
    refresh: true,
  });
  assert.equal(state.record.lockedContext.reader, undefined);
  state.activeTurnId = "running";
  await assert.rejects(
    host.taskSetContext({ taskId: record.id, mode: "reader", pdf: null }),
    /Wait/,
  );
});

it("captures navigation before explicit source additions without moving a blank task", () => {
  const blank = task("blank", pdf("B"));
  blank.createdFrom = [];
  assert.deepEqual(taskArticles(blank), []);
  assert.equal(taskCategory(blank), "unfiled");
});

it("research evidence never adds article folders and old acquired associations are repaired", () => {
  const research = task("research", pdf("ACQUIRED"));
  research.articleSources = pdf("ACQUIRED").items;
  research.literatureSourceKeys = ["1:ACQUIRED"];
  research.literature = {
    id: "pool",
    revision: 1,
    candidateRevision: 1,
    pool: 100,
    evaluated: 9,
    candidates: 9,
    pendingFulltext: 8,
    available: 1,
    read: 0,
    awaitingConfirmation: false,
  };
  const article = {
    ...research,
    id: "article",
    createdFrom: pdf("ORIGIN").items,
  };
  assert.equal(taskCategory(research), "research");
  assert.equal(taskCategory(article), "articles");
  assert.deepEqual(
    articleTaskGroups([research, article]).map((group) => group.id),
    ["1:ORIGIN"],
  );
  assert.deepEqual(
    research.lockedContext.items.map((item) => item.key),
    ["ACQUIRED"],
  );
  // Persisted empty origins and removed/changed research candidates cannot regroup a task.
  research.createdFrom = taskArticles(research);
  research.literatureSourceKeys = [];
  assert.deepEqual(taskArticles(research), []);
  assert.deepEqual(migrateSessionRecord(research).createdFrom, []);
  assert.deepEqual(
    migrateSessionRecord(article).createdFrom,
    article.createdFrom,
  );
  assert.equal(
    migrateSessionRecord({
      ...article,
      createdFrom: [{ key: "bad" }],
    } as unknown as ResearchTaskRecord).createdFrom,
    undefined,
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

it("PDF lookup rejects deleted/non-PDF attachments and identifies alternate files precisely", async () => {
  const globals = globalThis as unknown as { Zotero: unknown };
  const original = globals.Zotero;
  const parent = {
    key: "PAPER",
    getDisplayTitle: () => "Paper title",
    deleted: false,
  };
  const attachments = Array.from({ length: 28 }, (_, i) => ({
    libraryID: 1,
    key: `PDF${i}`,
    parentItemID: 10,
    deleted: false,
    isPDFAttachment: () => true,
    getDisplayTitle: () => `Attachment ${i}`,
    attachmentFilename: `Appendix ${i}.pdf`,
    dateModified: String(100 + i),
  }));
  const orphan = {
    ...attachments[0],
    key: "ORPHAN",
    parentItemID: 0,
    attachmentFilename: "standalone.pdf",
  };
  const deleted = { ...attachments[0], key: "TRASH", deleted: true };
  const nonPDF = {
    ...attachments[0],
    key: "EPUB",
    isPDFAttachment: () => false,
  };
  const all = [...attachments, orphan, deleted, nonPDF];
  globals.Zotero = {
    Reader: { getByTabID: () => undefined },
    getMainWindow: () => ({}),
    getActiveZoteroPane: () => ({ getSelectedLibraryID: () => 1 }),
    Libraries: {
      exists: (id: number) => id === 1,
      userLibraryID: 1,
      getName: () => "My library",
    },
    Items: {
      get: () => parent,
      getAll: async () => all,
      getByLibraryAndKey: (id: number, key: string) =>
        id === 1 ? all.find((item) => item.key === key) : undefined,
    },
  };
  try {
    const host = Object.assign(Object.create(AgentHost.prototype), {
      captureLockedContext: () => pdf("OTHER"),
    }) as {
      pdfContext(pdf: unknown): LockedContextSnapshot;
      contextSearchPdfs(
        params: Record<string, unknown>,
      ): Promise<import("@confucius/protocol").ContextSearchPdfsResult>;
    };
    const first = await host.contextSearchPdfs({});
    assert.equal(first.total, 29);
    assert.equal(first.items.length, 25);
    assert.equal(first.nextOffset, 25);
    const second = await host.contextSearchPdfs({ offset: first.nextOffset });
    assert.equal(second.items.length, 4);
    assert.equal(second.nextOffset, null);
    assert.equal(
      new Set([...first.items, ...second.items].map((item) => item.key)).size,
      29,
    );
    const searched = await host.contextSearchPdfs({ query: "appendix 3.pdf" });
    assert.equal(searched.items[0].key, "PDF3");
    assert.equal(searched.items.length, 1);
    const bound = host.pdfContext({ libraryID: 1, key: "PDF3" });
    assert.equal(bound.reader?.attachmentKey, "PDF3");
    assert.equal(bound.reader?.parentKey, "PAPER");
    assert.equal(bound.selection, undefined);
    assert.equal(bound.reader?.pageIndex, null);
    assert.equal(
      host.pdfContext({ libraryID: 1, key: "ORPHAN" }).reader?.parentKey,
      null,
    );
    for (const key of ["TRASH", "EPUB", "MISSING"])
      assert.throws(
        () => host.pdfContext({ libraryID: 1, key }),
        /no longer available/,
      );
    parent.deleted = true;
    assert.throws(
      () => host.pdfContext({ libraryID: 1, key: "PDF3" }),
      /no longer available/,
    );
  } finally {
    globals.Zotero = original;
  }
});

it("explicit task-entry context wins over an unrelated reader, while composer mentions allow automatic binding", async () => {
  const globals = globalThis as unknown as { PathUtils: unknown };
  const original = globals.PathUtils;
  globals.PathUtils = {};
  try {
    const host = Object.assign(Object.create(AgentHost.prototype), {
      sessions: new Map(),
      history: { register: () => {} },
      queueHistory: async () => {},
      persistSoon: () => {},
      emitSessionEvent: () => {},
      captureLockedContext: () => pdf("B"),
    }) as {
      sessionNew(params: Record<string, unknown>): ResearchTaskRecord;
      taskSetContext(
        params: Record<string, unknown>,
      ): Promise<ResearchTaskRecord>;
    };
    const context = {
      ...emptyLockedContext(),
      items: [{ ...pdf("A").items[0], source: "library" }],
    };
    const explicit = host.sessionNew({ context });
    await host.taskSetContext({
      taskId: explicit.id,
      mode: "follow_reader",
      refresh: true,
    });
    assert.equal(explicit.lockedContext.reader, undefined);
    assert.deepEqual(
      explicit.lockedContext.items.map((item) => item.key),
      ["A"],
    );
    const composer = host.sessionNew({ context, followReader: true });
    assert.equal(composer.lockedContext.reader?.attachmentKey, "PDFB");
    assert.deepEqual(
      composer.lockedContext.items.map((item) => item.key),
      ["B", "A"],
    );
    assert.equal(composer.pdfBinding, undefined);
  } finally {
    globals.PathUtils = original;
  }
});

it("removing inline sources unbinds only their exact identities and survives automatic refresh", async () => {
  const record = task("inline-remove", pdf("A"));
  record.lockedContext.items.push({ ...pdf("M").items[0], source: "library" });
  record.lockedContext.items.push({
    ...pdf("M", 2).items[0],
    source: "library",
  });
  const state = { record, activeTurnId: null as string | null };
  const host = Object.assign(Object.create(AgentHost.prototype), {
    sessions: new Map([[record.id, state]]),
    captureLockedContext: () => pdf("A"),
    emitSessionEvent: () => {},
    persistSoon: () => {},
    freezeBoundAnnotations: async () => {},
  }) as {
    taskSetContext(
      params: Record<string, unknown>,
    ): Promise<ResearchTaskRecord>;
  };
  await host.taskSetContext({
    taskId: record.id,
    mode: "remove",
    items: [{ libraryID: 1, key: "M" }],
  });
  assert.equal(record.lockedContext.reader?.attachmentKey, "PDFA");
  assert.equal(
    record.lockedContext.items.some(
      (item) => item.libraryID === 1 && item.key === "M",
    ),
    false,
  );
  assert.equal(
    record.lockedContext.items.some(
      (item) => item.libraryID === 2 && item.key === "M",
    ),
    true,
  );
  await host.taskSetContext({
    taskId: record.id,
    mode: "remove",
    items: [],
    clearReader: true,
  });
  assert.equal(record.pdfBinding, "manual");
  assert.equal(record.lockedContext.reader, undefined);
  state.record = migrateSessionRecord(record);
  await host.taskSetContext({
    taskId: record.id,
    mode: "follow_reader",
    refresh: true,
  });
  assert.equal(state.record.lockedContext.reader, undefined);
  assert.deepEqual(
    record.createdFrom?.map((item) => item.key),
    ["A", "M", "M"],
  );
  state.activeTurnId = "active";
  await assert.rejects(
    host.taskSetContext({ taskId: record.id, mode: "remove", items: [] }),
    /Wait/,
  );
});
