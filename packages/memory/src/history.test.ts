import assert from "node:assert/strict";
import { test } from "node:test";
import { initialContextWindow } from "@confucius/protocol";
import { InMemoryFileSystem } from "./fs";
import { HistoryStore } from "./history";

const task = (id = "task_a") => ({
  id,
  title: "共同标题",
  status: "completed" as const,
  backend: "native" as const,
  updatedAt: 1,
});
async function setup(fs = new InMemoryFileSystem()) {
  const store = new HistoryStore(fs, "/history");
  store.register(task());
  store.register(task("task_b"));
  await store.addWindow("task_a", initialContextWindow("task_a", "native", 1));
  return { fs, store };
}
test("complete evidence survives pagination, rollover and restart without duplicate items", async () => {
  const { fs, store } = await setup();
  const content = "早期论文证据" + "x".repeat(50000) + "最终页码 87";
  const input = {
    taskId: "task_a",
    windowId: "ctx_task_a_1",
    itemId: "item_1",
    role: "tool" as const,
    content,
    sourceIds: ["1:ABC"],
  };
  await store.append(input);
  await store.append(input);
  await store.addWindow("task_a", {
    ...initialContextWindow("task_a", "native"),
    id: "window_2",
    number: 2,
  });
  const restored = new HistoryStore(fs, "/history");
  restored.register(task());
  const found = await restored.search({ query: "最终页码" });
  assert.equal(found.total, 1);
  assert.match(found.items[0].excerpt, /最终页码/);
  let body = "",
    offset: number | null = 0;
  while (offset !== null) {
    const read = await restored.read(input, offset, 7000);
    body += read.content;
    offset = read.nextOffset;
  }
  assert.equal(body, content);
  assert.equal((await restored.windows("task_a")).length, 2);
});
test("global retrieval prefers explicit references and enforces source filters and deletion", async () => {
  const { store, fs } = await setup();
  for (const id of ["task_a", "task_b"])
    await store.append({
      taskId: id,
      windowId: "window",
      itemId: "item",
      role: "assistant",
      content: "研究结果与证据",
      sourceIds: [id === "task_a" ? "1:A" : "1:B"],
    });
  assert.equal(
    (await store.search({ query: "研究", preferredTaskIds: ["task_b"] }))
      .items[0].taskId,
    "task_b",
  );
  assert.equal((await store.search({ sourceIds: ["1:A"] })).total, 1);
  await assert.rejects(
    store.read(
      { taskId: "task_b", windowId: "window", itemId: "item" },
      0,
      100,
      ["1:A"],
    ),
  );
  await store.deleteTask("task_b");
  assert.equal((await store.search({ query: "研究" })).total, 1);
  const restored = new HistoryStore(fs, "/history");
  restored.register(task("task_b"));
  assert.equal((await restored.listTasks()).total, 0);
  await assert.rejects(
    restored.read({ taskId: "task_b", windowId: "window", itemId: "item" }),
  );
});
test("reported window usage is persisted without allocating another window", async () => {
  const { store, fs } = await setup();
  const window = initialContextWindow("task_a", "native", 1);
  await store.addWindow("task_a", window);
  window.inputTokens = 2400;
  window.usageSource = "reported";
  await store.addWindow("task_a", window);
  const restored = new HistoryStore(fs, "/history");
  restored.register(task());
  const windows = await restored.windows("task_a");
  assert.equal(windows.length, 1);
  assert.equal(windows[0].inputTokens, 2400);
  assert.equal(windows[0].usageSource, "reported");
});
test("failed index commit leaves the previous note and window readable", async () => {
  class FailingFs extends InMemoryFileSystem {
    fail = false;
    override async writeFile(path: string, content: string) {
      if (this.fail && path.endsWith("index.json"))
        throw new Error("disk full");
      return super.writeFile(path, content);
    }
  }
  const fs = new FailingFs();
  const { store } = await setup(fs);
  await store.writeNote("task_a", "progress", "已核验论文 A，下一步核验 B");
  fs.fail = true;
  await assert.rejects(
    store.writeNote("task_a", "progress", "incorrect replacement"),
    /disk full/,
  );
  await assert.rejects(
    store.addWindow("task_a", {
      ...initialContextWindow("task_a", "native"),
      id: "failed_window",
    }),
    /disk full/,
  );
  assert.match((await store.readNote("task_a", "progress")).content, /已核验/);
  assert.equal((await store.windows("task_a")).length, 1);
  await assert.rejects(store.writeNote("task_a", "../outside", "bad"));
});
