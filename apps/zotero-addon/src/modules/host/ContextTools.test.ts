import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HistoryStore,
  InMemoryFileSystem,
  MemoryEngine,
} from "@confucius/memory";
import {
  CompositeToolProvider,
  FilteredToolProvider,
} from "@confucius/harness";
import { contextTextTokens, type ToolResult } from "@confucius/protocol";
import { ContextToolProvider, readWorkingNotes } from "./ContextTools";
import { TaskHistoryToolProvider } from "./HistoryTools";
import { ToolExecutionService } from "./ReliableToolProvider";
import { registerHostOperationDomains } from "./HostOperationDomains";
import { memoryJsonStorage } from "./RuntimeStorage";

function fixture(fs = new InMemoryFileSystem()) {
  const history = new HistoryStore(fs, "/history");
  const memory = new MemoryEngine({ fs, root: "/memory", now: () => 100 });
  for (const id of ["current", "related", "other"])
    history.register({
      id,
      title: id,
      backend: "native",
      status: "completed",
      updatedAt: 1,
    });
  let scope: string[] | undefined;
  let switches = 0;
  let proposals = 0;
  const provider = new ContextToolProvider({
    history,
    memory,
    taskId: "current",
    references: () => ["related"],
    sourceIds: () => scope,
    binding: () => ({
      runId: "run",
      intentRevision: 1,
      sourceFingerprint: "sources",
    }),
    legacy: new TaskHistoryToolProvider({
      store: history,
      taskId: "current",
      references: () => [],
      requestNewContext: () => switches++,
    }),
    requestNewContext: () => switches++,
    propose: async () => {
      proposals++;
      return {
        ok: true,
        toolName: "context_save",
        data: { requiresApproval: true },
      };
    },
  });
  return {
    fs,
    history,
    memory,
    provider,
    scope: (value: string[] | undefined) => {
      scope = value;
    },
    switches: () => switches,
    proposals: () => proposals,
  };
}
const data = <T>(result: ToolResult): T => {
  assert.equal(result.ok, true, !result.ok ? result.message : "");
  return (result as { data: T }).data;
};

test("search deduplicates complete passages but preserves distinct pages with identical hit excerpts", async () => {
  const f = fixture();
  const common = "Evidence needle " + "same excerpt ".repeat(50);
  for (const [itemId, suffix] of [
    ["a", "page one"],
    ["b", "page two"],
    ["duplicate", "page one"],
  ])
    await f.history.append({
      taskId: "current",
      windowId: "w",
      itemId,
      role: "tool",
      content: common + suffix,
      sourceIds: ["1:PAPER"],
    });
  const result = data<{ results: Array<{ ref: string }> }>(
    await f.provider.call("context_search", { query: "needle" }),
  );
  assert.equal(result.results.length, 2);
});

test("source-scoped tools advertise task notes and guide compatible old memory calls to notes", async () => {
  const f = fixture();
  f.scope(["1:PAPER"]);
  const save = f.provider
    .listTools()
    .find((tool) => tool.name === "context_save")!;
  assert.deepEqual(save.inputSchema.properties.target, {
    type: "string",
    enum: ["note"],
  });
  assert.match(save.description, /target=note/);
  const denied = await f.provider.call("context_save", {
    target: "memory",
    content: "Pending report patch",
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, "permission_denied");
    assert.match(denied.message, /target=note/);
  }
  const saved = data<{ ref: string }>(
    await f.provider.call("context_save", {
      content: "Pending report patch",
    }),
  );
  assert.equal(saved.ref, "n:current:progress");
  assert.deepEqual((await f.history.listNotes("current"))[0].sourceIds, [
    "1:PAPER",
  ]);
  assert.equal((await f.memory.list()).length, 0);
  f.scope(undefined);
  assert.deepEqual(
    f.provider.listTools().find((tool) => tool.name === "context_save")!
      .inputSchema.properties.target,
    { type: "string", enum: ["note", "memory"] },
  );
});

test("handoff keeps the newest pending action ahead of large old notes and labels excerpts", async () => {
  const f = fixture();
  await f.history.writeNote(
    "current",
    "early_research",
    "OLD_RESEARCH " + "旧材料".repeat(1000),
    ["1:PAPER"],
  );
  await f.history.writeNote(
    "current",
    "progress",
    "LATEST_NEXT_ACTION: patch the saved report; all 29 annotations already exist.",
    ["1:PAPER"],
  );
  const notes = await readWorkingNotes(f.history, "current", 250, ["1:PAPER"]);
  assert.match(notes[0], /LATEST_NEXT_ACTION/);
  assert.match(notes.join("\n"), /Excerpt; use context_read/);
  assert.ok(
    notes.reduce((sum, note) => sum + contextTextTokens(note), 0) <= 250,
  );
  await f.history.writeNote("current", "outside", "OUTSIDE_SOURCE_SCOPE", [
    "1:OTHER",
  ]);
  const scoped = await readWorkingNotes(f.history, "current", 250, ["1:PAPER"]);
  assert.match(scoped[0], /LATEST_NEXT_ACTION/);
  assert.doesNotMatch(scoped.join("\n"), /OUTSIDE_SOURCE_SCOPE/);
  // Revising an earlier note should make it the current handoff, too.
  await f.history.writeNote(
    "current",
    "early_research",
    "REVISED_NEXT_ACTION",
    ["1:PAPER"],
  );
  const metadata = await f.history.listNotes("current");
  f.history.listNotes = async () =>
    metadata.map((note) => ({
      ...note,
      updatedAt: note.name === "early_research" ? 100 : 10,
    }));
  assert.match(
    (await readWorkingNotes(f.history, "current", 250, ["1:PAPER"]))[0],
    /REVISED_NEXT_ACTION/,
  );
});

test("auto-generated titles survive actual UTF-8 encoding at an emoji boundary", async () => {
  class Utf8Fs extends InMemoryFileSystem {
    override writeFile(path: string, content: string) {
      return super.writeFile(
        path,
        new TextDecoder().decode(new TextEncoder().encode(content)),
      );
    }
  }
  const f = fixture(new Utf8Fs());
  const content = "a".repeat(79) + "🧪 unchanged body";
  const saved = data<{ ref: string }>(
    await f.provider.call("context_save", { target: "memory", content }),
  );
  assert.equal(f.memory.get(saved.ref.slice(2))?.content, content);
  assert.equal(f.memory.get(saved.ref.slice(2))?.title, "a".repeat(79));
  const direct = await f.memory.save({
    content: "a".repeat(63) + "🧪 full body",
  });
  assert.equal(direct.title, "a".repeat(63));
});

test("similar facts with different values stay separate; identical text deduplicates", async () => {
  const f = fixture();
  const content = (marker: string) =>
    `Lookup term context-check; the retained answer marker is ${marker}. Test evidence only.`;
  const first = data<{ ref: string }>(
    await f.provider.call("context_save", {
      target: "memory",
      title: "First",
      content: content("VALUE-A"),
    }),
  );
  const second = data<{ ref: string }>(
    await f.provider.call("context_save", {
      target: "memory",
      title: "Second",
      content: content("VALUE-B"),
    }),
  );
  assert.notEqual(first.ref, second.ref);
  const repeated = data<{ ref: string }>(
    await f.provider.call("context_save", {
      target: "memory",
      title: "Reused",
      content: content("VALUE-A"),
    }),
  );
  assert.equal(first.ref, repeated.ref);
  assert.equal((await f.memory.list()).length, 2);
  assert.match(f.memory.get(first.ref.slice(2))!.content, /VALUE-A/);
  assert.match(f.memory.get(second.ref.slice(2))!.content, /VALUE-B/);
});

test("unified catalog hides aliases but compatibility dispatch and filtering remain effective", async () => {
  const { provider } = fixture();
  assert.deepEqual(
    provider.listTools().map((tool) => tool.name),
    ["context_search", "context_read", "context_save", "new_context"],
  );
  const composite = new CompositeToolProvider([provider]);
  assert.equal((await composite.call("notes_list", {})).ok, true);
  assert.equal(
    (
      await new FilteredToolProvider(
        composite,
        new Set(["context_search"]),
      ).call("notes_list", {})
    ).ok,
    false,
  );
});

test("default search spans related work, content-indexed notes and memory within the result budget", async () => {
  const f = fixture();
  await f.memory.save({
    id: "m",
    content: "retrieval 记忆证据",
    protection: "none",
  });
  for (const taskId of ["current", "related", "other"])
    await f.history.append({
      taskId,
      windowId: "w",
      itemId: "i",
      role: "tool",
      sourceIds: ["1:A"],
      content: `${taskId} retrieval ` + "证据".repeat(1000),
    });
  await f.history.writeNote(
    "related",
    "progress",
    "retrieval 条件：数据不得泄漏",
    ["1:A"],
  );
  const result = data<{ results: Array<{ ref: string }>; more: boolean }>(
    await f.provider.call("context_search", { query: "retrieval" }),
  );
  assert.ok(result.results.some((row) => row.ref === "n:related:progress"));
  assert.ok(result.results.some((row) => row.ref === "m:m"));
  assert.ok(result.results.every((row) => !row.ref.includes(":other:")));
  assert.ok(contextTextTokens(JSON.stringify(result)) <= 1500);
  assert.equal(f.memory.get("m")?.accessCount, 0);
  const compact = data<{ results: unknown[] }>(
    await f.provider.call("context_search", {
      query: "retrieval",
      maxTokens: 180,
    }),
  );
  assert.ok(contextTextTokens(JSON.stringify(compact)) <= 180);
  assert.equal(
    (await f.provider.call("context_read", { ref: "m:m", maxTokens: 0 })).ok,
    false,
  );
  const all = data<{ results: Array<{ ref: string }> }>(
    await f.provider.call("context_search", {
      query: "retrieval",
      scope: "all",
    }),
  );
  assert.ok(all.results.some((row) => row.ref.includes(":other:")));
  f.scope(["1:A"]);
  assert.equal(
    (await f.provider.call("context_read", { ref: "n:related:progress" })).ok,
    true,
  );
  f.scope(["1:B"]);
  assert.equal(
    data<{ results: unknown[] }>(
      await f.provider.call("context_search", { query: "retrieval" }),
    ).results.length,
    0,
  );
  assert.equal(
    (await f.provider.call("context_read", { ref: "n:related:progress" })).ok,
    false,
  );
  assert.equal(
    (await f.provider.call("context_read", { ref: "h:related:w:i" })).ok,
    false,
  );
  assert.equal(
    (await f.provider.call("context_read", { ref: "m:m" })).ok,
    false,
  );
  assert.equal(f.memory.get("m")?.accessCount, 0);
});

test("explicit reads page Unicode without gaps and renew only successful memory reads", async () => {
  const f = fixture();
  const text = "中文🧪abc".repeat(500);
  await f.memory.save({ id: "m", content: text, protection: "none" });
  let content = "";
  let offset: number | null = 0;
  do {
    const part: { content: string; nextOffset: number | null; tokens: number } =
      data<{ content: string; nextOffset: number | null; tokens: number }>(
        await f.provider.call("context_read", {
          ref: "m:m",
          offset,
          maxTokens: 100,
        }),
      );
    assert.ok(part.tokens <= 100);
    content += part.content;
    offset = part.nextOffset;
  } while (offset !== null);
  assert.equal(content, text);
  const count = f.memory.get("m")!.accessCount;
  await f.provider.call("context_read", { ref: "m:m", offset: 999999 });
  assert.equal(f.memory.get("m")!.accessCount, count);
  await f.history.append({
    taskId: "current",
    windowId: "w",
    itemId: "i",
    role: "user",
    sourceIds: [],
    content: "old",
  });
  await f.history.prune("current");
  const cleared = await f.provider.call("context_read", {
    ref: "h:current:w:i",
  });
  assert.equal(cleared.ok, false);
  if (!cleared.ok) assert.match(cleared.message, /cleared/);
});

test("working notes use a valid durable intent, replay and recovery; protected memory needs a proposal", async () => {
  const f = fixture();
  const execution = new ToolExecutionService(memoryJsonStorage());
  registerHostOperationDomains(execution, {
    history: f.history,
    artifacts: { get: async () => null },
    tools: { reconcile: async () => null },
  });
  const wrapped = execution.wrap(f.provider, { taskId: "current" });
  const args = {
    target: "note",
    content: "Progress: compared the evidence",
    name: "progress",
  };
  assert.equal(
    (
      await wrapped.call("context_save", { ...args }, undefined, {
        operationId: "op",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await wrapped.call("context_save", { ...args }, undefined, {
        operationId: "op",
      })
    ).ok,
    true,
  );
  assert.equal((await f.history.listNotes("current"))[0].revision, 1);
  const operation = (await execution.getOperation("op"))!;
  await execution.importLegacyOperation({ ...operation });
  await execution.retireContext("current");
  const retired = (await execution.getOperation("op"))!;
  assert.doesNotMatch(JSON.stringify(retired), /compared the evidence/);
  assert.equal(
    (
      await wrapped.call("context_save", { ...args }, undefined, {
        operationId: "op",
      })
    ).ok,
    false,
  );
  await f.memory.save({
    id: "protected",
    content: "User fact",
    protection: "user",
  });
  assert.equal(
    (
      await f.provider.call("context_save", {
        target: "memory",
        id: "protected",
        content: "Changed",
      })
    ).ok,
    true,
  );
  assert.equal(f.proposals(), 1);
  assert.equal(f.memory.get("protected")!.content, "User fact");
  const saved = data<{ ref: string }>(
    await f.provider.call("context_save", {
      target: "memory",
      content: "Ordinary reusable work",
    }),
  );
  assert.equal(f.memory.get(saved.ref.slice(2))!.protection, "none");
  await f.provider.call("new_context", {});
  assert.equal(f.switches(), 1);
});

test("rank quotas, bilingual hit offsets, cursor refill and source-fragment deduplication", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++)
    await f.history.writeNote(
      "current",
      `note${i}`,
      `资料${i} ` + "前文".repeat(600) + ` retrieval 证据笔记 ${i}`,
      ["1:A"],
    );
  for (let i = 0; i < 11; i++)
    await f.history.append({
      taskId: "current",
      windowId: "w",
      itemId: `item${i}`,
      role: "tool",
      toolName: "get_pages",
      content: `retrieval 历史证据编号 ${i}`,
      sourceIds: ["1:A"],
    });
  await f.history.append({
    taskId: "related",
    windowId: "w",
    itemId: "duplicate",
    role: "tool",
    toolName: "get_pages",
    content: "retrieval 历史证据编号 0",
    sourceIds: ["1:A"],
  });
  await f.memory.save({
    id: "memoryA",
    title: "memory A",
    content:
      "retrieval alpha dataset reflects an independent astronomy experiment",
    protection: "none",
  });
  await f.memory.save({
    id: "memoryB",
    title: "memory B",
    content:
      "retrieval beta cohort explains the biology population measurement",
    protection: "none",
  });
  type Page = {
    results: Array<{ ref: string; offset: number; excerpt: string }>;
    nextCursor: string | null;
  };
  const first = data<Page>(
    await f.provider.call("context_search", { query: "retrieval" }),
  );
  assert.deepEqual(
    ["n", "h", "m"].map(
      (kind) =>
        first.results.filter((r) => r.ref.startsWith(`${kind}:`)).length,
    ),
    [2, 4, 2],
  );
  assert.ok(
    first.results
      .filter((r) => r.ref.startsWith("n:"))
      .every((r) => r.offset > 1000 && r.excerpt.includes("retrieval")),
  );
  const refs = first.results.map((r) => r.ref);
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor) {
    assert.ok(pages++ < 10, "pagination must make progress");
    const page = data<Page>(
      await f.provider.call("context_search", { query: "retrieval", cursor }),
    );
    refs.push(...page.results.map((r) => r.ref));
    cursor = page.nextCursor;
  }
  assert.equal(new Set(refs).size, refs.length);
  assert.equal(refs.filter((ref) => ref.startsWith("h:")).length, 11);
  f.scope(["1:B"]);
  assert.equal(
    (
      await f.provider.call("context_search", {
        query: "retrieval",
        cursor: first.nextCursor,
      })
    ).ok,
    false,
  );
});

test("precise note evidence survives save/read and rejects stale versions without renewing retention", async () => {
  const f = fixture();
  await f.history.writeNote(
    "related",
    "finding",
    "start ".repeat(2000) + "decisive late evidence",
  );
  const result = data<{
    results: Array<{
      ref: string;
      offset: number;
      endOffset: number;
      sourceVersion: string;
      excerpt: string;
    }>;
  }>(await f.provider.call("context_search", { query: "decisive late" }));
  const hit = result.results.find((r) => r.ref === "n:related:finding")!;
  assert.ok(hit.offset > 10000);
  const location = {
    ref: hit.ref,
    offset: hit.offset,
    endOffset: hit.endOffset,
    sourceVersion: hit.sourceVersion,
  };
  const read = data<{ content: string; offset: number; endOffset: number }>(
    await f.provider.call("context_read", location),
  );
  assert.equal(read.content, hit.excerpt);
  data(
    await f.provider.call("context_save", {
      content: "Continue using the late finding",
      nextAction: "Compare evidence",
      evidence: [location],
    }),
  );
  assert.deepEqual((await f.history.listNotes("current"))[0].state?.evidence, [
    location,
  ]);
  await f.history.writeNote("related", "finding", "replacement");
  await f.history.archive("related", 100);
  assert.equal((await f.provider.call("context_read", location)).ok, false);
  assert.equal(
    (
      await f.provider.call("context_save", {
        content: "stale",
        evidence: [location],
      })
    ).ok,
    false,
  );
  assert.equal(
    (await f.history.retentionInfo("related")).retention.lastReadAt,
    undefined,
  );
});

test("search returns distinct passages of one original and invalidates cursors after corpus changes", async () => {
  const f = fixture();
  await f.history.append({
    taskId: "current",
    windowId: "w",
    itemId: "many",
    role: "tool",
    sourceIds: [],
    content: Array.from(
      { length: 15 },
      (_, i) => `needle experiment ${i}: ${"detail ".repeat(20)}`,
    ).join("\n\n"),
  });
  type Page = {
    results: Array<{ ref: string; offset: number }>;
    nextCursor: string;
  };
  const first = data<Page>(
    await f.provider.call("context_search", { query: "needle" }),
  );
  assert.ok(first.results.length > 1);
  assert.equal(
    new Set(first.results.map((r) => `${r.ref}:${r.offset}`)).size,
    first.results.length,
  );
  assert.ok(first.nextCursor);
  await f.history.append({
    taskId: "current",
    windowId: "w",
    itemId: "new",
    role: "tool",
    sourceIds: [],
    content: "needle changed corpus",
  });
  const resumed = await f.provider.call("context_search", {
    query: "needle",
    cursor: first.nextCursor,
  });
  assert.equal(resumed.ok, false);
  assert.match(!resumed.ok ? resumed.message : "", /current index/);
});

test("reported analysis needs source evidence and cannot claim host verification", async () => {
  const f = fixture();
  f.scope(["1:A"]);
  assert.equal(
    (
      await f.provider.call("context_save", {
        content: "Done",
        sourceProgress: [{ sourceId: "1:A", status: "analyzed" }],
      })
    ).ok,
    false,
  );
  await f.history.append({
    taskId: "current",
    windowId: "w",
    itemId: "read",
    role: "tool",
    sourceIds: ["1:A"],
    content: "actual source excerpt",
  });
  data(
    await f.provider.call("context_save", {
      content: "Result with limits",
      evidence: [{ ref: "h:current:w:read" }],
      sourceProgress: [{ sourceId: "1:A", status: "analyzed" }],
    }),
  );
  assert.equal(
    (await f.history.listNotes("current"))[0].state?.sourceProgress?.[0].status,
    "analyzed",
  );
  assert.equal(
    (
      await f.provider.call("context_save", {
        content: "Verified",
        sourceProgress: [{ sourceId: "1:A", status: "verified" }],
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await f.provider.call("context_save", {
        content: "Out of scope",
        sourceProgress: [{ sourceId: "1:B", status: "failed" }],
      })
    ).ok,
    false,
  );
});

test("coverage enumerates every source within a budget, reports the next unread page and enforces scope", async () => {
  const f = fixture();
  const scope: { allowed?: string[] } = {};
  const coverage = {
    version: 1 as const,
    binding: { runId: "run", intentRevision: 1, sourceFingerprint: "bound" },
    enumeration: "bound-items" as const,
    entries: Array.from({ length: 21 }, (_, i) => ({
      sourceId: `1:P${i}`,
      title: `Paper ${i}`,
      bindingVersion: `v${i}`,
      pageCount: 2000,
      pagesObserved: [1, 3],
      truncatedPages: [3],
      read: "partial" as const,
      analysis: "unreported" as const,
      verification: "unknown" as const,
      evidence: [],
    })),
  };
  const provider = new ContextToolProvider({
    history: f.history,
    memory: f.memory,
    taskId: "current",
    references: () => [],
    sourceIds: () => scope.allowed,
    coverage: async () => coverage,
    legacy: new TaskHistoryToolProvider({
      store: f.history,
      taskId: "current",
      references: () => [],
      requestNewContext: () => {},
    }),
    requestNewContext: () => {},
    propose: async () => ({
      ok: false,
      toolName: "context_save",
      code: "unavailable",
      message: "unused",
    }),
  });
  const ids: string[] = [];
  let cursor: string | null = null;
  type CoveragePage = {
    entries: Array<{ sourceId: string; nextUnreadPage: number }>;
    nextCursor: string | null;
  };
  do {
    const page: CoveragePage = data<CoveragePage>(
      await provider.call("context_search", {
        view: "coverage",
        ...(cursor ? { cursor } : {}),
      }),
    );
    assert.ok(page.entries.every((e) => e.nextUnreadPage === 2));
    ids.push(...page.entries.map((e) => e.sourceId));
    cursor = page.nextCursor;
    assert.ok(ids.length <= 21);
  } while (cursor);
  assert.equal(new Set(ids).size, 21);
  scope.allowed = ["1:P3"];
  const scoped = data<{
    expected: number;
    entries: Array<{ sourceId: string }>;
  }>(await provider.call("context_search", { view: "coverage" }));
  assert.equal(scoped.expected, 1);
  assert.deepEqual(
    scoped.entries.map((e) => e.sourceId),
    ["1:P3"],
  );
});
