import assert from "node:assert/strict";
import { it } from "node:test";
import { ReviewModel } from "../src/modules/ui/reviewModel.ts";
const entry = (id, status = "pending") => ({
  id,
  status,
  quote: id,
  comment: "Reason",
  searchText: "Author 中文",
});
const pool = (revision, entries) => ({
  taskId: "research",
  revision,
  batches: [{ id: "query", title: "Search", createdAt: 1, entries }],
});
it("uses the same defaults for candidate records, including already selected papers", () => {
  for (const count of [9, 10, 11]) {
    const model = new ReviewModel("research", {
      defaultStatus: "all",
      completion: false,
      selectable: () => true,
    });
    model.update(pool(0, []));
    model.update(
      pool(
        1,
        Array.from({ length: count }, (_, i) => entry(String(i), "accepted")),
      ),
    );
    assert.equal(model.presentation, count >= 10 ? "list" : "card");
    assert.equal(model.complete, false);
    assert.equal(model.visible().length, count);
    model.selectAll(true);
    assert.equal(model.selected().length, count);
  }
});
it("first candidate arrivals open once; appending the same search reminds without joining selection", () => {
  const model = new ReviewModel("research", {
    defaultStatus: "all",
    completion: false,
    selectable: () => true,
  });
  model.update(pool(0, []));
  model.update(pool(1, [entry("first", "accepted")]));
  assert.equal(model.arrivedEntries(["first"]), "open");
  assert.equal(model.newRows.length, 0);
  assert.equal(model.arrivedEntries(["first"]), undefined);
  model.presentation = "card";
  model.selectAll(true);
  model.current();
  model.view.scroll = 48;
  const previous = model.view;
  model.update(pool(2, [entry("first", "accepted"), entry("later")]));
  assert.equal(model.arrivedEntries(["later"]), "remind");
  assert.equal(model.view, previous);
  assert.equal(model.view.scroll, 48);
  assert.equal(model.presentation, "card");
  assert.deepEqual(
    model.selected().map((r) => r.entry.id),
    ["first"],
  );
  assert.equal(model.arrivedEntries(["later"]), undefined);
  model.update(
    pool(3, [entry("first", "accepted"), entry("later", "accepted")]),
  );
  assert.equal(model.arrivedEntries([]), undefined);
  assert.equal(model.newRows.length, 1);
  assert.equal(model.viewNew().entry.id, "later");
  assert.equal(model.newRows.length, 0);
});
it("history remains minimized and source metadata participates in local filtering", () => {
  const model = new ReviewModel("research", {
    defaultStatus: "all",
    completion: false,
  });
  model.update(pool(3, [entry("history"), entry("new")]));
  assert.equal(model.arrivedEntries([]), undefined);
  assert.equal(model.arrivedEntries(["new"]), "remind");
  model.filter("all", "中文");
  assert.equal(model.visible().length, 2);
  model.filter("all", "unknown");
  assert.equal(model.visible().length, 0);
});
