import assert from "node:assert/strict";
import { it } from "node:test";
import { reviewArrivals } from "../src/modules/ui/reviewArrivals.ts";
const event = (id, ts, type, payload) => ({ id, ts, type, payload });
it("keeps both domains quiet when the first poll restores unseen historical events", () => {
  const incoming = [
    event("old-annotation", 5, "annotation_review_changed", { batchId: "old" }),
    event("old-search", 8, "literature_updated", { workIds: ["old-paper"] }),
    event("new-annotation", 12, "annotation_review_changed", {
      batchId: "new",
    }),
    event("new-search", 13, "literature_updated", { workIds: ["new-paper"] }),
  ];
  assert.deepEqual(
    reviewArrivals(incoming, new Set(), 10, (e) => e.id),
    { batchIds: ["new"], workIds: ["new-paper"] },
  );
});
it("does not treat duplicate events, decisions or acquisition receipts as arrivals", () => {
  const incoming = [
    event("known", 12, "literature_updated", { workIds: ["known-paper"] }),
    event("receipt", 13, "annotation_review_changed", { revision: 4 }),
    event("acquisition", 14, "literature_updated", {
      summary: { revision: 5 },
    }),
    event("search", 15, "literature_updated", {
      workIds: ["same-query-page-two"],
    }),
  ];
  assert.deepEqual(
    reviewArrivals(incoming, new Set(["known"]), 10, (e) => e.id),
    { batchIds: [], workIds: ["same-query-page-two"] },
  );
});
it("uses host sequence after initial history even if the clock moves backward", () => {
  const incoming = [
    {
      ...event("old", 100, "literature_updated", { workIds: ["history"] }),
      sequence: 8,
    },
    {
      ...event("new", 2, "literature_updated", { workIds: ["new-page"] }),
      sequence: 11,
    },
  ];
  assert.deepEqual(
    reviewArrivals(incoming, new Set(["baseline"]), 10, (e) => e.id, 10),
    { batchIds: [], workIds: ["new-page"] },
  );
});
