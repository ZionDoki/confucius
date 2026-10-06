import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  AnnotationReviewBatch,
  AnnotationReviewStatus,
} from "@confucius/protocol";
import { AnnotationReviewModel } from "./annotationReviewModel";
const batch = (id: string): AnnotationReviewBatch => ({
  id,
  createdAt: 1,
  title: id,
  libraryID: 1,
  attachmentKey: "PDF",
  entries: ["one", "two"].map((key) => ({
    id: key,
    type: "highlight",
    page: 1,
    quote: `${id} ${key}`,
    comment: "note",
    color: "#ffd400",
    status: "pending",
  })),
});
it("preserves card, search, scroll and the explicit selection across incoming batches", () => {
  const m = new AnnotationReviewModel("task");
  m.update({ taskId: "task", revision: 1, batches: [batch("a")] });
  m.turn(1);
  m.selectAll(true);
  m.view.scroll = 250;
  const current = m.current()?.key;
  m.update({ taskId: "task", revision: 2, batches: [batch("a"), batch("b")] });
  assert.equal(m.current()?.key, current);
  assert.equal(m.view.scroll, 250);
  assert.equal(m.selected().length, 2);
  assert.equal(m.visible().length, 4);
  assert.deepEqual([...m.unseen], ["b"]);
  assert(!m.update({ taskId: "task", revision: 1, batches: [] }));
  assert.equal(m.rows().length, 4);
});
it("remembers independent per-batch views and limits bulk decisions to visible eligible rows", () => {
  const m = new AnnotationReviewModel("task");
  m.update({ taskId: "task", revision: 1, batches: [batch("a"), batch("b")] });
  m.switchScope("a");
  m.filter("pending", "two");
  m.selectAll(true);
  m.view.scroll = 80;
  m.current();
  m.switchScope("b");
  assert.equal(m.view.query, "");
  assert.equal(m.selected().length, 0);
  m.switchScope("a");
  assert.equal(m.view.query, "two");
  assert.equal(m.view.scroll, 80);
  assert.equal(m.selected().length, 1);
  const updated = batch("a");
  updated.entries[1].status = "accepted";
  m.update({ taskId: "task", revision: 2, batches: [updated, batch("b")] });
  assert.equal(m.selected().length, 0);
});

it("only considers the entire arrived pool complete after verified outcomes", () => {
  const m = new AnnotationReviewModel("task");
  assert.equal(m.complete, false);
  const done = batch("done");
  done.entries[0].status = "accepted";
  done.entries[1].status = "rejected";
  let revision = 0;
  for (const status of [
    "pending",
    "writing",
    "failed",
    "unknown",
    "unavailable",
  ] as AnnotationReviewStatus[]) {
    const waiting = batch("waiting");
    waiting.entries.forEach((e) => (e.status = status));
    m.update({
      taskId: "task",
      revision: ++revision,
      batches: [done, waiting],
    });
    m.switchScope("done");
    assert.equal(m.visible().length, 0);
    assert.equal(m.complete, false, status);
    assert.equal(m.counts[status], 2);
  }
  m.update({ taskId: "task", revision: revision + 1, batches: [done] });
  assert.equal(m.complete, true);
});

it("reopens completed reviews as history and retains the user's list state across new batches", () => {
  const m = new AnnotationReviewModel("task");
  const done = batch("done");
  done.entries.forEach((e) => (e.status = "accepted"));
  m.update({ taskId: "task", revision: 1, batches: [done] });
  m.view.query = "two";
  m.view.scroll = 100;
  m.resume();
  assert.equal(m.presentation, "list");
  assert.equal(m.view.status, "all");
  assert.equal(m.visible().length, 1);
  assert.equal(m.view.query, "two");
  assert.equal(m.view.scroll, 100);
  m.update({ taskId: "task", revision: 2, batches: [done, batch("new")] });
  m.resume();
  assert.equal(m.complete, false);
  assert.equal(m.presentation, "list");
  assert.equal(m.view.query, "two");
  assert.equal(m.view.status, "all");
  assert.equal(m.view.scroll, 100);
  assert.equal(m.selected().length, 0);
});

it("keeps unavailable suggestions visible for rejection without counting them as complete", () => {
  const m = new AnnotationReviewModel("task"),
    b = batch("bad");
  b.entries.forEach((e) => {
    e.status = "unavailable";
  });
  m.update({ taskId: "task", revision: 1, batches: [b] });
  m.selectAll(true);
  assert.equal(m.visible().length, 2);
  assert.equal(m.selected().length, 2);
  assert.equal(m.complete, false);
});

it("view new mounts the first unresolved new entry even beyond a long queue and a saved first entry", () => {
  const m = new AnnotationReviewModel("task"),
    older = batch("old"),
    newer = batch("new");
  older.entries = Array.from({ length: 240 }, (_, index) => ({
    ...older.entries[0],
    id: String(index),
  }));
  newer.entries[0].status = "accepted";
  newer.entries[1].status = "unavailable";
  m.update({ taskId: "task", revision: 1, batches: [older] });
  m.update({ taskId: "task", revision: 2, batches: [older, newer] });
  const first = m.viewNew();
  assert.equal(first?.entry.id, "two");
  assert.equal(first?.batch.id, "new");
  assert(
    m
      .visible()
      .slice(0, m.view.limit)
      .some((row) => row.key === first?.key),
  );
  assert.equal(m.view.current, first?.key);
  assert.equal(m.unseen.size, 0);
  const checking = batch("checking");
  checking.entries.forEach((e) => {
    e.status = "unknown";
  });
  m.update({ taskId: "task", revision: 3, batches: [older, newer, checking] });
  assert.equal(m.viewNew()?.batch.id, "checking");
  assert.equal(m.view.status, "all");
});
