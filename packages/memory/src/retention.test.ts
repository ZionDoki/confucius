import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_POLICY, initialContextWindow } from "@confucius/protocol";
import { MemoryEngine } from "./engine";
import { InMemoryFileSystem } from "./fs";
import { HistoryStore } from "./history";
import { ConversationLogEngine } from "./logs";
import { serializeMemory } from "./markdown";
import { tokenize } from "./tokenize";

const day = 86400000;
test("failed index cleanup is retried without leaving a deleted memory body in the overview", async () => {
  class Fs extends InMemoryFileSystem {
    failIndex = false;
    override async writeFile(path: string, content: string) {
      if (this.failIndex && path.endsWith("MEMORY.md"))
        throw new Error("index busy");
      return super.writeFile(path, content);
    }
  }
  const fs = new Fs();
  const engine = new MemoryEngine({ fs, root: "/mem" });
  await engine.save({
    id: "old",
    content: "REMOVED_MEMORY_BODY",
    protection: "none",
  });
  fs.failIndex = true;
  await assert.rejects(engine.delete("old"), /index busy/);
  assert.ok(JSON.stringify(fs.snapshot()).includes("REMOVED_MEMORY_BODY"));
  fs.failIndex = false;
  await engine.maintain();
  assert.ok(!JSON.stringify(fs.snapshot()).includes("REMOVED_MEMORY_BODY"));
});
test("search, merge and restart do not renew an ordinary memory; explicit read does", async () => {
  let now = day;
  const fs = new InMemoryFileSystem();
  const engine = new MemoryEngine({ fs, root: "/mem", now: () => now });
  const cold = await engine.save({
    id: "cold",
    content: "cold source experiment",
    protection: "none",
  });
  const warm = await engine.save({
    id: "warm",
    content: "warm source experiment",
    protection: "none",
  });
  await engine.save({
    id: "protected",
    content: "explicit user preference",
    protection: "user",
  });
  now += 89 * day;
  await engine.search({ query: "experiment" });
  assert.equal(engine.get(cold.id)?.lastUsedAt, undefined);
  assert.equal(engine.get(cold.id)?.accessCount, 0);
  await engine.update({
    id: cold.id,
    content: "cold source revised experiment",
  });
  assert.equal(engine.get(cold.id)?.lastUsedAt, undefined);
  await engine.read(warm.id);
  now += day;
  const restored = new MemoryEngine({ fs, root: "/mem", now: () => now });
  assert.deepEqual(
    (await restored.maintain()).map((op) => op.id),
    [cold.id],
  );
  assert.ok(restored.get(warm.id));
  assert.ok(restored.get("protected"));
  assert.ok(!JSON.stringify(fs.snapshot()).includes("cold source"));
});

test("capacity evicts oldest ordinary content but rejects writes when protected memory fills it", async () => {
  let now = day;
  const fs = new InMemoryFileSystem();
  const engine = new MemoryEngine({ fs, root: "/mem", now: () => now });
  for (let i = 0; i < CONTEXT_POLICY.memoryEntries; i++) {
    await engine.save({
      id: `m_${i}`,
      content: `entry ${i}`,
      protection: "none",
    });
    now++;
  }
  await engine.save({ id: "new", content: "latest", protection: "none" });
  assert.equal(engine.retentionStats().entries, CONTEXT_POLICY.memoryEntries);
  assert.equal(engine.get("m_0"), undefined);
  for (const record of await engine.list({ limit: 1000 }))
    await engine.update({ id: record.id, protection: "user" });
  const before = fs.snapshot();
  await assert.rejects(
    engine.save({ id: "overflow", content: "cannot fit", protection: "none" }),
    /capacity/,
  );
  assert.deepEqual(fs.snapshot(), before);
});

test("legacy migration protects unknown memories, resets false usage and is persistent", async () => {
  const fs = new InMemoryFileSystem();
  const seed = new MemoryEngine({ fs, root: "/mem", now: () => 1 });
  const record = await seed.save({
    id: "legacy",
    content: "unknown old memory",
  });
  delete record.retentionVersion;
  delete record.lastUsedAt;
  delete record.protection;
  record.accessCount = 999;
  await fs.writeFile("/mem/memories/legacy.md", serializeMemory(record));
  const migrated = new MemoryEngine({ fs, root: "/mem", now: () => 100 * day });
  await migrated.ensureLoaded();
  assert.equal(migrated.get("legacy")?.protection, "user");
  assert.equal(migrated.get("legacy")?.lastUsedAt, undefined);
  assert.equal(migrated.get("legacy")?.retentionStartedAt, 100 * day);
  assert.equal(migrated.get("legacy")?.accessCount, 0);
  const restarted = new MemoryEngine({
    fs,
    root: "/mem",
    now: () => 101 * day,
  });
  await restarted.ensureLoaded();
  assert.equal(restarted.get("legacy")?.lastUsedAt, undefined);
  assert.equal(restarted.get("legacy")?.retentionStartedAt, 100 * day);
});

test("failed replacement cannot evict existing memory, and ordinary batches cannot overwrite protected facts", async () => {
  class Fs extends InMemoryFileSystem {
    fail = false;
    override async writeFile(path: string, content: string) {
      if (this.fail && path.endsWith("incoming.md"))
        throw new Error("disk full");
      return super.writeFile(path, content);
    }
  }
  const fs = new Fs();
  const engine = new MemoryEngine({ fs, root: "/mem" });
  await engine.save({
    id: "old",
    content: "original fact",
    protection: "none",
  });
  await engine.save({
    id: "user",
    content: "explicit preference",
    protection: "user",
  });
  fs.fail = true;
  await assert.rejects(
    engine.save({ id: "incoming", content: "new fact", protection: "none" }),
    /disk full/,
  );
  assert.ok(engine.get("old"));
  await engine.applyOrdinaryOps(
    [
      { op: "delete", id: "user" },
      { op: "update", id: "user", content: "wrong" },
    ],
    "task",
    "batch",
  );
  assert.equal(engine.get("user")?.content, "explicit preference");
});

test("history indexes bodies once, reads only selected hits and clears all versions with resumable tombstones", async () => {
  class Fs extends InMemoryFileSystem {
    reads = 0;
    fail = false;
    override async readFile(path: string) {
      if (path.endsWith(".txt")) this.reads++;
      return super.readFile(path);
    }
    override async deleteFile(path: string) {
      if (this.fail) throw new Error("busy");
      return super.deleteFile(path);
    }
  }
  const fs = new Fs();
  const task = {
    id: "task",
    title: "task",
    backend: "native" as const,
    status: "completed" as const,
    updatedAt: 1,
  };
  const history = new HistoryStore(fs, "/history");
  history.register(task);
  await history.addWindow(task.id, initialContextWindow(task.id, "native"));
  for (let i = 0; i < 30; i++)
    await history.append({
      taskId: task.id,
      windowId: "window",
      itemId: `item_${i}`,
      role: "tool",
      sourceIds: ["1:A"],
      content: `complete experiment result ${i}`,
    });
  await history.writeNote(task.id, "progress", "old note");
  await history.writeNote(task.id, "progress", "new note");
  fs.reads = 0;
  assert.equal(
    (await history.search({ query: "experiment", limit: 2 })).items.length,
    2,
  );
  assert.equal(fs.reads, 2);
  fs.fail = true;
  await assert.rejects(history.prune(task.id), /busy/);
  await assert.rejects(
    history.read({ taskId: task.id, windowId: "window", itemId: "item_1" }),
    /cleared/,
  );
  assert.equal((await history.exportTask(task.id)).unindexed.length, 0);
  fs.fail = false;
  const restored = new HistoryStore(fs, "/history");
  restored.register(task);
  await restored.prune(task.id);
  assert.deepEqual(Object.keys(fs.snapshot()), ["/history/task/index.json"]);
  assert.equal((await restored.search({ query: "experiment" })).total, 0);
  const logs = new ConversationLogEngine({ fs, root: "/logs" });
  await logs.appendTurn({
    sessionId: task.id,
    title: "task",
    turnId: "turn",
    userText: "raw conversation",
    assistantText: "raw answer",
  });
  await logs.deleteSession(task.id);
  assert.equal(await logs.read(task.id), null);
  assert.ok(!JSON.stringify(fs.snapshot()).includes("raw conversation"));
});

test("Chinese indexing does not invent bigrams across word boundaries", () => {
  assert.ok(!tokenize("甲 English 乙").includes("甲乙"));
  assert.ok(tokenize("甲乙").includes("甲乙"));
});
