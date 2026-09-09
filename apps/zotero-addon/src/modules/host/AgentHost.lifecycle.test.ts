import { executionBinding } from "@confucius/protocol";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  HistoryStore,
  InMemoryFileSystem,
  MemoryEngine,
} from "@confucius/memory";
import type {
  ModelMessage,
  ModelRequest,
  TurnCheckpoint,
} from "@confucius/harness";
import {
  BudgetAccountant,
  MemoryToolProvider,
  WindowContext,
} from "@confucius/harness";
import {
  coalesceTimeline,
  initialContextWindow,
  TASK_TEMPLATES,
  type ApprovalResolution,
  type ConfuciusEvent,
  type ResearchTaskRecord,
  type RunState,
  type ToolExecutionContext,
  type ToolResult,
  type WorkSnapshot,
} from "@confucius/protocol";
import { AgentHost } from "./AgentHost";
import type { BackendCallbacks, BackendTurnInput } from "./AgentBackend";
import type { McpToolCallResult } from "./McpToolResult";
import { PluginRuntimeCapabilityStore } from "./PluginRuntimeSupport";
import { ToolExecutionService } from "./ReliableToolProvider";
import type { ExecutorResult, RunOutcome } from "./RunCoordinator";
import { memoryJsonStorage } from "./RuntimeStorage";
import { TaskTraceBuffer } from "./TaskTrace";
import { responseLanguageInstruction } from "./ResponseLanguage";
import { deepReadReviewMessages } from "./DeepReadReviewContext";
import { ArtifactStore } from "./ArtifactStore";
import { LibraryMentionSources } from "../ui/libraryMention";
import { ZoteroToolHost } from "../tools/ZoteroToolHost";

it("opens abstract-only citations in the library without resolving a PDF", async () => {
  const previous = Reflect.get(globalThis, "Zotero");
  const actions: unknown[] = [];
  Reflect.set(globalThis, "Zotero", {
    Items: { getByLibraryAndKey: () => ({ id: 41 }) },
    Reader: {
      open: () => assert.fail("an abstract citation selects its item"),
    },
    getMainWindow: () => ({
      focus: () => actions.push("focus"),
      Zotero_Tabs: { select: (id: string) => actions.push(id) },
      ZoteroPane: { selectItem: async (id: number) => actions.push(id) },
    }),
  });
  try {
    const host = Object.create(AgentHost.prototype) as {
      readerOpen: (params: Record<string, unknown>) => Promise<unknown>;
    };
    assert.deepEqual(
      await host.readerOpen({
        libraryID: 1,
        key: "ABSTRACT",
        selectItem: true,
      }),
      { opened: true },
    );
    assert.deepEqual(actions, ["focus", "zotero-pane", 41]);
  } finally {
    Reflect.set(globalThis, "Zotero", previous);
  }
});

it("isolates a source-grounded review while preserving the durable history and later tool groups", () => {
  const tool = (toolName: string, data: unknown, id: string): ModelMessage => ({
    role: "tool",
    toolCallId: id,
    content: JSON.stringify({ ok: true, toolName, data }),
  });
  const original: ModelMessage[] = [
    { role: "system", content: "Use configured Chinese" },
    { role: "user", content: "Read this paper" },
    {
      role: "assistant",
      content: "PREMATURE CONCLUSION",
      replayState: {
        provider: "test",
        version: 1,
        data: { reasoning: "BIASED REASONING" },
      },
    },
    tool(
      "get_pages",
      {
        libraryID: 1,
        key: "P",
        pages: [{ page: 2, text: "Primary evidence" }],
      },
      "p",
    ),
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "draft",
          name: "artifact_upsert",
          args: {
            id: "r",
            kind: "deep_read",
            body: { type: "markdown", markdown: "Fallible draft" },
          },
        },
      ],
    },
    tool(
      "artifact_upsert",
      { artifact: { id: "r", kind: "deep_read", status: "draft" } },
      "draft",
    ),
  ];
  assert.equal(deepReadReviewMessages(original), original);
  original.push(
    tool(
      "get_annotations",
      {
        libraryID: 1,
        key: "P",
        annotations: [{ key: "MARK", comment: "Saved explanation" }],
      },
      "annotations",
    ),
  );
  original.push(
    tool(
      "get_pages",
      {
        libraryID: 1,
        key: "P",
        pages: [{ page: 3, text: "Parallel source read" }],
      },
      "parallel",
    ),
  );
  const tail: ModelMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "fix",
          name: "update_annotation_comment",
          args: { key: "MARK", comment: "Corrected explanation" },
        },
      ],
    },
    tool("update_annotation_comment", { key: "MARK" }, "fix"),
  ];
  original.push(...tail);
  const snapshot = JSON.stringify(original);
  const projected = deepReadReviewMessages(original);
  const text = JSON.stringify(projected);
  assert.doesNotMatch(text, /PREMATURE CONCLUSION|BIASED REASONING/);
  for (const evidence of [
    "Parallel source read",
    "Fallible draft",
    "Saved explanation",
    "Use configured Chinese",
  ])
    assert(text.includes(evidence));
  assert.doesNotMatch(text, /Primary evidence/);
  assert.match(text, /earlierPageIndex/);
  assert.deepEqual(projected.slice(-2), tail);
  assert.equal(JSON.stringify(original), snapshot);
  const recovered = deepReadReviewMessages(
    [original[0], original[1], original[2], original[6], original[7], ...tail],
    {
      id: "r",
      title: "Recovered draft",
      body: { type: "markdown", markdown: "Durable report" },
      citations: [],
      revision: 2,
      status: "draft",
    },
  );
  assert.match(
    JSON.stringify(recovered),
    /Durable report|Parallel source read/,
  );
  assert.doesNotMatch(JSON.stringify(recovered), /PREMATURE CONCLUSION/);
  assert.deepEqual(recovered.slice(-2), tail);
  const historyBearingDraft = {
    id: "r",
    title: "Current draft",
    revision: 3,
    status: "draft" as const,
    body: { type: "markdown" as const, markdown: "Latest report" },
    citations: [],
    revisions: [{ body: "OBSOLETE FULL REPORT" }],
  };
  const latest = deepReadReviewMessages(original, historyBearingDraft);
  const inputs = latest.find((m) =>
    m.content.startsWith("Review inputs"),
  )!.content;
  assert.match(inputs, /"revision":3/);
  assert.match(inputs, /Latest report/);
  assert.doesNotMatch(inputs, /OBSOLETE FULL REPORT|"revisions"/);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface TestState {
  record: ResearchTaskRecord;
  events: ConfuciusEvent[];
  messages: ModelMessage[];
  loadedSkills: Set<string>;
  sessionGrants: Set<string>;
  abort: AbortController | null;
  activeTurnId: string | null;
  latestCheckpoint?: TurnCheckpoint;
  runBudget?: BudgetAccountant;
  externalToolNames?: Set<string>;
  externalSourceScope?: { itemRefs: Set<string> };
  externalVisualInspectionActive?: boolean;
}

// Expose private entry points only for exercising their real implementation.
// Storage, backend, and domain collaborators below do not require Zotero startup.
interface LifecycleHost {
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  shutdown(): Promise<void>;
  sessionPrompt(
    id: string,
    text: string,
  ): Promise<{ turnId?: string; superseded?: boolean }>;
  taskContinue(id: string): Promise<{ turnId?: string }>;
  taskToolCall(args: Record<string, unknown>): Promise<McpToolCallResult>;
  workSnapshot(state: TestState): Promise<WorkSnapshot>;
  executeBackend(
    state: TestState,
    input: BackendTurnInput,
    signal: AbortSignal,
  ): Promise<ExecutorResult>;
  finalizeRun(
    state: TestState,
    run: RunState,
    turnId: string,
    outcome: RunOutcome,
    current: () => boolean,
  ): Promise<void>;
  persistNow(): Promise<void>;
  queueHistory(): Promise<void>;
  requestToolApproval(
    state: TestState,
    turnId: string,
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ApprovalResolution>;
  approvalResolve(resolution: ApprovalResolution): { ok: boolean };
}

function run(record: ResearchTaskRecord, generation = 1): RunState {
  return {
    version: 1,
    id: "run-1",
    generation,
    intentRevision: 1,
    request: "Inspect the paper",
    sources: record.lockedContext,
    templateVersion: 1,
    requiredArtifactKinds: [],
    status: "running",
    budget: {
      maxIterations: 8,
      maxToolCalls: 20,
      iterationsUsed: 0,
      toolCallsUsed: 0,
      executorStarts: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      modelRequestsObservable: false,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function fixture() {
  const record: ResearchTaskRecord = {
    id: "task-1",
    schemaVersion: 4,
    title: "Lifecycle",
    titleState: "fixed",
    createdAt: 1,
    updatedAt: 1,
    mode: "agent",
    permissionMode: "ask",
    context: {},
    backend: "codex",
    status: "ready",
    capabilityProfile: "zotero_only",
    lockedContext: {
      version: 1,
      capturedAt: 1,
      fingerprint: "sources",
      items: [],
    },
    artifactIds: [],
    contextWindow: initialContextWindow("task-1", "codex", 1),
  };
  const state: TestState = {
    record,
    events: [],
    messages: [],
    loadedSkills: new Set(),
    sessionGrants: new Set(),
    abort: null,
    activeTurnId: null,
  };
  const starts: BackendTurnInput[] = [];
  const backend = {
    dispose: async (_id: string): Promise<void> => undefined,
    interrupt: async (_id: string): Promise<void> => undefined,
    startTurn: async (input: BackendTurnInput, callbacks: BackendCallbacks) => {
      starts.push(input);
      callbacks.stopped?.({ stopReason: "incomplete", text: "Saved progress" });
      return {};
    },
  };
  const execution = new ToolExecutionService(memoryJsonStorage());
  const fs = new InMemoryFileSystem();
  const history = new HistoryStore(fs, "/history");
  history.register(record);
  const host = Object.create(AgentHost.prototype) as LifecycleHost;
  let sequence = 0;
  Object.assign(host, {
    freezeBoundAnnotations: async () => undefined,
    postProcessingRuns: new Set(),
    externalHistoryText: new Map(),
    updates: { dispose() {} },
    taskTraceBuffer: new TaskTraceBuffer(),
    listeners: new Set(),
    sessions: new Map([[record.id, state]]),
    ids: () => `test-${++sequence}`,
    attachments: { resolve: () => [], consume: () => undefined },
    backendFor: () => backend,
    maxIterations: () => 8,
    maxToolCalls: () => 20,
    rejectPendingApprovals: () => undefined,
    history,
    artifacts: { list: async () => [] },
    memory: new MemoryEngine({ fs, root: "/memory" }),
    memoryProposals: new Map(),
    pendingApprovals: new Map(),
    memoryConsent: () => "off",
    contextWindowTokens: () => 32768,
    memoryContextHints: async () => "",
    queueHistory: async () => undefined,
    persistNow: async () => undefined,
    persistSoon: () => undefined,
    emitSessionEvent: (
      _state: TestState,
      turnId: string,
      type: ConfuciusEvent["type"],
      payload: ConfuciusEvent["payload"],
    ) => {
      state.events.push({
        id: `event-${++sequence}`,
        sessionId: record.id,
        turnId,
        type,
        payload,
        ts: Date.now(),
      } as ConfuciusEvent);
    },
    logs: { appendTurn: async () => undefined },
    loadedSkillRecords: () => [],
    workSnapshot: async (): Promise<WorkSnapshot> => ({
      completed: [],
      missing: [],
      unknownOperationIds: [],
    }),
    execution,
    maintenanceQueue: Promise.resolve(),
    historyCleanupEnabled: () => false,
  });
  return { host, state, backend, starts, execution };
}

it("native review consumes restored annotation pages, retains five pending edits, and checkpoints elapsed wall time", async (t) => {
  const previousZotero = Reflect.get(globalThis, "Zotero");
  Reflect.set(globalThis, "Zotero", {
    Prefs: { get: () => undefined },
    getMainWindow: () => ({ setTimeout, clearTimeout }),
  });
  const startedAt = 1800000000000;
  let clock = startedAt;
  t.mock.method(Date, "now", () => clock);
  try {
    const { host, state } = fixture();
    state.record.backend = "native";
    state.record.templateId = "deep-read";
    state.record.run = { ...run(state.record), templateId: "deep-read" };
    state.abort = new AbortController();
    state.activeTurnId = "native-review";
    state.runBudget = new BudgetAccountant({
      maxIterations: 12,
      maxToolCalls: 20,
    });
    const fs = new InMemoryFileSystem();
    const artifacts = new ArtifactStore("/artifacts", {
      read: (path) => fs.readFile(path),
      writeAtomic: (path, text) => fs.writeFile(path, text),
      exists: async (path) => Object.hasOwn(fs.snapshot(), path),
      makeDirectory: () => fs.makeDirectory(),
    });
    let id = 0,
      round = 0;
    const edits = Array.from({ length: 5 }, (_, i) => ({
      oldText: `original-${i}`,
      newText: `corrected-${i}`,
    }));
    const patch = { id: "report", expectedRevision: 1, status: "ready", edits };
    const calls = (name: string, args: Record<string, unknown>) => ({
      toolCalls: [{ id: `model-${++id}`, name, args }],
    });
    Reflect.deleteProperty(host, "emitSessionEvent");
    Object.assign(host, {
      artifacts,
      skills: { list: () => [] },
      mcpProviders: [],
      historyTools: () => new MemoryToolProvider(),
      memoryProvider: () => new MemoryToolProvider(),
      buildSystemPrompt: async () => "Review the paper",
      alwaysAllowedTools: () => new Set(),
      onToolAccess: () => undefined,
      nativeWindowContext: () =>
        new WindowContext({
          window: initialContextWindow(state.record.id, "native"),
          contextWindowTokens: 200000,
          maxOutputTokens: 4096,
          nextId: () => `history-${++id}`,
          archive: async ({ id, windowId }) => ({
            taskId: state.record.id,
            windowId,
            itemId: id,
          }),
          switchWindow: async () => assert.fail("evidence fits this window"),
          hint: async () => "",
        }),
      saveCheckpoint: async (_state: TestState, checkpoint: TurnCheckpoint) => {
        state.latestCheckpoint = checkpoint;
      },
      tools: {
        prepare: async () => null,
        execute: async (name: string, args: Record<string, unknown>) => ({
          ok: true,
          toolName: name,
          data:
            name === "get_pages"
              ? {
                  libraryID: 1,
                  key: "PAPER",
                  attachmentKey: "PDF",
                  pages: [{ page: 2, text: "Source evidence" }],
                }
              : {
                  libraryID: 1,
                  key: "PDF",
                  attachmentKey: "PDF",
                  offset: Number(args.offset ?? 0),
                  totalAnnotations: 41,
                  snapshot: "unchanged-comments",
                  annotations: Array.from(
                    { length: Number(args.offset) === 32 ? 9 : 16 },
                    (_, i) => ({
                      key: `mark-${Number(args.offset ?? 0) + i}`,
                      comment: "Detailed saved comment. ".repeat(100),
                    }),
                  ),
                  nextOffset:
                    Number(args.offset) === 32
                      ? null
                      : Number(args.offset ?? 0) + 16,
                },
        }),
      },
      openaiAdapter: () => ({
        complete: async (request: ModelRequest) => {
          round++;
          clock += 20000;
          if (round === 1)
            return calls("artifact_upsert", {
              id: "report",
              kind: "deep_read",
              title: "Report",
              status: "draft",
              body: {
                type: "markdown",
                markdown: edits.map((edit) => edit.oldText).join("\n"),
              },
              sourceContextIds: ["item:1:PAPER"],
            });
          if (round === 2) return calls("artifact_patch", patch);
          if (round === 3)
            return {
              toolCalls: [
                ...calls("get_pages", {
                  libraryID: 1,
                  key: "PAPER",
                  start: 2,
                  end: 2,
                }).toolCalls,
                ...calls("get_annotations", {
                  libraryID: 1,
                  key: "PDF",
                  offset: 0,
                  limit: 16,
                }).toolCalls,
              ],
            };
          if (round === 4) {
            const review = request.messages.find((message) =>
              message.content.startsWith("Review inputs"),
            );
            assert.ok(review);
            const inputs = JSON.parse(
              review.content.split("\n").slice(1).join("\n"),
            );
            assert.equal(inputs.savedAnnotations[0].annotations.length, 16);
            assert.equal(inputs.pendingCorrections[0].args.edits.length, 5);
            return calls("artifact_patch", patch);
          }
          if (round === 5) {
            const receipt = request.messages.findLast(
              (message) =>
                message.role === "tool" &&
                JSON.parse(message.content).toolName === "artifact_patch",
            );
            assert.ok(receipt);
            assert.match(
              JSON.parse(receipt.content).message,
              /16\/41.*offset=16/,
            );
            return calls("get_annotations", {
              libraryID: 1,
              key: "PDF",
              offset: 16,
              limit: 16,
            });
          }
          if (round === 6)
            return calls("get_annotations", {
              libraryID: 1,
              key: "PDF",
              offset: 32,
              limit: 16,
            });
          if (round === 7) return calls("artifact_patch", patch);
          return { text: "Five verified corrections saved." };
        },
      }),
    });
    const stopped =
      deferred<Parameters<NonNullable<BackendCallbacks["stopped"]>>[0]>();
    const native = Reflect.get(host, "nativeExecution").bind(host);
    await native(
      {
        task: state.record,
        turnId: state.activeTurnId,
        prompt: "Review",
        mode: "agent",
        capabilityProfile: "zotero_only",
      },
      {
        event: (event: ConfuciusEvent) => {
          Reflect.get(host, "recordTaskTrace").call(host, state, event);
          state.events.push(event);
        },
        stopped: stopped.resolve,
        disconnected: (error: Error) => {
          throw error;
        },
      },
    );
    const outcome = await stopped.promise;
    assert.equal(outcome.stopReason, "completed", JSON.stringify(outcome));
    const saved = (await artifacts.get("report"))!;
    assert.equal(saved.revision, 2);
    assert.equal(saved.status, "ready");
    assert.deepEqual(saved.body, {
      type: "markdown",
      markdown: edits.map((edit) => edit.newText).join("\n"),
    });
    assert.equal(
      state.events.filter((event) => event.type === "source_read_delivered")
        .length,
      4,
    );
    assert.ok(
      state.events.some(
        (event) =>
          event.type === "tool_result" &&
          event.payload.result.ok &&
          event.payload.result.toolName === "get_annotations" &&
          (event.payload.result.data as { archivedRef?: unknown }).archivedRef,
      ),
    );
    assert.equal(state.latestCheckpoint?.savedAt, startedAt + round * 20000);
    const savedEvent = state.events.find(
      (event) =>
        event.type === "artifact_upserted" &&
        event.payload.artifact.revision === 2,
    )!;
    const receipt = state.events.findLast(
      (event) =>
        event.type === "tool_result" &&
        event.payload.result.ok &&
        event.payload.result.toolName === "artifact_patch",
    )!;
    assert.ok(receipt.ts >= savedEvent.ts);
    assert.ok(receipt.sequence! > savedEvent.sequence!);
    assert.equal(
      receipt.type === "tool_result" &&
        receipt.payload.result.ok &&
        (receipt.payload.result.data as { appliedEditCount: number })
          .appliedEditCount,
      5,
    );
    const lastSequence = state.record.eventSequence!;
    // Restart the event producer with persisted state and a clock moving back.
    const restarted = fixture().host;
    clock -= 10000;
    Reflect.get(restarted, "recordTaskTrace").call(restarted, state, {
      id: "after-restart",
      sessionId: state.record.id,
      type: "text_delta",
      ts: clock,
      payload: { text: "continued" },
    });
    assert.equal(state.record.eventSequence, lastSequence + 1);
  } finally {
    Reflect.set(globalThis, "Zotero", previousZotero);
  }
});

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail("Lifecycle did not reach the expected state");
}

it("prepared MCP sessions may discover a directory but cannot execute before activation", () => {
  const { host, state } = fixture();
  state.record.run = run(state.record);
  state.activeTurnId = "prepare-turn";
  const capabilities = new PluginRuntimeCapabilityStore();
  const lease = capabilities.reserve({
    taskId: state.record.id,
    runId: state.record.run.id,
    turnId: state.activeTurnId,
    generation: state.record.run.generation,
  });
  state.record.contextSwitch = {
    version: 1,
    id: "switch",
    binding: executionBinding(state.record.run)!,
    handoffId: "handoff",
    from: state.record.contextWindow!,
    to: { ...state.record.contextWindow!, id: "next", number: 2 },
    phase: "prepared",
    createdAt: 1,
  };
  Object.assign(host, {
    pluginRuntime: {
      isCurrentLease: capabilities.isCurrent.bind(capabilities),
      isKnownLease: capabilities.isKnown.bind(capabilities),
    },
  });
  const validate = Reflect.get(host, "validatedRuntimeLease").bind(host);
  assert.equal(validate(state, lease, true, true), lease);
  assert.throws(() => validate(state, lease, true), /expired/);
  state.record.run.generation++;
  assert.throws(() => validate(state, lease, true, true), /expired/);
});

it("CLI save echoes and text fragments do not invalidate a complete handoff or add model calls", async () => {
  const { host, state } = fixture();
  state.record.run = run(state.record);
  state.activeTurnId = "handoff-turn";
  const history = Reflect.get(host, "history") as HistoryStore;
  await history.append({
    taskId: state.record.id,
    windowId: state.record.contextWindow!.id,
    itemId: "user",
    role: "user",
    content: "Continue",
    sourceIds: [],
  });
  await history.writeNote(
    state.record.id,
    "progress",
    "switched=true; current evidence is sufficient",
    undefined,
    {
      version: 1,
      binding: executionBinding(state.record.run)!,
      throughItemId: "user",
      evidenceRefs: [],
      nextAction: "Output the verified marker",
    },
  );
  Object.assign(host, {
    queueHistory: async (entry: {
      items: import("@confucius/memory").HistoryAppend[];
    }) => {
      for (const item of entry.items) await history.append(item);
    },
    auxiliaryAdapter: () =>
      assert.fail("complete handoff must not call a model"),
  });
  const capture = Reflect.get(host, "captureExternalHistory").bind(host);
  capture(state, {
    id: "echo",
    sessionId: state.record.id,
    turnId: state.activeTurnId,
    ts: 2,
    type: "tool_result",
    payload: {
      callId: "save",
      result: {
        ok: true,
        toolName: "runtime.tool",
        data: JSON.stringify({
          ok: true,
          toolName: "context_save",
          data: { saved: true },
        }),
      },
    },
  });
  capture(state, {
    id: "fragment",
    sessionId: state.record.id,
    turnId: state.activeTurnId,
    ts: 3,
    type: "text_delta",
    payload: { text: "Now switching" },
  });
  await history.flush();
  assert.equal(await history.head(state.record.id), "user");
  await Reflect.get(host, "prepareHandoff").call(host, state);
  assert.equal(state.record.contextHandoff?.supplemented, false);
  assert.equal(
    state.record.contextHandoff?.nextAction,
    "Output the verified marker",
  );
});

for (const backendKind of ["codex", "kimi"] as const) {
  it(`${backendKind} switches the engine session while retaining task notes, outputs and budget`, async () => {
    const { host, state, backend } = fixture();
    state.record.backend = backendKind;
    state.record.run = run(state.record);
    state.activeTurnId = "switch-turn";
    state.record.externalSessionId = "old-engine-session";
    state.record.externalTurnId = "old-engine-turn";
    state.record.artifactIds = ["saved-report"];
    state.externalSourceScope = { itemRefs: new Set(["1:PAPER"]) };
    state.messages = [{ role: "user", content: "OLD_ENGINE_TRANSCRIPT" }];
    const before = { ...state.record.run.budget };
    const direct = host as unknown as {
      history: HistoryStore;
      switchExternalContext(state: TestState): Promise<void>;
    };
    await direct.history.writeNote(
      state.record.id,
      "progress",
      "Continue with source 1:PAPER, report saved-report",
      ["1:PAPER"],
      {
        version: 1,
        binding: executionBinding(state.record.run)!,
        evidenceRefs: [],
      },
    );
    await direct.history.writeNote(
      state.record.id,
      "other",
      "OUTSIDE_SOURCE_SCOPE",
      ["1:OTHER"],
    );
    await direct.history.writeNote(
      state.record.id,
      "legacy",
      "UNSCOPED_LEGACY_NOTE",
    );
    let disposed = 0;
    backend.dispose = async () => {
      disposed++;
    };
    Object.assign(backend, {
      prepareSession: async () => ({ externalSessionId: "prepared-session" }),
    });
    await direct.switchExternalContext(state);
    assert.equal(
      disposed,
      0,
      "old runtime is released only after successful activation",
    );
    assert.equal(state.record.externalSessionId, "prepared-session");
    assert.equal(state.record.contextSwitch?.phase, "committed");
    assert.equal(state.record.externalTurnId, undefined);
    assert.equal(state.record.contextWindow!.number, 2);
    assert.deepEqual(state.record.artifactIds, ["saved-report"]);
    assert.deepEqual(state.record.run.budget, before);
    assert.match(JSON.stringify(state.record.contextHandoff), /1:PAPER/);
    assert.doesNotMatch(
      JSON.stringify(state.record.contextHandoff),
      /OLD_ENGINE_TRANSCRIPT|OUTSIDE_SOURCE_SCOPE|UNSCOPED_LEGACY_NOTE/,
    );
  });
}

function toolResult(response: McpToolCallResult): ToolResult {
  const content = response.content[0];
  if (content.type !== "text") throw new Error("Missing tool receipt");
  return JSON.parse(content.text) as ToolResult;
}

describe("configured research response language", () => {
  for (const language of ["zh-CN", "en-US"] as const) {
    it(`injects ${language} into native and continued external prompts`, async () => {
      const previous = Reflect.get(globalThis, "Zotero");
      Reflect.set(globalThis, "Zotero", {
        locale: language === "zh-CN" ? "en-US" : "zh-CN",
        Prefs: { get: () => language },
      });
      try {
        const { host, state } = fixture();
        const prompts = host as unknown as {
          buildSystemPrompt(
            text: string,
            options: Record<string, unknown>,
          ): Promise<string>;
          externalPrompt(
            task: ResearchTaskRecord,
            text: string,
            history: ModelMessage[],
          ): string;
        };
        const native = await prompts.buildSystemPrompt(
          "Read an English paper",
          {
            planMode: false,
            skills: [],
            loadedSkills: [],
            lockedContext: state.record.lockedContext,
            includeRecallContext: false,
          },
        );
        state.record.externalSessionId = "continued-session";
        const external = prompts.externalPrompt(
          state.record,
          "Repair remaining annotations",
          [{ role: "assistant", content: "Earlier English output" }],
        );
        const instruction = responseLanguageInstruction(language);
        assert.ok(native.includes(instruction));
        assert.ok(external.includes(instruction));
        assert.match(instruction, /quote/);
      } finally {
        Reflect.set(globalThis, "Zotero", previous);
      }
    });
  }
});

describe("task sources attached after choosing a research mode", () => {
  let previousZotero: unknown;
  let previousAddon: unknown;
  beforeEach(() => {
    previousZotero = Reflect.get(globalThis, "Zotero");
    previousAddon = Reflect.get(globalThis, "addon");
    Reflect.set(globalThis, "addon", { data: {} });
    Reflect.set(globalThis, "Zotero", {
      locale: "en-US",
      Prefs: { get: () => "en-US" },
      Items: {
        getByLibraryAndKey: (libraryID: number, key: string) => ({
          libraryID,
          key,
          getDisplayTitle: () => `Mentioned paper ${key}`,
          getAttachments: () => [key === "A" ? 10 : 20],
        }),
        get: (id: number) => ({
          libraryID: 1,
          key: id === 10 ? "PDF_A" : "PDF_B",
          attachmentContentType: "application/pdf",
        }),
      },
    });
  });
  afterEach(() => {
    Reflect.set(globalThis, "Zotero", previousZotero);
    Reflect.set(globalThis, "addon", previousAddon);
  });

  for (const backend of ["native", "codex", "kimi"] as const) {
    for (const mode of ["agent", "plan"] as const) {
      it(`${backend}/${mode} starts all paper templates with later @ sources and no open PDF`, async () => {
        for (const template of TASK_TEMPLATES.filter(
          (t) => t.source !== "selection",
        )) {
          const { host, state, starts, backend: runtime } = fixture();
          let sourceScope: Set<string> | undefined;
          const startTurn = runtime.startTurn;
          runtime.startTurn = (input, callbacks) => {
            sourceScope = state.externalSourceScope?.itemRefs;
            return startTurn(input, callbacks);
          };
          state.record.backend = backend;
          state.record.mode = mode;
          Object.assign(host, { requireEndpoint: () => ({}) });
          await host.rpc("task/stageTemplate", {
            taskId: state.record.id,
            templateId: template.id,
          });
          if (template.source !== "any") {
            await assert.rejects(
              host.sessionPrompt(state.record.id, "Read the task sources"),
              /workspace-template-context-(single|multi)_required/,
            );
            assert.equal(starts.length, 0);
          }
          const mentions = new LibraryMentionSources(
            async (taskId, context) => {
              await host.rpc("task/setContext", {
                taskId,
                mode: "add",
                context,
              });
            },
          );
          for (const key of template.source === "multi" ? ["A", "B"] : ["A"]) {
            mentions.add(state.record.id, {
              libraryID: 1,
              key,
              title: `Mentioned paper ${key}`,
              creators: [],
              year: "2026",
              itemType: "journalArticle",
            });
          }
          await mentions.flush(state.record.id);
          // Staging again must preserve the newly attached task sources.
          await host.rpc("task/stageTemplate", {
            taskId: state.record.id,
            templateId: template.id,
          });
          await host.sessionPrompt(state.record.id, "Read the task sources");
          await waitFor(() => state.activeTurnId === null);
          assert.ok(starts.length > 0, template.id);
          const input = starts[0];
          assert.equal(input.task.backend, backend);
          assert.equal(input.mode, mode);
          assert.equal(input.task.run!.sources.reader, undefined);
          assert.deepEqual(
            input.task.run!.sources.items.map((item) => item.key),
            template.source === "multi" ? ["A", "B"] : ["A"],
            template.id,
          );
          assert.equal(input.task.context.item?.key, "A");
          if (
            mode === "agent" &&
            ["deep-read", "evidence-audit", "synthesis"].includes(template.id)
          ) {
            assert.match(input.workflowInstruction!, /Mentioned paper A/);
            assert.match(input.workflowInstruction!, /attachmentKey=PDF_A/);
            assert.ok(sourceScope?.has("1:PDF_A"));
          }
        }
      });
    }
  }
});

describe("starting tasks with multiple PDF attachments", () => {
  let previousZotero: unknown;
  beforeEach(() => {
    previousZotero = Reflect.get(globalThis, "Zotero");
    const paper = {
      id: 1,
      libraryID: 1,
      key: "PAPER",
      getDisplayTitle: () => "A paper with supplementary information",
      getAttachments: () => [2, 3],
    };
    const pdfs = ["MAINPDF", "SUPPPDF"].map((key, index) => ({
      id: index + 2,
      libraryID: 1,
      key,
      parentItemID: 1,
      isAttachment: () => true,
      attachmentContentType: "application/pdf",
      attachmentFilename: index ? "supplement.pdf" : "paper.pdf",
      getDisplayTitle: () =>
        index ? "Supplementary information" : "Main paper",
      getAnnotations: () => [],
    }));
    const items = [paper, ...pdfs];
    Reflect.set(globalThis, "Zotero", {
      locale: "en-US",
      Prefs: { get: () => "en-US" },
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: (libraryID: number, key: string) =>
          items.find(
            (item) => item.libraryID === libraryID && item.key === key,
          ),
        get: (id: number) => items.find((item) => item.id === id),
      },
      Collections: {
        getByLibraryAndKey: () => ({ getChildItems: () => [paper] }),
      },
    });
  });
  afterEach(() => Reflect.set(globalThis, "Zotero", previousZotero));

  function multiPdfFixture(backend: ResearchTaskRecord["backend"]) {
    const test = fixture();
    const tools = new ZoteroToolHost(memoryJsonStorage());
    Reflect.deleteProperty(test.host, "freezeBoundAnnotations");
    Object.assign(test.host, { tools, requireEndpoint: () => ({}) });
    test.state.record.backend = backend;
    test.state.record.lockedContext.items = [
      {
        id: "paper",
        libraryID: 1,
        key: "PAPER",
        title: "Selected paper",
        source: "library",
      },
    ];
    return { ...test, tools };
  }

  for (const backend of ["native", "codex", "kimi"] as const) {
    it(`${backend} starts ordinary, single-paper and collection tasks without choosing a PDF`, async () => {
      for (const templateId of [undefined, "deep-read", "synthesis"] as const) {
        const { host, state, starts, tools } = multiPdfFixture(backend);
        state.record.templateId = templateId;
        if (templateId === "synthesis") {
          state.record.lockedContext.items = [];
          state.record.lockedContext.collection = {
            id: "collection",
            libraryID: 1,
            key: "COLLECTION",
            name: "Selected collection",
          };
        }
        await host.sessionPrompt(
          state.record.id,
          "Read the main paper and its supplement",
        );
        await waitFor(() => state.activeTurnId === null);
        assert.ok(starts.length, templateId);
        assert.ok(!state.events.some((event) => event.type === "turn_failed"));
        if (templateId) {
          assert.match(starts[0].workflowInstruction!, /attachmentKey=MAINPDF/);
          assert.match(starts[0].workflowInstruction!, /attachmentKey=SUPPPDF/);
          assert.match(starts[0].workflowInstruction!, /supplement\.pdf/);
        }
        for (const key of ["MAINPDF", "SUPPPDF"])
          assert.equal(
            Object.keys((await tools.ownership.read(`1_${key}`)).batches)
              .length,
            1,
          );
      }
    });

    it(`${backend} keeps the PDF selected in the locked reader instead of widening to its siblings`, async () => {
      const { host, state, starts, tools } = multiPdfFixture(backend);
      state.record.templateId = "deep-read";
      state.record.lockedContext.reader = {
        id: "reader",
        libraryID: 1,
        parentKey: "PAPER",
        attachmentKey: "SUPPPDF",
        title: "Supplementary information",
        pageLabel: "1",
        pageIndex: 0,
      };
      await host.sessionPrompt(state.record.id, "Read the selected supplement");
      await waitFor(() => state.activeTurnId === null);
      assert.ok(starts.length);
      assert.match(starts[0].workflowInstruction!, /attachmentKey=SUPPPDF/);
      assert.doesNotMatch(starts[0].workflowInstruction!, /MAINPDF/);
      assert.equal(
        Object.keys((await tools.ownership.read("1_MAINPDF")).batches).length,
        0,
      );
      assert.equal(
        Object.keys((await tools.ownership.read("1_SUPPPDF")).batches).length,
        1,
      );
    });
  }
});

describe("AgentHost lifecycle ownership", () => {
  let previousZotero: unknown;
  beforeEach(() => {
    previousZotero = Reflect.get(globalThis, "Zotero");
    Reflect.set(globalThis, "Zotero", {
      locale: "en-US",
      Prefs: { get: () => "en-US" },
    });
  });
  afterEach(() => {
    Reflect.set(globalThis, "Zotero", previousZotero);
  });

  it("retains articles from submitted turns when the next message changes sources", async () => {
    const { host, state } = fixture();
    for (const key of ["ARTICLE_A", "ARTICLE_B", "ARTICLE_A"]) {
      state.record.lockedContext = {
        version: 1,
        capturedAt: Date.now(),
        fingerprint: key,
        items: [
          {
            id: `item:1:${key}`,
            libraryID: 1,
            key,
            title: key,
            source: "reader",
          },
        ],
      };
      await host.sessionPrompt(state.record.id, `Read ${key}`);
      await waitFor(() => state.activeTurnId === null);
    }
    assert.deepEqual(
      state.record.articleSources?.map((item) => item.key),
      ["ARTICLE_A", "ARTICLE_B"],
    );
  });

  it("keeps legacy artifact calls working through the external gateway without write approvals", async () => {
    const { host, state } = fixture();
    const files = new Map<string, string>();
    const artifacts = new ArtifactStore("artifacts", {
      exists: async (path) => files.has(path),
      read: async (path) => files.get(path)!,
      writeAtomic: async (path, text) => {
        files.set(path, text);
      },
      makeDirectory: async () => {},
    });
    Object.assign(host, { artifacts });
    host.requestToolApproval = async () =>
      assert.fail("No Zotero write to approve");
    const body = { type: "markdown" as const, markdown: "Evidence" };
    const foreign = await artifacts.upsert(
      {
        id: "paper-report",
        taskId: "other-task",
        kind: "report",
        title: "Old report",
        body,
      },
      "native",
    );
    const save = (args: Record<string, unknown>) =>
      host.taskToolCall({
        taskId: state.record.id,
        name: "artifact_upsert",
        arguments: { kind: "report", title: "Report", body, ...args },
      });
    const invalid = toolResult(
      await save({ id: foreign.id, taskId: state.record.id }),
    );
    assert.equal(!invalid.ok && invalid.code, "invalid_args");
    const created = toolResult(await save({ taskId: "other-task" }));
    assert.equal(created.ok, true);
    const id = state.record.artifactIds[0];
    assert.ok(id);
    assert.equal((await artifacts.get(id))?.taskId, state.record.id);
    const revised = toolResult(await save({ id, taskId: "other-task" }));
    assert.equal(revised.ok, true);
    assert.equal((await artifacts.get(id))?.revision, 2);
    const read = toolResult(
      await host.taskToolCall({
        taskId: state.record.id,
        name: "artifact_read",
        arguments: { id },
      }),
    );
    assert.equal(read.ok, true);
    assert.equal(
      read.ok && (read.data as { content: string }).content,
      "Evidence",
    );
    const patched = toolResult(
      await host.taskToolCall({
        taskId: state.record.id,
        name: "artifact_patch",
        arguments: {
          id,
          expectedRevision: 2,
          edits: [{ oldText: "Evidence", newText: "Reviewed evidence" }],
        },
      }),
    );
    assert.equal(patched.ok, true);
    assert.deepEqual((await artifacts.get(id))?.body, {
      type: "markdown",
      markdown: "Reviewed evidence",
    });
    assert.equal((await artifacts.get(id))?.revision, 3);
    const windowRecord = (await host.rpc("artifact/get", { id })) as {
      artifact: { revision: number };
      taskStatus: string | null;
    };
    assert.equal(windowRecord.artifact.revision, 3);
    assert.equal(windowRecord.taskStatus, state.record.status);
    const orphanWindow = (await host.rpc("artifact/get", {
      id: foreign.id,
    })) as {
      taskStatus: string | null;
    };
    assert.equal(orphanWindow.taskStatus, null);
    assert.deepEqual(await artifacts.get(foreign.id), foreign);
    assert.equal(files.size, 2);
    assert(!state.events.some((event) => event.type === "approval_required"));
  });

  it("remembers allow-for-task for the approved tool and still asks for a different write tool", async () => {
    const { host, state } = fixture();
    state.record.backend = "native";
    Object.assign(host, {
      pendingApprovals: new Map(),
      describeApprovalCall: () => "PDF",
    });
    const first = host.requestToolApproval(
      state,
      "turn",
      "first",
      "commit_annotations",
      {},
    );
    assert.equal(
      state.events.filter((e) => e.type === "approval_required").length,
      1,
    );
    host.approvalResolve({
      id: "approval_first",
      verdict: "allow",
      scope: "session",
    });
    assert.equal((await first).verdict, "allow");
    assert.deepEqual([...state.sessionGrants], ["commit_annotations"]);
    const again = await host.requestToolApproval(
      state,
      "later-turn",
      "second",
      "commit_annotations",
      {},
    );
    assert.equal(again.verdict, "allow");
    assert.equal(
      state.events.filter((e) => e.type === "approval_required").length,
      1,
    );
    const different = host.requestToolApproval(
      state,
      "later-turn",
      "third",
      "create_note",
      {},
    );
    assert.equal(
      state.events.filter((e) => e.type === "approval_required").length,
      2,
    );
    host.approvalResolve({
      id: "approval_third",
      verdict: "deny",
      scope: "once",
    });
    assert.equal((await different).verdict, "deny");
    assert.deepEqual([...state.sessionGrants], ["commit_annotations"]);
  });

  for (const ending of [
    "completed",
    "aborted",
    "error",
    "signal",
    "incomplete",
  ] as const) {
    it(`keeps tool commentary out of the final reply when execution ends with ${ending}`, async () => {
      const { host, state, backend } = fixture();
      state.record.backend = "native";
      state.record.run = run(state.record);
      state.abort = new AbortController();
      state.activeTurnId = "turn-output";
      const controller = state.abort;
      const preambles = [
        "I will read the paper.",
        "\n\n",
        "Now I will save annotations.",
      ];
      const answer =
        ending === "completed"
          ? "The report is ready."
          : ending === "incomplete"
            ? "The report is partially written."
            : "";
      Object.assign(host, {
        memoryConsent: () => "off",
        finalizeTaskTitle: async () => undefined,
      });
      backend.startTurn = async (input, callbacks) => {
        let sequence = 0;
        const emit = (
          type: ConfuciusEvent["type"],
          payload: ConfuciusEvent["payload"],
        ) =>
          callbacks.event({
            id: `output-${++sequence}`,
            sessionId: state.record.id,
            turnId: input.turnId,
            ts: sequence,
            type,
            payload,
          } as ConfuciusEvent);
        for (const [index, text] of preambles.entries()) {
          emit("text_delta", { text: text.slice(0, 5) });
          emit("text_delta", { text: text.slice(5) });
          emit("tool_requested", {
            callId: `tool-${index}`,
            toolName: index ? "commit_annotations" : "get_pages",
            args: {},
          });
        }
        if (answer) {
          emit("text_delta", { text: "The report " });
          if (ending === "completed") emit("text_delta", { text: "is ready." });
        }
        if (ending === "signal") controller.abort();
        else
          callbacks.stopped?.({
            stopReason: ending,
            // Native TurnLoop and older runtime adapters return all model rounds.
            text: preambles.join("") + answer,
          });
        return {};
      };
      const result = await host.executeBackend(
        state,
        {
          task: state.record,
          turnId: state.activeTurnId,
          prompt: "Read and annotate",
          mode: "agent",
          capabilityProfile: "zotero_only",
        },
        controller.signal,
      );
      assert.equal(result.text, answer);
      await host.finalizeRun(
        state,
        state.record.run,
        "turn-output",
        {
          ...result,
          work: { completed: [], missing: [], unknownOperationIds: [] },
        },
        () => true,
      );
      const textEvents = state.events.filter(
        (event) => event.type === "text_delta",
      );
      assert.deepEqual(
        textEvents.map((event) => event.payload),
        [
          ...preambles
            .filter((text) => text.trim())
            .map((text) => ({ text, phase: "commentary" })),
          ...(answer ? [{ text: answer, phase: "final_answer" }] : []),
        ],
      );
      const blocks = coalesceTimeline(state.events);
      assert.deepEqual(
        blocks
          .filter((block) => block.kind === "text")
          .map((block) => block.text),
        answer ? [answer] : [],
      );
      assert.deepEqual(
        blocks
          .filter((block) => block.kind === "commentary")
          .map((block) => block.text),
        [preambles.filter((text) => text.trim()).join("\n\n")],
      );
    });
  }

  it("shows a Codex preamble before a host MCP tool and keeps it through stream retry", async () => {
    const { host, state, backend } = fixture();
    Reflect.deleteProperty(host, "emitSessionEvent");
    state.record.run = run(state.record);
    state.activeTurnId = "host-tool-route";
    const direct = host as unknown as {
      emitSessionEvent(
        state: TestState,
        turnId: string,
        type: string,
        payload: unknown,
      ): void;
    };
    backend.startTurn = async (input, callbacks) => {
      callbacks.event({
        id: "preamble",
        sessionId: state.record.id,
        turnId: input.turnId,
        ts: 10,
        type: "text_delta",
        payload: { text: "I will read the paper." },
      });
      assert.equal(
        state.events.filter((e) => e.type === "text_delta").length,
        0,
      );
      direct.emitSessionEvent(state, input.turnId, "tool_requested", {
        callId: "read",
        toolName: "get_pages",
        args: {},
      });
      assert.equal(
        state.events.filter((e) => e.type === "text_delta").length,
        1,
      );
      callbacks.event({
        id: "retry",
        sessionId: state.record.id,
        turnId: input.turnId,
        ts: 20,
        type: "model_request_progress",
        payload: {
          requestId: "provider",
          scope: "provider",
          attempt: 1,
          status: "failed",
          retryable: true,
        },
      });
      callbacks.stopped?.({ stopReason: "incomplete", text: "" });
      return {};
    };
    const result = await host.executeBackend(
      state,
      {
        task: state.record,
        turnId: state.activeTurnId,
        prompt: "Read",
        mode: "agent",
        capabilityProfile: "zotero_only",
      },
      new AbortController().signal,
    );
    assert.equal(result.text, "");
    assert.deepEqual(
      state.events.filter((e) => e.type === "text_delta").map((e) => e.payload),
      [{ text: "I will read the paper.", phase: "commentary" }],
    );
    assert.equal(state.record.run.providerRequest?.status, "failed");
    assert.equal(state.record.run.lastError?.request.requestId, "provider");
  });

  it("CLI stream retries replace unfinished text and exhausted output stays diagnostic", async () => {
    const { host, state, backend } = fixture();
    state.record.backend = "codex";
    state.record.run = run(state.record);
    state.abort = new AbortController();
    state.activeTurnId = "cli-output";
    Object.assign(host, {
      externalHistoryText: new Map(),
      memoryConsent: () => "off",
    });
    backend.startTurn = async (input, callbacks) => {
      let sequence = 0;
      const emit = (
        type: ConfuciusEvent["type"],
        payload: ConfuciusEvent["payload"],
      ) =>
        callbacks.event({
          id: `cli-${++sequence}`,
          sessionId: state.record.id,
          turnId: input.turnId,
          ts: sequence,
          type,
          payload,
        } as ConfuciusEvent);
      emit("text_delta", { text: "Failed fragment" });
      emit("model_request_progress", {
        requestId: "cli-output",
        attempt: 1,
        status: "failed",
        retryable: true,
      });
      emit("text_delta", { text: "Replacement fragment" });
      callbacks.stopped?.({
        stopReason: "incomplete",
        text: "",
        failure: { retryable: true, message: "stream disconnected" },
      });
      return {};
    };
    const result = await host.executeBackend(
      state,
      {
        task: state.record,
        turnId: state.activeTurnId,
        prompt: "Read",
        mode: "agent",
        capabilityProfile: "zotero_only",
      },
      state.abort.signal,
    );
    assert.equal(result.text, "Replacement fragment");
    await host.finalizeRun(
      state,
      state.record.run,
      "cli-output",
      {
        ...result,
        stopReason: "model_retries_exhausted",
        work: { completed: [], missing: [], unknownOperationIds: [] },
      },
      () => true,
    );
    assert.equal(
      state.events.some(
        (event) =>
          event.type === "text_delta" && event.payload.phase === "final_answer",
      ),
      false,
    );
    assert.equal(
      state.messages.some(
        (message) =>
          message.role === "assistant" &&
          String(message.content).includes("fragment"),
      ),
      false,
    );
    assert.ok(state.record.recoverableTurn);
  });

  it("stores the model effort confirmed by the external runtime for later turns", async () => {
    const { host, state, backend } = fixture();
    state.record.backend = "kimi";
    state.record.runtimeModel = { modelId: "k3", reasoningEffort: "on" };
    state.record.run = run(state.record);
    state.activeTurnId = "effort-selection";
    let callbacks: BackendCallbacks | undefined;
    backend.startTurn = async (_input, received) => {
      callbacks = received;
      return {
        externalSessionId: "session",
        runtimeModel: { modelId: "k3", reasoningEffort: "max" },
      };
    };
    const pending = host.executeBackend(
      state,
      {
        task: state.record,
        turnId: state.activeTurnId,
        prompt: "Continue",
        mode: "agent",
        capabilityProfile: "zotero_only",
      },
      new AbortController().signal,
    );
    await waitFor(() => state.record.runtimeModel?.reasoningEffort === "max");
    assert.deepEqual(state.record.runtimeModel, {
      modelId: "k3",
      reasoningEffort: "max",
    });
    callbacks!.stopped?.({ stopReason: "completed", text: "Done" });
    await pending;
  });

  it("bounds a live but silent external process and ignores output after its lease expires", async () => {
    const { host, state, backend } = fixture();
    state.record.run = run(state.record);
    state.activeTurnId = "silent-runtime";
    const previous = Reflect.get(Zotero, "getMainWindow");
    let tick: (() => void) | undefined;
    let delay = 0;
    Reflect.set(Zotero, "getMainWindow", () => ({
      setTimeout: (callback: () => void, ms: number) => {
        tick = callback;
        delay = ms;
        return 1;
      },
      clearTimeout: () => {
        tick = undefined;
      },
    }));
    try {
      let callbacks: BackendCallbacks | undefined;
      backend.startTurn = async (_input, received) => {
        callbacks = received;
        return {};
      };
      const pending = host.executeBackend(
        state,
        {
          task: state.record,
          turnId: state.activeTurnId,
          prompt: "Read",
          mode: "agent",
          capabilityProfile: "zotero_only",
        },
        new AbortController().signal,
      );
      await waitFor(() => !!callbacks);
      callbacks!.event({
        id: "retry",
        sessionId: state.record.id,
        turnId: state.activeTurnId,
        type: "model_request_progress",
        payload: {
          requestId: "r",
          attempt: 1,
          status: "failed",
          retryable: true,
        },
        ts: 1,
      });
      assert.equal(delay, 120_000);
      tick!();
      const result = await pending;
      assert.equal(result.stopReason, "incomplete");
      assert.equal(result.failure?.code, "runtime_idle_timeout");
      assert.equal(result.failure?.retryable, true);
      const count = state.events.length;
      callbacks!.event({
        id: "late",
        sessionId: state.record.id,
        turnId: state.activeTurnId,
        type: "text_delta",
        payload: { text: "Late text", phase: "commentary" },
        ts: 2,
      });
      assert.equal(state.events.length, count);
      assert.equal(tick, undefined);
    } finally {
      Reflect.set(Zotero, "getMainWindow", previous);
    }
  });

  it("joins a completed commentary suffix to its unphased streamed prefix", async () => {
    const { host, state, backend } = fixture();
    state.record.run = run(state.record);
    state.activeTurnId = "late-phase";
    backend.startTurn = async (input, callbacks) => {
      for (const [index, payload] of [
        { text: "I will", itemId: "a" },
        { text: " read.", phase: "commentary", itemId: "a" },
      ].entries())
        callbacks.event({
          id: String(index),
          sessionId: state.record.id,
          turnId: input.turnId,
          ts: index,
          type: "text_delta",
          payload,
        } as ConfuciusEvent);
      callbacks.stopped?.({ stopReason: "completed", text: "Done." });
      return {};
    };
    const result = await host.executeBackend(
      state,
      {
        task: state.record,
        turnId: state.activeTurnId,
        prompt: "Read",
        mode: "agent",
        capabilityProfile: "zotero_only",
      },
      new AbortController().signal,
    );
    assert.deepEqual(coalesceTimeline(state.events), [
      { kind: "commentary", text: "I will read." },
    ]);
    assert.equal(result.text, "Done.");
  });

  it("finishes a revised read-only request without reviving the prior annotation obligation", async () => {
    const { host, state, backend, starts } = fixture();
    Reflect.deleteProperty(host, "workSnapshot");
    Object.assign(host, {
      artifacts: { list: async () => [] },
      tools: {
        workForTask: async (
          _task: string,
          _since: number,
          _fingerprint: unknown,
          options: { intentRevision: number },
        ) => ({
          completed: [],
          missing:
            options.intentRevision === 1
              ? [
                  {
                    id: "prior-candidates",
                    kind: "proposal",
                    description: "Submit annotations",
                  },
                ]
              : [],
        }),
      },
    });
    backend.startTurn = async (input, callbacks) => {
      starts.push(input);
      callbacks.stopped?.({
        stopReason: "completed",
        text: "Summary from the existing evidence",
      });
      return {};
    };
    await host.sessionPrompt(state.record.id, "Prepare annotations");
    await waitFor(() => state.activeTurnId === null);
    assert.equal(state.record.run?.stopReason, "stalled");
    const oldRun = state.record.run!;
    const oldStarts = starts.length;
    await host.sessionPrompt(
      state.record.id,
      "Do not write annotations. Just give a summary.",
    );
    await waitFor(() => state.activeTurnId === null);
    assert.equal(state.record.run?.id, oldRun.id);
    assert.equal(state.record.run?.intentRevision, oldRun.intentRevision + 1);
    assert.equal(state.record.run?.status, "completed");
    assert.equal(
      starts.length,
      oldStarts + 1,
      "no continuation to submit withdrawn candidates",
    );
    assert.ok(
      state.record.run!.budget.executorStarts > oldRun.budget.executorStarts,
    );
  });

  it("continues admitted work on an explicit PDF even when the captured UI selection is another paper", async () => {
    const { host, state, backend, starts } = fixture();
    state.record.lockedContext.items = [
      {
        id: "1:OLDPAPER",
        libraryID: 1,
        key: "OLDPAPER",
        title: "Old selection",
        source: "reader",
      },
    ];
    Reflect.deleteProperty(host, "workSnapshot");
    let committed = false;
    Object.assign(host, {
      artifacts: { list: async () => [] },
      tools: {
        workForTask: async (
          _task: string,
          _since: number,
          _fingerprint: unknown,
          options: { sourceRefs?: string[] },
        ) => ({
          completed: [],
          missing:
            !committed &&
            (!options.sourceRefs || options.sourceRefs.includes("1:NEWPDF"))
              ? [
                  {
                    id: "new-pdf-proposal",
                    kind: "proposal",
                    description:
                      "Submit the explicitly requested new PDF candidates",
                  },
                ]
              : [],
        }),
      },
    });
    backend.startTurn = async (input, callbacks) => {
      starts.push(input);
      callbacks.stopped?.({
        stopReason: "completed",
        text: "Candidate prepared",
      });
      return {};
    };
    await host.sessionPrompt(state.record.id, "Annotate NEWPDF");
    await waitFor(() => state.activeTurnId === null);
    assert.equal(state.record.run?.stopReason, "stalled");
    assert.equal(state.record.run?.status, "interrupted");
    assert.ok(
      starts.length > 1,
      "known unsubmitted candidates trigger continuation",
    );
    assert.equal(
      state.events.filter((event) => event.type === "turn_completed").length,
      0,
    );
    const previousRun = state.record.run!;
    const snapshot = await host.workSnapshot(state);
    assert.equal(snapshot.missing[0]?.id, "new-pdf-proposal");

    state.externalSourceScope = { itemRefs: new Set(["1:OLDPAPER"]) };
    assert.equal(
      (await host.workSnapshot(state)).missing.length,
      0,
      "an enforced preset source boundary still applies",
    );
    state.externalSourceScope = undefined;
    committed = true;
    await host.taskContinue(state.record.id);
    await waitFor(() => state.activeTurnId === null);
    assert.equal(state.record.run?.status, "completed");
    assert.equal(state.record.run?.id, previousRun.id);
    assert.ok(
      state.record.run!.budget.executorStarts >
        previousRun.budget.executorStarts,
    );
  });

  for (const runtimeFailure of [false, true]) {
    it(`cancels tasks and writes the final recovery snapshot before clearing sessions${runtimeFailure ? " even after runtime disposal fails" : ""}`, async () => {
      const { host, state } = fixture();
      const previousZotero = Reflect.get(globalThis, "Zotero");
      const previousToolkit = Reflect.get(globalThis, "ztoolkit");
      const clearedTimers: number[] = [];
      Reflect.set(globalThis, "Zotero", {
        getMainWindows: () => [
          { clearTimeout: (id: number) => clearedTimers.push(id) },
        ],
      });
      Reflect.set(globalThis, "ztoolkit", { log() {} });
      const controller = new AbortController();
      state.abort = controller;
      state.activeTurnId = "active-turn";
      state.record.run = run(state.record);
      state.record.run.budget.toolCallsUsed = 3;
      const completed = fixture().state;
      completed.record.id = "completed-task";
      completed.record.status = "completed";
      completed.record.run = run(completed.record);
      completed.record.run.status = "completed";
      completed.record.run.budget.modelRequestsObservable = true;
      completed.record.run.budget.elapsedMs = 200;
      completed.runBudget = new BudgetAccountant(
        { maxIterations: 8, maxToolCalls: 20 },
        () => 10_000,
      );
      completed.runBudget.restoreMax({ elapsedMs: 10_000 });
      const completedBefore = structuredClone(completed.record);
      const sessions = new Map([
        [state.record.id, state],
        [completed.record.id, completed],
      ]);
      const snapshots: ResearchTaskRecord[][] = [];
      const saving = deferred<void>();
      let denials = 0;
      let disposed = 0;
      const pendingApprovals = new Map([
        [
          "approval",
          {
            sessionId: state.record.id,
            resolve: (resolution: ApprovalResolution) => {
              assert.equal(resolution.verdict, "deny");
              state.record.status = "running";
              denials++;
            },
          },
        ],
      ]);
      Reflect.deleteProperty(host, "persistNow");
      Reflect.deleteProperty(host, "persistSoon");
      Object.assign(host, {
        sessions,
        pendingApprovals,
        listeners: new Set(),
        titleFinalizers: new Map(),
        persistQueue: Promise.resolve(),
        persistTimer: 19,
        backendFor: () => ({
          dispose: async () => {
            disposed++;
          },
        }),
        pluginRuntime: {
          shutdown: async () => {
            if (runtimeFailure) throw new Error("provider closed badly");
          },
        },
        writeState: async () => {
          snapshots.push(
            [...sessions.values()].map((entry) =>
              JSON.parse(JSON.stringify(entry.record)),
            ),
          );
          await saving.promise;
        },
      });
      try {
        const stopping = host.shutdown();
        assert.equal(host.shutdown(), stopping);
        await waitFor(() => snapshots.length === 1);
        assert.equal(controller.signal.aborted, true);
        assert.equal(denials, 1);
        assert.equal(disposed, 2);
        assert.deepEqual(clearedTimers, [19]);
        assert.equal(pendingApprovals.size, 0);
        assert.equal(state.activeTurnId, null);
        assert.equal(
          sessions.size,
          2,
          "retain task state until the recovery snapshot is saved",
        );
        assert.equal(snapshots[0][0].status, "interrupted");
        assert.equal(snapshots[0][0].run?.stopReason, "host_shutdown");
        assert.equal(snapshots[0][0].run?.budget.toolCallsUsed, 3);
        assert.deepEqual(snapshots[0][1], completedBefore);
        await assert.rejects(
          host.sessionPrompt(state.record.id, "late prompt"),
          /shutting down/,
        );
        const lateSave = host.persistNow();
        saving.resolve();
        if (runtimeFailure)
          await assert.rejects(stopping, /provider closed badly/);
        else await stopping;
        await lateSave;
        assert.equal(sessions.size, 0);
        await host.persistNow();
        assert.equal(
          snapshots.length,
          1,
          "late callbacks must not overwrite disk with an empty session map",
        );
      } finally {
        saving.resolve();
        Reflect.set(globalThis, "Zotero", previousZotero);
        Reflect.set(globalThis, "ztoolkit", previousToolkit);
      }
    });
  }

  it("freezes the measured budget before completed-task background work", async () => {
    const { host, state } = fixture();
    let now = 0;
    state.record.backend = "native";
    state.record.run = run(state.record);
    state.record.run.status = "completed";
    state.record.run.budget.modelRequestsObservable = true;
    state.activeTurnId = "done-turn";
    state.runBudget = new BudgetAccountant(
      { maxIterations: 8, maxToolCalls: 20 },
      () => now,
    );
    now = 250;
    const saving = deferred<void>();
    host.persistNow = () => saving.promise;
    const finishing = host.finalizeRun(
      state,
      state.record.run,
      "done-turn",
      {
        stopReason: "completed",
        text: "",
        work: { completed: [], missing: [], unknownOperationIds: [] },
      },
      () => state.activeTurnId === "done-turn",
    );
    now = 100_000;
    saving.resolve();
    await finishing;
    assert.equal(state.record.run.budget.elapsedMs, 250);
    assert.equal(state.runBudget, undefined);
  });

  it("accounts final-step attempts and usage after the main budget is frozen", async () => {
    const { host, state } = fixture();
    state.record.run = run(state.record);
    state.record.run.status = "completed";
    const before = { ...state.record.run.budget };
    Object.assign(host, {
      externalAnalysisAdapter: () => ({
        complete: async (
          request: import("@confucius/harness").ModelRequest,
        ) => {
          await request.onRequestProgress?.({
            requestId: "aux",
            attempt: 1,
            status: "started",
          });
          return {
            text: "Title",
            usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
          };
        },
      }),
    });
    const job = {
      turnId: "ended-turn",
      runId: state.record.run.id,
      userText: "Read",
      assistantText: "Done",
      pending: ["title"],
    };
    const adapter = Reflect.get(host, "auxiliaryAdapter").call(
      host,
      state,
      job,
      "title",
    ) as import("@confucius/harness").ModelAdapter;
    await adapter.complete({ messages: [] });
    assert.equal(state.record.run.status, "completed");
    assert.equal(
      state.record.run.budget.iterationsUsed,
      before.iterationsUsed + 1,
    );
    assert.equal(state.record.run.budget.totalTokens, before.totalTokens + 8);
    assert.equal(state.runBudget, undefined);
  });

  it("does not clear a newer run while the old final status is being persisted", async () => {
    const { host, state } = fixture();
    const oldRun = run(state.record);
    state.record.run = oldRun;
    state.abort = new AbortController();
    state.activeTurnId = "old-turn";
    const saving = deferred<void>();
    host.persistNow = () => saving.promise;
    const finishing = host.finalizeRun(
      state,
      oldRun,
      "old-turn",
      {
        stopReason: "incomplete",
        text: "Old progress",
        work: { completed: [], missing: [], unknownOperationIds: [] },
      },
      () => state.record.run === oldRun && state.activeTurnId === "old-turn",
    );

    const newRun = run(state.record, 2);
    const newAbort = new AbortController();
    const newTools = new Set(["get_item"]);
    const newSources = { itemRefs: new Set(["1:NEWITEM"]) };
    state.record.run = newRun;
    state.record.status = "running";
    state.record.externalTurnId = "runtime-new-turn";
    state.activeTurnId = "new-turn";
    state.abort = newAbort;
    state.externalToolNames = newTools;
    state.externalSourceScope = newSources;
    state.externalVisualInspectionActive = true;
    saving.resolve();
    await finishing;

    assert.equal(state.record.run, newRun);
    assert.equal(state.record.status, "running");
    assert.equal(state.activeTurnId, "new-turn");
    assert.equal(state.abort, newAbort);
    assert.equal(state.externalToolNames, newTools);
    assert.equal(state.externalSourceScope, newSources);
    assert.equal(state.externalVisualInspectionActive, true);
    assert.equal(state.record.externalTurnId, "runtime-new-turn");
  });

  it("makes an asynchronous setup failure resumable instead of leaving a running turn", async () => {
    const { host, state, starts } = fixture();
    host.queueHistory = async () => {
      throw new Error("History volume unavailable");
    };
    await assert.rejects(
      host.sessionPrompt(state.record.id, "Inspect the paper"),
      /History volume unavailable/,
    );
    assert.equal(state.record.run?.status, "failed");
    assert.equal(state.record.run?.stopReason, "error");
    assert.equal(state.record.status, "failed");
    assert.equal(state.activeTurnId, null);
    assert.equal(state.abort, null);
    assert.equal(starts.length, 0);
    assert.equal(
      state.events.filter((event) => event.type === "turn_failed").length,
      1,
    );
    const oldRun = state.record.run!;

    host.queueHistory = async () => undefined;
    const resumed = await host.taskContinue(state.record.id);
    assert.ok(resumed.turnId);
    await waitFor(() => starts.length === 1 && state.activeTurnId === null);
    assert.equal(state.record.run?.id, oldRun.id);
    assert.equal(state.record.run?.generation, oldRun.generation + 1);
    assert.equal(state.record.run?.intentRevision, oldRun.intentRevision);
  });

  it("starts only the newest submitted prompt when interrupts return in reverse order", async () => {
    const { host, state, backend, starts } = fixture();
    const interrupts = [deferred<void>(), deferred<void>()];
    let count = 0;
    backend.interrupt = () => interrupts[count++].promise;
    const first = host.sessionPrompt(state.record.id, "First request");
    const second = host.sessionPrompt(state.record.id, "Latest request");
    assert.equal(count, 2);
    interrupts[1].resolve();
    const latest = await second;
    await waitFor(() => starts.length === 1 && state.activeTurnId === null);
    const current = state.record.run;
    interrupts[0].resolve();
    assert.equal((await first).superseded, true);
    assert.ok(latest.turnId);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].task.run?.request, "Latest request");
    assert.equal(state.record.run, current);
  });

  for (const boundary of ["prepare", "approval"] as const) {
    it(`does not dispatch a stale external write after generation changes during ${boundary}`, async () => {
      const { host, state, execution } = fixture();
      state.record.run = run(state.record);
      state.activeTurnId = "old-turn";
      const oldAbort = new AbortController();
      state.abort = oldAbort;
      const capabilities = new PluginRuntimeCapabilityStore();
      const oldLease = capabilities.issue({
        taskId: state.record.id,
        runId: state.record.run.id,
        turnId: state.activeTurnId,
        generation: 1,
      });
      const oldLeaseSignal = capabilities.signal(oldLease)!;
      const entered = deferred<void>();
      const release = deferred<void>();
      let captured: ToolExecutionContext | undefined;
      let writes = 0;
      Object.assign(host, {
        pluginRuntime: {
          isCurrentLease: capabilities.isCurrent.bind(capabilities),
          leaseSignal: capabilities.signal.bind(capabilities),
        },
        tools: {
          prepare: async (
            name: string,
            args: Record<string, unknown>,
            context: ToolExecutionContext,
          ) => {
            captured = context;
            context.preparedOperation = {
              schemaVersion: 1,
              domain: "zotero",
              name,
              args: { ...args },
              resources: ["zotero:1:NOTE"],
              recovery: {},
            };
            if (boundary === "prepare") {
              entered.resolve();
              await release.promise;
            }
            return null;
          },
          execute: async (name: string): Promise<ToolResult> => {
            writes++;
            return { ok: true, toolName: name, effect: "applied", data: {} };
          },
        },
      });
      host.requestToolApproval = async () => {
        assert.equal(boundary, "approval");
        entered.resolve();
        await release.promise;
        return { id: "call", verdict: "allow", scope: "once" };
      };
      const calling = host.taskToolCall({
        taskId: state.record.id,
        lease: oldLease,
        callId: "call",
        operationId: "external-operation",
        name: "create_note",
        arguments: { libraryID: 1, content: "Reviewed content" },
      });
      await entered.promise;
      state.record.run = run(state.record, 2);
      state.activeTurnId = "new-turn";
      const newAbort = new AbortController();
      state.abort = newAbort;
      const newLease = capabilities.issue({
        taskId: state.record.id,
        runId: state.record.run.id,
        turnId: state.activeTurnId,
        generation: 2,
      });
      release.resolve();

      const result = toolResult(await calling);
      assert.equal(result.ok, false);
      assert.equal(result.effect, "none");
      assert.equal(writes, 0);
      assert.equal(oldLeaseSignal.aborted, true);
      assert.equal(captured?.signal?.aborted, true);
      assert.equal(
        oldAbort.signal.aborted,
        false,
        "lease revocation cancels independently of a reused task signal",
      );
      assert.equal(newAbort.signal.aborted, false);
      assert.equal(capabilities.signal(newLease)?.aborted, false);
      assert.deepEqual(await execution.listOperations(), []);
    });
  }
});

for (const phase of [
  "prepared",
  "session-ready",
  "committed",
  "startup",
] as const)
  it(`context handoff recovers from ${phase} failure without losing the old window or receipts`, async () => {
    const { host, state, backend } = fixture();
    state.record.run = run(state.record);
    state.activeTurnId = "handoff-turn";
    state.record.contextResetRequested = true;
    state.record.externalSessionId = "old";
    const oldWindow = state.record.contextWindow!.id;
    const oldBudget = structuredClone(state.record.run.budget);
    const direct = host as unknown as {
      history: HistoryStore;
      switchExternalContext(state: TestState): Promise<void>;
    };
    await direct.history.writeNote(
      state.record.id,
      "progress",
      "Continue the saved report",
      undefined,
      {
        version: 1,
        binding: executionBinding(state.record.run)!,
        evidenceRefs: [],
      },
    );
    let failed = false;
    Object.assign(backend, {
      prepareSession: async () => {
        if (phase === "startup" && !failed) {
          failed = true;
          throw new Error("injected startup");
        }
        return { externalSessionId: "candidate" };
      },
    });
    host.persistNow = async () => {
      if (
        phase !== "startup" &&
        state.record.contextSwitch?.phase === phase &&
        !failed
      ) {
        failed = true;
        throw new Error(`injected ${phase}`);
      }
    };
    await assert.rejects(direct.switchExternalContext(state), /injected/);
    assert.equal(state.record.contextWindow!.id, oldWindow);
    assert.equal(state.record.externalSessionId, "old");
    assert.deepEqual(state.record.run.budget, oldBudget);
    assert.ok(state.record.contextSwitch);
    await direct.switchExternalContext(state);
    assert.equal(state.record.contextSwitch?.phase, "committed");
    assert.equal(state.record.externalSessionId, "candidate");
    assert.deepEqual(state.record.run.budget, oldBudget);
  });

it("a candidate prepared after user steering cannot overwrite the newer run", async () => {
  const { host, state, backend } = fixture();
  state.record.run = run(state.record);
  state.activeTurnId = "handoff-turn";
  state.record.externalSessionId = "old";
  const direct = host as unknown as {
    history: HistoryStore;
    switchExternalContext(state: TestState): Promise<void>;
  };
  await direct.history.writeNote(
    state.record.id,
    "progress",
    "Continue the saved report",
    undefined,
    {
      version: 1,
      binding: executionBinding(state.record.run)!,
      evidenceRefs: [],
    },
  );
  let discarded = false;
  Object.assign(backend, {
    prepareSession: async () => {
      state.record.run = {
        ...state.record.run!,
        intentRevision: 2,
        request: "New user request",
      };
      state.record.contextSwitch = undefined;
      return { externalSessionId: "late-candidate" };
    },
    discardSession: async () => {
      discarded = true;
    },
  });
  await assert.rejects(direct.switchExternalContext(state), /superseded/);
  assert.equal(state.record.run.request, "New user request");
  assert.equal(state.record.externalSessionId, "old");
  assert.equal(discarded, true);
});
