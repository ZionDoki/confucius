import type {
  AnnotationReviewBatch,
  AnnotationReviewEntry,
  AnnotationReviewPool,
  AnnotationReviewStatus,
} from "@confucius/protocol";

export type ReviewFilter = AnnotationReviewStatus | "all";
export interface ReviewScopeView {
  query: string;
  status: ReviewFilter;
  selected: Set<string>;
  current?: string;
  scroll: number;
  limit: number;
}
export const reviewEntryKey = (batchId: string, entryId: string) =>
  JSON.stringify([batchId, entryId]);
export interface ReviewRow {
  batch: AnnotationReviewBatch;
  entry: AnnotationReviewEntry;
  key: string;
}
/** IDs, rather than indices, keep incoming publications outside a user's selection. */
export class AnnotationReviewModel {
  pool: AnnotationReviewPool;
  scope = "all";
  presentation: "card" | "list" = "card";
  unseen = new Set<string>();
  private views = new Map<string, ReviewScopeView>();
  constructor(taskId: string) {
    this.pool = { taskId, revision: -1, batches: [] };
  }
  get counts(): Record<AnnotationReviewStatus, number> {
    const counts = {
      pending: 0,
      writing: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
      unknown: 0,
      unavailable: 0,
    };
    for (const batch of this.pool.batches)
      for (const entry of batch.entries) counts[entry.status]++;
    return counts;
  }
  /** Completion covers all arrived batches, never just an empty filtered view. */
  get complete(): boolean {
    const counts = this.counts;
    return (
      counts.accepted + counts.rejected > 0 &&
      ![
        counts.pending,
        counts.writing,
        counts.failed,
        counts.unknown,
        counts.unavailable,
      ].some(Boolean)
    );
  }
  resume() {
    if (!this.complete) return;
    this.presentation = "list";
    if (this.view.status === "pending") this.view.status = "all";
  }
  get view(): ReviewScopeView {
    let view = this.views.get(this.scope);
    if (!view) {
      view = {
        query: "",
        status: "pending",
        selected: new Set(),
        scroll: 0,
        limit: 80,
      };
      this.views.set(this.scope, view);
    }
    return view;
  }
  update(pool: AnnotationReviewPool): boolean {
    if (pool.taskId !== this.pool.taskId || pool.revision <= this.pool.revision)
      return false;
    const previous = new Set(this.pool.batches.map((b) => b.id));
    if (this.pool.revision >= 0)
      pool.batches.forEach((b) => {
        if (!previous.has(b.id)) this.unseen.add(b.id);
      });
    this.pool = pool;
    for (const id of this.unseen) {
      const batch = pool.batches.find((b) => b.id === id);
      if (
        !batch ||
        batch.entries.every((e) => ["accepted", "rejected"].includes(e.status))
      )
        this.unseen.delete(id);
    }
    if (this.scope !== "all" && !pool.batches.some((b) => b.id === this.scope))
      this.scope = "all";
    return true;
  }
  rows(): ReviewRow[] {
    return this.pool.batches
      .filter((b) => this.scope === "all" || b.id === this.scope)
      .flatMap((batch) =>
        batch.entries.map((entry) => ({
          batch,
          entry,
          key: reviewEntryKey(batch.id, entry.id),
        })),
      );
  }
  visible(): ReviewRow[] {
    const query = this.view.query.trim().toLocaleLowerCase();
    return this.rows().filter(
      ({ batch, entry }) =>
        (this.view.status === "all" ||
          entry.status === this.view.status ||
          (this.view.status === "pending" &&
            ["failed", "unavailable"].includes(entry.status))) &&
        (!query ||
          `${entry.quote} ${entry.comment} ${entry.page} ${batch.title}`
            .toLocaleLowerCase()
            .includes(query)),
    );
  }
  selectable(row: ReviewRow) {
    return (
      ["pending", "failed", "unavailable"].includes(row.entry.status) ||
      (this.view.status === "rejected" && row.entry.status === "rejected")
    );
  }
  selected(): ReviewRow[] {
    return this.visible().filter(
      (row) => this.selectable(row) && this.view.selected.has(row.key),
    );
  }
  selectAll(checked: boolean) {
    this.view.selected = new Set(
      checked
        ? this.visible()
            .filter((row) => this.selectable(row))
            .map((row) => row.key)
        : [],
    );
  }
  current(): ReviewRow | undefined {
    const rows = this.rows();
    const row =
      rows.find((r) => r.key === this.view.current) ??
      rows.find((r) => r.entry.status === "pending") ??
      rows[0];
    this.view.current = row?.key;
    return row;
  }
  turn(delta: number) {
    const rows = this.rows(),
      index = rows.findIndex((row) => row.key === this.current()?.key);
    this.view.current =
      rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.key;
  }
  switchScope(id: string) {
    this.scope = id;
    this.unseen.delete(id);
  }
  viewNew(): ReviewRow | undefined {
    const batch = this.pool.batches.find((b) => this.unseen.has(b.id)),
      entry = batch?.entries.find(
        (e) => !["accepted", "rejected"].includes(e.status),
      );
    if (!batch || !entry) return;
    this.scope = "all";
    this.filter(
      ["pending", "failed", "unavailable"].includes(entry.status)
        ? "pending"
        : "all",
      "",
    );
    const key = reviewEntryKey(batch.id, entry.id);
    this.view.current = key;
    this.view.limit = Math.max(
      80,
      this.visible().findIndex((row) => row.key === key) + 80,
    );
    this.unseen.clear();
    return { batch, entry, key };
  }
  filter(status: ReviewFilter, query = this.view.query) {
    this.view.status = status;
    this.view.query = query;
    this.view.selected.clear();
    this.view.scroll = 0;
    this.view.limit = 80;
  }
}
