import type {
  AnnotationReviewDecision,
  AnnotationReviewPool,
} from "@confucius/protocol";
import { createWorkspaceButton } from "./workspaceControls";
import { getString } from "../../utils/locale";
import {
  AnnotationReviewModel,
  type ReviewRow,
  type ReviewFilter,
  type ReviewScopeView,
} from "./annotationReviewModel";

const NS = "http://www.w3.org/1999/xhtml";
const text = (key: string) => getString(`workspace-annotations-${key}`);
const remembered = new WeakMap<Document, Map<string, AnnotationReviewModel>>();
function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className = "",
  label = "",
): HTMLElementTagNameMap[K] {
  const n = doc.createElementNS(NS, tag) as HTMLElementTagNameMap[K];
  n.className = className;
  n.textContent = label;
  return n;
}
function glyph(
  doc: Document,
  name:
    | "stack"
    | "list"
    | "minus"
    | "check"
    | "cross"
    | "chevron"
    | "search"
    | "filter",
) {
  const paths = {
    stack: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
    list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    minus: "M5 12h14",
    check: "m5 12 4 4 10-10",
    cross: "m6 6 12 12M18 6 6 18",
    chevron: "m6 9 6 6 6-6",
    search: "m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    filter: "M4 7h16M4 17h16M8 4v6M16 14v6",
  };
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(key, value);
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}

export function createAnnotationReviewPanel(
  doc: Document,
  options: {
    rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    viewport: HTMLElement;
    anchor: HTMLElement;
    opened: () => void;
    visibilityChanged: () => void;
  },
) {
  const win = doc.defaultView;
  const views = remembered.get(doc) ?? new Map<string, AnnotationReviewModel>();
  remembered.set(doc, views);
  const radioGroup = `review-${Math.random().toString(36).slice(2)}`;
  const busyTasks = new Set<string>();
  const busy = () => !!taskId && busyTasks.has(taskId);
  const root = node(doc, "section", "confucius-annotation-review");
  root.hidden = true;
  root.setAttribute("aria-label", text("title"));
  const makeButton = (
    label: string,
    name?: Parameters<typeof glyph>[1],
    primary = false,
  ) => {
    const b = createWorkspaceButton(
      doc,
      "",
      label,
      primary ? "primary" : "outline",
    );
    if (name) b.prepend(glyph(doc, name));
    return b;
  };
  const capsule = makeButton("", "stack"),
    capsuleCopy = node(doc, "span", "ar-capsule-copy"),
    capsuleLabel = node(doc, "span", "", text("capsule")),
    capsuleCount = node(doc, "span", "ar-capsule-count"),
    capsuleNew = node(doc, "span", "ar-capsule-new"),
    caret = glyph(doc, "chevron");
  capsule.classList.add("ar-capsule");
  capsule.setAttribute("aria-haspopup", "dialog");
  capsule.setAttribute("aria-expanded", "false");
  caret.classList.add("ar-caret");
  capsuleCopy.append(capsuleLabel, capsuleCount, capsuleNew);
  capsule.append(capsuleCopy, caret);
  const scopeRow = node(doc, "div", "ar-scope-row"),
    scope = makeButton(text("all-batches"), "chevron"),
    scopeCount = node(doc, "span", "ar-muted");
  scopeRow.append(scope, scopeCount);
  const stack = node(doc, "div", "ar-stack"),
    paper = node(doc, "article", "ar-paper"),
    meta = node(doc, "div", "ar-meta"),
    batchLabel = node(doc, "span", "ar-batch-label"),
    source = makeButton(""),
    status = node(doc, "span", "ar-status");
  meta.append(batchLabel, source, status);
  const body = node(doc, "div", "ar-card-body"),
    quote = node(doc, "blockquote", "ar-quote"),
    comment = node(doc, "p", "ar-comment");
  const cardReason = node(doc, "p", "ar-row-error");
  body.append(quote, comment, cardReason);
  const cardFooter = node(doc, "div", "ar-card-footer"),
    position = node(doc, "span", "ar-position"),
    range = node(doc, "input", "ar-range"),
    cardActions = node(doc, "div", "ar-actions");
  range.type = "range";
  range.min = "1";
  range.step = "1";
  range.setAttribute("aria-label", text("scrub"));
  const reject = makeButton(text("reject"), "cross"),
    accept = makeButton(text("accept"), "check", true),
    restore = makeButton(text("restore")),
    cardOutcome = node(doc, "span", "ar-muted");
  reject.classList.add("ar-decision");
  accept.classList.add("ar-decision");
  cardActions.append(reject, accept, restore, cardOutcome);
  cardFooter.append(position, range, cardActions);
  paper.append(meta, body, cardFooter);
  stack.append(paper);
  const notice = node(doc, "span", "ar-sr"),
    undo = makeButton(text("undo"));
  undo.hidden = true;
  const popup = node(doc, "section", "ar-popup");
  popup.id = `${radioGroup}-popup`;
  capsule.setAttribute("aria-controls", popup.id);
  popup.hidden = true;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-modal", "false");
  popup.setAttribute("aria-label", text("title"));
  const popupHeader = node(doc, "header", "ar-popup-header"),
    titleRow = node(doc, "div", "ar-header"),
    popupTitle = node(doc, "h3", "", text("title")),
    viewSwitch = node(doc, "div", "ar-view-switch"),
    cardView = makeButton("", "stack"),
    listView = makeButton("", "list"),
    collapse = makeButton("", "minus");
  viewSwitch.setAttribute("role", "group");
  viewSwitch.setAttribute("aria-label", text("view"));
  for (const [button, label] of [
    [cardView, text("card-view")],
    [listView, text("list-view")],
  ] as const) {
    button.classList.add("confucius-icon-button");
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  viewSwitch.append(cardView, listView);
  collapse.classList.add("confucius-icon-button");
  collapse.title = text("collapse");
  collapse.setAttribute("aria-label", text("collapse"));
  titleRow.append(popupTitle, viewSwitch, collapse);
  const summaryRow = node(doc, "div", "ar-summary-row"),
    summary = node(doc, "span", "ar-muted"),
    newButton = makeButton(text("new"));
  newButton.hidden = true;
  summaryRow.append(summary, newButton);
  popupHeader.append(titleRow, summaryRow);
  const searchRow = node(doc, "div", "ar-search-row"),
    search = node(doc, "input", "ar-search"),
    filter = makeButton(text("pending"), "filter");
  search.type = "search";
  search.placeholder = text("search");
  search.setAttribute("aria-label", text("search"));
  searchRow.append(search, filter);
  const selectRow = node(doc, "div", "ar-select-row"),
    selectLabel = node(doc, "label", "ar-select-label"),
    selectAll = node(doc, "input"),
    resultCount = node(doc, "span"),
    clearSelection = makeButton(text("clear-selection"));
  selectAll.type = "checkbox";
  selectAll.setAttribute("aria-label", text("select-all"));
  selectLabel.append(selectAll, resultCount);
  selectRow.append(selectLabel, clearSelection);
  const scroll = node(doc, "div", "ar-list"),
    empty = node(doc, "div", "ar-empty", text("empty"));
  scroll.append(empty);
  const cardArea = node(doc, "div", "ar-card-area"),
    completion = node(doc, "div", "ar-completion"),
    completionTitle = node(doc, "h3", "", text("complete")),
    completionSummary = node(doc, "p", "ar-muted");
  completion.append(glyph(doc, "check"), completionTitle, completionSummary);
  cardArea.append(scopeRow, stack);
  const popupFooter = node(doc, "footer", "ar-popup-footer"),
    selectionSummary = node(doc, "span", "ar-muted"),
    bulk = node(doc, "div", "ar-actions"),
    bulkReject = makeButton(text("reject"), "cross"),
    bulkAccept = makeButton(text("accept"), "check", true),
    bulkRestore = makeButton(text("restore")),
    verify = makeButton(text("verify")),
    finish = makeButton(text("finish"), undefined, true);
  finish.classList.add("ar-finish");
  verify.hidden = true;
  bulk.append(bulkReject, bulkAccept, bulkRestore);
  popupFooter.append(selectionSummary, undo, verify, bulk, finish);
  const popupError = node(doc, "p", "ar-error ar-popup-error");
  popupError.setAttribute("role", "alert");
  function setError(message: string) {
    popupError.textContent = message;
    capsule.dataset.error = String(!!message);
    capsule.title = message || summary.textContent || text("title");
  }
  popup.append(
    popupHeader,
    searchRow,
    selectRow,
    scroll,
    cardArea,
    completion,
    popupError,
    popupFooter,
  );
  root.append(capsule, popup, notice);
  const menu = node(doc, "div", "ar-filter-menu");
  menu.hidden = true;
  const batchChoices = node(doc, "div"),
    statusChoices = node(doc, "div", "ar-status-choices");
  menu.append(
    node(doc, "p", "ar-muted", text("batch")),
    batchChoices,
    statusChoices,
  );
  root.append(menu);
  const live = node(doc, "span", "ar-sr");
  live.setAttribute("aria-live", "polite");
  root.append(live);
  const rows = new Map<string, HTMLElement>(),
    groups = new Map<string, HTMLElement>();
  const choices = new Map<string, HTMLInputElement>();
  let model: AnnotationReviewModel | undefined,
    taskId: string | undefined,
    destroyed = false,
    generation = 0,
    interaction = 0,
    open = false,
    filterFrom: "deck" | "list" | null = null,
    loading = false;
  let composing:
    { owner: AnnotationReviewModel; view: ReviewScopeView } | undefined;
  let pendingRefresh = false,
    lastRejected: AnnotationReviewDecision["entries"] = [],
    lastCard = "",
    lastWheel = 0,
    lastTurn = 0,
    wheelAmount = 0;
  let drag:
    | {
        id: number;
        x: number;
        y: number;
        dx: number;
        active: boolean;
        cancel: boolean;
      }
    | undefined;
  const pageText = (page: number) => `${text("page")} ${page}`;
  const batchNumber = (id: string) =>
    (model?.pool.batches.findIndex((b) => b.id === id) ?? -1) + 1;
  const statusText = (s: string) => text(s);
  function announce(value: string) {
    live.textContent = value;
  }
  async function locate(row: ReviewRow | undefined) {
    if (!row) return;
    const request = generation;
    try {
      await options.rpc("reader/open", {
        libraryID: row.batch.libraryID,
        key: row.batch.attachmentKey,
        pageIndex: row.entry.page - 1,
        annotationKey: row.entry.annotationKey,
      });
    } catch (e) {
      if (!destroyed && generation === request) setError(String(e));
    }
  }
  function sizePopup() {
    if (!open) return;
    const bottom = options.anchor.getBoundingClientRect().top - 8,
      top = options.viewport.getBoundingClientRect().top;
    popup.style.height = `${Math.max(100, Math.min(560, bottom - Math.max(8, top) - 8))}px`;
  }
  function closeFilter(focus = false) {
    const origin = filterFrom;
    filterFrom = null;
    menu.hidden = true;
    scope.setAttribute("aria-expanded", "false");
    filter.setAttribute("aria-expanded", "false");
    if (focus)
      (origin === "deck" ? scope : filter).focus({ preventScroll: true });
  }
  function close(focus = false) {
    if (open) interaction++;
    if (model && open && model.presentation === "list")
      model.view.scroll = scroll.scrollTop;
    open = false;
    popup.hidden = true;
    capsule.setAttribute("aria-expanded", "false");
    closeFilter();
    if (focus) capsule.focus({ preventScroll: true });
  }
  function show(presentation?: "card" | "list") {
    if (!model) return;
    interaction++;
    if (open && model.presentation === "list")
      model.view.scroll = scroll.scrollTop;
    if (presentation) model.presentation = presentation;
    else model.resume();
    open = true;
    popup.hidden = false;
    capsule.setAttribute("aria-expanded", "true");
    options.opened();
    closeFilter();
    render();
    sizePopup();
    if (model.presentation === "list") {
      scroll.scrollTop = model.view.scroll;
      search.focus({ preventScroll: true });
    } else collapse.focus({ preventScroll: true });
  }
  function renderCard() {
    const row = model?.current();
    stack.hidden = !row;
    if (!row || !model) return;
    paper.style.setProperty(
      "--ar-color",
      row.entry.color || "var(--confucius-line-strong)",
    );
    batchLabel.textContent = `${text("batch")} ${batchNumber(row.batch.id)}`;
    batchLabel.title = row.batch.title;
    source.textContent = pageText(row.entry.page);
    source.title = text("source");
    source.classList.add("ar-source");
    status.textContent = statusText(row.entry.status);
    status.dataset.status = row.entry.status;
    cardReason.textContent = row.entry.error ?? "";
    if (lastCard !== row.key) {
      lastCard = row.key;
      quote.textContent = row.entry.quote || text("image");
      comment.textContent = row.entry.comment;
      body.scrollTop = 0;
    }
    const entries = model.rows(),
      index = entries.findIndex((r) => r.key === row.key);
    position.textContent = `${String(index + 1).padStart(2, "0")} / ${entries.length}`;
    range.max = String(entries.length);
    range.value = String(index + 1);
    range.setAttribute("aria-valuetext", `${index + 1} / ${entries.length}`);
    const pending = ["pending", "failed"].includes(row.entry.status);
    accept.hidden = !pending;
    reject.hidden = !pending && row.entry.status !== "unavailable";
    restore.hidden = row.entry.status !== "rejected";
    cardOutcome.hidden = pending || row.entry.status === "rejected";
    cardOutcome.textContent = statusText(row.entry.status);
    accept.disabled = reject.disabled = restore.disabled = busy();
    accept.title = reject.title = restore.title = busy() ? text("writing") : "";
    paper.setAttribute(
      "aria-label",
      `${position.textContent} · ${statusText(row.entry.status)}`,
    );
  }
  function makeRow(row: ReviewRow) {
    const item = node(doc, "article", "ar-list-row"),
      label = node(doc, "label", "ar-checkbox"),
      check = node(doc, "input"),
      readOnly = node(doc, "span", "ar-readonly"),
      content = node(doc, "div", "ar-row-content"),
      m = node(doc, "div", "ar-meta"),
      type = node(doc, "span", "ar-type", text(`type-${row.entry.type}`)),
      page = makeButton(pageText(row.entry.page)),
      state = node(doc, "span", "ar-status"),
      q = node(doc, "blockquote", "ar-quote", row.entry.quote || text("image")),
      c = node(doc, "p", "ar-comment", row.entry.comment),
      reason = node(doc, "p", "ar-row-error");
    item.dataset.key = row.key;
    item.style.setProperty(
      "--ar-color",
      row.entry.color || "var(--confucius-line-strong)",
    );
    check.type = "checkbox";
    check.setAttribute(
      "aria-label",
      `${text("select")} · ${pageText(row.entry.page)} · ${row.entry.comment || row.entry.quote}`,
    );
    label.append(check);
    page.classList.add("ar-source");
    page.title = text("source");
    m.append(type, page, state);
    content.append(m, q, c, reason);
    item.append(label, readOnly, content);
    check.addEventListener("change", () => {
      if (!model) return;
      if (check.checked) model.view.selected.add(row.key);
      else model.view.selected.delete(row.key);
      renderSelection();
    });
    page.addEventListener("click", () => {
      const current = model?.rows().find((r) => r.key === row.key);
      void locate(current);
    });
    rows.set(row.key, item);
    return item;
  }
  function renderRows() {
    if (!model) return;
    const oldScroll = scroll.scrollTop,
      visible = model.visible(),
      keys = new Set(visible.map((row) => row.key));
    const rendered = visible.slice(0, model.view.limit),
      renderedKeys = new Set(rendered.map((row) => row.key));
    for (const batch of model.pool.batches) {
      let group = groups.get(batch.id);
      if (!group) {
        group = node(doc, "section", "ar-group");
        group.dataset.batch = batch.id;
        const head = node(doc, "div", "ar-group-title"),
          label = node(doc, "strong"),
          progress = node(doc, "span", "ar-muted");
        head.append(label, progress);
        group.append(head);
        groups.set(batch.id, group);
        scroll.insertBefore(group, empty);
      }
      group.hidden = !rendered.some((row) => row.batch.id === batch.id);
      group.querySelector("strong")!.textContent =
        `${text("batch")} ${batchNumber(batch.id)} · ${new Date(batch.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const done = batch.entries.filter((e) =>
        ["accepted", "rejected"].includes(e.status),
      ).length;
      group.querySelector(".ar-group-title > span")!.textContent =
        `${done}/${batch.entries.length} ${text("processed")}`;
      let previous = group.firstElementChild!;
      for (const entry of batch.entries) {
        const key = JSON.stringify([batch.id, entry.id]),
          row = { batch, entry, key };
        let item = rows.get(key);
        if (!item) {
          if (!renderedKeys.has(key)) continue;
          item = makeRow(row);
        }
        // A search can mount a late entry before earlier pages load. Preserve
        // source order without moving stable nodes (or losing their focus).
        if (previous.nextElementSibling !== item)
          group.insertBefore(item, previous.nextElementSibling);
        previous = item;
        item.hidden = !keys.has(key) || !renderedKeys.has(key);
        const canSelect = model.selectable(row);
        (item.querySelector("label") as HTMLElement).hidden = !canSelect;
        const readOnly = item.querySelector(".ar-readonly") as HTMLElement;
        readOnly.hidden = canSelect;
        readOnly.textContent = entry.status === "accepted" ? "✓" : "·";
        const check = item.querySelector("input")!;
        check.checked = model.view.selected.has(key);
        const state = item.querySelector(".ar-status") as HTMLElement;
        state.textContent = statusText(entry.status);
        state.dataset.status = entry.status;
        item.querySelector(".ar-row-error")!.textContent = entry.error ?? "";
      }
    }
    empty.hidden = visible.length > 0;
    empty.textContent = model.view.query
      ? text("no-results")
      : text(model.complete && !busy() ? "complete" : "empty");
    if (
      !(composing?.owner === model && composing.view === model.view) &&
      search.value !== model.view.query
    )
      search.value = model.view.query;
    scroll.scrollTop = oldScroll;
    renderSelection();
  }
  function renderSelection() {
    if (!model) return;
    const selected = model.selected(),
      visible = model.visible(),
      eligible = visible.filter((row) => model!.selectable(row));
    selectAll.hidden = !eligible.length;
    selectAll.checked =
      !!eligible.length && selected.length === eligible.length;
    selectAll.indeterminate =
      selected.length > 0 && selected.length < eligible.length;
    resultCount.textContent = `${text("results")} ${visible.length}`;
    clearSelection.hidden = !selected.length;
    const isList = model.presentation === "list",
      complete = model.complete && !busy();
    selectionSummary.textContent =
      isList && selected.length
        ? `${text("selected")} ${selected.length} · ${new Set(selected.map((row) => row.batch.id)).size} ${text("batches")}`
        : complete
          ? text("records-kept")
          : busy() || model.counts.writing
            ? text("saving-minimized")
            : text(isList ? "select-hint" : "gestures");
    bulk.hidden = !isList || !selected.length;
    finish.hidden = !complete;
    undo.hidden = !lastRejected.length;
    undo.disabled = verify.disabled = busy();
    undo.title = verify.title = busy() ? text("writing") : "";
    const acceptable = selected.filter((row) =>
      ["pending", "failed"].includes(row.entry.status),
    );
    bulkAccept.hidden = !acceptable.length;
    bulkReject.hidden = model.view.status === "rejected";
    bulkRestore.hidden = model.view.status !== "rejected";
    bulkAccept.lastChild!.textContent = `${text("accept")} ${acceptable.length}`;
    bulkRestore.textContent = `${text("restore")} ${selected.length}`;
    bulkAccept.disabled = bulkReject.disabled = bulkRestore.disabled = busy();
    bulkAccept.title =
      bulkReject.title =
      bulkRestore.title =
        busy() ? text("writing") : "";
    verify.hidden = !model.pool.batches.some((b) =>
      b.entries.some((e) => e.status === "unknown"),
    );
  }
  function renderChoices() {
    if (!model) return;
    const options = [
      {
        id: "all",
        label: text("all-batches"),
        entries: model.pool.batches.flatMap((b) => b.entries),
      },
      ...model.pool.batches.map((b, i) => ({
        id: b.id,
        label: `${text("batch")} ${i + 1}`,
        entries: b.entries,
      })),
    ];
    for (const option of options) {
      let input = choices.get(option.id);
      if (!input) {
        const label = node(doc, "label", "ar-filter-option");
        input = node(doc, "input");
        input.type = "radio";
        input.name = `${radioGroup}-batch`;
        input.value = option.id;
        const copy = node(doc, "span"),
          count = node(doc, "small", "ar-muted");
        label.append(input, copy, count);
        batchChoices.append(label);
        choices.set(option.id, input);
        input.addEventListener("change", () => {
          if (!model) return;
          interaction++;
          if (open && model.presentation === "list")
            model.view.scroll = scroll.scrollTop;
          model.switchScope(option.id);
          render();
          scroll.scrollTop = model.view.scroll;
          if (filterFrom === "deck") closeFilter(true);
        });
      }
      input.checked = model.scope === option.id;
      input.parentElement!.querySelector("span")!.textContent =
        option.label + (model.unseen.has(option.id) ? ` · ${text("new")}` : "");
      input.parentElement!.querySelector("small")!.textContent =
        `${option.entries.filter((e) => e.status === "pending").length} ${text("pending")}`;
    }
    statusChoices
      .querySelectorAll<HTMLInputElement>("input")
      .forEach(
        (input: HTMLInputElement) =>
          (input.checked = input.value === model!.view.status),
      );
  }
  function render() {
    if (!model) return;
    const wasHidden = root.hidden;
    root.hidden = !model.pool.batches.length;
    if (wasHidden !== root.hidden) options.visibilityChanged();
    if (root.hidden) {
      close();
      return;
    }
    const entries = model.pool.batches.flatMap((b) => b.entries),
      counts = model.counts,
      complete = model.complete && !busy(),
      isList = model.presentation === "list";
    root.dataset.view = model.presentation;
    cardView.setAttribute("aria-pressed", String(!isList));
    listView.setAttribute("aria-pressed", String(isList));
    searchRow.hidden = selectRow.hidden = scroll.hidden = !isList;
    cardArea.hidden = isList || complete;
    completion.hidden = isList || !complete;
    const attention = counts.failed + counts.unknown + counts.unavailable;
    capsuleCount.textContent = complete
      ? `${text("processed")} ${entries.length}`
      : [
          counts.pending ? `${counts.pending} ${text("to-review")}` : "",
          counts.writing || busy() ? text("writing") : "",
          attention ? `${attention} ${text("attention")}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
    capsule.dataset.attention = String(attention > 0);
    scope.lastChild!.textContent =
      model.scope === "all"
        ? text("all-batches")
        : `${text("batch")} ${batchNumber(model.scope)}`;
    scopeCount.textContent = `${model.rows().filter((r) => r.entry.status === "pending").length} ${text("pending")}`;
    summary.textContent = [
      "pending",
      "accepted",
      "rejected",
      ...["writing", "failed", "unknown", "unavailable"].filter((s) =>
        entries.some((e) => e.status === s),
      ),
    ]
      .map(
        (s) =>
          `${entries.filter((e) => e.status === s).length} ${statusText(s)}`,
      )
      .join(" · ");
    const newCount = model.pool.batches
      .filter((b) => model!.unseen.has(b.id))
      .reduce((n, b) => n + b.entries.length, 0);
    newButton.hidden = capsuleNew.hidden = !newCount;
    newButton.textContent = `${text("view-new")} ${newCount}`;
    capsuleNew.textContent = `+${newCount}`;
    capsuleNew.title = newButton.textContent;
    capsule.title =
      popupError.textContent || summary.textContent || text("title");
    completionSummary.textContent = `${counts.accepted} ${text("accepted")} · ${counts.rejected} ${text("rejected")}`;
    filter.lastChild!.textContent =
      (model.scope === "all"
        ? ""
        : `${text("batch")} ${batchNumber(model.scope)} · `) +
      statusText(model.view.status);
    renderCard();
    renderRows();
    renderChoices();
  }
  async function refresh() {
    if (!taskId || destroyed) return;
    if (loading) {
      pendingRefresh = true;
      return;
    }
    loading = true;
    const id = taskId,
      request = generation;
    try {
      const pool = (await options.rpc("annotation/review/list", {
        taskId: id,
      })) as AnnotationReviewPool;
      if (
        !destroyed &&
        taskId === id &&
        generation === request &&
        model?.update(pool)
      ) {
        render();
        sizePopup();
      }
    } catch (e) {
      if (generation === request && !destroyed) setError(String(e));
    } finally {
      if (generation === request) {
        loading = false;
        if (pendingRefresh) {
          pendingRefresh = false;
          void refresh();
        }
      }
    }
  }
  async function decide(
    kind: AnnotationReviewDecision["action"],
    selected: ReviewRow[],
  ) {
    if (!model || !taskId || busy() || !selected.length) return;
    const owner = model,
      originView = model.view,
      focused = doc.activeElement as HTMLElement | null,
      wasOpen = open,
      wasPresentation = owner.presentation,
      request = generation,
      actionInteraction = interaction,
      id = taskId,
      current = owner.current()?.key;
    const currentRequest = () =>
      !destroyed && generation === request && model === owner;
    const entries = selected.map((row) => ({
      batchId: row.batch.id,
      entryId: row.entry.id,
    }));
    busyTasks.add(id);
    setError("");
    render();
    try {
      const pool = (await options.rpc("annotation/review/decide", {
        taskId: id,
        action: kind,
        entries,
      })) as AnnotationReviewPool;
      owner.update(pool);
      selected.forEach((row) => originView.selected.delete(row.key));
      if (currentRequest()) {
        lastRejected = kind === "reject" ? entries : [];
        undo.hidden = !lastRejected.length;
        const updated = owner.pool.batches.flatMap((batch) =>
          batch.entries.filter((entry) =>
            entries.some(
              (e) => e.batchId === batch.id && e.entryId === entry.id,
            ),
          ),
        );
        const expected =
          kind === "accept"
            ? "accepted"
            : kind === "reject"
              ? "rejected"
              : "pending";
        const completed = updated.filter((e) =>
          kind === "restore"
            ? ["pending", "failed", "unavailable"].includes(e.status)
            : e.status === expected,
        ).length;
        notice.textContent = `${text(kind === "restore" ? "restored" : expected)} · ${completed}/${selected.length}`;
        if (completed < selected.length) setError(text("incomplete"));
        if (
          owner.presentation === "card" &&
          interaction === actionInteraction &&
          originView === owner.view &&
          current === owner.current()?.key &&
          ["accepted", "rejected"].includes(owner.current()?.entry.status ?? "")
        ) {
          const rows = owner.rows(),
            index = rows.findIndex((row) => row.key === current),
            next = [...rows.slice(index + 1), ...rows.slice(0, index)].find(
              (row) =>
                ["pending", "failed", "unavailable"].includes(row.entry.status),
            );
          if (next) owner.view.current = next.key;
        }
        render();
        // A processed row or bulk action can disappear. Keep keyboard users in
        // the same surface without taking focus from subsequent user activity.
        if (
          focused &&
          interaction === actionInteraction &&
          root.contains(focused) &&
          !focused.getClientRects().length &&
          [focused, doc.body, doc.documentElement].includes(
            doc.activeElement as HTMLElement,
          )
        ) {
          if (open && wasOpen && model?.presentation === wasPresentation)
            (model.presentation === "list" ? search : range).focus({
              preventScroll: true,
            });
        }
        announce(notice.textContent);
      }
    } catch (e) {
      if (currentRequest()) setError(String(e));
    } finally {
      busyTasks.delete(id);
      if (!destroyed) {
        const previousFocus = doc.activeElement as HTMLElement | null;
        render();
        if (
          currentRequest() &&
          interaction === actionInteraction &&
          open &&
          model?.complete &&
          previousFocus &&
          cardArea.contains(previousFocus) &&
          !previousFocus.getClientRects().length &&
          [previousFocus, doc.body, doc.documentElement].includes(
            doc.activeElement as HTMLElement,
          )
        )
          finish.focus({ preventScroll: true });
      }
    }
  }
  function openFilter(origin: "deck" | "list") {
    if (filterFrom === origin) {
      closeFilter(true);
      return;
    }
    filterFrom = origin;
    menu.hidden = false;
    statusChoices.hidden = origin === "deck";
    renderChoices();
    const target = origin === "deck" ? scope : filter,
      rect = target.getBoundingClientRect(),
      bounds = options.anchor.getBoundingClientRect();
    menu.style.maxHeight = `${Math.max(100, win!.innerHeight - 24)}px`;
    menu.style.width = `${Math.min(272, bounds.width)}px`;
    menu.style.left = `${Math.max(0, Math.min(bounds.width - menu.offsetWidth, rect.left - bounds.left))}px`;
    const top = rect.bottom - bounds.top + 4,
      spaceBelow = win!.innerHeight - rect.bottom - 8;
    menu.style.top = `${Math.max(8 - bounds.top, spaceBelow < menu.offsetHeight ? rect.top - bounds.top - menu.offsetHeight - 4 : top)}px`;
    target.setAttribute("aria-expanded", "true");
    menu
      .querySelector<HTMLInputElement>("input:checked")
      ?.focus({ preventScroll: true });
  }
  for (const value of ["pending", "accepted", "rejected", "all"]) {
    const label = node(doc, "label", "ar-filter-option"),
      input = node(doc, "input");
    input.type = "radio";
    input.name = `${radioGroup}-status`;
    input.value = value;
    label.append(input, node(doc, "span", "", statusText(value)));
    statusChoices.append(label);
    input.addEventListener("change", () => {
      model?.filter(value as ReviewFilter);
      render();
      scroll.scrollTop = 0;
    });
  }
  scope.addEventListener("click", () => openFilter("deck"));
  filter.addEventListener("click", () => openFilter("list"));
  capsule.addEventListener("click", () => (open ? close(true) : show()));
  cardView.addEventListener("click", () => show("card"));
  listView.addEventListener("click", () => show("list"));
  collapse.addEventListener("click", () => close(true));
  finish.addEventListener("click", () => close(true));
  source.addEventListener("click", () => void locate(model?.current()));
  accept.addEventListener(
    "click",
    () => void decide("accept", model?.current() ? [model.current()!] : []),
  );
  reject.addEventListener(
    "click",
    () => void decide("reject", model?.current() ? [model.current()!] : []),
  );
  restore.addEventListener(
    "click",
    () => void decide("restore", model?.current() ? [model.current()!] : []),
  );
  bulkAccept.addEventListener(
    "click",
    () =>
      void decide(
        "accept",
        model
          ?.selected()
          .filter((row) => ["pending", "failed"].includes(row.entry.status)) ??
          [],
      ),
  );
  bulkReject.addEventListener(
    "click",
    () => void decide("reject", model?.selected() ?? []),
  );
  bulkRestore.addEventListener(
    "click",
    () => void decide("restore", model?.selected() ?? []),
  );
  undo.addEventListener("click", () => {
    const rows =
      model?.pool.batches
        .flatMap((batch) =>
          batch.entries.map((entry) => ({
            batch,
            entry,
            key: JSON.stringify([batch.id, entry.id]),
          })),
        )
        .filter((row) =>
          lastRejected.some(
            (e) => e.batchId === row.batch.id && e.entryId === row.entry.id,
          ),
        ) ?? [];
    void decide("restore", rows);
  });
  clearSelection.addEventListener("click", () => {
    model?.view.selected.clear();
    renderRows();
  });
  selectAll.addEventListener("change", () => {
    model?.selectAll(selectAll.checked);
    renderRows();
  });
  verify.addEventListener("click", () => void refresh());
  const query = () => {
    if (!model) return;
    model.filter(model.view.status, search.value);
    renderRows();
    scroll.scrollTop = 0;
  };
  search.addEventListener("compositionstart", () => {
    if (model) composing = { owner: model, view: model.view };
  });
  search.addEventListener("compositionend", () => {
    const current = composing;
    composing = undefined;
    if (current?.owner === model && current?.view === model?.view) query();
    else renderRows();
  });
  search.addEventListener("input", (event) => {
    if (!composing && !(event as InputEvent).isComposing) query();
  });
  range.addEventListener("input", () => {
    if (model) {
      interaction++;
      model.view.current = model.rows()[Number(range.value) - 1]?.key;
      renderCard();
    }
  });
  scroll.addEventListener(
    "scroll",
    () => {
      if (model && open && model.presentation === "list") {
        model.view.scroll = scroll.scrollTop;
        if (
          scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 160 &&
          model.view.limit < model.visible().length
        ) {
          model.view.limit += 80;
          renderRows();
        }
      }
    },
    { passive: true },
  );
  const viewNew = () => {
    if (!model) return;
    const first = model.viewNew();
    if (!first) return;
    show("list");
    const target = groups.get(first.batch.id);
    if (target) scroll.scrollTop = target.offsetTop - scroll.offsetTop;
  };
  newButton.addEventListener("click", viewNew);
  function turn(delta: number) {
    if (!model) return;
    interaction++;
    model.turn(delta);
    renderCard();
  }
  paper.addEventListener(
    "wheel",
    (event) => {
      const e = event as WheelEvent;
      if (
        !open ||
        model?.presentation !== "card" ||
        e.ctrlKey ||
        (e.target as Element).closest("button,input")
      )
        return;
      if (
        body.contains(e.target as Node) &&
        body.scrollHeight > body.clientHeight + 2
      )
        return;
      e.preventDefault();
      const now = Date.now();
      if (lastTurn && now - lastTurn < 240) return;
      if (now - lastWheel > 160) wheelAmount = 0;
      lastWheel = now;
      wheelAmount +=
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(wheelAmount) > 38) {
        turn(Math.sign(wheelAmount));
        wheelAmount = 0;
        lastTurn = now;
      }
    },
    { passive: false },
  );
  paper.addEventListener("pointerdown", (event) => {
    const e = event as PointerEvent;
    if (e.button !== 0 || (e.target as Element).closest("button,input")) return;
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      dx: 0,
      active: false,
      cancel: false,
    };
  });
  paper.addEventListener("pointermove", (event) => {
    const e = event as PointerEvent;
    if (!drag || drag.id !== e.pointerId || drag.cancel) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (!drag.active && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
      drag.cancel = true;
      return;
    }
    if (
      !drag.active &&
      Math.abs(dx) > 12 &&
      Math.abs(dx) > Math.abs(dy) * 1.25
    ) {
      drag.active = true;
      paper.setPointerCapture(e.pointerId);
      win?.getSelection()?.removeAllRanges();
    }
    if (drag.active) {
      drag.dx = dx;
      paper.style.transform = `translateX(${Math.max(-80, Math.min(80, dx)) * 0.3}px)`;
    }
  });
  const end = (event: Event) => {
    const e = event as PointerEvent;
    if (!drag || drag.id !== e.pointerId) return;
    const current = drag;
    drag = undefined;
    paper.style.transform = "";
    if (paper.hasPointerCapture(e.pointerId))
      paper.releasePointerCapture(e.pointerId);
    if (
      current.active &&
      Math.abs(current.dx) > 44 &&
      e.type !== "pointercancel"
    )
      turn(current.dx < 0 ? 1 : -1);
  };
  paper.addEventListener("pointerup", end);
  paper.addEventListener("pointercancel", end);
  const outside = (event: Event) => {
    const target = event.target as Node;
    if (!root.contains(target)) close();
    else if (
      !menu.contains(target) &&
      !scope.contains(target) &&
      !filter.contains(target)
    )
      closeFilter();
  };
  doc.addEventListener("pointerdown", outside);
  root.addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      if (filterFrom) closeFilter(true);
      else if (open) close(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    } else if (
      open &&
      model?.presentation === "card" &&
      !filterFrom &&
      !(e.target as Element).closest("input,button") &&
      ["ArrowLeft", "ArrowRight"].includes(e.key)
    ) {
      e.preventDefault();
      turn(e.key === "ArrowRight" ? 1 : -1);
    }
  });
  const observer = win?.ResizeObserver
    ? new win.ResizeObserver(sizePopup)
    : undefined;
  observer?.observe(options.viewport);
  observer?.observe(options.anchor);
  win?.addEventListener("resize", sizePopup);
  return {
    node: root,
    get floating() {
      return open;
    },
    get visible() {
      return !root.hidden;
    },
    close,
    refresh,
    update(id: string | undefined) {
      if (taskId === id) return;
      close();
      generation++;
      loading = pendingRefresh = false;
      composing = undefined;
      taskId = id;
      model = id ? (views.get(id) ?? new AnnotationReviewModel(id)) : undefined;
      if (id && model) {
        views.delete(id);
        views.set(id, model);
        if (views.size > 20) views.delete(views.keys().next().value!);
      }
      rows.clear();
      groups.clear();
      choices.clear();
      batchChoices.replaceChildren();
      scroll.replaceChildren(empty);
      lastCard = "";
      lastRejected = [];
      undo.hidden = true;
      setError("");
      root.hidden = true;
      options.visibilityChanged();
      if (model) {
        render();
        void refresh();
      }
    },
    destroy() {
      destroyed = true;
      generation++;
      close();
      observer?.disconnect();
      win?.removeEventListener("resize", sizePopup);
      doc.removeEventListener("pointerdown", outside);
    },
  };
}
