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

test("archive keeps refs stable; only a nonempty explicit read renews retention", async () => {
  const { store } = await setup();
  const ref = { taskId: "task_a", windowId: "w", itemId: "read" };
  await store.append({
    ...ref,
    role: "tool",
    toolName: "get_pages",
    content: "早期条件 xxxxxxxxx 最终证据",
    sourceIds: ["1:A"],
  });
  await store.archive("task_a", 100);
  const before = (await store.retentionInfo("task_a")).retention;
  const hit = (await store.search({ query: "最终证据" })).items[0];
  assert.equal(
    (await store.read(ref, hit.offset)).content.includes("最终证据"),
    true,
  );
  await store.sample("task_a");
  await store.exportTask("task_a");
  assert.deepEqual((await store.retentionInfo("task_a")).retention, before);
  await store.read(ref, 99999, 100, undefined, true);
  assert.equal(
    (await store.retentionInfo("task_a")).retention.lastReadAt,
    undefined,
  );
  await store.read(ref, 0, 100, undefined, true);
  assert.ok((await store.retentionInfo("task_a")).retention.lastReadAt! > 100);
  assert.equal(hit.itemId, ref.itemId);
});

test("legacy archive migration backs up the index, shards terms and never deletes original files", async () => {
  const fs = new InMemoryFileSystem();
  const ref = { taskId: "task_a", windowId: "w", itemId: "i" };
  const content = "早期关键证据";
  const index = {
    version: 1,
    windows: [],
    items: [
      {
        ...ref,
        role: "tool",
        createdAt: 1,
        characters: content.length,
        excerpt: content,
        sourceIds: [],
      },
    ],
    notes: [],
  };
  await fs.writeFile("/history/task_a/windows/w/i.txt", content);
  await fs.writeFile("/history/task_a/index.json", JSON.stringify(index));
  const store = new HistoryStore(fs, "/history");
  store.register(task());
  assert.equal(
    (await store.retentionInfo("task_a")).rawBytes,
    new TextEncoder().encode(content).length,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile("/history/task_a/index.pre-archive.json")),
    index,
  );
  assert.ok(await fs.readFile("/history/task_a/windows/w/terms.json"));
  const snapshot = fs.snapshot();
  assert.equal(
    (await store.retentionInfo("task_a")).bytes,
    Object.values(snapshot).reduce(
      (sum, text) => sum + new TextEncoder().encode(text).length,
      0,
    ),
  );
  let bodyReads = 0;
  const read = fs.readFile.bind(fs);
  fs.readFile = async (path) => {
    if (path.endsWith(".txt")) bodyReads++;
    return read(path);
  };
  for (let i = 0; i < 5; i++) await store.retentionInfo("task_a");
  assert.equal(bodyReads, 0);
  assert.equal(snapshot["/history/task_a/windows/w/i.txt"], content);
});

test("read leases block prune and UTF-16 continuation never splits an emoji", async () => {
  const { store } = await setup();
  const ref = { taskId: "task_a", windowId: "w", itemId: "emoji" };
  const content = "中文🧪".repeat(20);
  await store.append({ ...ref, role: "user", content, sourceIds: [] });
  const release = store.acquire("task_a");
  await assert.rejects(store.prune("task_a"), /in-flight read/);
  release();
  let all = "",
    offset: number | null = 0;
  do {
    const part = await store.read(ref, offset, 5);
    all += part.content;
    offset = part.nextOffset;
  } while (offset !== null);
  assert.equal(all, content);
  assert.equal((await store.read(ref, 2, 1)).content, "🧪");
  assert.equal((await store.read(ref, 2, 1)).nextOffset, 4);
  await store.prune("task_a");
  await assert.rejects(store.read(ref), /retention policy/);
});

test("archive delivery is independent of verification and never renews retention", async () => {
  const { store } = await setup();
  const ref = { taskId: "task_a", windowId: "w", itemId: "evidence" };
  await store.append({
    ...ref,
    role: "tool",
    content: "original evidence",
    sourceIds: [],
  });
  await store.archive("task_a", 100);
  await store.recordDelivery(ref, "host-provided");
  assert.equal((await store.read(ref)).item.delivery, "host-provided");
  await store.recordDelivery(ref, "native-request");
  await store.recordDelivery(ref, "host-provided");
  const item = (await store.read(ref)).item;
  assert.equal(item.delivery, "native-request");
  assert.equal(item.verification, undefined);
  assert.equal(
    (await store.retentionInfo("task_a")).retention.lastReadAt,
    undefined,
  );
});

test("distillation sampling stays bounded and spans early and late windows and sources", async () => {
  const { store } = await setup();
  for (let n = 0; n < 40; n++)
    await store.append({
      taskId: "task_a",
      windowId: `w${n}`,
      itemId: `i${n}`,
      role: "tool",
      content: `Evidence ${n} `.repeat(500),
      sourceIds: [`source${n % 3}`],
    });
  const sample = await store.sample("task_a", 2000);
  assert.ok(sample.reduce((n, s) => n + s.content.length, 0) <= 2000);
  assert.ok(sample.some((s) => s.ref.includes(":w0:")));
  assert.ok(sample.some((s) => s.ref.includes(":w39:")));
  assert.equal(new Set(sample.flatMap((s) => s.sourceIds)).size, 3);
});
