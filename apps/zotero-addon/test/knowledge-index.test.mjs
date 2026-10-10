import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  InMemoryFileSystem,
  MemoryEngine,
  KnowledgeBaseService,
  serializeMemory,
} from "@confucius/memory";
import {
  KnowledgeIndex,
  zoteroKnowledgeNotes,
} from "../src/modules/host/KnowledgeIndex.ts";
import {
  ResearchMemory,
  parseResearchUpdates,
} from "../src/modules/host/ResearchMemory.ts";
import { memoryJsonStorage } from "../src/modules/host/RuntimeStorage.ts";
import { ConfuciusMemoryToolProvider } from "../src/modules/host/MemoryTools.ts";
import { AgentHost } from "../src/modules/host/AgentHost.ts";

const digest = async (value) =>
  createHash("sha256").update(value).digest("hex");
function setup(options = {}) {
  const fs = options.fs ?? new InMemoryFileSystem();
  const memory = new MemoryEngine({ fs, root: "/memory", ...options });
  const journal = memoryJsonStorage();
  const tracker = new ResearchMemory(memory, journal, digest);
  const notes = new Map();
  const index = new KnowledgeIndex(memory, {
    list: async () => [...notes.values()].map((row) => ({ ...row })),
    read: async (libraryID, key) =>
      notes.get(`note:${libraryID}:${key}`) ?? null,
  });
  return { fs, memory, journal, tracker, notes, index };
}
const request = "我正在研究科研 Agent 的长期记忆，需要追踪检索可靠性。";
const update = (extra = {}) => ({
  type: "project",
  title: "Agent 长期记忆",
  content: "目标：研究长期记忆\n- 待研究：检索可靠性\n- 下一步：设计对照实验",
  status: "active",
  evidence: "我正在研究科研 Agent 的长期记忆",
  ...extra,
});

test("knowledge loads cold Zotero note titles and bodies for search and direct reads", async (t) => {
  const previous = globalThis.Zotero;
  t.after(() => {
    globalThis.Zotero = previous;
  });
  const loaded = new Set();
  const requireData = (type, value) => {
    if (!loaded.has(type)) throw new Error(`${type} is not loaded`);
    return value;
  };
  const note = {
    libraryID: 2,
    key: "NOTE0001",
    dateModified: "2026-10-07 00:00:00",
    deleted: false,
    isNote: () => true,
    getDisplayTitle: () => requireData("itemData", "Cold group note"),
    getNote: () => requireData("note", "<p>Cold group evidence</p>"),
  };
  const deleted = { ...note, key: "NOTE0002", deleted: true };
  const regular = { ...note, key: "ITEM0001", isNote: () => false };
  const items = [note, deleted, regular];
  globalThis.Zotero = {
    Libraries: { getAll: () => [{ libraryID: 1 }, { libraryID: 2 }] },
    Items: {
      getAll: async (libraryID) => (libraryID === 2 ? items : []),
      getByLibraryAndKeyAsync: async (libraryID, key) =>
        items.find((item) => item.libraryID === libraryID && item.key === key),
      loadDataTypes: async (notes, types) => {
        assert.ok(notes.every((item) => item === note));
        if (notes.length) types.forEach((type) => loaded.add(type));
      },
    },
  };
  const { memory } = setup();
  await memory.save({
    title: "Group memory",
    content: "Group memory evidence",
  });
  const index = new KnowledgeIndex(memory, zoteroKnowledgeNotes());
  assert.throws(() => note.getNote(), /not loaded/);
  const result = await index.search("evidence");
  assert.equal(result.total, 2);
  assert.ok(result.items.some((item) => item.title === "Cold group note"));
  loaded.clear();
  assert.equal((await index.read("note:2:NOTE0001")).content, note.getNote());
  assert.equal((await index.read("note:2:NOTE0001")).title, "Cold group note");
  await assert.rejects(
    index.read("note:2:NOTE0002"),
    /deleted or is unavailable/,
  );
  await assert.rejects(
    index.read("note:2:ITEM0001"),
    /deleted or is unavailable/,
  );
});

test("knowledge index follows live note edits and deletions, pages results, and retains legacy files", async () => {
  const { notes, index, memory, fs } = setup();
  const note = {
    id: "note:1:NOTE0001",
    title: "Retrieval paper",
    content: "<p>initial evidence</p>",
    format: "html",
    kind: "note",
    updatedAt: 1,
    source: { libraryID: 1, key: "NOTE0001" },
  };
  notes.set(note.id, note);
  const legacy = new KnowledgeBaseService(memory);
  const base = await legacy.create({ title: "Legacy topic" });
  const entry = await legacy.saveEntry({
    knowledgeBaseId: base.id,
    kind: "note",
    title: "Legacy evidence",
    content: "Original body",
  });
  const original = await fs.readFile(`/memory/memories/${entry.id}.md`);
  const first = await index.search("", 0, 1);
  assert.equal(first.total, 3);
  assert.equal(first.nextOffset, 1);
  assert.equal(Object.hasOwn(first.items[0], "content"), false);
  assert.equal(
    (await index.read(`memory:${entry.id}`)).content,
    "Original body",
  );
  assert.equal(await fs.readFile(`/memory/memories/${entry.id}.md`), original);
  note.content = "<p>updated native evidence</p>";
  assert.equal((await index.read(note.id)).content, note.content);
  assert.equal((await index.search("updated native")).items[0].id, note.id);
  notes.delete(note.id);
  await assert.rejects(index.read(note.id), /deleted or is unavailable/);
  assert.equal((await index.search("Retrieval")).total, 0);
});

test("knowledge excludes child notes of trashed or unavailable parents and restores them with the parent", async (t) => {
  const previous = globalThis.Zotero;
  t.after(() => {
    globalThis.Zotero = previous;
  });
  const parent = { id: 10, deleted: false };
  const note = {
    libraryID: 1,
    key: "NOTE0001",
    parentItemID: parent.id,
    dateModified: "2026-10-07 00:00:00",
    deleted: false,
    isNote: () => true,
    getDisplayTitle: () => "Child source",
    getNote: () => "<p>Child evidence</p>",
  };
  let present = true;
  let parentReads = 0;
  let onLoad = () => {};
  globalThis.Zotero = {
    Libraries: { getAll: () => [{ libraryID: 1 }] },
    Items: {
      getAll: async () => [note],
      getByLibraryAndKeyAsync: async () => note,
      getAsync: async (id) => {
        assert.equal(id, parent.id);
        parentReads++;
        return present ? parent : false;
      },
      loadDataTypes: async () => onLoad(),
    },
  };
  const { memory } = setup();
  const index = new KnowledgeIndex(memory, zoteroKnowledgeNotes());
  const id = "note:1:NOTE0001";
  assert.equal((await index.read(id)).content, note.getNote());
  assert.ok(parentReads > 0, "Direct reads must load cold ancestors");
  assert.equal((await index.search("evidence")).total, 1);
  parent.deleted = true;
  assert.equal(
    note.deleted,
    false,
    "Trashing a parent does not trash its child",
  );
  assert.equal((await index.search("evidence")).total, 0);
  await assert.rejects(index.read(id), /deleted or is unavailable/);
  parent.deleted = false;
  assert.equal((await index.search("evidence")).total, 1);
  assert.equal((await index.read(id)).content, note.getNote());
  onLoad = () => {
    parent.deleted = true;
  };
  await assert.rejects(index.read(id), /deleted or is unavailable/);
  present = false;
  onLoad = () => {};
  await assert.rejects(index.read(id), /deleted or is unavailable/);
});

test("knowledge refreshes edited, removed and newly added memory files without renewing retention", async () => {
  let now = 1;
  const { memory, index, fs } = setup({ now: () => now });
  const record = await memory.save({
    title: "Original title",
    content: "originalmarker",
    protection: "none",
  });
  const path = `/memory/memories/${record.id}.md`;
  await index.read(`memory:${record.id}`, true);
  const changed = serializeMemory({
    ...record,
    title: "Edited title",
    content: "updatedmarker",
    updatedAt: 2,
  });
  await fs.writeFile(path, changed);
  now = 100;
  assert.equal((await index.search("originalmarker")).total, 0);
  const found = (await index.search("updatedmarker")).items[0];
  assert.equal(found.title, "Edited title");
  assert.equal(found.updatedAt, 2);
  assert.equal((await memory.search({ query: "updatedmarker" })).length, 1);
  assert.equal((await memory.search({ query: "originalmarker" })).length, 0);
  assert.equal(memory.get(record.id).lastUsedAt, 1);
  assert.equal(memory.get(record.id).accessCount, 1);
  assert.equal(await fs.readFile(path), changed);
  await fs.deleteFile(path);
  assert.equal((await index.search("updatedmarker")).total, 0);
  assert.equal(memory.get(record.id), undefined);
  assert.doesNotMatch(await fs.readFile("/memory/MEMORY.md"), /updatedmarker/);
  const added = serializeMemory({
    ...record,
    id: "mem_external",
    title: "External file",
    content: "externalmarker",
  });
  const addedPath = "/memory/memories/mem_external.md";
  await fs.writeFile(addedPath, added);
  assert.equal((await index.search("externalmarker")).total, 1);
  assert.equal(
    (await index.read("memory:mem_external")).content,
    "externalmarker",
  );
  assert.equal(await fs.readFile(addedPath), added);
  assert.equal(memory.get("mem_external").lastUsedAt, undefined);
  assert.equal(memory.get("mem_external").accessCount, 0);
});

test("legacy topic names do not block new research memory or change legacy files", async () => {
  const { memory, tracker, fs, index } = setup();
  const legacy = new KnowledgeBaseService(memory);
  const base = await legacy.create({
    title: update().title,
    description: "Old topic",
  });
  const entry = await legacy.saveEntry({
    knowledgeBaseId: base.id,
    kind: "note",
    title: "Prior evidence",
    content: "Keep the original file",
  });
  const originals = await Promise.all(
    [base, entry].map((record) =>
      fs.readFile(`/memory/memories/${record.id}.md`),
    ),
  );
  const snapshot = await tracker.snapshot(request, "a");
  assert.equal(snapshot.records.length, 0);
  const changes = await tracker.apply(
    "a:1",
    snapshot,
    [update()],
    "a",
    () => true,
  );
  assert.equal(changes.length, 1);
  assert.notEqual(changes[0].id, base.id);
  await tracker.apply(
    "a:2",
    await tracker.snapshot(request, "a"),
    [update({ id: changes[0].id, content: "New research progress" })],
    "a",
    () => true,
  );
  assert.equal((await memory.list()).length, 3);
  assert.match(memory.get(changes[0].id).content, /New research progress/);
  assert.deepEqual(
    await Promise.all(
      [base, entry].map((record) =>
        fs.readFile(`/memory/memories/${record.id}.md`),
      ),
    ),
    originals,
  );
  assert.deepEqual(
    new Set(
      (await index.search(update().title)).items.map((item) => item.kind),
    ),
    new Set(["legacy", "project"]),
  );
});

test("production memory provider advertises unified reads and blocks new legacy writes", async () => {
  const { memory, index } = setup();
  const provider = new ConfuciusMemoryToolProvider(
    memory,
    undefined,
    undefined,
    index,
  );
  assert.deepEqual(
    provider.listTools().map((tool) => tool.name),
    ["knowledge_search", "knowledge_read"],
  );
  const failure = await provider.prepare("knowledge_base_create", {
    title: "Duplicate",
  });
  assert.equal(failure.ok, false);
  assert.equal(
    (await provider.call("knowledge_base_create", { title: "Duplicate" })).ok,
    false,
  );
  assert.equal((await memory.list()).length, 0);
  const record = await memory.save({ content: "abcdef", title: "Short" });
  const result = await provider.call("knowledge_read", {
    id: `memory:${record.id}`,
    limit: 3,
  });
  assert.equal(result.data.content, "abc");
  assert.equal(result.data.nextOffset, 3);
  assert.equal(
    (
      await provider.call("knowledge_read", {
        id: `memory:${record.id}`,
        offset: 100,
      })
    ).ok,
    false,
  );
});

test("research updates require current user evidence and known identities", () => {
  const snapshot = { revision: 0, records: [] };
  assert.deepEqual(
    parseResearchUpdates("[]", "Explain this paper", snapshot),
    [],
  );
  assert.equal(
    parseResearchUpdates(JSON.stringify([update()]), request, snapshot).length,
    1,
  );
  assert.throws(() =>
    parseResearchUpdates(
      JSON.stringify([update({ evidence: "assistant guessed a preference" })]),
      request,
      snapshot,
    ),
  );
  assert.throws(() =>
    parseResearchUpdates(
      JSON.stringify([update({ id: "invented" })]),
      request,
      snapshot,
    ),
  );
  assert.throws(() =>
    parseResearchUpdates(
      JSON.stringify([update(), update()]),
      request,
      snapshot,
    ),
  );
  assert.throws(() =>
    parseResearchUpdates('[{"type":"project"}]', request, snapshot),
  );
});

test("research state reuses the same topic across tasks, preserves provenance and replays once", async () => {
  const { memory, tracker } = setup();
  const first = await tracker.snapshot(request, "task-a");
  await tracker.apply("a:1", first, [update()], "task-a", () => true);
  const record = (await memory.list())[0];
  await tracker.apply("a:1", first, [update()], "task-a", () => true);
  assert.equal((await memory.list()).length, 1);
  const second = await tracker.snapshot("Agent 长期记忆", "task-b");
  assert.equal(second.records[0].id, record.id);
  await tracker.apply(
    "b:1",
    second,
    [
      update({
        id: record.id,
        content: "检索可靠性：已完成对照实验；问题已解决。",
        status: "completed",
      }),
    ],
    "task-b",
    () => true,
  );
  const revised = memory.get(record.id);
  assert.match(revised.content, /已解决/);
  assert.deepEqual(revised.sourceRefs, ["task:task-a", "task:task-b"]);
  assert.ok(revised.tags.includes("research:status:completed"));
  assert.equal((await memory.list()).length, 1);
});

test("a conflicting batch stays unapplied and can merge both conversations from a fresh snapshot", async () => {
  const { memory, tracker, journal } = setup();
  await tracker.apply(
    "seed",
    await tracker.snapshot(request, "seed"),
    [update()],
    "seed",
    () => true,
  );
  const record = (await memory.list())[0];
  const a = await tracker.snapshot(request, "a");
  const b = await tracker.snapshot(request, "b");
  await tracker.apply(
    "a:1",
    a,
    [update({ id: record.id, content: "A: latency measured" })],
    "a",
    () => true,
  );
  const newTopic = update({ title: "另一项研究" });
  await assert.rejects(
    tracker.apply(
      "b:1",
      b,
      [newTopic, update({ id: record.id, content: "B: accuracy measured" })],
      "b",
      () => true,
    ),
    /Research memory changed/,
  );
  assert.equal(
    (await memory.list()).length,
    1,
    "Do not partially apply a batch with a known conflict",
  );
  assert.equal((await journal.read("research")).applied.includes("b:1"), false);
  const merged = update({
    id: record.id,
    content: "A: latency measured; B: accuracy measured",
  });
  const fresh = await tracker.snapshot(request, "b");
  await tracker.apply("b:1", fresh, [newTopic, merged], "b", () => true);
  assert.match(
    memory.get(record.id).content,
    /A: latency measured; B: accuracy measured/,
  );
  assert.deepEqual(memory.get(record.id).sourceRefs, [
    "task:seed",
    "task:a",
    "task:b",
  ]);
  assert.deepEqual(
    await tracker.apply("b:1", fresh, [newTopic, merged], "b", () => true),
    [],
  );
  assert.equal((await memory.list()).length, 2);
});

test("concurrent creation of the same research topic requires a merge instead of dropping one task", async () => {
  const { memory, tracker, journal } = setup();
  const a = await tracker.snapshot(request, "a");
  const b = await tracker.snapshot(request, "b");
  await tracker.apply("a:1", a, [update()], "a", () => true);
  await assert.rejects(
    tracker.apply(
      "b:1",
      b,
      [update({ content: "B: accuracy measured" })],
      "b",
      () => true,
    ),
    /Research memory changed/,
  );
  assert.equal((await journal.read("research")).applied.includes("b:1"), false);
  const fresh = await tracker.snapshot(request, "b");
  await tracker.apply(
    "b:1",
    fresh,
    [
      update({
        id: fresh.records[0].id,
        content: `${fresh.records[0].content}\nB: accuracy measured`,
      }),
    ],
    "b",
    () => true,
  );
  assert.equal((await memory.list()).length, 1);
  assert.deepEqual((await memory.list())[0].sourceRefs, ["task:a", "task:b"]);
});

test("manual corrections, forget and a new turn fence late maintenance", async () => {
  const { memory, tracker } = setup();
  await tracker.apply(
    "a:1",
    await tracker.snapshot(request, "a"),
    [update()],
    "a",
    () => true,
  );
  const record = (await memory.list())[0];
  const stale = await tracker.snapshot(request, "a");
  await tracker.correct(record.id, "人工纠正：仅研究短期检索", record.content);
  await tracker.apply(
    "a:2",
    stale,
    [update({ id: record.id })],
    "a",
    () => true,
  );
  assert.equal(memory.get(record.id).content, "人工纠正：仅研究短期检索");
  assert.equal(memory.get(record.id).protection, "user");
  await tracker.forget(record.id);
  assert.equal(await tracker.ignoresArchive("a"), true);
  assert.equal(await tracker.ignoresArchive("unrelated"), false);
  assert.equal(
    await tracker.maintainArchive("a", async () => {
      assert.fail("Forgotten memory must not be distilled from its old task");
    }),
    false,
  );
  await tracker.apply(
    "a:3",
    await tracker.snapshot(request, "a"),
    [update()],
    "a",
    () => true,
  );
  assert.equal((await memory.list()).length, 0);
  await tracker.apply(
    "a:4",
    await tracker.snapshot(request, "a"),
    [update({ title: "Another topic" })],
    "a",
    () => false,
  );
  assert.equal((await memory.list()).length, 0);
});

test("forget fences archive maintenance that was prepared before the decision", async () => {
  const { memory, tracker } = setup();
  await tracker.apply(
    "a:1",
    await tracker.snapshot(request, "a"),
    [update()],
    "a",
    () => true,
  );
  const record = (await memory.list())[0];
  assert.equal(await tracker.ignoresArchive("a"), false);
  // The model may already have produced ordinary memory ops when the user forgets.
  const ops = [{ op: "add", title: "Archive summary", content: "Prior topic" }];
  await tracker.forget(record.id);
  const applied = await tracker.maintainArchive("a", async () => {
    await memory.applyOrdinaryOps(ops, "a", "archive-batch");
  });
  assert.equal(applied, false);
  assert.equal((await memory.list()).length, 0);
});

test("active research survives idle maintenance and archive distillation cannot overwrite it", async () => {
  let now = 1;
  const { memory, tracker } = setup({ now: () => now });
  await tracker.apply(
    "a:1",
    await tracker.snapshot(request, "a"),
    [update()],
    "a",
    () => true,
  );
  const record = (await memory.list())[0];
  now += 100 * 86400000;
  await memory.maintain();
  assert.ok(memory.get(record.id));
  await memory.applyOrdinaryOps(
    [{ op: "delete", id: record.id }],
    "archive",
    "batch",
  );
  assert.ok(memory.get(record.id));
});

test("explicit preferences are recalled in a new task while current instructions retain priority", async () => {
  const { memory, tracker } = setup();
  const user = "以后请用中文回答，引用论文时请提供原文页码。";
  const snapshot = await tracker.snapshot(user, "preference-source");
  const updates = parseResearchUpdates(
    JSON.stringify([
      {
        type: "preference",
        title: "回答与引用偏好",
        content: "使用中文回答；论文引用提供原文页码。",
        evidence: user,
        status: "active",
      },
    ]),
    user,
    snapshot,
  );
  await tracker.apply(
    "preference-source:1",
    snapshot,
    updates,
    "preference-source",
    () => true,
  );
  const host = Object.create(AgentHost.prototype);
  host.memory = memory;
  const hints = await host.memoryContextHints(
    "A completely different research topic",
  );
  assert.match(hints, /使用中文回答/);
  assert.match(hints, /current user instructions take precedence/);
});

test("a lost creation receipt recovers the same research memory after restart", async () => {
  class LostFs extends InMemoryFileSystem {
    fail = true;
    async writeFile(path, content) {
      await super.writeFile(path, content);
      if (this.fail && path.includes("/memories/")) {
        this.fail = false;
        throw new Error("lost receipt");
      }
    }
  }
  const fs = new LostFs();
  const { tracker, journal } = setup({ fs });
  const snapshot = await tracker.snapshot(request, "a");
  await assert.rejects(
    tracker.apply("a:1", snapshot, [update()], "a", () => true),
    /lost receipt/,
  );
  const memory = new MemoryEngine({ fs, root: "/memory" });
  const restarted = new ResearchMemory(memory, journal, digest);
  await restarted.apply("a:1", snapshot, [update()], "a", () => true);
  assert.equal((await memory.list()).length, 1);
});

test("host tracking consumes bounded allowance and resumes prepared results without another model call", async () => {
  const { memory, tracker } = setup();
  const host = Object.create(AgentHost.prototype);
  let calls = 0;
  const events = [];
  Object.assign(host, {
    memoryConsent: () => "review",
    memory,
    researchMemory: () => tracker,
    auxiliaryAdapter: () => ({
      complete: async ({ onAttempt }) => {
        await onAttempt();
        calls++;
        return { text: JSON.stringify([update()]) };
      },
    }),
    persistNow: async () => {},
    emitSessionEvent(_state, _turn, type, payload) {
      events.push({ type, payload });
    },
  });
  const state = {
    record: {
      id: "a",
      run: { id: "run" },
      maintenanceBudget: { turnId: "turn", attempts: 0 },
    },
  };
  const job = {
    runId: "run",
    turnId: "turn",
    userText: request,
    assistantText: "下一步设计对照实验。",
    pending: ["memory"],
    researchTracking: true,
  };
  await host.trackResearchMemory(state, job, () => true);
  assert.equal(calls, 1);
  assert.equal(state.record.maintenanceBudget.attempts, 1);
  await host.trackResearchMemory(state, job, () => true);
  assert.equal(calls, 1);
  assert.equal((await memory.list()).length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "memory_updated");
  assert.equal(events[0].payload.op, "add");
  assert.equal(events[0].payload.total, 1);
  host.memoryConsent = () => "off";
  await host.trackResearchMemory(
    state,
    { ...job, researchUpdates: undefined },
    () => true,
  );
  assert.equal(calls, 1);
});

test("a rebased partial batch can reorder new topics without reusing another topic's identity", async () => {
  class PartialFs extends InMemoryFileSystem {
    remaining = Infinity;
    async writeFile(path, content) {
      if (path.includes("/memories/") && --this.remaining === 0) {
        this.remaining = Infinity;
        throw new Error("interrupted batch");
      }
      await super.writeFile(path, content);
    }
  }
  const fs = new PartialFs();
  const { tracker, journal } = setup({ fs });
  await tracker.apply(
    "seed",
    await tracker.snapshot(request, "seed"),
    [update()],
    "seed",
    () => true,
  );
  const snapshot = await tracker.snapshot(request, "b");
  const id = snapshot.records[0].id;
  const first = update({ title: "First additional topic" });
  const last = update({ title: "Last additional topic" });
  const original = [
    first,
    update({ id, content: "B: accuracy measured" }),
    last,
  ];
  fs.remaining = 2;
  await assert.rejects(
    tracker.apply("b:1", snapshot, original, "b", () => true),
    /interrupted batch/,
  );
  await tracker.apply(
    "a:1",
    snapshot,
    [update({ id, content: "A: latency measured" })],
    "a",
    () => true,
  );
  const restartedMemory = new MemoryEngine({ fs, root: "/memory" });
  const restarted = new ResearchMemory(restartedMemory, journal, digest);
  await assert.rejects(
    restarted.apply("b:1", snapshot, original, "b", () => true),
    /Research memory changed/,
  );
  // A fresh extraction omits the already-saved first topic and moves the last
  // one into its position. Array positions are not durable creation identities.
  await restarted.apply(
    "b:1",
    await restarted.snapshot(request, "b"),
    [
      last,
      update({ id, content: "A: latency measured; B: accuracy measured" }),
    ],
    "b",
    () => true,
  );
  const records = await restartedMemory.list();
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map((record) => record.id)).size, 3);
  assert.ok(records.some((record) => record.title === first.title));
  assert.ok(records.some((record) => record.title === last.title));
  assert.match(
    restartedMemory.get(id).content,
    /A: latency measured; B: accuracy measured/,
  );
});

function trackingHost(memory, tracker, states, complete) {
  const host = Object.create(AgentHost.prototype);
  Object.assign(host, {
    memory,
    sessions: new Map(states.map((state) => [state.record.id, state])),
    postProcessingRuns: new Set(),
    memoryConsent: () => "review",
    researchMemory: () => tracker,
    auxiliaryAdapter: (state) => ({
      complete: async ({ onAttempt, messages }) => {
        await onAttempt();
        return {
          text: JSON.stringify(
            await complete(state, JSON.parse(messages[1].content)),
          ),
        };
      },
    }),
    persistNow: async () => {},
    emitSessionEvent: () => {},
  });
  return host;
}

function trackingState(id, job = {}) {
  return {
    activeTurnId: null,
    record: {
      id,
      run: { id: `run-${id}` },
      maintenanceBudget: { turnId: "turn", attempts: 0 },
      postProcessing: [
        {
          runId: `run-${id}`,
          turnId: "turn",
          userText: request,
          assistantText: "Research progress",
          pending: ["memory"],
          researchTracking: true,
          ...job,
        },
      ],
    },
  };
}

test("host rebases overlapping research completions within its existing model allowance", async () => {
  const { memory, tracker } = setup();
  await tracker.apply(
    "seed",
    await tracker.snapshot(request, "seed"),
    [update()],
    "seed",
    () => true,
  );
  const states = [trackingState("a"), trackingState("b")];
  let announceB, releaseB;
  const bStarted = new Promise((resolve) => {
    announceB = resolve;
  });
  const bResponse = new Promise((resolve) => {
    releaseB = resolve;
  });
  const calls = { a: 0, b: 0 };
  const host = trackingHost(memory, tracker, states, async (state, input) => {
    const id = state.record.id;
    calls[id]++;
    if (id === "b" && calls.b === 1) {
      announceB();
      await bResponse;
    }
    if (id === "b" && calls.b === 2)
      assert.match(input.existing[0].content, /A: latency measured/);
    return [
      update({
        id: input.existing[0].id,
        content: `${input.existing[0].content}\n${id === "a" ? "A: latency measured" : "B: accuracy measured"}`,
      }),
    ];
  });
  const bRun = host.retryPostProcessing("b");
  await bStarted;
  await host.retryPostProcessing("a");
  releaseB();
  await bRun;
  assert.deepEqual(calls, { a: 1, b: 2 });
  const record = (await memory.list())[0];
  assert.match(record.content, /A: latency measured/);
  assert.match(record.content, /B: accuracy measured/);
  assert.deepEqual(record.sourceRefs, ["task:seed", "task:a", "task:b"]);
  assert.deepEqual(
    states.map((state) => state.record.postProcessing),
    [[], []],
  );
  assert.equal(states[1].record.maintenanceBudget.attempts, 2);
});

test("an exhausted conflict remains pending across retries instead of claiming successful maintenance", async () => {
  const { memory, tracker, journal } = setup();
  await tracker.apply(
    "seed",
    await tracker.snapshot(request, "seed"),
    [update()],
    "seed",
    () => true,
  );
  const snapshot = await tracker.snapshot(request, "b");
  const id = snapshot.records[0].id;
  await tracker.apply(
    "a:1",
    snapshot,
    [update({ id, content: "A: latency measured" })],
    "a",
    () => true,
  );
  const state = trackingState("b", {
    researchSnapshot: snapshot,
    researchUpdates: [update({ id, content: "B: accuracy measured" })],
    researchAttempts: 2,
  });
  state.record.maintenanceBudget.attempts = 2;
  const host = trackingHost(memory, tracker, [state], async () =>
    assert.fail("No remaining model allowance"),
  );
  await host.retryPostProcessing("b");
  await host.retryPostProcessing("b");
  assert.equal(state.record.postProcessing.length, 1);
  assert.deepEqual(state.record.postProcessing[0].pending, ["memory"]);
  assert.match(state.record.postProcessing[0].error, /allowance/);
  assert.equal(
    (await journal.read("research")).applied.includes("b:turn"),
    false,
  );
  assert.match(memory.get(id).content, /A: latency measured/);
  assert.doesNotMatch(memory.get(id).content, /B: accuracy measured/);
});

test("an invalid rebase keeps the original prepared snapshot paired with its result for retry", async () => {
  const { memory, tracker } = setup();
  await tracker.apply(
    "seed",
    await tracker.snapshot(request, "seed"),
    [update()],
    "seed",
    () => true,
  );
  const snapshot = await tracker.snapshot(request, "b");
  const id = snapshot.records[0].id;
  await tracker.apply(
    "a:1",
    snapshot,
    [update({ id, content: "A: latency measured" })],
    "a",
    () => true,
  );
  const prepared = [update({ id, content: "B: accuracy measured" })];
  const state = trackingState("b", {
    researchSnapshot: snapshot,
    researchUpdates: prepared,
  });
  let calls = 0;
  const host = trackingHost(memory, tracker, [state], async (_state, input) => {
    calls++;
    assert.match(input.existing[0].content, /A: latency measured/);
    return calls === 1
      ? [{}]
      : [
          update({
            id,
            content: `${input.existing[0].content}\nB: accuracy measured`,
          }),
        ];
  });
  await host.retryPostProcessing("b");
  assert.equal(state.record.postProcessing[0].researchSnapshot, snapshot);
  assert.equal(state.record.postProcessing[0].researchUpdates, prepared);
  assert.deepEqual(state.record.postProcessing[0].pending, ["memory"]);
  assert.match(state.record.postProcessing[0].error, /grounded user evidence/);
  await host.retryPostProcessing("b");
  assert.equal(calls, 2);
  assert.deepEqual(state.record.postProcessing, []);
  assert.match(memory.get(id).content, /A: latency measured/);
  assert.match(memory.get(id).content, /B: accuracy measured/);
});

test("old knowledge writeback RPCs cannot create a duplicate destination", async () => {
  const host = Object.create(AgentHost.prototype);
  for (const method of [
    "artifact/writebackPreview",
    "artifact/writebackCommit",
  ])
    await assert.rejects(
      host.rpc(method, { target: "knowledge_base" }),
      /Zotero note/,
    );
  await assert.rejects(
    host.rpc("knowledge/create", { title: "Duplicate" }),
    /index/,
  );
});
