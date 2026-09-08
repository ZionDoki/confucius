import assert from "node:assert/strict";
import { it } from "node:test";
import {
  emptyLockedContext,
  executionBinding,
  restoreRun,
  type RunState,
  type WorkSnapshot,
} from "@confucius/protocol";
import { RunCoordinator, projectWork } from "./RunCoordinator";
import { ArtifactStore, type ArtifactFileSystem } from "./ArtifactStore";

function run(): RunState {
  return {
    version: 1,
    id: "run_1",
    generation: 1,
    intentRevision: 1,
    request: "Read this paper",
    sources: emptyLockedContext(1),
    templateVersion: 1,
    requiredArtifactKinds: [],
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    budget: {
      maxIterations: 8,
      maxToolCalls: 8,
      iterationsUsed: 0,
      toolCallsUsed: 0,
      executorStarts: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      modelRequestsObservable: true,
    },
  };
}
const empty = (): WorkSnapshot => ({
  completed: [],
  missing: [],
  unknownOperationIds: [],
});
const gap = () => ({
  ...empty(),
  missing: [
    { id: "report", kind: "artifact" as const, description: "Save report" },
  ],
});

it("external context switches keep the run, receipts and cumulative budget with distinct requests", async () => {
  const state = run();
  state.budget.modelRequestsObservable = false;
  state.budget.toolCallsUsed = 2;
  state.budget.promptTokens = 123;
  let starts = 0,
    switches = 0;
  const ids = new Set<string>();
  const completed = [{ id: "saved-write", description: "Already saved" }];
  const coordinator = new RunCoordinator({
    run: state,
    current: () => true,
    persist: async () => {},
    progress: () => {},
    snapshot: async () => ({ ...empty(), completed }),
    requestProgress: (progress) => {
      if (progress.status === "started") ids.add(progress.requestId);
    },
    switchContext: async () => {
      switches++;
      state.generation++;
    },
    executor: {
      run: async (input) => {
        starts++;
        if (starts === 1) return { stopReason: "context_switch", text: "" };
        assert.equal(input.continuation, true);
        assert.match(input.prompt, /saved-write/);
        return { stopReason: "completed", text: "Done" };
      },
    },
  });
  const result = await coordinator.execute(
    "Read",
    new AbortController().signal,
  );
  assert.equal(result.stopReason, "completed");
  assert.equal(switches, 1);
  assert.equal(state.id, "run_1");
  assert.equal(state.budget.executorStarts, 2);
  assert.equal(state.budget.toolCallsUsed, 2);
  assert.equal(state.budget.promptTokens, 123);
  assert.equal(ids.size, 2);
  assert.deepEqual(result.work.completed, completed);
});

it("unknown writes block context switching", async () => {
  const state = run();
  let calls = 0;
  const coordinator = new RunCoordinator({
    run: state,
    current: () => true,
    persist: async () => {},
    progress: () => {},
    snapshot: async () => ({
      ...empty(),
      unknownOperationIds: calls ? ["uncertain-write"] : [],
    }),
    switchContext: async () =>
      assert.fail("an unresolved write cannot cross the boundary"),
    executor: {
      run: async () => {
        calls++;
        return { stopReason: "context_switch", text: "" };
      },
    },
  });
  assert.equal(
    (await coordinator.execute("Read", new AbortController().signal))
      .stopReason,
    "outcome_unknown",
  );
});

it("restoring an interrupted host closes in-flight requests and preserves the last provider error", () => {
  const state = run();
  state.modelRequest = {
    requestId: "executor",
    scope: "executor",
    status: "started",
    attempt: 1,
  };
  state.providerRequest = {
    requestId: "provider",
    scope: "provider",
    parentRequestId: "executor",
    status: "started",
    attempt: 2,
  };
  state.lastError = {
    at: 2,
    request: {
      ...state.providerRequest,
      status: "failed",
      code: "responseStreamDisconnected",
    },
  };
  const restored = restoreRun(state)!;
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.modelRequest?.code, "host_restarted");
  assert.equal(restored.providerRequest?.status, "failed");
  assert.equal(restored.lastError?.request.code, "responseStreamDisconnected");
  assert.equal(state.modelRequest.status, "started");
  state.status = "interrupted";
  state.stopReason = "host_restarted";
  assert.equal(restoreRun(state)?.modelRequest?.code, "host_restarted");
  state.status = "completed";
  assert.equal(restoreRun(state)?.providerRequest?.status, "completed");
});

it("a silent external executor recovers saved annotations and completes its missing report", async () => {
  const state = run();
  state.budget.modelRequestsObservable = false;
  state.requiredArtifactKinds = ["deep_read"];
  const store = fixtureStore();
  const ids: string[] = [];
  const annotations = Array.from({ length: 8 }, (_, i) => ({
    id: `annotation-${i}`,
    description: "saved annotation",
  }));
  let starts = 0,
    stops = 0;
  const coordinator = new RunCoordinator({
    run: state,
    current: () => true,
    persist: async () => {},
    progress: () => {},
    snapshot: async () =>
      projectWork(
        state,
        await store.list(ids),
        { completed: starts ? annotations : [], missing: [] },
        [],
      ),
    recover: async () => {
      stops++;
    },
    wait: async () => {},
    executor: {
      run: async (input) => {
        if (++starts === 1)
          return {
            stopReason: "incomplete",
            text: "",
            failure: {
              code: "runtime_idle_timeout",
              message: "Runtime stopped responding",
              retryable: true,
            },
          };
        assert.equal(stops, 1);
        assert.equal(input.continuation, true);
        assert.match(input.prompt, /annotation-7/);
        assert.match(input.prompt, /artifact:deep_read/);
        assert.match(input.prompt, /preserve completed writes/);
        const report = await store.upsert(
          {
            taskId: "task",
            kind: "deep_read",
            title: "Report",
            body: { type: "markdown", markdown: "Evidence reviewed." },
            status: "ready",
          },
          "codex",
          [],
          undefined,
          executionBinding(state),
        );
        ids.push(report.id);
        return {
          stopReason: "completed",
          text: "Saved the report and preserved eight annotations.",
        };
      },
    },
  });
  const outcome = await coordinator.execute(
    "Read the paper",
    new AbortController().signal,
  );
  assert.equal(outcome.stopReason, "completed");
  assert.equal(outcome.work.completed.length, 9);
  assert.deepEqual(outcome.work.missing, []);
  assert.equal(state.modelRequest?.status, "completed");
  assert.equal(starts, 2);
});
function fixtureStore() {
  const files = new Map<string, string>();
  let count = 0;
  const fs: ArtifactFileSystem = {
    read: async (path) => files.get(path)!,
    writeAtomic: async (path, text) => {
      files.set(path, text);
    },
    exists: async (path) => files.has(path),
    makeDirectory: async () => {},
  };
  return new ArtifactStore(
    "artifacts",
    fs,
    () => Date.now(),
    () => `artifact_${++count}`,
  );
}

it("resumes a v1 deep-read without chasing its obsolete second artifact obligation", async () => {
  const state = {
    ...run(),
    templateId: "deep-read" as const,
    requiredArtifactKinds: ["deep_read", "annotation_set"] as const,
  };
  const current: RunState = {
    ...state,
    requiredArtifactKinds: [...state.requiredArtifactKinds],
  };
  const store = fixtureStore();
  const report = await store.upsert(
    {
      taskId: "task",
      kind: "deep_read",
      title: "Report",
      body: { type: "markdown", markdown: "Reviewed" },
      status: "ready",
    },
    "native",
    [],
    undefined,
    executionBinding(current),
  );
  assert.deepEqual(projectWork(current, [report], empty(), []).missing, []);
  assert.equal(current.requiredArtifactKinds.length, 2); // No destructive migration.
  const explicit = { ...current, templateVersion: 2 };
  assert(
    projectWork(explicit, [report], empty(), []).missing.some(
      (m) => m.id === "artifact:annotation_set",
    ),
  );
});

for (const language of ["zh-CN", "en-US"] as const) {
  it(`uses ${language} for host continuation progress`, async () => {
    let calls = 0;
    const messages: string[] = [];
    const coordinator = new RunCoordinator({
      run: run(),
      language,
      current: () => true,
      persist: async () => {},
      progress: (text) => messages.push(text),
      snapshot: async () => (calls < 2 ? gap() : empty()),
      executor: {
        run: async () => {
          calls++;
          return { stopReason: "completed", text: "done" };
        },
      },
    });
    assert.equal(
      (await coordinator.execute("read", new AbortController().signal))
        .stopReason,
      "completed",
    );
    assert.match(
      messages[0],
      language === "zh-CN"
        ? /继续完成剩余工作/
        : /Continuing the remaining work/,
    );
  });
}

for (const backend of ["native", "kimi", "codex"] as const) {
  it(`${backend}: ordinary task continues a known draft without mandatory stages`, async () => {
    const state = run();
    const store = fixtureStore();
    const ids: string[] = [];
    let calls = 0;
    const coordinator = new RunCoordinator({
      run: state,
      current: () => true,
      persist: async () => {},
      progress: () => {},
      snapshot: async () =>
        projectWork(state, await store.list(ids), empty(), []),
      executor: {
        run: async ({ continuation }) => {
          calls++;
          state.budget.iterationsUsed++;
          const artifact = await store.upsert(
            {
              id: ids[0],
              taskId: "task",
              kind: "report",
              title: "Report",
              status: calls === 1 ? "draft" : "ready",
              body: {
                type: "markdown",
                markdown:
                  calls === 1 ? "evidence collected" : "finished report",
              },
            },
            backend,
            [],
            undefined,
            executionBinding(state),
          );
          if (!ids.includes(artifact.id)) ids.push(artifact.id);
          assert.equal(continuation, calls > 1);
          return {
            stopReason: "completed",
            text: calls === 1 ? "I am done" : "Saved",
          };
        },
      },
    });
    const outcome = await coordinator.execute(
      "Read",
      new AbortController().signal,
    );
    assert.equal(outcome.stopReason, "completed");
    assert.equal(calls, 2);
    assert.equal((await store.list(ids)).length, 1);
    assert.equal(state.budget.iterationsUsed, 2);
  });
}
it("plain answer ends after one executor result with no hidden verifier", async () => {
  const state = run();
  let calls = 0;
  const c = new RunCoordinator({
    run: state,
    current: () => true,
    persist: async () => {},
    progress: () => {},
    snapshot: async () => empty(),
    executor: {
      run: async () => {
        calls++;
        return { stopReason: "completed", text: "Answer" };
      },
    },
  });
  assert.equal(
    (await c.execute("Question", new AbortController().signal)).stopReason,
    "completed",
  );
  assert.equal(calls, 1);
});
it("keeps advancing the same batch while authoritative remaining counts decrease", async () => {
  const state = run();
  let remaining = 5;
  const c = new RunCoordinator({
    run: state,
    current: () => true,
    persist: async () => {},
    progress: () => {},
    snapshot: async () => ({
      ...empty(),
      missing: remaining
        ? [
            {
              id: "same-proposal",
              kind: "proposal",
              description: `${remaining} candidates remain`,
            },
          ]
        : [],
    }),
    executor: {
      run: async () => {
        state.budget.iterationsUsed++;
        remaining--;
        return { stopReason: "completed", text: "Saved another entry" };
      },
    },
  });
  assert.equal(
    (await c.execute("Submit all", new AbortController().signal)).stopReason,
    "completed",
  );
  assert.equal(state.budget.iterationsUsed, 5);
});
for (const changed of [true, false]) {
  it(`${changed ? "changed" : "identical"} draft contents determine progress independently of record revision`, async () => {
    const state = run();
    const store = fixtureStore();
    const ids: string[] = [];
    let calls = 0;
    const c = new RunCoordinator({
      run: state,
      current: () => true,
      persist: async () => {},
      progress: () => {},
      snapshot: async () =>
        projectWork(state, await store.list(ids), empty(), []),
      executor: {
        run: async () => {
          calls++;
          state.budget.iterationsUsed++;
          const artifact = await store.upsert(
            {
              id: ids[0],
              taskId: "task",
              kind: "report",
              title: "Report",
              status: calls === 5 ? "ready" : "draft",
              body: {
                type: "markdown",
                markdown: changed ? `Evidence ${calls}` : "Same evidence",
              },
            },
            "native",
            [],
            undefined,
            executionBinding(state),
          );
          if (!ids.length) ids.push(artifact.id);
          return { stopReason: "completed", text: "Saved draft" };
        },
      },
    });
    const result = await c.execute(
      "Finish report",
      new AbortController().signal,
    );
    assert.equal(result.stopReason, changed ? "completed" : "stalled");
    assert.equal(calls, changed ? 5 : 3);
  });
}
it("saved artifacts are matched to execution, source and intent revision, never event kinds", async () => {
  const state = run();
  state.requiredArtifactKinds = ["report"];
  const store = fixtureStore();
  const a = await store.upsert(
    {
      taskId: "task",
      kind: "report",
      title: "Earlier",
      body: { type: "markdown", markdown: "old" },
    },
    "native",
    [],
    undefined,
    { ...executionBinding(state)!, runId: "old" },
  );
  assert.equal(projectWork(state, [a], empty(), []).missing.length, 1);
  const b = { ...a, execution: executionBinding(state) };
  assert.equal(projectWork(state, [b], empty(), []).missing.length, 0);
  state.intentRevision++;
  assert.equal(projectWork(state, [b], empty(), []).missing.length, 1);
  assert.equal(projectWork(state, [], empty(), []).missing.length, 1);
});
it("unknown effect is reconciled by snapshot before any executor is started", async () => {
  const state = run();
  let calls = 0;
  const c = new RunCoordinator({
    run: state,
    current: () => true,
    persist: async () => {},
    progress: () => {},
    snapshot: async () => ({ ...empty(), unknownOperationIds: ["op"] }),
    executor: {
      run: async () => {
        calls++;
        return { stopReason: "completed", text: "" };
      },
    },
  });
  assert.equal(
    (await c.execute("Write", new AbortController().signal)).stopReason,
    "outcome_unknown",
  );
  assert.equal(calls, 0);
});
it("budget exhaustion remains interrupted across restart and continue", async () => {
  const state = run();
  state.budget.iterationsUsed = 8;
  const restored = restoreRun(JSON.parse(JSON.stringify(state)))!;
  assert.equal(restored.status, "interrupted");
  let calls = 0;
  const c = new RunCoordinator({
    run: restored,
    current: () => true,
    persist: async () => {},
    progress: () => {},
    snapshot: async () => gap(),
    executor: {
      run: async () => {
        calls++;
        return { stopReason: "completed", text: "" };
      },
    },
  });
  assert.equal(
    (await c.execute("Continue", new AbortController().signal)).stopReason,
    "iteration_budget",
  );
  assert.equal(calls, 0);
});
it("external internal steps remain unknown and host starts have a distinct budget", async () => {
  const state = run();
  state.budget.modelRequestsObservable = false;
  state.budget.executorStarts = 8;
  const c = new RunCoordinator({
    run: state,
    current: () => true,
    persist: async () => {},
    progress: () => {},
    snapshot: async () => gap(),
    executor: {
      run: async () => {
        throw Error("must not start");
      },
    },
  });
  assert.equal(
    (await c.execute("Continue", new AbortController().signal)).stopReason,
    "executor_budget",
  );
});
it("repeated unchanged gaps stop after one targeted repair instead of fake completion", async () => {
  const state = run();
  let calls = 0;
  const progress: string[] = [];
  const c = new RunCoordinator({
    run: state,
    current: () => true,
    persist: async () => {},
    progress: (m) => progress.push(m),
    snapshot: async () => gap(),
    executor: {
      run: async () => {
        calls++;
        return { stopReason: "completed", text: "Done" };
      },
    },
  });
  assert.equal(
    (await c.execute("Create report", new AbortController().signal)).stopReason,
    "stalled",
  );
  assert.equal(calls, 3);
  assert.equal(progress.length, 2);
  assert.equal(state.status, "interrupted");
});
it("a late result cannot change the newer execution generation", async () => {
  const state = run();
  let current = true;
  const c = new RunCoordinator({
    run: state,
    current: () => current,
    persist: async () => {},
    progress: () => {},
    snapshot: async () => empty(),
    executor: {
      run: async () => {
        current = false;
        return { stopReason: "completed", text: "old" };
      },
    },
  });
  const outcome = await c.execute("Old", new AbortController().signal);
  assert.equal(outcome.superseded, true);
  assert.notEqual(state.status, "completed");
});
it("cancel during execution never schedules a continuation", async () => {
  const state = run();
  const abort = new AbortController();
  let calls = 0;
  const c = new RunCoordinator({
    run: state,
    current: () => true,
    persist: async () => {},
    progress: () => {},
    snapshot: async () => gap(),
    executor: {
      run: async () => {
        calls++;
        abort.abort();
        return { stopReason: "completed", text: "partial" };
      },
    },
  });
  assert.equal((await c.execute("Write", abort.signal)).stopReason, "aborted");
  assert.equal(calls, 1);
});
it("failure to persist the run does not dispatch an executor", async () => {
  const state = run();
  let calls = 0;
  const c = new RunCoordinator({
    run: state,
    current: () => true,
    persist: async () => {
      throw Error("disk full");
    },
    progress: () => {},
    snapshot: async () => empty(),
    executor: {
      run: async () => {
        calls++;
        return { stopReason: "completed", text: "" };
      },
    },
  });
  await assert.rejects(
    c.execute("Work", new AbortController().signal),
    /disk full/,
  );
  assert.equal(calls, 0);
});

for (const backend of ["codex", "kimi"]) {
  it(`${backend}: transient termination stops the old executor and rechecks receipts before two bounded recoveries`, async () => {
    const state = run();
    state.budget.modelRequestsObservable = false;
    let starts = 0,
      stops = 0,
      reads = 0;
    const waits: number[] = [];
    const coordinator = new RunCoordinator({
      run: state,
      current: () => true,
      persist: async () => {},
      progress: () => {},
      snapshot: async () => {
        reads++;
        return {
          ...empty(),
          completed: [{ id: "saved-annotation", description: "saved" }],
        };
      },
      recover: async () => {
        stops++;
      },
      wait: async (ms) => {
        waits.push(ms);
      },
      executor: {
        run: async (input) => {
          assert.equal(
            stops,
            starts,
            "each replacement waits for old execution teardown",
          );
          if (starts) {
            assert.equal(input.continuation, true);
            assert.match(input.prompt, /saved-annotation/);
          }
          starts++;
          return {
            stopReason: "error",
            text: "failed fragment",
            failure: { retryable: true, message: "connection reset" },
          };
        },
      },
    });
    assert.equal(
      (await coordinator.execute("go", new AbortController().signal))
        .stopReason,
      "model_retries_exhausted",
    );
    assert.equal(starts, 3);
    assert.equal(stops, 2);
    assert.ok(reads >= 6);
    assert.deepEqual(waits, [1000, 2000]);
    assert.equal(state.budget.executorStarts, 3);
    assert.equal(state.modelRequest?.exhausted, true);
    assert.equal(state.modelRequest?.attempt, 3);
    assert.equal(restoreRun(state)?.modelRequest?.exhausted, true);
  });
}
it("unknown writes, authentication failures and cancelled recovery never start another executor", async () => {
  for (const kind of ["unknown", "auth", "cancel"]) {
    const state = run();
    state.budget.modelRequestsObservable = false;
    const abort = new AbortController();
    let starts = 0;
    const coordinator = new RunCoordinator({
      run: state,
      current: () => true,
      persist: async () => {},
      progress: () => {},
      snapshot: async () => ({
        ...empty(),
        unknownOperationIds:
          kind === "unknown" && starts ? ["unconfirmed-write"] : [],
      }),
      recover: async () => {
        if (kind === "cancel") abort.abort();
      },
      wait: async (_ms, signal) => {
        if (signal.aborted) throw new Error("cancelled");
      },
      executor: {
        run: async () => {
          starts++;
          return {
            stopReason: "error",
            text: "",
            failure: { retryable: kind !== "auth", message: "failed" },
          };
        },
      },
    });
    const result = await coordinator.execute("go", abort.signal);
    assert.equal(starts, 1);
    assert.equal(
      result.stopReason,
      kind === "unknown"
        ? "outcome_unknown"
        : kind === "cancel"
          ? "aborted"
          : "error",
    );
  }
});
