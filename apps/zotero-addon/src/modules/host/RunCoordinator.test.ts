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
