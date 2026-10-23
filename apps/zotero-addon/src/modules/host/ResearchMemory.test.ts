import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { InMemoryFileSystem, MemoryEngine } from "@confucius/memory";
import { ResearchMemory, type ResearchUpdate } from "./ResearchMemory";
import { memoryJsonStorage } from "./RuntimeStorage";

const digest = async (text: string) =>
  createHash("sha256").update(text).digest("hex");

function fixture() {
  const fs = new InMemoryFileSystem();
  const memory = new MemoryEngine({ fs, root: "/memory", now: () => 100 });
  const storage = memoryJsonStorage();
  const research = new ResearchMemory(memory, storage, digest);
  return { fs, memory, storage, research };
}

type Fixture = ReturnType<typeof fixture>;

const update = (content: string): ResearchUpdate => ({
  type: "project",
  title: "Ongoing topic",
  content,
  evidence: "the user's message",
  status: "active",
});

async function applyTask(f: Fixture, taskId: string, content: string) {
  const snapshot = await f.research.snapshot("state", taskId);
  return f.research.apply(
    `batch_${taskId}`,
    snapshot,
    [update(content)],
    taskId,
    () => true,
  );
}

test("forget excludes every contributing source task beyond the 20-ref display window", async () => {
  const f = fixture();
  for (let i = 0; i < 22; i++) await applyTask(f, `task_${i}`, `state ${i}`);
  const [record] = await f.memory.list({ limit: 10 });
  assert.ok(record);
  assert.equal(record.sourceRefs?.length, 20);
  assert.equal(record.researchTasks?.length, 22);
  // The oldest contributors left the display window but stay known sources.
  assert.equal(record.sourceRefs?.includes("task:task_1"), false);
  assert.equal(record.researchTasks?.includes("task_1"), true);
  const restored = new MemoryEngine({
    fs: f.fs,
    root: "/memory",
    now: () => 100,
  });
  await restored.ensureLoaded();
  assert.equal(restored.get(record.id)?.researchTasks?.length, 22);

  await f.research.forget(record.id);
  for (let i = 0; i < 22; i++)
    assert.equal(
      await f.research.ignoresArchive(`task_${i}`),
      true,
      `task_${i}`,
    );
  assert.equal(await f.research.suppressesTitle(" ongoing topic "), true);
  assert.equal(await f.research.suppressesTitle("other topic"), false);
});

test("a forgotten topic is not recreated by a later source task", async () => {
  const f = fixture();
  await applyTask(f, "task_a", "state a");
  const [record] = await f.memory.list({ limit: 10 });
  assert.ok(record);
  await f.research.forget(record.id);
  const changes = await applyTask(f, "task_b", "state b");
  assert.deepEqual(changes, []);
  const remaining = (await f.memory.list({ limit: 10 })).filter((entry) =>
    entry.tags.includes("confucius:research"),
  );
  assert.equal(remaining.length, 0);
});

test("forget falls back to capped task refs for records created before the field existed", async () => {
  const f = fixture();
  const saved = await f.memory.save({
    id: "mem_legacy_research",
    type: "project",
    title: "Legacy topic",
    content: "Legacy research state",
    tags: ["confucius:research", "research:status:active"],
    protection: "none",
    sourceRefs: ["task:old_a", "task:old_b"],
    sourceSessionId: "old_a",
  });
  await f.research.forget(saved.id);
  assert.equal(await f.research.ignoresArchive("old_a"), true);
  assert.equal(await f.research.ignoresArchive("old_b"), true);
  assert.equal(await f.research.suppressesTitle("Legacy Topic"), true);
});

test("apply and forget merge sourceRefs with researchTasks instead of replacing them", async () => {
  const f = fixture();
  await applyTask(f, "task_a", "state a");
  const [record] = await f.memory.list({ limit: 10 });
  assert.ok(record);
  // context_save appends its own task provenance without touching researchTasks.
  await f.memory.update(
    {
      id: record.id,
      sourceRefs: [...(record.sourceRefs ?? []), "task:context_save_task"],
    },
    false,
  );
  await applyTask(f, "task_b", "state b");
  const merged = f.memory.get(record.id);
  assert.ok(merged?.researchTasks?.includes("task_a"));
  assert.ok(merged?.researchTasks?.includes("task_b"));
  assert.ok(merged?.researchTasks?.includes("context_save_task"));
  await f.research.forget(record.id);
  for (const taskId of ["task_a", "task_b", "context_save_task"])
    assert.equal(await f.research.ignoresArchive(taskId), true, taskId);
});

test("snapshot finds a record by its uncapped research tasks", async () => {
  const f = fixture();
  for (let i = 0; i < 21; i++) await applyTask(f, `task_${i}`, `state ${i}`);
  const [record] = await f.memory.list({ limit: 10 });
  assert.ok(record);
  // The display window dropped task_0; the complete provenance still links it.
  assert.equal(record.sourceRefs?.includes("task:task_0"), false);
  assert.equal(record.researchTasks?.includes("task_0"), true);
  const snapshot = await f.research.snapshot("no matching phrase", "task_0");
  assert.deepEqual(
    snapshot.records.map((entry) => entry.id),
    [record.id],
  );
  assert.deepEqual(
    (await f.research.snapshot("no matching phrase", "task_unknown")).records,
    [],
  );
});
