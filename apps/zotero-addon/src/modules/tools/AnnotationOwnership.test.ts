import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryJsonStorage } from "../host/RuntimeStorage";
import {
  AnnotationOwnership,
  availableAnnotationColor,
  normalizedColor,
} from "./AnnotationOwnership";
import { annotationMatchesFilter } from "@confucius/protocol";
import {
  annotationBatchTag,
  annotationBatchTime,
  legacyBatchTagChange,
} from "./AnnotationBatchLabels";

test("task/PDF baselines survive continuation and restart, new tasks get independent batches", async () => {
  const storage = memoryJsonStorage();
  let store = new AnnotationOwnership(storage);
  const a = {
    taskId: "task-a",
    title: "First request",
    createdAt: 1000,
    agent: "native",
  };
  const first = await store.freeze("1_PDF", a, ["#FFD400", " #abc "]);
  const color = await store.color("1_PDF", first.batch.id, "#ffd400");
  assert.notEqual(color, "#ffd400");
  store = new AnnotationOwnership(storage);
  const continued = await store.freeze(
    "1_PDF",
    { ...a, title: "new title", agent: "kimi" },
    [color],
  );
  assert.deepEqual(continued.forbiddenColors, ["#ffd400", "#aabbcc"]);
  assert.equal(continued.batch.name, first.batch.name);
  assert.equal(continued.batch.timeLabel, first.batch.timeLabel);
  assert.equal(
    annotationBatchTag(continued.batch),
    annotationBatchTag(first.batch),
  );
  assert.equal(await store.color("1_PDF", first.batch.id, "#ffd400"), color);
  const other = await store.freeze(
    "1_PDF",
    { taskId: "task-b", title: "Second task" },
    [color],
  );
  assert.notEqual(other.batch.id, first.batch.id);
  assert.notEqual(await store.color("1_PDF", other.batch.id, color), color);
  const later = await store.freeze("1_OTHER", a, ["#ff6666"]);
  assert.deepEqual(later.forbiddenColors, ["#ff6666"]);
});

test("one time label replaces exactly the two old batch tags and preserves user labels", () => {
  const createdAt = new Date(2026, 8, 10, 18, 30, 5).getTime();
  const batch = { id: "b", taskId: "t", name: "Old title · task-1", createdAt };
  assert.equal(annotationBatchTime(createdAt), "2026-09-10 18:30:05");
  const tag = "Confucius 批次：2026-09-10 18:30:05";
  assert.equal(annotationBatchTag(batch), tag);
  const old = [
    "Confucius 批次：Old title · task-1",
    "Confucius 批次日期：2026-09-10",
  ];
  const changed = legacyBatchTagChange(
    [...old, "human-tag", "Confucius 批次：Manually renamed"],
    batch,
  );
  assert.deepEqual(changed, { remove: old, add: tag });
  assert.equal(legacyBatchTagChange([tag, "human-tag"], batch), undefined);
  assert.equal(legacyBatchTagChange(["human-tag"], batch), undefined);
  assert.equal(
    annotationBatchTag({ ...batch, timeLabel: "2026-09-10 10:30:05" }),
    "Confucius 批次：2026-09-10 10:30:05",
  );
  assert.throws(() => annotationBatchTime(Number.NaN), /Invalid/);
});
test("provenance is confirmed only after creation; edits and deletion preserve the original owner", async () => {
  const store = new AnnotationOwnership(memoryJsonStorage());
  const context = { taskId: "a", agent: "native", title: "First" };
  const { batch } = await store.freeze("1_PDF", context, []);
  await store.plan("1_PDF", "ANN", batch.id, context, "payload");
  assert.equal(await store.owned("1_PDF", "ANN"), null);
  await assert.rejects(store.confirm("1_PDF", "ANN", "wrong"));
  await store.confirm("1_PDF", "ANN", "payload");
  const original = await store.owned("1_PDF", "ANN");
  await store.modified("1_PDF", "ANN", { taskId: "b", agent: "kimi" }, 2000);
  const changed = await store.owned("1_PDF", "ANN");
  assert.equal(changed?.batchId, batch.id);
  assert.equal(changed?.taskId, "a");
  assert.equal(changed?.agent, "native");
  assert.equal(changed?.createdAt, original?.createdAt);
  assert.equal(changed?.modifiedAt, 2000);
  await store.modified(
    "1_PDF",
    "ANN",
    { taskId: "c", agent: "codex" },
    3000,
    true,
  );
  assert.equal(await store.owned("1_PDF", "ANN"), null);
  assert.equal((await store.read("1_PDF")).marks.ANN.status, "deleted");
  assert.equal(await store.owned("1_PDF", "HUMAN"), null);
});
test("palette exhaustion generates usable colors and selections include legacy annotations only explicitly", () => {
  const blocked = new Set([
    "#ffd400",
    "#2ea8e5",
    "#a28ae5",
    "#5fb236",
    "#f19837",
    "#e56eee",
    "#ff6666",
    "#aaaaaa",
  ]);
  const color = availableAnnotationColor("#ffd400", blocked);
  assert.ok(normalizedColor(color));
  assert.ok(!blocked.has(color));
  const selected = {
    mode: "selected" as const,
    batchIds: ["a", "b"],
    includeExisting: false,
  };
  assert.equal(annotationMatchesFilter("a", selected), true);
  assert.equal(annotationMatchesFilter(null, selected), false);
  assert.equal(
    annotationMatchesFilter(null, { ...selected, includeExisting: true }),
    true,
  );
  assert.equal(
    annotationMatchesFilter("a", { ...selected, mode: "current" }, "b"),
    false,
  );
});

test("a missing previously frozen baseline or unreadable ownership store never reallocates colors", async () => {
  const storage = memoryJsonStorage();
  const service = new AnnotationOwnership(storage);
  const context = { taskId: "protected" };
  await service.freeze("1_PDF", context, ["#ffd400"]);
  await storage.write("ownership_1_PDF", {
    version: 1,
    batches: {},
    marks: {},
    filter: { mode: "all", batchIds: [], includeExisting: false },
  });
  await assert.rejects(
    service.freeze("1_PDF", context, ["#ff6666"]),
    /baseline was lost/,
  );
  const unavailable = new AnnotationOwnership({
    read: async () => {
      throw new Error("unreadable");
    },
    write: async () => {
      throw new Error("must not write");
    },
  });
  await assert.rejects(unavailable.freeze("1_PDF", context, []), /unreadable/);
});
