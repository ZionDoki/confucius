import assert from "node:assert/strict";
import { it } from "node:test";
import {
  ConversationLogEngine,
  InMemoryFileSystem,
  MemoryEngine,
  HistoryStore,
  type LogReadResult,
} from "@confucius/memory";
import { ConfuciusMemoryToolProvider, ZoteroMemoryFs } from "./MemoryTools";

it("migrates legacy history through directory-only IOUtils without walking index files", async () => {
  const ref = { taskId: "legacy", windowId: "window", itemId: "evidence" };
  const content = "Original evidence 中文";
  const original = JSON.stringify({
    version: 1,
    windows: [],
    items: [
      {
        ...ref,
        role: "tool",
        characters: content.length,
        createdAt: 1,
        excerpt: content,
        sourceIds: [],
      },
    ],
    notes: [],
  });
  const files = new Map([
    ["/history/legacy/index.json", original],
    ["/history/legacy/windows/window/evidence.txt", content],
  ]);
  const children = (path: string) => {
    path = path.replace(/\/+$/, "");
    return [
      ...new Set(
        [...files.keys()]
          .filter((file) => file.startsWith(path + "/"))
          .map(
            (file) => path + "/" + file.slice(path.length + 1).split("/")[0],
          ),
      ),
    ];
  };
  const previous = ["IOUtils", "PathUtils", "Zotero"].map(
    (key) => [key, Reflect.get(globalThis, key)] as const,
  );
  Reflect.set(globalThis, "Zotero", { isWin: false });
  Reflect.set(globalThis, "PathUtils", {
    parent: (path: string) => path.slice(0, path.lastIndexOf("/")),
  });
  Reflect.set(globalThis, "IOUtils", {
    exists: async (path: string) =>
      files.has(path) || children(path).length > 0,
    stat: async (path: string) => ({
      type: files.has(path) ? "regular" : "directory",
      size: new TextEncoder().encode(files.get(path) ?? "").length,
    }),
    getChildren: async (path: string) => {
      if (files.has(path)) throw new Error("NS_ERROR_FILE_DESTINATION_NOT_DIR");
      return children(path);
    },
    makeDirectory: async () => undefined,
    readUTF8: async (path: string) => {
      assert.ok(files.has(path));
      return files.get(path)!;
    },
    writeUTF8: async (path: string, text: string) => {
      files.set(path, text);
    },
    remove: async (path: string) => {
      files.delete(path);
    },
  });
  try {
    const fs = new ZoteroMemoryFs();
    const store = new HistoryStore(fs, "/history");
    store.register({
      id: "legacy",
      title: "Legacy",
      status: "completed",
      backend: "native",
      updatedAt: 1,
    });
    assert.equal(
      (await store.retentionInfo("legacy")).rawBytes,
      new TextEncoder().encode(content).length,
    );
    assert.equal(files.get("/history/legacy/index.pre-archive.json"), original);
    assert.equal((await store.read(ref)).content, content);
    assert.deepEqual(
      await fs.listFiles("/history/legacy/windows/window/terms.json"),
      [],
    );
    await store.prune("legacy");
    assert.equal((await store.retentionInfo("legacy")).bytes, 0);
  } finally {
    for (const [key, value] of previous) Reflect.set(globalThis, key, value);
  }
});

it("retains hidden conversation-log aliases for existing calls", async () => {
  const fs = new InMemoryFileSystem();
  const memory = new MemoryEngine({ fs, root: "/memory" });
  const logs = new ConversationLogEngine({ fs, root: "/logs" });
  await logs.appendTurn({
    sessionId: "research-task",
    title: "Grounded survey",
    turnId: "turn-1",
    userText: "Find evidence on retrieval reliability",
    assistantText: "The retrieval experiment needs a held-out evaluation.",
  });
  const provider = new ConfuciusMemoryToolProvider(memory, logs);
  const names = provider.listTools().map((tool) => tool.name);
  for (const name of ["conversation_log_search", "conversation_log_read"]) {
    assert.equal(names.filter((candidate) => candidate === name).length, 0);
    assert.equal(provider.getMeta(name)?.mutatesState, false);
    assert.equal(provider.getMeta(name)?.catalog, "memory.read");
    assert.equal(provider.getSchema(name)?.type, "object");
  }
  const searchArgs = { query: "retrieval reliability", limit: 5 };
  assert.equal(
    await provider.prepare("conversation_log_search", searchArgs),
    null,
  );
  const search = await provider.call("conversation_log_search", searchArgs);
  assert.equal(search.ok, true);
  const hits = search.ok
    ? (
        search.data as {
          results: Array<{ sessionId: string; excerpt: string }>;
        }
      ).results
    : [];
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, "research-task");
  assert.match(hits[0].excerpt, /retrieval/i);

  const readArgs = { sessionId: hits[0].sessionId, maxChars: 4000 };
  assert.equal(await provider.prepare("conversation_log_read", readArgs), null);
  const read = await provider.call("conversation_log_read", readArgs);
  assert.equal(read.ok, true);
  const log = read.ok
    ? (read.data as { log: LogReadResult & { sessionId: string } }).log
    : undefined;
  assert.equal(log?.sessionId, "research-task");
  assert.match(log?.content ?? "", /held-out evaluation/);
});
