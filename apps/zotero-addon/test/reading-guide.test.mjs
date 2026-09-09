import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import {
  artifactBodyMatchesKind,
  readingBodyForView,
  readingCitationErrors,
  artifactUpsertGuidance,
} from "@confucius/protocol";
import { ArtifactStore } from "../src/modules/host/ArtifactStore.ts";
import { ArtifactToolProvider } from "../src/modules/host/ArtifactToolProvider.ts";
import { ReadingDiscussionStore } from "../src/modules/host/ReadingDiscussionStore.ts";
import {
  ReadingDiscussions,
  ReadingDiscussionTools,
} from "../src/modules/host/ReadingDiscussions.ts";
import { projectWork } from "../src/modules/host/RunCoordinator.ts";
import {
  presetWorkflow,
  presetToolNames,
} from "../src/modules/host/PresetWorkflow.ts";
import { AgentHost } from "../src/modules/host/AgentHost.ts";

const clone = (value) => JSON.parse(JSON.stringify(value));
const guide = {
  version: 1,
  overview: "Follow the original argument [cite:e1].",
  checkpoints: [
    {
      id: "problem",
      kind: "signpost",
      title: "What problem motivates the paper?",
      before: "Locate the gap.",
      after: "Now examine the method.",
      citationIds: ["e1"],
    },
    {
      id: "method",
      kind: "checkpoint",
      title: "Why does this method work?",
      before: "Read the two steps.",
      after: "The experiment tests this choice.",
      citationIds: ["e1"],
      reading: "The authors describe two steps [cite:e1].",
      writing:
        "The first sentence states the choice; the next supplies its reason.",
      question: "What remains untested?",
      further: "Illustrative example, not a reported experiment.",
    },
    {
      id: "limits",
      kind: "checkpoint",
      title: "What can we conclude?",
      before: "Check the denominator.",
      after: "Return to the question.",
      citationIds: ["e2"],
      reading: "Only this population is tested.",
      writing: "The limitation qualifies the earlier claim.",
    },
  ],
  annotationsMarkdown: "No native marks were saved.",
};
const citations = [
  {
    id: "e1",
    itemLibraryID: 1,
    itemKey: "PAPER",
    attachmentKey: "PDF",
    page: 2,
    quote: "We use two steps.",
    title: "Test paper",
  },
  {
    id: "e2",
    itemLibraryID: 1,
    itemKey: "PAPER",
    attachmentKey: "PDF",
    page: 3,
    quote: "Only one population was tested.",
  },
];
function paper() {
  const body = { type: "markdown", markdown: "", readingGuide: clone(guide) };
  return {
    id: "art_reading",
    taskId: "main",
    title: "Test paper",
    kind: "deep_read",
    revision: 1,
    status: "ready",
    body,
    citations: clone(citations),
    sourceContextIds: ["item:1:PAPER"],
    createdAt: 1,
    updatedAt: 1,
    revisions: [
      {
        revision: 1,
        body: clone(body),
        citations: clone(citations),
        sourceContextIds: ["item:1:PAPER"],
        createdAt: 1,
        backend: "native",
      },
    ],
  };
}
const parent = {
  id: "main",
  backend: "native",
  externalSessionId: "MAIN_SESSION_SECRET",
  messages: [{ content: "MAIN_HISTORY_SECRET" }],
  runtimeModel: { model: "test-model" },
};
function disk() {
  const files = new Map();
  return {
    files,
    read: async (id) => files.get(id) ?? null,
    write: async (id, text) => {
      files.set(id, text);
    },
    remove: async (id) => {
      files.delete(id);
    },
  };
}
function artifactStore() {
  const fs = disk();
  return new ArtifactStore("/artifacts", {
    read: fs.read,
    writeAtomic: fs.write,
    exists: async (id) => fs.files.has(id),
    makeDirectory: async () => {},
  });
}
function innerTools() {
  const names = [
    "get_pages",
    "get_item",
    "get_annotations",
    "artifact_patch",
    "context_save",
    "context_search",
    "commit_annotations",
    "search_items",
  ];
  const called = [];
  const listTools = () =>
    names.map((name) => ({
      name,
      description: name,
      inputSchema: {
        type: "object",
        properties: {
          libraryID: { type: "integer" },
          key: { type: "string" },
          attachmentKey: { type: "string" },
        },
        required: ["libraryID", "key"],
        additionalProperties: false,
      },
    }));
  return {
    called,
    listTools,
    getSchema: (name) => listTools().find((t) => t.name === name)?.inputSchema,
    getMeta: (name) => ({
      name,
      catalog: "paper.read",
      concurrency: "parallel_safe",
      mutatesState: [
        "artifact_patch",
        "context_save",
        "commit_annotations",
      ].includes(name),
    }),
    prepare: async () => null,
    call: async (name, args, _signal, context) => {
      called.push({ name, args, context });
      return {
        ok: true,
        toolName: name,
        data: { text: "Original paper evidence" },
      };
    },
  };
}
function service(extra = {}, savedDisk = disk()) {
  const inputs = [],
    starts = [],
    stopped = [];
  const tools = innerTools(),
    store = new ReadingDiscussionStore(savedDisk);
  const external = {
    kind: "codex",
    startTurn: async (input, callbacks) => {
      starts.push({ input, callbacks });
      callbacks.handle({ externalSessionId: "PRIVATE_" + input.task.id });
      return {};
    },
    interrupt: async (id) => {
      stopped.push(id);
    },
    dispose: async (id) => {
      stopped.push(id);
    },
  };
  const options = {
    store,
    tools: () => tools,
    backend: () => external,
    endpoint: () => ({
      id: "model",
      name: "Model",
      apiKey: "DO_NOT_PERSIST",
      baseUrl: "https://example.invalid/v1",
      model: "reading-model",
      maxTokens: 1000,
      contextWindowTokens: 32768,
      reasoningEffort: "medium",
    }),
    model: (snapshot) => ({
      complete: async (input) => {
        inputs.push({ snapshot, input: clone(input) });
        return { text: "SOURCE_GROUNDED_ANSWER", end: "stop" };
      },
    }),
    language: () => "zh-CN",
    maxIterations: () => 12,
    maxToolCalls: () => 15,
    validateLease: () => true,
    schedule: setTimeout,
    cancel: clearTimeout,
    ...extra,
  };
  return {
    value: new ReadingDiscussions(options),
    store,
    options,
    inputs,
    starts,
    stopped,
    tools,
    disk: savedDisk,
  };
}
async function finished(s, id) {
  for (let n = 0; n < 80; n++) {
    const result = (await s.value.get("art_reading", id)).discussion;
    if (result.status !== "running") return result;
    await setImmediate();
  }
  assert.fail("discussion did not settle");
}

test("guide/report patches are atomic, citation-complete and compatible with old revisions", async () => {
  const store = artifactStore();
  const provider = new ArtifactToolProvider(
    store,
    "main",
    "native",
    [],
    () => {},
  );
  const first = await provider.call("artifact_upsert", {
    kind: "deep_read",
    title: "Paper",
    body: paper().body,
    citations,
    status: "ready",
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const id = first.data.artifact.id;
  const read = await provider.call("artifact_read", { id, part: "guide" });
  assert.equal(JSON.parse(read.data.content).checkpoints[1].id, "method");
  const report = "Overview [cite:e1]. Evidence [cite:e2].";
  assert.equal(
    (
      await provider.call("artifact_patch", {
        id,
        expectedRevision: 1,
        reportMarkdown: report,
      })
    ).ok,
    true,
  );
  assert.deepEqual((await store.get(id)).body.readingGuide, guide);
  assert.equal(
    (
      await provider.call("artifact_patch", {
        id,
        expectedRevision: 2,
        edits: [{ oldText: "Overview", newText: "Reviewed overview" }],
      })
    ).ok,
    true,
  );
  const changed = clone(guide);
  changed.checkpoints[1].reading = "A corrected explanation [cite:e1].";
  assert.equal(
    (
      await provider.call("artifact_patch", {
        id,
        expectedRevision: 3,
        readingGuide: changed,
      })
    ).ok,
    true,
  );
  const before = await store.get(id);
  assert.equal(
    before.body.markdown,
    "Reviewed overview [cite:e1]. Evidence [cite:e2].",
  );
  assert.equal(before.revisions[0].body.markdown, "");
  const invalid = clone(changed);
  invalid.checkpoints[2].hint = "Unknown [cite:missing].";
  assert.equal(
    (
      await provider.call("artifact_patch", {
        id,
        expectedRevision: 4,
        readingGuide: invalid,
        reportMarkdown: "SHOULD_NOT_SAVE",
      })
    ).ok,
    false,
  );
  assert.deepEqual(await store.get(id), before);
  assert.equal(
    (
      await provider.call("artifact_patch", {
        id,
        expectedRevision: 4,
        citations: [citations[0]],
      })
    ).ok,
    false,
  );
  assert.deepEqual(await store.get(id), before);
  const duplicate = clone(guide);
  duplicate.checkpoints[1].id = "problem";
  assert.equal(
    artifactBodyMatchesKind("deep_read", {
      ...paper().body,
      readingGuide: duplicate,
    }),
    false,
  );
  const missing = clone(guide);
  delete missing.checkpoints[1].id;
  assert.equal(
    artifactBodyMatchesKind("deep_read", {
      ...paper().body,
      readingGuide: missing,
    }),
    false,
  );
  const reportOnly = await store.upsert(
    {
      taskId: "main",
      kind: "deep_read",
      title: "Old",
      body: { type: "markdown", markdown: "Legacy" },
    },
    "native",
    [],
  );
  assert.equal(reportOnly.body.readingGuide, undefined);
  assert.equal((await store.get(reportOnly.id, true)).body.markdown, "Legacy");
  assert.deepEqual(readingCitationErrors(paper().body, citations), []);
  assert.match(
    readingBodyForView(paper().body, citations, "guide").markdown,
    /We use two steps/,
  );
  assert.equal(
    readingBodyForView(before.body, citations, "report").markdown,
    before.body.markdown,
  );
});

test("completion follows workflow version and an explicit report target", () => {
  const artifact = paper();
  artifact.execution = {
    runId: "run",
    intentRevision: 1,
    sourceFingerprint: "paper",
  };
  const run = {
    id: "run",
    intentRevision: 1,
    sources: { fingerprint: "paper" },
    requiredArtifactKinds: ["deep_read"],
    templateId: "deep-read",
    templateVersion: 3,
  };
  const work = () =>
    projectWork(run, [artifact], { completed: [], missing: [] }, []);
  assert.equal(work().missing.length, 0);
  delete artifact.body.readingGuide;
  assert.equal(work().missing.length, 1);
  run.templateVersion = 2;
  assert.equal(work().missing.length, 0);
  run.reportArtifactId = artifact.id;
  assert.equal(work().missing.length, 1);
  artifact.body.markdown = "Report";
  assert.equal(work().missing.length, 0);
  run.reportArtifactId = "another";
  assert.equal(work().missing.length, 1);
  assert.equal(presetWorkflow("deep-read").version, 3);
  assert.equal(presetWorkflow("deep-read", { version: 2 }).version, 2);
  assert.equal(
    presetToolNames(
      presetWorkflow("deep-read", { reportArtifactId: "target" }),
    ).has("commit_annotations"),
    false,
  );
  assert.match(
    artifactUpsertGuidance({
      templateId: "deep-read",
      reportArtifactId: "target",
    }),
    /only|preserv|Preserve/,
  );
});

test("report generation is idempotent, refuses to interrupt a main task and pins its artifact", async () => {
  const artifact = paper(),
    state = { record: { id: "main", status: "completed" }, activeTurnId: null };
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const host = Object.assign(Object.create(AgentHost.prototype), {
    artifactGet: async () => ({ artifact }),
    requireSession: () => state,
    reportRequests: new Set(),
    sessionPrompt: async (...args) => {
      calls.push(args);
      await gate;
    },
    taskContinue: async (id) => {
      calls.push(["resume", id]);
    },
  });
  const old = globalThis.Zotero;
  globalThis.Zotero = { Prefs: { get: () => "zh-CN" } };
  try {
    state.activeTurnId = "MAIN_RUNNING";
    assert.equal(
      (
        await host.artifactGenerateReport({
          artifactId: artifact.id,
          expectedRevision: 1,
        })
      ).status,
      "busy",
    );
    assert.equal(calls.length, 0);
    state.activeTurnId = null;
    const first = host.artifactGenerateReport({
      artifactId: artifact.id,
      expectedRevision: 1,
    });
    await setImmediate();
    assert.equal(
      (
        await host.artifactGenerateReport({
          artifactId: artifact.id,
          expectedRevision: 1,
        })
      ).status,
      "busy",
    );
    release();
    await first;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].at(-1), artifact.id);
    assert.doesNotMatch(
      JSON.stringify(calls),
      /MAIN_HISTORY_SECRET|READING_ONLY_SENTINEL/,
    );
    await assert.rejects(
      host.artifactGenerateReport({
        artifactId: artifact.id,
        expectedRevision: 99,
      }),
      /changed/,
    );
    state.record.run = { reportArtifactId: artifact.id, status: "interrupted" };
    await host.artifactGenerateReport({
      artifactId: artifact.id,
      expectedRevision: 1,
    });
    assert.deepEqual(calls.at(-1), ["resume", "main"]);
  } finally {
    globalThis.Zotero = old;
  }
});

test("report tool scope cannot create another artifact or replace the companion", async () => {
  const store = artifactStore();
  const artifact = paper();
  await store.upsert({ ...artifact, id: artifact.id }, "native", []);
  const provider = new ArtifactToolProvider(
    store,
    "main",
    "native",
    [],
    () => {},
    undefined,
    undefined,
    undefined,
    artifact.id,
  );
  for (const [name, args] of [
    [
      "artifact_upsert",
      { kind: "deep_read", title: "Duplicate", body: artifact.body },
    ],
    [
      "artifact_patch",
      { id: "another", expectedRevision: 1, reportMarkdown: "Wrong" },
    ],
    [
      "artifact_patch",
      { id: artifact.id, expectedRevision: 1, readingGuide: guide },
    ],
  ])
    assert.equal((await provider.call(name, args)).ok, false);
  assert.equal(
    (
      await provider.call("artifact_patch", {
        id: artifact.id,
        expectedRevision: 1,
        reportMarkdown: "Report [cite:e1]",
      })
    ).ok,
    true,
  );
  assert.deepEqual((await store.get(artifact.id)).body.readingGuide, guide);
});

test("private conversations are lazy, source-scoped and excluded from parent inputs and other checkpoints", async () => {
  const s = service(),
    artifact = paper(),
    original = clone(parent);
  try {
    assert.equal(
      (await s.value.open(artifact, parent, 1, "method", false)).discussion,
      null,
    );
    assert.equal(s.disk.files.size, 0);
    const one = (await s.value.open(artifact, parent, 1, "method")).discussion;
    await s.value.prompt(
      artifact.id,
      one.id,
      "READING_ONLY_SENTINEL: explain this step",
    );
    assert.equal((await finished(s, one.id)).status, "completed");
    await s.value.prompt(artifact.id, one.id, "Now give an example");
    await finished(s, one.id);
    assert.match(JSON.stringify(s.inputs.at(-1)), /READING_ONLY_SENTINEL/);
    const two = (await s.value.open(artifact, parent, 1, "limits")).discussion;
    await s.value.prompt(artifact.id, two.id, "What is untested?");
    await finished(s, two.id);
    assert.doesNotMatch(
      JSON.stringify(s.inputs.at(-1)),
      /READING_ONLY_SENTINEL/,
    );
    assert.doesNotMatch(
      JSON.stringify(s.inputs),
      /MAIN_HISTORY_SECRET|MAIN_SESSION_SECRET/,
    );
    assert.deepEqual(parent, original);
    assert.doesNotMatch(
      [...s.disk.files.values()].join(""),
      /DO_NOT_PERSIST|MAIN_HISTORY_SECRET|MAIN_SESSION_SECRET/,
    );
    const stored = await s.store.get(artifact.id, one.id);
    const privateTools = new ReadingDiscussionTools(s.tools, stored);
    assert.deepEqual(
      privateTools.listTools().map((t) => t.name),
      ["get_pages", "get_item", "reading_discussion_history"],
    );
    for (const name of [
      "context_search",
      "context_save",
      "artifact_patch",
      "commit_annotations",
      "get_annotations",
      "search_items",
    ])
      assert.equal(
        (await privateTools.call(name, { libraryID: 1, key: "PAPER" })).ok,
        false,
      );
    assert.equal(
      (await privateTools.call("get_pages", { libraryID: 1, key: "OTHER" })).ok,
      false,
    );
    assert.equal(
      (
        await privateTools.call("get_pages", {
          libraryID: 1,
          key: "PAPER",
          attachmentKey: "OTHERPDF",
        })
      ).ok,
      false,
    );
    assert.equal(
      (await privateTools.call("get_pages", { libraryID: 1, key: "PAPER" })).ok,
      true,
    );
    assert.equal(s.tools.called.at(-1).context.taskId, one.id);
    assert.equal(s.tools.called.at(-1).args.attachmentKey, "PDF");
    const after = clone(artifact);
    after.revision = 2;
    after.body.markdown = "New report";
    after.citations.push({
      id: "reportOnly",
      itemLibraryID: 1,
      itemKey: "PAPER",
    });
    after.revisions.push({
      ...after.revisions[0],
      revision: 2,
      body: clone(after.body),
      citations: clone(after.citations),
    });
    assert.equal(
      (await s.value.open(after, parent, 2, "method")).discussion.id,
      one.id,
    );
    after.revision = 3;
    after.body.readingGuide.checkpoints[1].reading = "Corrected method";
    after.revisions.push({
      ...after.revisions[1],
      revision: 3,
      body: clone(after.body),
    });
    const revised = await s.value.open(after, parent, 3, "method");
    assert.notEqual(revised.discussion.id, one.id);
    assert.equal(revised.previous[0].id, one.id);
  } finally {
    await s.value.shutdown();
  }
});

for (const backend of ["codex", "kimi"])
  test(`${backend}: separate external sessions, strict leases, stream ownership, cancellation and explicit restart resume`, async () => {
    const s = service(),
      artifact = paper();
    const externalParent = { ...parent, backend };
    const first = (await s.value.open(artifact, externalParent, 1, "method"))
      .discussion;
    const second = (await s.value.open(artifact, externalParent, 1, "limits"))
      .discussion;
    await s.value.prompt(artifact.id, first.id, "READING_ONLY_SENTINEL");
    await s.value.prompt(artifact.id, second.id, "Another question");
    for (let i = 0; i < 10 && s.starts.length < 2; i++) await setImmediate();
    const [one, two] = s.starts;
    assert.notEqual(one.input.task.id, two.input.task.id);
    assert.equal(one.input.task.externalSessionId, undefined);
    assert.equal(one.input.workingDirectory, undefined);
    assert.equal(one.input.capabilityProfile, "zotero_only");
    assert.equal(one.input.includeArtifactGuidance, false);
    assert.doesNotMatch(
      JSON.stringify(two.input),
      /READING_ONLY_SENTINEL|MAIN_SESSION_SECRET|MAIN_HISTORY_SECRET/,
    );
    const lease = {
      taskId: first.id,
      turnId: one.input.turnId,
      runId: one.input.task.run.id,
      generation: 1,
    };
    assert.throws(
      () => s.value.toolList(first.id, { ...lease, taskId: "main" }),
      /expired/,
    );
    assert.equal(
      (await s.value.toolCall(first.id, lease, "context_save", {})).ok,
      false,
    );
    const emit = (run, type, payload, taskId = run.input.task.id) =>
      run.callbacks.event({
        id: "event",
        sessionId: taskId,
        turnId: run.input.turnId,
        type,
        payload,
      });
    emit(one, "text_delta", { text: "WRONG_TASK" }, second.id);
    emit(one, "text_delta", { text: "PARTIAL" });
    assert.equal(
      (await s.value.get(artifact.id, first.id)).discussion.messages.at(-1)
        .text,
      "PARTIAL",
    );
    await s.value.abort(artifact.id, first.id);
    emit(one, "text_delta", { text: "LATE" });
    assert.throws(() => s.value.toolList(first.id, lease), /expired/);
    assert.equal(
      (await s.value.get(artifact.id, second.id)).discussion.status,
      "running",
    );
    assert.deepEqual(s.stopped, [first.id]);
    await s.store.save(artifact.id);
    const restarted = service({}, s.disk);
    const restored = await restarted.store.get(artifact.id, second.id);
    assert.equal(restored.record.status, "interrupted");
    assert.equal(restarted.starts.length, 0);
    await restarted.value.prompt(artifact.id, second.id, "", true);
    for (let i = 0; i < 10 && !restarted.starts.length; i++)
      await setImmediate();
    assert.equal(
      restarted.starts[0].input.task.externalSessionId,
      "PRIVATE_" + second.id,
    );
    assert.notEqual(
      restarted.starts[0].input.task.externalSessionId,
      parent.externalSessionId,
    );
    emit(restarted.starts[0], "text_delta", { text: "Finished answer" });
    emit(restarted.starts[0], "turn_completed", { stopReason: "completed" });
    for (let i = 0; i < 10; i++) await setImmediate();
    const completed = (await restarted.value.get(artifact.id, second.id))
      .discussion;
    assert.equal(completed.status, "completed");
    assert.equal(completed.error, undefined);
    assert.equal(completed.messages.at(-1).incomplete, false);
    await restarted.value.shutdown();
    await s.value.shutdown();
    await s.value.removeArtifacts([artifact.id]);
    assert.equal(s.disk.files.size, 0);
  });

test("reading state changes do not create artifact revisions and survive restart", async () => {
  const fs = disk(),
    store = new ReadingDiscussionStore(fs);
  await store.state("art_reading", {
    checkpointId: "method",
    checkpointOffset: -24,
    discussionCheckpointId: "method",
    quote: { checkpointId: "method", text: "private selected words" },
    lens: "writing",
    drafts: { method: "unfinished" },
    expanded: { method: false },
  });
  await store.state("art_reading", { view: "report" });
  const next = await new ReadingDiscussionStore(fs).state("art_reading");
  assert.equal(next.lens, "writing");
  assert.equal(next.drafts.method, "unfinished");
  assert.equal(next.view, "report");
  assert.equal(next.checkpointOffset, -24);
  assert.deepEqual(next.quote, {
    checkpointId: "method",
    text: "private selected words",
  });
  await store.state("art_reading", { quote: null });
  assert.equal((await store.state("art_reading")).quote, null);
  await assert.rejects(
    store.state("art_reading", { checkpointOffset: Infinity }),
    /Invalid/,
  );
  await assert.rejects(
    store.state("art_reading", { quote: { text: "missing scope" } }),
    /Invalid/,
  );
  await assert.rejects(
    store.state("art_reading", { messages: ["inject"] }),
    /Invalid/,
  );
  const old = globalThis.Zotero;
  globalThis.Zotero = { Prefs: { get: () => "en-US" } };
  const host = Object.create(AgentHost.prototype);
  host.writebackRevision = (artifact, number) =>
    artifact.revisions.find((r) => r.revision === number);
  const artifact = paper();
  artifact.revisions[0].body.markdown = "REPORT_ONLY";
  assert.match(
    host.readingWritebackRevision(artifact, 1, "guide").revision.body.markdown,
    /We use two steps/,
  );
  assert.equal(
    host.readingWritebackRevision(artifact, 1, "report").revision.body.markdown,
    "REPORT_ONLY",
  );
  assert.throws(
    () => host.readingWritebackRevision(artifact, 1, "private"),
    /Invalid/,
  );
  globalThis.Zotero = old;
});
