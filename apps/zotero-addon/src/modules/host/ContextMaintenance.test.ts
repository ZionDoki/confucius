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
  archivesToPrune,
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
  clearRetiredContext(state: State): Promise<void>;
  archiveRetiredContext(state: State): Promise<void>;
  retentionReasons(state: State): Promise<string[]>;
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
    historyCleanupEnabled: () => true,
    ids: () => "testid",
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
  const cleaned: string[][] = [];
  Reflect.set(f.host, "readingDiscussionsInstance", {
    removeArtifacts: async (ids: string[]) => {
      cleaned.push(ids);
    },
  });
  assert.equal((await f.host.sessionDelete("old")).ok, true);
  assert.deepEqual(cleaned, [["kept-report"]]);
  assert.ok(!JSON.stringify(f.fs.snapshot()).includes("RAW_OLD_CONTEXT"));
  assert.equal(await f.logs.read("old"), null);
  assert.equal(f.memory.get("kept")?.content, "User-saved conclusion");
  assert.deepEqual(f.target.record.artifactIds, ["kept-report"]);
});

test("successful distillation retains readable originals and independent artifact identities", async () => {
  const f = await fixture();
  f.history.prune = async () => {
    assert.fail("Distillation cannot authorize deletion");
  };
  await f.history.archive("old", 100);
  await f.host.runContextMaintenance(f.owner, f.job, () => true);
  assert.equal(f.calls(), 1);
  assert.equal((await f.memory.list()).length, 1);
  assert.equal(f.target.messages.length, 1);
  assert.deepEqual(f.target.record.artifactIds, ["kept-report"]);
  assert.equal(f.target.record.historyClearedAt, undefined);
  assert.equal(f.target.record.historyDistilledAt, 2);
  assert.match(
    (await f.history.read({ taskId: "old", windowId: "w", itemId: "i" }))
      .content,
    /RAW_OLD_CONTEXT/,
  );
});

test("hot-tier archive needs no model, releases working copies only after persistence and preserves refs", async () => {
  const f = await fixture();
  await f.host.archiveRetiredContext(f.target);
  assert.equal(f.calls(), 0);
  assert.equal(f.target.messages.length, 0);
  assert.equal(await f.logs.read("old"), null);
  assert.equal(
    (await f.history.retentionInfo("old")).retention.tier,
    "archived",
  );
  assert.equal(
    (await f.history.retentionInfo("old")).retention.projectionPending,
    false,
  );
  assert.match(
    (await f.history.read({ taskId: "old", windowId: "w", itemId: "i" }))
      .content,
    /RAW_OLD_CONTEXT/,
  );
  assert.ok(
    (await f.history.exportTask("old")).items.some((i) =>
      i.content?.includes("RAW_OLD_CONTEXT"),
    ),
  );
});

test("failed archive state persistence leaves the old working projection recoverable", async () => {
  const f = await fixture();
  f.persist(async () => {
    if (!f.target.messages.length) throw new Error("state offline");
  });
  await assert.rejects(f.host.archiveRetiredContext(f.target), /state offline/);
  assert.equal(f.target.messages.length, 1);
  assert.ok(await f.logs.read("old"));
  assert.match(
    (await f.history.read({ taskId: "old", windowId: "w", itemId: "i" }))
      .content,
    /RAW_OLD_CONTEXT/,
  );
});

test("archive expiration and capacity honor last explicit use, protected references and soft overflow", () => {
  const now = 200 * 86400000;
  const base = {
    id: "a",
    updatedAt: 0,
    archivedAt: now - 91 * 86400000,
    bytes: 1,
    protected: false,
  };
  assert.deepEqual(
    archivesToPrune([base], now).map((r) => r.id),
    ["a"],
  );
  assert.deepEqual(
    archivesToPrune([{ ...base, lastReadAt: now - 1 }], now),
    [],
  );
  assert.deepEqual(
    archivesToPrune(
      [{ ...base, protected: true, bytes: CONTEXT_POLICY.archiveBytes + 1 }],
      now,
    ),
    [],
  );
  const rows = [
    { ...base, archivedAt: now - 2, bytes: CONTEXT_POLICY.archiveBytes },
    { ...base, id: "b", archivedAt: now - 1, bytes: 1 },
  ];
  assert.deepEqual(
    archivesToPrune(rows, now).map((r) => r.id),
    ["a"],
  );
});

test("active task references and handoff refs protect other archives", async () => {
  const f = await fixture();
  f.owner.activeTurnId = "active";
  f.owner.record.references = [{ kind: "task", taskId: "old", title: "old" }];
  assert.deepEqual(await f.host.retentionReasons(f.target), [
    "referenced_by_active_task",
  ]);
  const release = f.history.acquire("old");
  assert.ok((await f.host.retentionReasons(f.target)).includes("reading"));
  release();
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

test("retention cleanup resumes its tombstone after interrupted deletion without a model call", async () => {
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
  await assert.rejects(f.host.clearRetiredContext(f.target), /interrupted/);
  assert.equal((await f.history.retentionInfo("old")).cleanupPending, true);
  await f.host.clearRetiredContext(f.target);
  assert.equal(f.calls(), 0);
  assert.doesNotMatch(JSON.stringify(f.fs.snapshot()), /RAW_OLD_CONTEXT/);
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
