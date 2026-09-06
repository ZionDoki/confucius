import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ModelMessage } from "@confucius/harness";
import { BudgetAccountant } from "@confucius/harness";
import {
  coalesceTimeline,
  initialContextWindow,
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
    "Primary evidence",
    "Parallel source read",
    "Fallible draft",
    "Saved explanation",
    "Use configured Chinese",
  ])
    assert(text.includes(evidence));
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
    interrupt: async (_id: string): Promise<void> => undefined,
    startTurn: async (input: BackendTurnInput, callbacks: BackendCallbacks) => {
      starts.push(input);
      callbacks.stopped?.({ stopReason: "incomplete", text: "Saved progress" });
      return {};
    },
  };
  const execution = new ToolExecutionService(memoryJsonStorage());
  const host = Object.create(AgentHost.prototype) as LifecycleHost;
  let sequence = 0;
  Object.assign(host, {
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
    history: { register: () => undefined, append: async () => undefined },
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
  });
  return { host, state, backend, starts, execution };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail("Lifecycle did not reach the expected state");
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
