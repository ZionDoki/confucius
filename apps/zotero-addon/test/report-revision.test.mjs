import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { setTimeout, clearTimeout } from "node:timers";
import { BudgetAccountant } from "@confucius/harness";
import {
  DEFAULT_REPORT_STYLE,
  REPORT_STYLE_OPTIONS,
  executionBinding,
  restoreRun,
  renderMarkdownHtml,
} from "@confucius/protocol";
import { AgentHost } from "../src/modules/host/AgentHost.ts";
import { ArtifactStore } from "../src/modules/host/ArtifactStore.ts";
import { ToolExecutionService } from "../src/modules/host/ReliableToolProvider.ts";
import { memoryJsonStorage } from "../src/modules/host/RuntimeStorage.ts";
import {
  reportContent,
  reportEvidence,
  reportRevisionCandidate,
  reportRevisionMessages,
  reportRevisionPatch,
  missingReportPages,
} from "../src/modules/host/ReportRevision.ts";

const { AbortController } = globalThis;

beforeEach(() => {
  globalThis.Zotero = {
    Prefs: { get: () => "zh-CN" },
    getMainWindow: () => ({ setTimeout, clearTimeout }),
  };
  globalThis.ztoolkit = { log() {} };
});
const source = {
  ok: true,
  toolName: "get_pages",
  data: {
    libraryID: 1,
    key: "PAPER",
    attachmentKey: "PDF",
    pages: [
      {
        page: 2,
        text: "50 of 100 tasks were completed, on two applications. The method remembers preceding actions.",
      },
    ],
  },
};
const event = (result, id = "source") => ({
  id,
  type: "tool_result",
  sessionId: "task",
  turnId: "turn",
  ts: 100,
  payload: { callId: id, result },
});
async function fixture(backend = "native") {
  const files = new Map();
  const store = new ArtifactStore(
    "/artifacts",
    {
      read: async (path) => {
        if (!files.has(path)) throw new Error("missing");
        return files.get(path);
      },
      writeAtomic: async (path, text) => {
        files.set(path, text);
      },
      exists: async (path) => files.has(path),
      makeDirectory: async () => {},
    },
    () => 10,
    () => "report",
  );
  const run = {
    version: 1,
    id: "run",
    generation: 1,
    intentRevision: 1,
    request: "Explain this paper",
    templateId: "deep-read",
    templateVersion: 2,
    sources: { version: 1, capturedAt: 1, fingerprint: "sources", items: [] },
    requiredArtifactKinds: ["deep_read"],
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    reportRevisionBaseline: {},
    budget: {
      maxIterations: 8,
      maxToolCalls: 8,
      iterationsUsed: 0,
      executorStarts: 1,
      toolCallsUsed: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      modelRequestsObservable: backend === "native",
    },
  };
  const artifact = await store.upsert(
    {
      taskId: "task",
      kind: "deep_read",
      title: "Paper",
      status: "ready",
      body: {
        type: "markdown",
        markdown:
          "All tasks succeeded. [cite:e1]\n\n100/100 tasks. [cite:e1]\n\n:::parallel\n> Unexplained mechanism [cite:e1]\n",
      },
      citations: [
        {
          id: "e1",
          itemLibraryID: 1,
          itemKey: "PAPER",
          attachmentKey: "PDF",
          page: 2,
        },
      ],
    },
    backend,
    ["item:1:PAPER"],
    undefined,
    executionBinding(run),
  );
  const state = {
    record: {
      id: "task",
      mode: "agent",
      backend,
      templateId: "deep-read",
      reportStyle: DEFAULT_REPORT_STYLE,
      artifactIds: [artifact.id],
      lockedContext: run.sources,
      run,
      runtimeModel: { modelId: "chosen", reasoningEffort: "high" },
      contextWindow: { capacityTokens: 32768 },
    },
    runBudget: new BudgetAccountant({ maxIterations: 8, maxToolCalls: 8 }),
    abort: new AbortController(),
    activeTurnId: "turn",
    events: [event(source)],
    messages: [
      {
        role: "assistant",
        content: "BIASED_AUTHOR_NOTES",
        replayState: { data: { reasoning: "HIDDEN_REASONING" } },
      },
    ],
  };
  const calls = [],
    reads = [];
  const improved =
    "Only half the tasks completed on two applications. [cite:e1]\n\n:::parallel\n> The method remembers preceding actions. [cite:e1]\n\nLater actions depend on the state created by earlier actions. This explains why a sequence matters, but does not establish results on other applications.\n:::";
  let response = JSON.stringify({ markdown: improved });
  let current = true;
  const model = {
    complete: async (request, signal) => {
      calls.push({ request, signal });
      await request.onAttempt?.();
      return {
        text: response,
        end: "stop",
        usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 },
      };
    },
  };
  const host = Object.create(AgentHost.prototype);
  let seq = 0;
  Object.assign(host, {
    artifacts: store,
    execution: new ToolExecutionService(memoryJsonStorage()),
    ids: () => `id_${++seq}`,
    persistNow: async () => {},
    contextWindowTokens: () => 32768,
    maxOutputTokens: () => 4096,
    readEndpointStore: () => ({
      store: { endpoints: [], activeEndpointId: "" },
    }),
    openaiAdapter: () => model,
    backendFor: () => ({
      analyze: async (prompt, selection, options, signal) => {
        calls.push({ prompt, selection, options, signal });
        return response;
      },
    }),
    toolContext: () => ({
      taskId: "task",
      turnId: "turn",
      backend,
      execution: executionBinding(run),
    }),
    executeTool: async (name, args) => {
      reads.push({ name, args });
      return source;
    },
    emitSessionEvent: (_state, turnId, type, payload) =>
      state.events.push({
        id: `event_${++seq}`,
        sessionId: "task",
        turnId,
        ts: 100,
        type,
        payload,
      }),
  });
  return {
    host,
    state,
    run,
    store,
    artifact,
    calls,
    reads,
    model,
    improved,
    setResponse: (value) => {
      response = value;
    },
    supersede: () => {
      current = false;
    },
    revise: () => host.improveReadingReport(state, run, "turn", () => current),
  };
}

test("all 27 combinations enter independent context with original evidence and no author history", async () => {
  const f = await fixture();
  for (const layout of REPORT_STYLE_OPTIONS.layout)
    for (const tone of REPORT_STYLE_OPTIONS.tone)
      for (const focus of REPORT_STYLE_OPTIONS.focus) {
        const evidence = reportEvidence(
          f.artifact,
          f.state.events,
          f.state.messages,
        );
        const messages = reportRevisionMessages({
          request: f.run.request,
          languageInstruction: "Chinese",
          style: { layout, tone, focus },
          artifact: { ...f.artifact, revisions: [{ body: "OLD_REPORT" }] },
          evidence,
          maxInputTokens: 16000,
        });
        const input = JSON.stringify(messages);
        assert.match(
          input,
          new RegExp(`layout=${layout}; tone=${tone}; focus=${focus}`),
        );
        assert.match(input, /50 of 100/);
        assert.doesNotMatch(
          input,
          /BIASED_AUTHOR_NOTES|HIDDEN_REASONING|OLD_REPORT/,
        );
        assert.equal(
          messages.filter((m) => m.role === "assistant" || m.role === "tool")
            .length,
          0,
        );
      }
});

test("original evidence is reused across a saved draft and archived-only or foreign results are excluded", async () => {
  const f = await fixture();
  const evidence = reportEvidence(f.artifact, [
    ...f.state.events,
    event({
      ...source,
      data: {
        libraryID: 1,
        key: "OTHER",
        pages: [{ page: 2, text: "FOREIGN" }],
      },
    }),
    event({
      ...source,
      data: {
        ...source.data,
        archivedRef: "opaque",
        pages: [{ page: 2, text: "ARCHIVED" }],
      },
    }),
  ]);
  assert.equal(evidence.length, 1);
  assert.deepEqual(missingReportPages(f.artifact, evidence), []);
  assert.deepEqual(missingReportPages(f.artifact, []), [
    {
      libraryID: 1,
      key: "PDF",
      start: 2,
      end: 2,
      rereadReason:
        "Retrieve missing cited evidence for a single direct report revision",
    },
  ]);
  assert.throws(
    () =>
      reportRevisionMessages({
        request: "read",
        languageInstruction: "Chinese",
        artifact: f.artifact,
        evidence,
        maxInputTokens: 10,
      }),
    /context allowance/,
  );
});

test("a new annotation snapshot removes obsolete pagination, including deleted marks", async () => {
  const f = await fixture();
  const comments = (offset, snapshot, annotations) =>
    event({
      ok: true,
      toolName: "get_annotations",
      data: { libraryID: 1, key: "PDF", offset, snapshot, annotations },
    });
  const evidence = reportEvidence(f.artifact, [
    comments(0, "old", [{ key: "old1" }]),
    comments(25, "old", [{ key: "deleted" }]),
    comments(0, "new", [{ key: "kept" }]),
  ]);
  assert.equal(evidence.length, 1);
  assert.doesNotMatch(JSON.stringify(evidence), /old1|deleted/);
});

for (const backend of ["native", "codex", "kimi"])
  test(`${backend} directly edits one report, retains citations/history, and never repeats the pass`, async () => {
    const f = await fixture(backend);
    await f.revise();
    const saved = await f.store.get("report");
    assert.equal(saved.body.markdown, f.improved);
    assert.equal(saved.id, f.artifact.id);
    assert.equal(saved.revision, 2);
    assert.equal(saved.status, "ready");
    assert.deepEqual(saved.citations, f.artifact.citations);
    assert.equal(saved.revisions[0].body.markdown, f.artifact.body.markdown);
    assert.match(
      renderMarkdownHtml(saved.body.markdown),
      /confucius-reading-parallel/,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.reads.length, 0);
    if (backend !== "native") {
      assert.deepEqual(f.calls[0].selection, f.state.record.runtimeModel);
      assert.equal(f.calls[0].options.preserveSettings, true);
      assert.equal(f.calls[0].signal, f.state.abort.signal);
    } else assert.equal(f.run.budget.totalTokens, 250);
    assert.equal(f.run.reportRevision.status, "finished");
    f.state.record.run = f.run; // same durable request after continuation
    await f.revise();
    assert.equal(f.calls.length, 1);
  });

for (const fault of [
  "invalid",
  "model failure",
  "cancel",
  "supersede",
  "conflict",
  "budget",
  "write budget",
])
  test(`revision ${fault} preserves the saved report without a quality gate`, async () => {
    const f = await fixture();
    let expectedRevision = 1;
    if (fault === "invalid") f.setResponse('{"score":0}');
    if (fault === "budget") f.run.budget.iterationsUsed = 8;
    if (fault === "write budget") f.run.budget.toolCallsUsed = 8;
    if (["model failure", "cancel", "supersede", "conflict"].includes(fault))
      f.model.complete = async () => {
        if (fault === "model failure") throw new Error("Network failure");
        if (fault === "cancel") f.state.abort.abort();
        if (fault === "supersede") f.supersede();
        if (fault === "conflict") {
          await f.store.upsert(
            {
              ...f.artifact,
              body: { type: "markdown", markdown: "User's later report" },
            },
            "native",
            [],
            1,
            executionBinding(f.run),
          );
          expectedRevision = 2;
        }
        return { text: JSON.stringify({ markdown: "Must not overwrite" }) };
      };
    await f.revise();
    const saved = await f.store.get("report");
    assert.equal(saved.revision, expectedRevision);
    assert.equal(saved.status, "ready");
    assert.equal(
      saved.body.markdown,
      fault === "conflict" ? "User's later report" : f.artifact.body.markdown,
    );
    assert.equal(f.run.status, "running");
    assert.equal(f.run.reportRevision.status === "finished", false);
  });

test("question, unchanged body, draft, other run and restored attempts do not start revision", async () => {
  const f = await fixture();
  const candidate = (run, a = f.artifact) => reportRevisionCandidate(run, [a]);
  assert.equal(candidate({ ...f.run, templateId: "freeform" }), undefined);
  assert.equal(
    candidate({
      ...f.run,
      reportRevisionBaseline: { [f.artifact.id]: reportContent(f.artifact) },
    }),
    undefined,
  );
  assert.equal(candidate(f.run, { ...f.artifact, status: "draft" }), undefined);
  assert.equal(candidate({ ...f.run, id: "next" }), undefined);
  const restored = restoreRun({
    ...f.run,
    reportRevision: {
      artifactId: "report",
      inputRevision: 1,
      intentRevision: 1,
      status: "started",
    },
  });
  assert.equal(candidate(restored), undefined);
  assert.equal(restored.reportRevision.status, "started");
});

test("direct output cannot change target or claim approval, and no-op does not save a version", async () => {
  const f = await fixture();
  for (const output of [
    { id: "other", edits: [] },
    { status: "ready", edits: [] },
    { edits: [], markdown: "new" },
    { markdown: "" },
    { edits: [{ oldText: f.artifact.body.markdown, newText: "" }] },
    { edits: [{ oldText: "missing" }] },
  ])
    assert.throws(() =>
      reportRevisionPatch(JSON.stringify(output), f.artifact),
    );
  f.setResponse('{"edits":[]}');
  await f.revise();
  assert.equal((await f.store.get("report")).revision, 1);
  assert.equal(f.run.reportRevision.status, "finished");
});

test("missing cited pages are fetched once, while evidence failures still permit direct editing", async () => {
  const f = await fixture();
  f.state.events = [];
  await f.revise();
  assert.deepEqual(
    f.reads.map((r) => r.name),
    ["get_pages"],
  );
  assert.equal(f.reads[0].args.start, 2);
  assert.equal(f.reads[0].args.end, 2);
  assert.equal(f.calls.length, 1);
  const g = await fixture();
  g.state.events = [];
  g.host.executeTool = async () => ({
    ok: false,
    toolName: "get_pages",
    code: "unavailable",
    message: "No PDF",
  });
  g.setResponse('{"edits":[]}');
  await g.revise();
  assert.equal(g.calls.length, 1);
  assert.equal((await g.store.get("report")).status, "ready");
});

test("external analysis forwards cancellation to its own isolated request", async () => {
  const { ExternalBackend } =
    await import("../src/modules/host/AgentBackend.ts");
  const controller = new AbortController(),
    calls = [];
  const backend = new ExternalBackend("codex", {
    rpc: async (method, params) => {
      calls.push({ method, params });
      if (method === "runtime/analyze") return new Promise(() => {});
      return { ok: true };
    },
  });
  const pending = backend.analyze(
    "edit",
    { modelId: "selected", reasoningEffort: "high" },
    { preserveSettings: true, timeoutMs: 5000 },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["runtime/analyze", "runtime/cancelAnalysis"],
  );
  assert.equal(calls[0].params.analysisId, calls[1].params.analysisId);
});

test("plugin Codex revision preserves effort and uses an ephemeral session", async () => {
  const { PluginCodexAdapter } =
    await import("../src/modules/host/PluginCodexAdapter.ts");
  const adapter = new PluginCodexAdapter();
  const calls = [];
  let notify,
    closed = 0;
  adapter.configuredMcpServers = async () => [];
  adapter.openRpc = async () => ({
    onNotification: (fn) => {
      notify = fn;
    },
    onFailure: () => {},
    close: () => {},
    closeAndWait: async () => {
      closed++;
    },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "model/list")
        return {
          data: [
            {
              model: "chosen",
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
              ],
            },
          ],
        };
      if (method === "thread/start") return { thread: { id: "isolated" } };
      if (method === "turn/start")
        notify({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
      return {};
    },
  });
  await adapter.analyze(
    "edit",
    "/tmp",
    { modelId: "chosen", reasoningEffort: "high" },
    { preserveSettings: true },
  );
  assert.equal(
    calls.find((c) => c.method === "thread/start").params.ephemeral,
    true,
  );
  for (const c of calls.filter((c) =>
    ["thread/start", "turn/start"].includes(c.method),
  ))
    assert.equal(c.params.effort, "high");
  assert.equal(closed, 1);
});

test("plugin Kimi revision preserves its advertised thinking setting", async () => {
  const { PluginKimiAdapter } =
    await import("../src/modules/host/PluginKimiAdapter.ts");
  const adapter = new PluginKimiAdapter();
  const calls = [];
  let closed = 0;
  const config = {
    sessionId: "isolated",
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "chosen",
        options: [{ value: "chosen", name: "chosen" }],
      },
      {
        id: "thinking",
        category: "thought_level",
        currentValue: "low",
        options: [
          { value: "low", name: "low" },
          { value: "high", name: "high" },
        ],
      },
    ],
  };
  adapter.openConnection = async () => ({
    rpc: {
      close: () => {},
      closeAndWait: async () => {
        closed++;
      },
      request: async (method, params) => {
        calls.push({ method, params });
        return method === "session/prompt"
          ? { stopReason: "end_turn" }
          : config;
      },
    },
  });
  await adapter.analyze(
    "edit",
    "/tmp",
    { modelId: "chosen", reasoningEffort: "high" },
    { preserveSettings: true },
  );
  const efforts = calls.filter(
    (c) =>
      c.method === "session/set_config_option" &&
      c.params.configId === "thinking",
  );
  assert.ok(efforts.length > 0);
  assert.ok(efforts.every((c) => c.params.value === "high"));
  assert.equal(calls.filter((c) => c.method === "session/new").length, 1);
  assert.equal(closed, 1);
});
