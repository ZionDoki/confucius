import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { BtwManager } from "../src/modules/host/BtwManager.ts";
import { BtwStore } from "../src/modules/host/BtwStore.ts";
import { BtwContextTools } from "../src/modules/host/BtwContext.ts";
import {
  executeNativeBtw,
  executeExternalBtw,
} from "../src/modules/host/BtwExecution.ts";
import { InMemoryFileSystem, HistoryStore } from "@confucius/memory";
import { ScriptedModel } from "@confucius/harness";
import {
  emptyLockedContext,
  validateBtwSelection,
  btwSourceKey,
} from "@confucius/protocol";
import { createHarness } from "../../../packages/harness/src/test-kit.ts";

const selection = (taskId = "main") => ({
  source: { kind: "conversation", taskId, messageId: "turn_1" },
  text: "The selected passage",
  surroundingText: "Before. The selected passage. After.",
  capturedAt: 1000,
});
const pdf = (key = "PAPER001", libraryID = 1) => ({
  ...selection(),
  source: {
    kind: "pdf",
    libraryID,
    parentKey: key,
    attachmentKey: "PDF00001",
    title: "Paper",
    pageIndex: 2,
    pageLabel: "3",
  },
});
const report = (taskId = "main", revision = 1) => ({
  ...selection(taskId),
  source: { kind: "report", taskId, artifactId: "report1", revision },
});
const task = (id = "main", backend = "native") => ({
  id,
  backend,
  title: id,
  updatedAt: 100,
  createdAt: 1,
  status: "running",
  lockedContext: emptyLockedContext(),
  artifactIds: [],
  runtimeModel:
    backend === "native"
      ? undefined
      : { modelId: "selected-model", reasoningEffort: "low" },
});
const event = (type, turnId, payload, sessionId = "main") => ({
  type,
  turnId,
  payload,
  sessionId,
  id: `${type}_${turnId}`,
  ts: 100,
});

function setup(overrides = {}) {
  const fs = overrides.fs ?? new InMemoryFileSystem();
  const store = new BtwStore(fs, () => "/btw");
  const history = new HistoryStore(fs, "/history");
  const parent = task();
  const runs = [],
    completions = [];
  let serial = 0;
  const options = {
    store,
    history,
    library: createHarness({}).tools,
    resolve: async (chosen) => ({
      selection: chosen,
      sources: emptyLockedContext(),
      tasks: [{ record: parent, events: [] }],
      report:
        chosen.source.kind === "report"
          ? {
              id: "report1",
              revision: chosen.source.revision,
              text: `Report version ${chosen.source.revision}`,
            }
          : undefined,
    }),
    taskExists: () => true,
    autoCleanup: () => false,
    config: () => ({
      capacity: 32768,
      maxOutput: 4096,
      maxIterations: 8,
      maxToolCalls: 12,
    }),
    execute: (run) => {
      runs.push(run);
      return new Promise((resolve) => completions.push(resolve));
    },
    stop: async (run) => {
      completions[runs.indexOf(run)]?.({ text: run.turn.answer });
    },
    now: () => 1_000_000,
    id: () => `serial_${++serial}`,
    ...overrides,
  };
  const manager = new BtwManager(options);
  return { manager, fs, store, history, parent, options, runs, completions };
}
async function settled(manager, id) {
  for (let i = 0; i < 100; i++) {
    const view = manager.view(id);
    if (!view.record.turns.some((t) => t.status === "running")) return view;
    await setImmediate();
  }
  assert.fail("Btw did not settle");
}
async function submit(manager, chosen = selection(), requestId = "req1") {
  const { record } = await manager.open(chosen);
  return manager.prompt({
    btwId: record.id,
    requestId,
    text: "Explain this",
    selection: chosen,
  });
}

test("PDF article grouping, task report grouping, and library boundaries", async () => {
  assert.equal(btwSourceKey(report().source), btwSourceKey(selection().source));
  assert.notEqual(
    btwSourceKey(pdf().source),
    btwSourceKey(pdf("PAPER001", 2).source),
  );
  const { manager } = setup();
  const a = await manager.open(report());
  const b = await manager.open(selection());
  const c = await manager.open(selection("other"));
  assert.equal(a.record.id, b.record.id);
  assert.notEqual(a.record.id, c.record.id);
  const [x, y] = await Promise.all([manager.open(pdf()), manager.open(pdf())]);
  assert.equal(x.record.id, y.record.id);
  await manager.shutdown();
});

test("immutable quote, duplicate submission, draft and busy behavior are isolated", async () => {
  const { manager, parent, runs, completions, fs } = setup();
  const mainBefore = JSON.stringify(parent),
    chosen = selection();
  const { record } = await manager.open(chosen);
  const params = {
    btwId: record.id,
    requestId: "same",
    text: "Explain this",
    selection: chosen,
  };
  await manager.prompt(params);
  await manager.prompt(params);
  assert.equal(runs.length, 1);
  await assert.rejects(
    manager.prompt({ ...params, text: "Different" }),
    /different question/,
  );
  await assert.rejects(
    manager.prompt({ ...params, requestId: "second" }),
    /still running/,
  );
  chosen.text = "Navigation changed the selection";
  assert.equal(runs[0].turn.selection.text, "The selected passage");
  assert.notEqual(runs[0].task.id, parent.id);
  assert.equal(runs[0].task.externalSessionId, undefined);
  assert.equal(runs[0].task.capabilityProfile, "zotero_only");
  assert.equal(runs[0].task.templateId, undefined);
  await manager.draft(record.id, "next\nquestion");
  runs[0].event(
    event("text_delta", runs[0].turn.id, { text: "Partial answer" }),
  );
  completions[0]({ text: "Final answer" });
  const done = await settled(manager, record.id);
  assert.equal(done.record.turns[0].answer, "Final answer");
  assert.equal(done.record.draft, "next question");
  assert.equal(JSON.stringify(parent), mainBefore);
  assert.ok(
    Object.keys(fs.snapshot()).every((path) => path.startsWith("/btw/")),
  );
  await manager.shutdown();
});

test("independent sources execute concurrently and abort affects only one", async () => {
  const { manager, runs, completions } = setup();
  const a = await submit(manager),
    b = await submit(manager, selection("other"));
  assert.equal(runs.length, 2);
  await manager.abort(a.record.id);
  assert.equal(runs[0].abort.signal.aborted, true);
  assert.equal(runs[1].abort.signal.aborted, false);
  completions[1]({ text: "Other answer" });
  assert.equal(
    (await settled(manager, b.record.id)).record.turns[0].status,
    "completed",
  );
  await manager.shutdown();
});

test("reopening preserves background generation and persisted recovery never resends", async () => {
  const env = setup();
  const view = await submit(env.manager);
  env.runs[0].event(
    event("text_delta", env.runs[0].turn.id, { text: "Saved partial" }),
  );
  await env.runs[0].save();
  assert.equal(
    (await env.manager.open(report())).record.turns[0].status,
    "running",
  );
  assert.equal(env.runs.length, 1);
  const restored = setup({ fs: new InMemoryFileSystem(env.fs.snapshot()) });
  const recovery = await restored.manager.open(selection());
  assert.equal(recovery.record.turns[0].status, "interrupted");
  assert.equal(recovery.record.turns[0].answer, "Saved partial");
  assert.equal(restored.runs.length, 0);
  await env.manager.shutdown();
  await restored.manager.shutdown();
  assert.equal(view.record.turns[0].answer, ""); // RPC views do not expose mutable records.
});

test("scope and catalog deny arbitrary histories, global memory and writes", async () => {
  const env = setup();
  const { record } = await env.manager.open(report());
  const doc = await env.store.load(record.id);
  const resolved = await env.options.resolve(report());
  const tools = new BtwContextTools(
    resolved,
    doc,
    env.options.library,
    env.history,
    () => true,
  );
  for (const name of [
    "create_collection",
    "memory_search",
    "artifact_upsert",
    "open_item",
    "conversation_log_read",
  ]) {
    assert.equal(tools.getMeta(name), null);
    assert.equal((await tools.call(name, {})).code, "permission_denied");
  }
  assert.equal(
    (await tools.call("context_search", { taskId: "other", query: "x" })).ok,
    false,
  );
  assert.equal(
    (await tools.call("context_search", { scope: "all" })).ok,
    false,
  );
  assert.equal(
    (await tools.call("context_read", { ref: "h:other:window:item" })).ok,
    false,
  );
  assert.equal(
    (await tools.call("context_read", { ref: "a:report1:2" })).ok,
    false,
  );
  assert.equal(
    (await tools.call("context_read", { ref: "a:report1:1" })).data.content,
    "Report version 1",
  );
  await env.manager.shutdown();
});

test("Chinese queries retrieve relevant late passages and only completed main turns", async () => {
  const env = setup();
  const { record } = await env.manager.open(selection());
  const doc = await env.store.load(record.id);
  const answer =
    "Unrelated introduction. ".repeat(200) +
    "\n\n卷积网络能捕获局部空间结构，注意力用于全局依赖。";
  const resolved = {
    selection: selection(),
    sources: emptyLockedContext(),
    tasks: [
      {
        record: env.parent,
        events: [
          event("turn_started", "done", { userText: "方法比较" }),
          event("text_delta", "done", { text: answer }),
          event("turn_completed", "done", {}),
          event("turn_started", "running", { userText: "ongoing" }),
          event("text_delta", "running", { text: "Secret ongoing marker" }),
        ],
      },
    ],
  };
  const tools = new BtwContextTools(
    resolved,
    doc,
    env.options.library,
    env.history,
    () => true,
  );
  const found = await tools.search("卷积网络有什么作用");
  assert.ok(found.items.some((item) => item.excerpt.includes("卷积网络")));
  const hit = found.items.find((item) => item.excerpt.includes("卷积网络"));
  assert.ok(hit.offset > 1000);
  assert.ok(
    (await tools.read(hit.ref, hit.offset)).content.includes("卷积网络"),
  );
  assert.equal(
    (await tools.call("context_read", { ref: "s:main:running" })).ok,
    false,
  );
  await env.manager.shutdown();
});

test("native btw executes a bounded read-only tool loop and preserves its own archives", async () => {
  const model = new ScriptedModel([
    {
      toolCalls: [
        { id: "lookup", name: "search_items", args: { query: "paper" } },
      ],
      end: "tool_calls",
    },
    { text: "A concise answer based on the lookup.", end: "stop" },
  ]);
  const env = setup({ execute: (run) => executeNativeBtw(run, model) });
  const view = await submit(env.manager);
  const done = await settled(env.manager, view.record.id);
  assert.equal(done.record.turns[0].status, "completed");
  assert.match(done.record.turns[0].answer, /concise answer/);
  const document = await env.store.load(view.record.id);
  assert.ok(Object.keys(document.archive).length >= 2);
  assert.ok(document.checkpoint);
  assert.equal(
    Object.keys(env.fs.snapshot()).some((path) => path.startsWith("/history/")),
    false,
  );
  await env.manager.shutdown();
});

test("retained terminal answers remain searchable after timeline trimming", async () => {
  const env = setup();
  env.history.register(env.parent);
  const base = {
    taskId: "main",
    windowId: "window",
    sourceIds: [],
    createdAt: 10,
  };
  await env.history.append({
    ...base,
    itemId: "answer_old",
    turnId: "old",
    role: "assistant",
    content: "Archived spectral analysis",
  });
  await env.history.append({
    ...base,
    itemId: "reading_old",
    turnId: "old",
    role: "tool",
    content: "Spectral analysis original evidence",
  });
  await env.history.append({
    ...base,
    itemId: "answer_failed",
    turnId: "failed",
    role: "assistant",
    incomplete: true,
    content: "Spectral analysis FAILED",
  });
  for (let i = 0; i < 60; i++) {
    await env.history.append({
      ...base,
      createdAt: 20 + i,
      itemId: `ongoing_${i}`,
      turnId: "ongoing",
      role: "tool",
      content: "Spectral analysis",
    });
  }
  const { record } = await env.manager.open(selection());
  const tools = new BtwContextTools(
    await env.options.resolve(selection()),
    await env.store.load(record.id),
    env.options.library,
    env.history,
    () => true,
  );
  const results = await tools.search("spectral analysis");
  assert.ok(
    (await tools.search("")).items.some((item) =>
      item.ref.endsWith(":answer_old"),
    ),
  );
  assert.ok(results.items.some((item) => item.ref.endsWith(":reading_old")));
  assert.equal(
    results.items.some((item) => item.ref.endsWith(":answer_failed")),
    false,
  );
  assert.match(
    (await tools.read("h:main:window:answer_old")).content,
    /Archived/,
  );
  await env.manager.shutdown();
});

test("late checkpoints cannot recreate a removed source", async () => {
  const env = setup();
  const { record } = await submit(env.manager);
  const run = env.runs[0];
  await env.manager.remove(record.id);
  await run.save();
  assert.equal(await env.store.load(record.id), undefined);
  assert.throws(() => env.manager.events(record.id, 0), /not open/);
  await env.manager.shutdown();
});

test("deletion during source resolution fences both open and prompt", async () => {
  for (const action of ["open", "prompt"]) {
    const env = setup();
    const { record } = await env.manager.open(selection());
    let release;
    env.options.resolve = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending =
      action === "open"
        ? env.manager.open(selection())
        : env.manager.prompt({
            btwId: record.id,
            requestId: "req",
            text: "Explain",
            selection: selection(),
          });
    const rejected = assert.rejects(pending, /removed|closed/);
    await env.manager.remove(record.id);
    release({
      selection: selection(),
      sources: emptyLockedContext(),
      tasks: [{ record: env.parent, events: [] }],
    });
    await rejected;
    assert.equal(env.runs.length, 0);
    assert.equal(await env.store.load(record.id), undefined);
    await env.manager.shutdown();
  }
});

test("Codex and Kimi adapters receive fresh side identities and no artifact guidance", async () => {
  for (const kind of ["codex", "kimi"]) {
    let input;
    const backend = {
      startTurn: async (value, callbacks) => {
        input = value;
        callbacks.event(
          event(
            "text_delta",
            value.turnId,
            { text: "External answer" },
            value.task.id,
          ),
        );
        callbacks.event(
          event("turn_completed", value.turnId, {}, value.task.id),
        );
        return {};
      },
      dispose: async () => {},
    };
    const parent = task("main", kind);
    parent.externalSessionId = "MAIN_PROVIDER_SESSION";
    const env = setup({
      resolve: async (chosen) => ({
        selection: chosen,
        sources: emptyLockedContext(),
        tasks: [{ record: parent, events: [] }],
      }),
      execute: (run) => executeExternalBtw(run, backend),
    });
    const view = await submit(env.manager);
    assert.equal(
      (await settled(env.manager, view.record.id)).record.turns[0].answer,
      "External answer",
    );
    assert.equal(input.task.backend, kind);
    assert.equal(input.task.externalSessionId, undefined);
    assert.equal(input.includeArtifactGuidance, false);
    assert.equal(input.capabilityProfile, "zotero_only");
    assert.deepEqual(input.task.runtimeModel, parent.runtimeModel);
    await env.manager.shutdown();
  }
});

test("storage failure prevents dispatch and exposes unsaved state", async () => {
  const env = setup();
  const view = await env.manager.open(selection());
  const write = env.fs.writeFile.bind(env.fs);
  env.fs.writeFile = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(
    env.manager.prompt({
      btwId: view.record.id,
      requestId: "req",
      text: "Explain",
      selection: selection(),
    }),
    /disk full/,
  );
  assert.equal(env.runs.length, 0);
  assert.match(env.manager.view(view.record.id).storageError, /disk full/);
  assert.equal(env.manager.view(view.record.id).record.draft, "Explain");
  env.fs.writeFile = write;
  await env.manager.prompt({
    btwId: view.record.id,
    requestId: "req",
    text: "Explain",
    selection: selection(),
  });
  assert.equal(env.runs.length, 1);
  await env.manager.shutdown();
});

test("deleting a source removes saved side history and cancels its generation", async () => {
  const env = setup();
  const view = await submit(env.manager);
  await env.manager.pruneSources(() => false);
  assert.equal(env.runs[0].abort.signal.aborted, true);
  assert.equal(await env.store.load(view.record.id), undefined);
  await env.manager.shutdown();
});

test("retention archives old idle histories, protects active runs, then expires archives", async () => {
  const env = setup();
  const view = await env.manager.open(selection());
  const now = view.record.updatedAt + 31 * 86_400_000;
  assert.deepEqual(await env.store.cleanup(new Set([view.record.id]), now), []);
  assert.equal((await env.store.load(view.record.id)).archivedAt, undefined);
  await env.store.cleanup(new Set(), now);
  assert.equal((await env.store.load(view.record.id)).archivedAt, now);
  await env.manager.shutdown();
  assert.equal((await env.store.load(view.record.id)).archivedAt, now);
  assert.deepEqual(await env.store.cleanup(new Set(), now + 90 * 86_400_000), [
    view.record.id,
  ]);
});

test("retention never overwrites a new draft or deletes a newly active history", async () => {
  for (const operation of ["archive", "expire"]) {
    const env = setup();
    const { record } = await env.manager.open(selection());
    const now = record.updatedAt + 200 * 86_400_000;
    if (operation === "expire") {
      const doc = await env.store.load(record.id);
      doc.archivedAt = record.updatedAt;
      await env.store.save(doc);
    }
    const read = env.fs.readFile.bind(env.fs);
    let release, entered;
    const reading = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    env.fs.readFile = async (path) => {
      const content = await read(path);
      entered();
      await gate;
      return content;
    };
    let active = false;
    const cleanup = env.store.cleanup(() => active, now);
    await reading;
    if (operation === "archive")
      await env.manager.draft(record.id, "New draft");
    else active = true;
    release();
    assert.deepEqual(await cleanup, []);
    const saved = await env.store.load(record.id);
    assert.ok(saved);
    if (operation === "archive") {
      assert.equal(saved.record.draft, "New draft");
      assert.equal(saved.archivedAt, undefined);
    }
    await env.manager.shutdown();
  }
});

test("a save queued during removal wins after the old file is deleted", async () => {
  const env = setup();
  const { record } = await env.manager.open(selection());
  const doc = await env.store.load(record.id);
  const remove = env.fs.deleteFile.bind(env.fs);
  let release, entered;
  const deleting = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  env.fs.deleteFile = async (path) => {
    entered();
    await gate;
    await remove(path);
  };
  const removal = env.store.remove(record.id);
  await deleting;
  doc.record.draft = "Reopened history";
  const saving = env.store.save(doc);
  release();
  await Promise.all([removal, saving]);
  assert.equal(
    (await env.store.load(record.id)).record.draft,
    "Reopened history",
  );
  await env.manager.shutdown();
});

test("damaged archive contents are rejected without replacing the original", async () => {
  const env = setup();
  const { record } = await env.manager.open(selection());
  for (const archive of [[], { invalid: 42 }]) {
    const doc = { record, archive };
    const content = JSON.stringify(doc);
    await env.fs.writeFile(`/btw/${record.id}.json`, content);
    await assert.rejects(env.store.load(record.id), /damaged/);
    assert.equal(await env.fs.readFile(`/btw/${record.id}.json`), content);
  }
  await env.manager.shutdown();
});

test("selection validators reject cross-source identifiers and preserve surrogate pairs", () => {
  assert.throws(() =>
    validateBtwSelection({
      ...selection(),
      source: { kind: "conversation", taskId: "../other", messageId: "x" },
    }),
  );
  assert.throws(() => validateBtwSelection({ ...selection(), text: "  " }));
  assert.throws(() =>
    validateBtwSelection({
      ...pdf(),
      source: { ...pdf().source, pageIndex: -1 },
    }),
  );
  const chosen = { ...selection(), text: "你好🧪" };
  assert.equal(validateBtwSelection(chosen).text, chosen.text);
});
