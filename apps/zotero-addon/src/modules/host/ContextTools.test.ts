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
import { ContextToolProvider } from "./ContextTools";
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
      content: "retrieval " + "证据".repeat(1000),
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
