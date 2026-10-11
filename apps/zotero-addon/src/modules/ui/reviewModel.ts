export type ReviewStatus =
  | "pending"
  | "writing"
  | "accepted"
  | "rejected"
  | "failed"
  | "unknown"
  | "unavailable";
export type ReviewAction = "accept" | "reject" | "restore";
export interface ReviewEntry {
  id: string;
  quote: string;
  comment: string;
  status: ReviewStatus;
  page?: number;
  type?: string;
  color?: string;
  error?: string;
  searchText?: string;
}
export interface ReviewBatch<E extends ReviewEntry = ReviewEntry> {
  id: string;
  title: string;
  createdAt: number;
  entries: E[];
}
export interface ReviewPool<E extends ReviewEntry = ReviewEntry> {
  taskId: string;
  revision: number;
  /** Serialized loaders may refresh projected metadata at the same domain revision. */
  metadataKey?: string;
  batches: ReviewBatch<E>[];
}
export interface ReviewModelOptions<E extends ReviewEntry = ReviewEntry> {
  defaultStatus?: ReviewFilter;
  completion?: boolean;
  selectable?: (row: ReviewRow<E>, view: ReviewScopeView) => boolean;
}
export type ReviewFilter = ReviewStatus | "all";
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
export interface ReviewRow<E extends ReviewEntry = ReviewEntry> {
  batch: ReviewBatch<E>;
  entry: E;
  key: string;
}
/** IDs, rather than indices, keep incoming publications outside a user's selection. */
export class ReviewModel<E extends ReviewEntry = ReviewEntry> {
  pool: ReviewPool<E>;
  scope = "all";
  private presentationValue: "card" | "list" = "card";
  private presentationChosen = false;
  get presentation() {
    return this.presentationValue;
  }
  set presentation(value: "card" | "list") {
    this.presentationValue = value;
    this.presentationChosen = true;
  }
  unseen = new Set<string>();
  private views = new Map<string, ReviewScopeView>();
  private announced = new Set<string>();
  private announcedEntries = new Set<string>();
  readonly unseenEntries = new Set<string>();
  constructor(
    taskId: string,
    private readonly options: ReviewModelOptions<E> = {},
  ) {
    this.pool = { taskId, revision: -1, batches: [] };
  }
  get counts(): Record<ReviewStatus, number> {
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
    if (this.options.completion === false) return false;
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
        status: this.options.defaultStatus ?? "pending",
        selected: new Set(),
        scroll: 0,
        limit: 80,
      };
      this.views.set(this.scope, view);
    }
    return view;
  }
  update(pool: ReviewPool<E>): boolean {
    if (
      pool.taskId !== this.pool.taskId ||
      pool.revision < this.pool.revision ||
      (pool.revision === this.pool.revision &&
        (!pool.metadataKey || pool.metadataKey === this.pool.metadataKey))
    )
      return false;
    const previous = new Set(this.pool.batches.map((b) => b.id));
    if (this.pool.revision >= 0)
      pool.batches.forEach((b) => {
        if (!previous.has(b.id)) this.unseen.add(b.id);
      });
    this.pool = pool;
    if (
      !this.presentationChosen &&
      pool.batches.some((b) => b.entries.length)
    ) {
      this.presentation =
        pool.batches.reduce((n, b) => n + b.entries.length, 0) >= 10
          ? "list"
          : "card";
    }
    for (const key of this.unseenEntries) {
      const row = this.allRows().find((r) => r.key === key);
      if (
        !row ||
        (this.options.completion !== false &&
          ["accepted", "rejected"].includes(row.entry.status))
      )
        this.unseenEntries.delete(key);
    }
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
  /** Live submission IDs survive snapshot races; history and receipts never notify. */
  arrived(batchIds: readonly string[]): "open" | "remind" | undefined {
    const batches = this.pool.batches.filter(
      (batch) => batchIds.includes(batch.id) && !this.announced.has(batch.id),
    );
    for (const batch of batches) this.announced.add(batch.id);
    const pending = batches.filter((batch) =>
      batch.entries.some(
        (entry) => !["accepted", "rejected"].includes(entry.status),
      ),
    );
    if (!pending.length) return;
    const first = this.pool.batches[0].id;
    for (const batch of pending)
      if (batch.id !== first) this.unseen.add(batch.id);
    if (pending.some((batch) => batch.id === first)) {
      this.unseen.delete(first);
      return "open";
    }
    return "remind";
  }
  /** Append pages within the same search are arrivals too; metadata/receipts are quiet. */
  arrivedEntries(entryIds: readonly string[]): "open" | "remind" | undefined {
    const all = this.allRows(),
      arrived = all.filter(
        (r) =>
          entryIds.includes(r.entry.id) &&
          !this.announcedEntries.has(r.entry.id),
      );
    for (const row of arrived) this.announcedEntries.add(row.entry.id);
    const pending = arrived.filter(
      (r) =>
        this.options.completion === false ||
        !["accepted", "rejected"].includes(r.entry.status),
    );
    if (!pending.length) return;
    if (pending.some((r) => r.key === all[0]?.key)) {
      this.unseen.delete(all[0].batch.id);
      return "open";
    }
    for (const row of pending) this.unseenEntries.add(row.key);
    return "remind";
  }
  allRows(): ReviewRow<E>[] {
    return this.pool.batches.flatMap((batch) =>
      batch.entries.map((entry) => ({
        batch,
        entry,
        key: reviewEntryKey(batch.id, entry.id),
      })),
    );
  }
  get newRows(): ReviewRow<E>[] {
    return this.allRows().filter(
      (r) => this.unseen.has(r.batch.id) || this.unseenEntries.has(r.key),
    );
  }
  rows(): ReviewRow<E>[] {
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
  visible(): ReviewRow<E>[] {
    const query = this.view.query.trim().toLocaleLowerCase();
    return this.rows().filter(
      ({ batch, entry }) =>
        (this.view.status === "all" ||
          entry.status === this.view.status ||
          (this.view.status === "pending" &&
            ["failed", "unavailable"].includes(entry.status))) &&
        (!query ||
          `${entry.quote} ${entry.comment} ${entry.page ?? ""} ${batch.title} ${entry.searchText ?? ""}`
            .toLocaleLowerCase()
            .includes(query)),
    );
  }
  selectable(row: ReviewRow<E>) {
    if (this.options.selectable) return this.options.selectable(row, this.view);
    return (
      ["pending", "failed", "unavailable"].includes(row.entry.status) ||
      (this.view.status === "rejected" && row.entry.status === "rejected")
    );
  }
  selected(): ReviewRow<E>[] {
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
  current(): ReviewRow<E> | undefined {
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
    for (const row of this.allRows())
      if (row.batch.id === id) this.unseenEntries.delete(row.key);
  }
  viewNew(): ReviewRow<E> | undefined {
    const first = this.newRows.find(
        (r) =>
          this.options.completion === false ||
          !["accepted", "rejected"].includes(r.entry.status),
      ),
      batch = first?.batch,
      entry = first?.entry;
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
    this.unseenEntries.clear();
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
