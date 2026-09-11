import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { createHash } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import {
  InMemoryFileSystem,
  MemoryEngine,
  KnowledgeBaseService,
} from "@confucius/memory";
import { MemoryApprovals } from "../src/modules/host/MemoryApprovals.ts";
import { ArtifactStore } from "../src/modules/host/ArtifactStore.ts";
import { ArtifactToolProvider } from "../src/modules/host/ArtifactToolProvider.ts";
import {
  createTaskBranchSnapshot,
  forkBranchArtifacts,
} from "../src/modules/host/TaskBranch.ts";
import {
  AgentHost,
  resolvePresetSources,
} from "../src/modules/host/AgentHost.ts";
import {
  presetWorkflow,
  presetToolCallInScope,
} from "../src/modules/host/PresetWorkflow.ts";
import { ZoteroToolHost } from "../src/modules/tools/ZoteroToolHost.ts";
import { ConfuciusMemoryToolProvider } from "../src/modules/host/MemoryTools.ts";
import { ToolExecutionService } from "../src/modules/host/ReliableToolProvider.ts";
import { memoryJsonStorage } from "../src/modules/host/RuntimeStorage.ts";
import { reconcileKnowledgeWrite } from "../src/modules/host/KnowledgeOperations.ts";
import { artifactWritebackFor } from "../src/modules/host/ArtifactWriteback.ts";
import { McpToolProvider } from "../src/modules/host/McpToolProvider.ts";

const digest = async (text) => createHash("sha256").update(text).digest("hex");
const sources = { version: 1, capturedAt: 1, fingerprint: "source", items: [] };
function artifacts() {
  const fs = new InMemoryFileSystem();
  let sequence = 0;
  return new ArtifactStore(
    "/artifacts",
    {
      read: (path) => fs.readFile(path),
      writeAtomic: (path, text) => fs.writeFile(path, text),
      exists: async (path) => Object.hasOwn(fs.snapshot(), path),
      makeDirectory: async () => {},
    },
    () => 1,
    () => `art_${++sequence}`,
  );
}
beforeEach(() => {
  globalThis.ztoolkit = { log() {} };
  globalThis.PathUtils = {
    localProfileDir: "/isolated-test",
    join: (...paths) => paths.join("/"),
  };
  globalThis.Zotero = {
    Prefs: { get: () => undefined },
    getMainWindow: () => ({ setTimeout, clearTimeout }),
    Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user" }) },
  };
});

test("all 120 collection and saved-search members can be enumerated and read within the preset", async () => {
  const items = Array.from({ length: 120 }, (_, i) => ({
    id: i + 1,
    libraryID: 1,
    key: `K${String(i + 1).padStart(7, "0")}`,
    getField: () => "",
    getDisplayTitle: () => `Paper ${i + 1}`,
    getCreators: () => [],
    getAttachments: () => [],
    itemType: "journalArticle",
  }));
  globalThis.Zotero.Collections = {
    getByLibraryAndKey: () => ({
      name: "120 papers",
      getChildItems: () => items,
    }),
  };
  globalThis.Zotero.Searches = {
    getByLibraryAndKey: () => ({
      search: async () => items.map((item) => item.id),
    }),
  };
  globalThis.Zotero.Items = {
    get: (id) => items[id - 1],
    getAsync: async (ids) => ids.map((id) => items[id - 1]),
  };
  const host = Object.create(ZoteroToolHost.prototype);
  for (const [method, kind, key] of [
    ["getCollectionItems", "collection", "COLLECT1"],
    ["runSavedSearch", "savedSearch", "SEARCH01"],
  ]) {
    const resolved = await resolvePresetSources(
      { ...sources, [kind]: { libraryID: 1, key } },
      presetWorkflow("synthesis"),
    );
    const found = [];
    let offset = 0;
    do {
      const page = await host[method]({ libraryID: 1, key, limit: 50, offset });
      assert.equal(page.data.total, 120);
      found.push(...page.data.items);
      offset = page.data.nextOffset;
    } while (offset !== null);
    assert.equal(new Set(found.map((item) => item.key)).size, 120);
    for (const item of found)
      assert.equal(
        presetToolCallInScope(resolved.scope, "get_item", item),
        true,
      );
    assert.equal(
      presetToolCallInScope(resolved.scope, "get_item", {
        libraryID: 1,
        key: "OUTSIDE",
      }),
      false,
    );
    assert.match(resolved.inventory, /Resolved 120 items/);
    assert.doesNotMatch(resolved.inventory, /Paper 120/);
  }
});

test("manual protection can be toggled repeatedly; stable source receipts remain idempotent", async () => {
  const memory = new MemoryEngine({
    fs: new InMemoryFileSystem(),
    root: "/memory",
  });
  const record = await memory.save({
    content: "Constraint",
    protection: "none",
  });
  const service = new MemoryApprovals({
    memory,
    proposals: new Map(),
    digest,
    persist: async () => {},
  });
  for (const protection of ["user", "none", "user"]) {
    const op = {
      op: "update",
      id: record.id,
      content: record.content,
      title: record.title,
      protection,
    };
    const context = { taskId: "manual", source: "manual-protection" };
    const proposal = await service.propose(op, context);
    assert.equal(proposal.created, true);
    assert.equal((await service.propose(op, context)).created, false);
    await service.resolve(proposal.proposal.id, "accept", () => op);
    assert.equal(memory.get(record.id).protection, protection);
  }
  const op = {
    op: "update",
    id: record.id,
    content: record.content,
    title: record.title,
    protection: "none",
  };
  const context = {
    taskId: "manual",
    source: "context-tool",
    sourceId: "operation-1",
  };
  const proposal = await service.propose(op, context);
  await service.resolve(proposal.proposal.id, "reject", () => op);
  assert.equal((await service.propose(op, context)).created, false);
  const manual = { taskId: "manual", source: "manual-protection" };
  const rejected = await service.propose(op, manual);
  await service.resolve(rejected.proposal.id, "reject", () => op);
  assert.equal((await service.propose(op, manual)).created, true);
});

test("branch artifacts use the selected revision and independent read/edit/writeback ownership", async () => {
  const store = artifacts();
  const original = await store.upsert(
    {
      taskId: "source",
      kind: "report",
      title: "Old title",
      body: { type: "markdown", markdown: "At branch point" },
    },
    "native",
  );
  original.writeback = {
    state: "committed",
    target: "zotero_note",
    targetRef: "1:NOTE0001",
  };
  await store.save(original);
  const event = (type, payload) => ({
    id: type,
    sessionId: "source",
    turnId: "turn",
    type,
    payload,
    ts: 1,
  });
  const snapshot = createTaskBranchSnapshot(
    [
      event("turn_started", { userText: "Report" }),
      event("artifact_upserted", { artifact: original }),
      event("turn_completed", {}),
    ],
    "turn",
    "branch",
    () => "event",
  );
  await store.upsert(
    {
      ...original,
      title: "Later title",
      body: { type: "markdown", markdown: "Later source edit" },
    },
    "native",
  );
  await forkBranchArtifacts(snapshot, store, "branch");
  const branch = (await store.list(snapshot.artifactIds))[0];
  assert.notEqual(branch.id, original.id);
  assert.equal(branch.title, "Old title");
  assert.equal(branch.body.markdown, "At branch point");
  assert.equal(branch.writeback, undefined);
  assert.equal(branch.writebacks, undefined);
  const provider = new ArtifactToolProvider(
    store,
    "branch",
    "native",
    [],
    () => {},
  );
  assert.equal(
    (await provider.call("artifact_read", { id: branch.id })).ok,
    true,
  );
  assert.equal(
    (await provider.call("artifact_read", { id: original.id })).ok,
    false,
  );
  await store.upsert(
    { ...branch, body: { type: "markdown", markdown: "Branch edit" } },
    "native",
  );
  assert.equal(
    (await store.get(original.id)).body.markdown,
    "Later source edit",
  );
  assert.equal(
    snapshot.events.find((entry) => entry.type === "artifact_upserted").payload
      .artifact.taskId,
    "branch",
  );
  assert.equal(
    await forkBranchArtifacts(snapshot, store, "branch", true),
    false,
  );
});

test("artifact knowledge writeback recovers a lost receipt and reuses each destination entry", async () => {
  class LostReceiptFs extends InMemoryFileSystem {
    fail = false;
    async writeFile(path, content) {
      await super.writeFile(path, content);
      if (this.fail && path.includes("/memories/")) {
        this.fail = false;
        throw new Error("lost receipt");
      }
    }
  }
  const fs = new LostReceiptFs();
  const memory = new MemoryEngine({ fs, root: "/memory" });
  const knowledge = new KnowledgeBaseService(memory);
  const base = await knowledge.create({ title: "Topic" });
  const second = await knowledge.create({ title: "Second topic" });
  const store = artifacts();
  const artifact = await store.upsert(
    {
      taskId: "task",
      kind: "report",
      title: "Report",
      body: { type: "markdown", markdown: "Evidence" },
    },
    "native",
  );
  const execution = new ToolExecutionService(memoryJsonStorage());
  execution.registerDomain("memory", {
    reconcile: (_intent, operation) =>
      reconcileKnowledgeWrite(memory, operation),
  });
  const host = Object.create(AgentHost.prototype);
  const state = {
    record: { id: "task", backend: "native", lockedContext: sources },
    abort: null,
  };
  Object.assign(host, {
    memory,
    knowledge,
    artifacts: store,
    execution,
    sessions: new Map([["task", state]]),
    preparedWritebacks: new Map(),
    writebackSnapshots: new Map(),
    emitSessionEvent() {},
    persistNow: async () => {},
  });
  let sequence = 0;
  const commit = async (knowledgeBaseId, fail = false) => {
    const operationId = `knowledge-${++sequence}`;
    const pending = await store.update(artifact.id, (current) => ({
      ...current,
      writeback: {
        state: "pending",
        target: "knowledge_base",
        revision: current.revision,
        targetRef: artifactWritebackFor(
          current,
          "knowledge_base",
          knowledgeBaseId,
        )?.targetRef,
        operationId: `task:writeback:${operationId}`,
      },
    }));
    fs.fail = fail;
    try {
      await host.performArtifactWriteback(
        pending,
        pending.revision,
        "knowledge_base",
        { knowledgeBaseId, operationId },
        "writeback",
      );
    } catch (error) {
      assert.equal(fail, true);
      await host.markArtifactWritebackFailed(
        pending,
        pending.revision,
        "knowledge_base",
        error,
        "writeback",
      );
      assert.equal((await store.get(artifact.id)).writeback.state, "unknown");
      await host.artifactWritebackPreview({
        id: artifact.id,
        target: "knowledge_base",
        knowledgeBaseId,
      });
      assert.equal((await store.get(artifact.id)).writeback.state, "committed");
    }
  };
  await commit(base.id, true);
  const entryId = (await knowledge.get(base.id)).entries[0].id;
  await commit(second.id);
  await store.upsert(
    { ...artifact, body: { type: "markdown", markdown: "Revised evidence" } },
    "native",
  );
  await commit(base.id);
  const entries = (await knowledge.get(base.id)).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, entryId);
  assert.match(entries[0].content, /Revised evidence/);
  assert.equal((await knowledge.get(second.id)).entries.length, 1);
});

test("lost knowledge creation and update receipts reconcile after restart without blocking another task", async () => {
  class LostReceiptFs extends InMemoryFileSystem {
    fail = false;
    async writeFile(path, content) {
      await super.writeFile(path, content);
      if (this.fail && path.includes("/memories/")) {
        this.fail = false;
        throw new Error("lost receipt");
      }
    }
  }
  const fs = new LostReceiptFs();
  const journal = memoryJsonStorage();
  let memory = new MemoryEngine({ fs, root: "/memory" });
  const service = () => {
    const execution = new ToolExecutionService(journal);
    execution.registerDomain("memory", {
      reconcile: (_intent, operation) =>
        reconcileKnowledgeWrite(memory, operation),
    });
    return execution;
  };
  await memory.ensureLoaded();
  let sequence = 0;
  const lose = async (name, args) => {
    fs.fail = true;
    const operationId = `op-${++sequence}`;
    const first = await service()
      .wrap(new ConfuciusMemoryToolProvider(memory), {
        taskId: "first",
        operationId,
      })
      .call(name, args);
    assert.equal(first.effect, "unknown");
    memory = new MemoryEngine({ fs, root: "/memory" });
    const execution = service();
    const next = await execution
      .wrap(new ConfuciusMemoryToolProvider(memory), {
        taskId: "other",
        operationId: `next-${sequence}`,
      })
      .call("knowledge_base_create", { title: `Other topic ${sequence}` });
    assert.equal(next.ok, true, next.message);
    const replay = await execution
      .wrap(new ConfuciusMemoryToolProvider(memory), {
        taskId: "first",
        operationId,
      })
      .call(name, args);
    assert.equal(replay.ok, true, replay.message);
    return replay.data;
  };
  const created = await lose("knowledge_base_create", { title: "Topic A" });
  const baseId = created.knowledgeBase.id;
  await lose("knowledge_base_update", {
    id: baseId,
    description: "Updated description",
  });
  const saved = await lose("knowledge_base_save_entry", {
    knowledgeBaseId: baseId,
    kind: "insight",
    title: "Entry",
    content: "Evidence",
  });
  await lose("knowledge_base_save_entry", {
    id: saved.entry.id,
    knowledgeBaseId: baseId,
    kind: "insight",
    title: "Entry",
    content: "Revised evidence",
  });
  const base = await new KnowledgeBaseService(memory).get(baseId);
  assert.equal(base.entries.length, 1);
  assert.equal(base.entries[0].content, "Revised evidence");
});

test("memory reads preserve external edits and deletions while persisting usage separately", async () => {
  const fs = new InMemoryFileSystem();
  const memory = new MemoryEngine({ fs, root: "/memory" });
  const record = await memory.save({ content: "OLD CONTENT", title: "Memory" });
  const path = `/memory/memories/${record.id}.md`;
  await fs.writeFile(
    path,
    (await fs.readFile(path)).replace("OLD CONTENT", "NEW CONTENT"),
  );
  const edited = await fs.readFile(path);
  assert.equal((await memory.read(record.id)).content, "NEW CONTENT");
  assert.equal(await fs.readFile(path), edited);
  const restarted = new MemoryEngine({ fs, root: "/memory" });
  assert.equal((await restarted.read(record.id)).accessCount, 2);
  await fs.deleteFile(path);
  assert.equal(await memory.read(record.id), undefined);
  assert.equal(Object.hasOwn(fs.snapshot(), path), false);
});

test("writing to notes and multiple knowledge bases preserves independent associations after edits", async () => {
  const store = artifacts();
  const artifact = await store.upsert(
    {
      taskId: "task",
      kind: "report",
      title: "Report",
      body: { type: "markdown", markdown: "First version" },
    },
    "native",
  );
  for (const [target, targetRef] of [
    ["zotero_note", "1:NOTE0001"],
    ["knowledge_base", "base:entry"],
    ["knowledge_base", "second:entry2"],
  ])
    await store.update(artifact.id, (current) => ({
      ...current,
      writeback: { state: "committed", target, targetRef, revision: 1 },
    }));
  const revised = await store.upsert(
    { ...artifact, body: { type: "markdown", markdown: "Revised" } },
    "native",
  );
  assert.equal(
    artifactWritebackFor(revised, "knowledge_base", "base").targetRef,
    "base:entry",
  );
  assert.equal(
    artifactWritebackFor(revised, "knowledge_base", "second").targetRef,
    "second:entry2",
  );
  assert.equal(
    artifactWritebackFor(revised, "knowledge_base", "new"),
    undefined,
  );
  const state = {
    record: {
      id: "task",
      backend: "native",
      lockedContext: { ...sources, items: [{ libraryID: 1, key: "PAPER001" }] },
    },
  };
  const host = Object.create(AgentHost.prototype);
  let prepared;
  Object.assign(host, {
    artifacts: store,
    sessions: new Map([["task", state]]),
    preparedWritebacks: new Map(),
    writebackSnapshots: new Map(),
    toolContext: () => ({}),
    execution: {
      wrap: () => ({
        prepare: async (name, args, context) => {
          prepared = { name, args, operationId: context.operationId };
          return null;
        },
      }),
    },
    writebackBefore: async () => "",
  });
  await host.artifactWritebackPreview({
    id: artifact.id,
    target: "zotero_note",
    revision: 2,
  });
  assert.equal(prepared.name, "update_note");
  assert.equal(prepared.args.key, "NOTE0001");
  const unwritten = await store.upsert(
    {
      taskId: "task",
      kind: "report",
      title: "New report",
      body: { type: "markdown", markdown: "Evidence" },
    },
    "native",
  );
  const params = { id: unwritten.id, target: "zotero_note", revision: 1 };
  await host.artifactWritebackPreview(params);
  const creationId = prepared.operationId;
  assert.equal(prepared.name, "create_note");
  await store.update(unwritten.id, (current) => ({
    ...current,
    writeback: {
      state: "committed",
      target: "zotero_note",
      targetRef: "1:NOTE0002",
      revision: 1,
    },
  }));
  await store.update(unwritten.id, (current) => ({
    ...current,
    writeback: {
      state: "committed",
      target: "knowledge_base",
      targetRef: "base:other",
      revision: 1,
    },
  }));
  await host.artifactWritebackPreview(params);
  assert.equal(prepared.name, "update_note");
  assert.notEqual(prepared.operationId, creationId);
  const updateId = prepared.operationId;
  await host.artifactWritebackPreview(params);
  assert.equal(prepared.operationId, updateId);
});

test("reloading optional MCP servers cancels stale discovery and keeps the latest configuration", async () => {
  const originalConnect = McpToolProvider.connect;
  const pending = [];
  McpToolProvider.connect = async (config, signal) =>
    new Promise((resolve) => pending.push({ config, signal, resolve }));
  let config = [
    { id: "old", url: "http://old.test" },
    { id: "other", url: "http://other.test" },
  ];
  globalThis.Zotero.Prefs.get = () => JSON.stringify(config);
  const host = Object.create(AgentHost.prototype);
  try {
    const old = host.reloadMcp();
    assert.equal(pending.length, 2);
    config = [{ id: "new", url: "http://new.test" }];
    const fresh = host.reloadMcp();
    assert.equal(pending[0].signal.aborted, true);
    pending[2].resolve({ id: "new" });
    await fresh;
    pending[0].resolve({ id: "old" });
    pending[1].resolve({ id: "other" });
    await old;
    assert.deepEqual(host.mcpProviders, [{ id: "new" }]);
  } finally {
    McpToolProvider.connect = originalConnect;
  }
});
