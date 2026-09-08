import assert from "node:assert/strict";
import { after, test } from "node:test";
import { posix } from "node:path";
import {
  CONTEXT_POLICY,
  contextTextTokens,
  emptyLockedContext,
  initialContextWindow,
  type ResearchTaskRecord,
} from "@confucius/protocol";
import {
  HistoryStore,
  InMemoryFileSystem,
  MemoryEngine,
  ConversationLogEngine,
} from "@confucius/memory";
import {
  ModelError,
  retryModelRequest,
  type ModelAdapter,
} from "@confucius/harness";
import {
  workToDistill,
  distillationMessages,
  distillationMemories,
  parseDistillation,
} from "./ContextMaintenance";
import { AgentHost } from "./AgentHost";
import { TaskTraceBuffer } from "./TaskTrace";
import { ToolExecutionService } from "./ReliableToolProvider";
import { memoryJsonStorage } from "./RuntimeStorage";

const oldGlobals = ["PathUtils", "IOUtils"].map(
  (name) => [name, Reflect.get(globalThis, name)] as const,
);
Reflect.set(globalThis, "PathUtils", { ...posix, localProfileDir: "/profile" });
Reflect.set(globalThis, "IOUtils", { exists: async () => false });
after(() => {
  for (const [name, value] of oldGlobals) Reflect.set(globalThis, name, value);
});

test("retention chooses oldest ended work by age, count and bytes, exempting active work", () => {
  const now = 100 * 86400000;
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    updatedAt: now - i,
    bytes: 1,
    protected: false,
  }));
  assert.deepEqual(
    workToDistill(rows, now).map((row) => row.id),
    ["11", "10"],
  );
  assert.equal(workToDistill([{ ...rows[0], updatedAt: 1 }], now).length, 1);
  assert.equal(
    workToDistill([{ ...rows[0], bytes: CONTEXT_POLICY.recentBytes + 1 }], now)
      .length,
    1,
  );
  assert.equal(
    workToDistill([{ ...rows[0], updatedAt: 1, protected: true }], now).length,
    0,
  );
});

test("distillation has bounded evidence and rejects malformed or unauthorized edits", () => {
  const messages = distillationMessages("原始信息".repeat(100000), []);
  assert.ok(
    contextTextTokens(JSON.stringify(messages)) <=
      CONTEXT_POLICY.maintenanceInputTokens,
  );
  assert.match(messages[0].content, /untrusted evidence/);
  assert.deepEqual(parseDistillation("[]", new Set()), []);
  for (const text of [
    "",
    "[",
    "{}",
    '[{"op":"delete","id":"protected"}]',
    '[{"op":"add","content":"x"}]',
  ])
    assert.throws(() => parseDistillation(text, new Set()));
});

test("distillation only permits merging complete old memories that fit its input catalog", async () => {
  const memory = new MemoryEngine({
    fs: new InMemoryFileSystem(),
    root: "/memory",
  });
  const large = await memory.save({
    id: "large",
    content: "长材料".repeat(700),
    protection: "none",
  });
  const small = await memory.save({
    id: "small",
    content: "Complete concise evidence",
    protection: "none",
  });
  const selected = distillationMemories([large, small]);
  assert.deepEqual(
    selected.map((record) => record.id),
    ["small"],
  );
  const messages = distillationMessages("work", [large, small]);
  const catalog = messages[1].content.split("\n")[1];
  assert.deepEqual(JSON.parse(catalog), [
    { id: "small", content: small.content },
  ]);
  assert.throws(() =>
    parseDistillation(
      '[{"op":"delete","id":"large"}]',
      new Set(selected.map((record) => record.id)),
    ),
  );
});

function record(id: string): ResearchTaskRecord {
  return {
    id,
    title: id,
    schemaVersion: 4,
    titleState: "fixed",
    createdAt: 1,
    updatedAt: 2,
    mode: "agent",
    permissionMode: "ask",
    context: {},
    backend: "native",
    status: "completed",
    capabilityProfile: "zotero_only",
    artifactIds: ["kept-report"],
    lockedContext: emptyLockedContext(1),
    contextWindow: initialContextWindow(id, "native", 1),
  };
}
type State = {
  record: ResearchTaskRecord;
  activeTurnId: string | null;
  messages: Array<{ role: "user"; content: string }>;
  events: unknown[];
  contextCleanup?: Promise<void>;
};
type Job = NonNullable<ResearchTaskRecord["postProcessing"]>[number];
type MaintenanceHost = {
  runContextMaintenance(
    owner: State,
    job: Job,
    current: () => boolean,
  ): Promise<void>;
  resumeContextCleanup(state: State): Promise<void>;
  retryPostProcessing(id: string): Promise<ResearchTaskRecord>;
  sessionDelete(id: string): Promise<{ ok: boolean }>;
  scheduleContextMaintenanceNow(owner: State, turnId: string): Promise<void>;
};
async function fixture() {
  const fs = new InMemoryFileSystem();
  const memory = new MemoryEngine({ fs, root: "/memory" });
  const history = new HistoryStore(fs, "/history");
  const logs = new ConversationLogEngine({ fs, root: "/logs" });
  const target: State = {
    record: record("old"),
    activeTurnId: null,
    messages: [{ role: "user", content: "RAW_OLD_CONTEXT" }],
    events: [],
  };
  const owner: State = {
    record: record("owner"),
    activeTurnId: null,
    messages: [],
    events: [],
  };
  owner.record.maintenanceBudget = { turnId: "turn", attempts: 0 };
  const job: Job = {
    turnId: "turn",
    userText: "",
    assistantText: "",
    pending: ["memory"],
    maintenanceTarget: "old",
    maintenanceSourceUpdatedAt: 2,
    maintenanceBatchId: "batch",
  };
  owner.record.postProcessing = [job];
  history.register(target.record);
  history.register(owner.record);
  await history.append({
    taskId: "old",
    windowId: "w",
    itemId: "i",
    role: "user",
    content: "RAW_OLD_CONTEXT",
    sourceIds: [],
  });
  await history.writeNote("old", "progress", "RAW_OLD_CONTEXT note");
  await logs.appendTurn({
    sessionId: "old",
    title: "old",
    turnId: "oldturn",
    userText: "RAW_OLD_CONTEXT",
    assistantText: "Done",
  });
  let calls = 0;
  let failModel = false;
  let duringModel = () => {};
  let persist = async () => {};
  const host = Object.create(AgentHost.prototype) as MaintenanceHost;
  Object.assign(host, {
    memory,
    history,
    logs,
    sessions: new Map([
      ["old", target],
      ["owner", owner],
    ]),
    postProcessingRuns: new Set(),
    memoryProposals: new Map(),
    pendingApprovals: new Map(),
    pendingHistory: [],
    taskTraceBuffer: new TaskTraceBuffer(),
    execution: new ToolExecutionService(memoryJsonStorage()),
    backendFor: () => ({ dispose: async () => {} }),
    memoryConsent: () => "review",
    persistNow: () => persist(),
    emitSessionEvent: (
      _state: State,
      _turn: string,
      type: string,
      payload: unknown,
    ) => {
      _state.events.push({ type, payload });
    },
    auxiliaryAdapter: (): ModelAdapter => ({
      complete: (request) =>
        retryModelRequest(
          async () => {
            await request.onAttempt?.();
            calls++;
            duringModel();
            if (failModel)
              throw new ModelError("offline", "transport", { retryable: true });
            return {
              text: '[{"op":"add","type":"note","title":"Result","content":"Reusable distilled conclusion"}]',
            };
          },
          {
            maxAttempts: request.maxAttempts,
            scheduleTimeout: (callback) => setTimeout(callback, 0),
            cancelTimeout: (handle) =>
              clearTimeout(handle as ReturnType<typeof setTimeout>),
          },
        ),
    }),
  });
  return {
    host,
    fs,
    memory,
    history,
    logs,
    owner,
    target,
    job,
    calls: () => calls,
    failModel: () => {
      failModel = true;
    },
    duringModel: (callback: () => void) => {
      duringModel = callback;
    },
    persist: (callback: () => Promise<void>) => {
      persist = callback;
    },
  };
}

test("deleting a task clears its history and duplicate transcript without deleting saved memory", async () => {
  const f = await fixture();
  await f.memory.save({
    id: "kept",
    content: "User-saved conclusion",
    protection: "user",
  });
  assert.equal((await f.host.sessionDelete("old")).ok, true);
  assert.ok(!JSON.stringify(f.fs.snapshot()).includes("RAW_OLD_CONTEXT"));
  assert.equal(await f.logs.read("old"), null);
  assert.equal(f.memory.get("kept")?.content, "User-saved conclusion");
  assert.deepEqual(f.target.record.artifactIds, ["kept-report"]);
});

test("successful distillation commits before removing raw copies, keeping artifact identities", async () => {
  const f = await fixture();
  let committed = false;
  f.persist(async () => {
    if (f.job.maintenanceApplied) committed = true;
  });
  const prune = f.history.prune.bind(f.history);
  f.history.prune = async (id) => {
    assert.ok(committed);
    await prune(id);
  };
  await f.host.runContextMaintenance(f.owner, f.job, () => true);
  assert.equal(f.calls(), 1);
  assert.equal((await f.memory.list()).length, 1);
  assert.equal(f.target.messages.length, 0);
  assert.deepEqual(f.target.record.artifactIds, ["kept-report"]);
  assert.ok(f.target.record.historyClearedAt);
  assert.doesNotMatch(JSON.stringify(f.fs.snapshot()), /RAW_OLD_CONTEXT/);
  await assert.rejects(
    f.history.read({ taskId: "old", windowId: "w", itemId: "i" }),
    /cleared/,
  );
});

test("post-cleanup diagnostic events do not re-enter retention or trigger another distillation", async () => {
  const f = await fixture();
  await f.host.runContextMaintenance(f.owner, f.job, () => true);
  f.owner.record.postProcessing = [];
  await f.history.append({
    taskId: "old",
    windowId: "after-cleanup",
    itemId: "status",
    role: "event",
    purpose: "diagnostic",
    content: "session_updated: completed",
    sourceIds: [],
  });
  const info = await f.history.retentionInfo("old");
  assert.equal(info.items, 1);
  assert.equal(info.retrievableItems, 0);
  await f.host.scheduleContextMaintenanceNow(f.owner, "next-turn");
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.owner.record.postProcessing, []);

  // Reusing an old task to save meaningful work must make that work eligible.
  await f.history.writeNote("old", "new-work", "New reusable evidence");
  await f.host.scheduleContextMaintenanceNow(f.owner, "later-turn");
  assert.equal(f.calls(), 2);
});

test("model failure and exhausted allowance never clear originals or grant more retries", async () => {
  const f = await fixture();
  f.failModel();
  await assert.rejects(
    f.host.runContextMaintenance(f.owner, f.job, () => true),
    /offline/,
  );
  assert.equal(f.calls(), 2);
  await assert.rejects(
    f.host.runContextMaintenance(f.owner, f.job, () => true),
    /allowance/,
  );
  assert.equal(f.calls(), 2);
  assert.match(JSON.stringify(f.fs.snapshot()), /RAW_OLD_CONTEXT/);
  assert.equal(f.job.maintenanceApplied, undefined);
});

test("failed result persistence and memory writes preserve the raw batch", async () => {
  for (const failure of ["result", "memory"]) {
    const f = await fixture();
    if (failure === "result")
      f.persist(async () => {
        if (f.job.maintenanceOps) throw new Error("storage offline");
      });
    else
      f.memory.applyOrdinaryOps = async () => {
        throw new Error("storage offline");
      };
    await assert.rejects(
      f.host.runContextMaintenance(f.owner, f.job, () => true),
      /storage offline/,
    );
    assert.match(JSON.stringify(f.fs.snapshot()), /RAW_OLD_CONTEXT/);
    assert.equal(f.target.record.historyClearedAt, undefined);
  }
});

test("cleanup resumes after interrupted raw deletion without another model call", async () => {
  const f = await fixture();
  const remove = f.fs.deleteFile.bind(f.fs);
  let failed = false;
  f.fs.deleteFile = async (path) => {
    if (!failed && path.endsWith("i.txt")) {
      failed = true;
      throw new Error("process interrupted");
    }
    await remove(path);
  };
  await assert.rejects(
    f.host.runContextMaintenance(f.owner, f.job, () => true),
    /interrupted/,
  );
  assert.equal(f.job.maintenanceApplied, true);
  assert.equal((await f.history.retentionInfo("old")).cleanupPending, true);
  await f.host.resumeContextCleanup(f.target);
  assert.equal(f.calls(), 1);
  assert.doesNotMatch(JSON.stringify(f.fs.snapshot()), /RAW_OLD_CONTEXT/);
  assert.equal(f.job.pending.length, 0);
});

test("resuming the source during model distillation cancels deletion and closes loading", async () => {
  const f = await fixture();
  f.duringModel(() => {
    f.target.activeTurnId = "new-turn";
    f.target.record.updatedAt = 3;
  });
  await f.host.runContextMaintenance(f.owner, f.job, () => true);
  assert.match(JSON.stringify(f.fs.snapshot()), /RAW_OLD_CONTEXT/);
  assert.equal(f.job.maintenanceApplied, undefined);
  assert.match(JSON.stringify(f.owner.events.at(-1)), /cancelled/);
});

test("legacy per-turn extraction jobs retire without calling a model", async () => {
  const f = await fixture();
  f.owner.record.postProcessing = [
    {
      turnId: "legacy",
      userText: "hello",
      assistantText: "hi",
      pending: ["memory"],
    },
  ];
  await f.host.retryPostProcessing("owner");
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.owner.record.postProcessing, []);
});
