import type {
  LiteraturePage,
  LiteratureConfirmation,
  LiteratureSummary,
  LiteratureWork,
} from "@confucius/protocol";
import { createWorkspaceButton } from "./workspaceControls";
import { droppedFilePaths } from "./fileDrop";
import { getString } from "../../utils/locale";

type Rpc = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;
type Query = NonNullable<LiteratureSummary["latestQuery"]>;
const NS = "http://www.w3.org/1999/xhtml";
const text = (key: string) => getString(`workspace-literature-${key}`);
function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  label?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElementNS(NS, tag) as HTMLElementTagNameMap[K];
  if (label) element.textContent = label;
  return element;
}

/** Shared, quiet research glyph; all surfaces inherit the workspace palette. */
export function researchIcon(doc: Document, kind: "search" | "agent") {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(name, value);
  svg.classList.add("confucius-research-icon");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    kind === "search"
      ? "M16 16 21 21M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0"
      : "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
  );
  svg.append(path);
  return svg;
}

/** A card is docked only after it is entirely outside the conversation viewport. */
export function literatureCardOffscreen(
  card: { top: number; bottom: number },
  viewport: { top: number; bottom: number },
): boolean {
  return card.bottom <= viewport.top || card.top >= viewport.bottom;
}

/** One editor and one versioned selection, presented inline or above the composer. */
export function createLiteraturePanel(
  doc: Document,
  options: {
    rpc: Rpc;
    viewport: HTMLElement;
    changed: () => void;
    visibilityChanged: () => void;
  },
) {
  const win = doc.defaultView;
  const dock = node(doc, "div");
  dock.className = "confucius-literature-dock";
  dock.hidden = true;
  const popup = node(doc, "section");
  popup.id = "confucius-literature-popup";
  popup.className = "confucius-literature confucius-literature-popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", text("title"));
  popup.hidden = true;
  const capsule = createWorkspaceButton(
    doc,
    "confucius-literature-capsule",
    "",
  );
  capsule.classList.add("confucius-literature-capsule");
  capsule.setAttribute("aria-haspopup", "dialog");
  capsule.setAttribute("aria-controls", popup.id);
  capsule.setAttribute("aria-expanded", "false");
  const capsuleLabel = node(doc, "span"),
    caret = node(doc, "span", "⌃");
  caret.setAttribute("aria-hidden", "true");
  capsule.append(researchIcon(doc, "search"), capsuleLabel, caret);
  dock.append(popup, capsule);

  const editor = node(doc, "div");
  editor.className = "confucius-literature-editor";
  const header = node(doc, "div");
  header.className = "confucius-literature-header";
  const heading = node(doc, "div"),
    title = node(doc, "h3"),
    metadata = node(doc, "div");
  metadata.className = "confucius-literature-meta";
  heading.append(title, metadata);
  const close = createWorkspaceButton(doc, "", text("collapse"));
  close.classList.add("confucius-literature-quiet");
  header.append(researchIcon(doc, "search"), heading, close);
  const tabs = node(doc, "div");
  tabs.className = "confucius-literature-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", text("title"));
  const candidateTab = createWorkspaceButton(doc, "", ""),
    poolTab = createWorkspaceButton(doc, "", "");
  candidateTab.id = "confucius-literature-candidates-tab";
  poolTab.id = "confucius-literature-pool-tab";
  const scroll = node(doc, "div");
  scroll.className = "confucius-literature-scroll";
  scroll.id = "confucius-literature-results";
  scroll.setAttribute("role", "tabpanel");
  for (const tab of [candidateTab, poolTab]) {
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", scroll.id);
  }
  tabs.append(candidateTab, poolTab);
  const filter = node(doc, "input");
  filter.type = "search";
  filter.className = "confucius-literature-filter";
  filter.placeholder = text("filter");
  filter.setAttribute("aria-label", text("filter"));
  const count = node(doc, "div"),
    error = node(doc, "div");
  count.className = "confucius-literature-meta confucius-literature-count";
  error.className = "confucius-literature-error";
  error.setAttribute("role", "alert");
  const rows = node(doc, "div"),
    paging = node(doc, "div");
  paging.className =
    "confucius-literature-controls confucius-literature-paging";
  const controls = node(doc, "div");
  controls.className = "confucius-literature-tools";
  const localFilter = node(doc, "details");
  localFilter.className = "confucius-literature-local-filter";
  localFilter.append(node(doc, "summary", text("filter")), filter);
  // Direct search is contextual, available only after the Agent has searched.
  const refine = node(doc, "details");
  refine.className = "confucius-literature-refine";
  refine.append(node(doc, "summary", text("refine")));
  const form = node(doc, "div");
  form.className = "confucius-literature-controls";
  const query = node(doc, "input");
  query.placeholder = text("query");
  query.setAttribute("aria-label", text("query"));
  const from = node(doc, "input"),
    to = node(doc, "input");
  for (const [input, label] of [
    [from, text("from")],
    [to, text("to")],
  ] as const) {
    input.type = "number";
    input.min = "1000";
    input.max = "9999";
    input.placeholder = label;
    input.setAttribute("aria-label", label);
    input.className = "confucius-literature-year";
  }
  const oa = node(doc, "input");
  oa.type = "checkbox";
  const oaLabel = node(doc, "label");
  oaLabel.append(oa, text("oa"));
  const sort = node(doc, "select");
  sort.setAttribute("aria-label", text("sort"));
  for (const key of ["relevance", "date", "citations"]) {
    const option = node(doc, "option", text(key));
    option.value = key;
    sort.append(option);
  }
  const search = createWorkspaceButton(doc, "", text("search"));
  form.append(query, from, to, oaLabel, sort, search);
  const history = node(doc, "div");
  history.className = "confucius-literature-history";
  refine.append(form, history);
  controls.append(localFilter, refine);
  const confirmation = node(doc, "section");
  confirmation.className = "confucius-literature-confirmation";
  confirmation.hidden = true;
  const footer = node(doc, "div");
  footer.className = "confucius-literature-footer";
  const locate = createWorkspaceButton(doc, "", text("locate"));
  locate.classList.add("confucius-literature-quiet");
  const review = createWorkspaceButton(doc, "", text("review"), "primary");
  const cancel = createWorkspaceButton(doc, "", text("cancel-downloads"));
  const actions = node(doc, "div");
  actions.className = "confucius-literature-controls";
  actions.append(cancel, review);
  footer.append(locate, actions);
  scroll.append(controls, count, rows, paging, confirmation);
  editor.append(header, tabs, error, scroll, footer);
  popup.append(editor);

  type Card = {
    query: Query;
    root: HTMLElement;
    compact: HTMLElement;
    slot: HTMLElement;
    title: HTMLElement;
    meta: HTMLElement;
    status: HTMLElement;
    preview: HTMLElement;
    view: HTMLButtonElement;
    confirm: HTMLButtonElement;
  };
  const cards = new Map<string, Card>();
  let taskId: string | undefined,
    summary: LiteratureSummary | undefined,
    activeId: string | undefined;
  let inlineId: string | undefined,
    floating = false,
    disposed = false;
  let epoch = 0,
    request = 0,
    revision = -1,
    busy = false,
    offset = 0;
  let selection: "auto" | "candidates" | "pool" = "auto";
  let preview: LiteratureWork[] = [],
    proposal: LiteratureConfirmation | undefined;
  let refreshTimer: number | undefined, frame: number | undefined;
  const selected = () =>
    selection === "candidates" ||
    (selection === "auto" && (summary?.candidates ?? 0) > 0);
  const active = () => (activeId ? cards.get(activeId) : undefined);
  function activate(id: string) {
    if (activeId === id) return;
    activeId = id;
    const q = cards.get(id)?.query;
    if (q) {
      query.value = q.query;
      from.value = q.fromYear ? String(q.fromYear) : "";
      to.value = q.toYear ? String(q.toYear) : "";
      oa.checked = q.openAccess ?? false;
    }
  }
  const message = (e: unknown) => {
    error.textContent = String(e instanceof Error ? e.message : e);
  };
  const meta = (q: Query) =>
    [
      "OpenAlex",
      q.fromYear || q.toYear ? `${q.fromYear ?? "…"}–${q.toYear ?? "…"}` : "",
      q.openAccess ? text("oa") : "",
      `${text("pool")} ${summary?.pool ?? 0}`,
    ]
      .filter(Boolean)
      .join(" · ");
  const status = () =>
    summary?.acquiring
      ? `${text("downloading")} ${summary.acquiring}`
      : summary?.hasCandidateChanges || summary?.awaitingConfirmation
        ? text("draft")
        : summary?.pendingFulltext
          ? `${text("missing")} ${summary.pendingFulltext}`
          : summary?.available
            ? `${text("fulltext")} ${summary.available}`
            : text("found");
  function labels() {
    capsuleLabel.textContent = `${text("title")} · ${text("pool")} ${summary?.pool ?? 0} · ${text("candidates")} ${summary?.candidates ?? 0}${summary?.pendingFulltext && !summary.hasCandidateChanges ? ` · ${text("missing")} ${summary.pendingFulltext}` : ""}`;
    for (const card of cards.values()) {
      card.title.textContent = card.query.query;
      card.meta.textContent = meta(card.query);
      card.status.textContent = status();
      card.view.textContent = `${text("view")} · ${text("candidates")} ${summary?.candidates ?? 0}`;
      card.confirm.hidden =
        !summary?.hasCandidateChanges && !summary?.awaitingConfirmation;
      card.confirm.disabled = busy;
      card.preview.replaceChildren(
        ...preview.slice(0, 2).map((work) => {
          const line = node(doc, "div"),
            label = node(doc, "span", work.title);
          line.append(
            label,
            node(doc, "span", work.year ? String(work.year) : ""),
          );
          return line;
        }),
      );
    }
    title.textContent = active()?.query.query ?? text("title");
    metadata.textContent = active() ? meta(active()!.query) : "OpenAlex";
    candidateTab.textContent = `${text("candidates")} ${summary?.candidates ?? 0}`;
    poolTab.textContent = `${text("pool")} ${summary?.pool ?? 0}`;
    for (const tab of [candidateTab, poolTab]) {
      const on = (tab === candidateTab) === selected();
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    scroll.setAttribute(
      "aria-labelledby",
      selected() ? candidateTab.id : poolTab.id,
    );
    count.textContent = `${text("evaluated")} ${summary?.evaluated ?? 0} · ${text("fulltext")} ${summary?.available ?? 0} · ${text("read")} ${summary?.read ?? 0}`;
    locate.hidden = !floating;
    cancel.hidden = !summary?.acquiring;
    review.hidden =
      !!proposal ||
      (!summary?.hasCandidateChanges && !summary?.awaitingConfirmation);
    review.disabled = busy;
    search.disabled = busy;
    if (proposal) {
      const apply =
        confirmation.querySelector<HTMLButtonElement>("[data-confirm]");
      if (apply)
        apply.disabled =
          busy || proposal.candidateRevision !== summary?.candidateRevision;
      const warning = confirmation.querySelector<HTMLElement>("[data-stale]");
      if (warning)
        warning.hidden =
          proposal.candidateRevision === summary?.candidateRevision;
    }
  }
  function measure() {
    frame = undefined;
    if (disposed) return;
    const card = active()?.root;
    const viewport = options.viewport.getBoundingClientRect();
    const outside =
      !!card?.isConnected &&
      literatureCardOffscreen(card.getBoundingClientRect(), viewport);
    if (!outside && floating) hidePopup(false);
    dock.hidden = !outside;
    // The popup stays inside the workbench, even in a short Zotero sidebar.
    const bottom = capsule.getBoundingClientRect().top;
    popup.style.maxHeight = `${Math.max(100, bottom - Math.max(8, viewport.top) - 8)}px`;
    options.visibilityChanged();
  }
  function scheduleMeasure() {
    if (frame === undefined) frame = win?.requestAnimationFrame(measure);
  }
  function preserveScroll(work: () => void) {
    const y = options.viewport.scrollTop,
      inner = scroll.scrollTop;
    work();
    options.viewport.scrollTop = y;
    scroll.scrollTop = inner;
  }
  function hidePopup(focus: boolean) {
    if (!floating) return;
    floating = false;
    popup.hidden = true;
    capsule.setAttribute("aria-expanded", "false");
    const card = inlineId ? cards.get(inlineId) : undefined;
    if (card)
      preserveScroll(() => {
        card.slot.append(editor);
        card.slot.style.height = "";
      });
    if (focus && !dock.hidden) capsule.focus({ preventScroll: true });
    labels();
  }
  function collapseInline() {
    const card = inlineId ? cards.get(inlineId) : undefined;
    if (card) {
      card.compact.hidden = false;
      card.slot.style.height = "";
      popup.append(editor);
    }
    inlineId = undefined;
    scheduleMeasure();
  }
  function openInline(id: string, confirm = false) {
    hidePopup(false);
    if (inlineId !== id) collapseInline();
    activate(id);
    inlineId = id;
    const card = cards.get(id)!;
    card.compact.hidden = true;
    card.slot.append(editor);
    labels();
    void refresh()
      .then(() => {
        if (activeId !== id || disposed) return;
        if (confirm) void showConfirmation();
        else close.focus({ preventScroll: true });
      })
      .catch(message);
    scheduleMeasure();
  }
  function showPopup() {
    if (floating) {
      hidePopup(true);
      return;
    }
    const card = inlineId ? cards.get(inlineId) : undefined;
    preserveScroll(() => {
      if (card)
        card.slot.style.height = `${card.slot.getBoundingClientRect().height}px`;
      popup.append(editor);
      popup.hidden = false;
      floating = true;
    });
    capsule.setAttribute("aria-expanded", "true");
    labels();
    measure();
    close.focus({ preventScroll: true });
    void refresh().catch(message);
  }
  function makeCard(q: Query) {
    const root = node(doc, "article");
    root.className = "confucius-literature confucius-literature-card";
    root.setAttribute("aria-label", `${text("title")}: ${q.query}`);
    const compact = node(doc, "div"),
      cardHeader = node(doc, "div");
    cardHeader.className = "confucius-literature-header";
    const heading = node(doc, "div"),
      title = node(doc, "h3"),
      meta = node(doc, "div"),
      status = node(doc, "span");
    meta.className = "confucius-literature-meta";
    status.className = "confucius-literature-status";
    heading.append(title, meta);
    cardHeader.append(researchIcon(doc, "search"), heading, status);
    const preview = node(doc, "div");
    preview.className = "confucius-literature-preview";
    const footer = node(doc, "div");
    footer.className = "confucius-literature-footer";
    const view = createWorkspaceButton(doc, "", text("view")),
      confirm = createWorkspaceButton(doc, "", text("review"), "primary");
    view.classList.add("confucius-literature-quiet");
    view.addEventListener("click", () => openInline(q.id));
    confirm.addEventListener("click", () => openInline(q.id, true));
    footer.append(view, confirm);
    compact.append(cardHeader, preview, footer);
    const slot = node(doc, "div");
    root.append(compact, slot);
    const card = {
      query: q,
      root,
      compact,
      slot,
      title,
      meta,
      status,
      preview,
      view,
      confirm,
    };
    cards.set(q.id, card);
    return card;
  }
  async function refresh() {
    const id = taskId,
      stamp = ++request,
      era = epoch;
    if (!id || disposed) return;
    const wasSelected = selected();
    const params = {
      taskId: id,
      offset,
      filter: filter.value,
      selected: wasSelected ? true : undefined,
    };
    const fetched = await Promise.all([
      options.rpc("literature/list", params) as Promise<LiteraturePage>,
      options.rpc("literature/list", {
        taskId: id,
        limit: 2,
        selected: (summary?.candidates ?? 0) > 0 ? true : undefined,
      }) as Promise<LiteraturePage>,
    ]).catch((e: unknown) => {
      if (taskId !== id || epoch !== era || stamp !== request || disposed)
        return undefined;
      throw e;
    });
    if (!fetched) return;
    const [result, sample] = fetched;
    if (taskId !== id || epoch !== era || stamp !== request || disposed) return;
    if (summary && result.summary.revision < summary.revision) {
      queueRefresh();
      return;
    }
    summary = result.summary;
    if (wasSelected !== selected() || (offset > 0 && offset >= result.total)) {
      offset =
        wasSelected !== selected()
          ? 0
          : Math.max(0, Math.floor((result.total - 1) / 20) * 20);
      await refresh();
      return;
    }
    revision = summary.revision;
    preview = sample.items;
    if (!activeId && result.queries[0]) {
      // Legacy pools may predate the lightweight anchor in event history.
      makeCard(result.queries[0]);
      activate(result.queries[0].id);
      options.changed();
    }
    labels();
    renderRows(result);
    scheduleMeasure();
  }
  function queueRefresh() {
    if (disposed || refreshTimer !== undefined) return;
    refreshTimer = win?.setTimeout(() => {
      refreshTimer = undefined;
      if (!busy) void refresh().catch(message);
    }, 100);
  }
  async function act(work: () => Promise<unknown>) {
    if (busy || !taskId || disposed) return;
    const era = epoch;
    busy = true;
    error.textContent = "";
    labels();
    try {
      await work();
      if (epoch !== era || disposed) return;
      await refresh();
      options.changed();
    } catch (e) {
      if (epoch !== era || disposed) return;
      message(e);
      await refresh().catch(() => undefined);
    } finally {
      if (epoch === era && !disposed) {
        busy = false;
        labels();
      }
    }
  }
  function endConfirmation() {
    proposal = undefined;
    confirmation.hidden = true;
    confirmation.replaceChildren();
    rows.hidden =
      paging.hidden =
      controls.hidden =
      count.hidden =
      tabs.hidden =
        false;
    scroll.scrollTop = 0;
    labels();
  }
  async function showConfirmation() {
    const id = taskId,
      era = epoch;
    if (!id) return;
    await act(async () => {
      const value = (await options.rpc("literature/preview", {
        taskId: id,
      })) as LiteratureConfirmation;
      const ids = [
        ...new Set([...value.added, ...value.removed, ...value.acquire]),
      ];
      const works = await Promise.all(
        ids.map(
          (paperId) =>
            options.rpc("literature/get", {
              taskId: id,
              id: paperId,
            }) as Promise<LiteratureWork>,
        ),
      );
      if (epoch !== era) return;
      proposal = value;
      confirmation.replaceChildren();
      confirmation.append(
        node(doc, "h4", text("review-title")),
        node(
          doc,
          "p",
          `${text("added")} ${value.added.length} · ${text("removed")} ${value.removed.length} · ${text("acquire")} ${value.acquire.length}`,
        ),
        node(doc, "p", text("confirm-help")),
      );
      for (const [label, ids] of [
        [text("added"), value.added],
        [text("removed"), value.removed],
        [text("acquire"), value.acquire],
      ] as const) {
        if (!ids.length) continue;
        const list = node(doc, "ul");
        list.setAttribute("aria-label", label);
        for (const workId of ids)
          list.append(
            node(
              doc,
              "li",
              works.find((w) => w.id === workId)?.title ?? workId,
            ),
          );
        const group = node(doc, "details");
        group.open = label === text("added");
        group.append(node(doc, "summary", `${label} · ${ids.length}`), list);
        confirmation.append(group);
      }
      const warning = node(doc, "p", text("stale"));
      warning.dataset.stale = "true";
      warning.hidden = true;
      const apply = createWorkspaceButton(doc, "", text("confirm"), "primary"),
        back = createWorkspaceButton(doc, "", text("dismiss"));
      apply.dataset.confirm = "true";
      apply.addEventListener(
        "click",
        () =>
          void act(async () => {
            await options.rpc("literature/confirm", {
              taskId: id,
              candidateRevision: value.candidateRevision,
            });
            if (epoch === era) endConfirmation();
          }),
      );
      back.addEventListener("click", endConfirmation);
      const actions = node(doc, "div");
      actions.className = "confucius-literature-controls";
      actions.append(back, apply);
      confirmation.append(warning, actions);
      confirmation.hidden = false;
      rows.hidden =
        paging.hidden =
        controls.hidden =
        count.hidden =
        tabs.hidden =
          true;
      scroll.scrollTop = 0;
      apply.focus({ preventScroll: true });
    });
  }
  function renderRows(result: LiteraturePage) {
    const id = taskId!,
      era = epoch;
    const opened = new Set(
      (
        Array.from(
          rows.querySelectorAll("details[open]"),
        ) as HTMLDetailsElement[]
      ).map((e) => (e.closest("[data-work-id]") as HTMLElement).dataset.workId),
    );
    const focused = doc.activeElement as HTMLElement | null;
    const focusedWork = rows.contains(focused)
      ? (focused?.closest("[data-work-id]") as HTMLElement | null)?.dataset
          .workId
      : undefined;
    const focusedAction = focused?.dataset.action;
    const y = scroll.scrollTop;
    rows.replaceChildren();
    paging.replaceChildren();
    history.replaceChildren();
    if (!result.items.length)
      rows.append(
        node(
          doc,
          "p",
          selected() ? text("empty-candidates") : text("empty-results"),
        ),
      );
    for (const work of result.items) {
      const row = node(doc, "article");
      row.className = "confucius-literature-row";
      row.dataset.workId = work.id;
      const check = node(doc, "input");
      check.type = "checkbox";
      check.checked = work.decision.selected;
      check.dataset.action = "select";
      const label = node(doc, "label"),
        labelText = node(doc, "span", work.title);
      label.append(check, labelText);
      check.addEventListener("change", () => {
        if (busy) {
          check.checked = work.decision.selected;
          return;
        }
        const selected = check.checked;
        void act(() =>
          options.rpc("literature/updateCandidates", {
            taskId: id,
            candidateRevision: result.summary.candidateRevision,
            changes: [{ id: work.id, selected, reason: text("user-choice") }],
          }),
        );
      });
      const info = node(
        doc,
        "div",
        [
          work.year,
          work.authors.slice(0, 2).join(", "),
          work.venue,
          `${text("citations")} ${work.citedBy}`,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      info.className = "confucius-literature-meta";
      const reason = node(
        doc,
        "p",
        work.decision.reason ?? text("not-evaluated"),
      );
      reason.className = "confucius-literature-reason";
      const details = node(doc, "details");
      details.open = opened.has(work.id);
      details.append(
        node(doc, "summary", text("abstract")),
        node(doc, "p", work.abstract ?? text("no-abstract")),
      );
      const status = node(
        doc,
        "div",
        `${text(work.acquisition.status)}${work.acquisition.error ? ` · ${work.acquisition.error}` : ""}`,
      );
      status.className = "confucius-literature-meta";
      row.append(label, info, reason, details);
      if (work.acquisition.status !== "missing") row.append(status);
      if (work.acquisition.message)
        row.append(node(doc, "p", work.acquisition.message));
      if (
        work.acquisition.status === "failed" ||
        (work.acquisition.item && work.acquisition.status !== "available")
      ) {
        const actions = node(doc, "div");
        actions.className = "confucius-literature-controls";
        const retry = createWorkspaceButton(doc, "", text("retry"));
        retry.dataset.action = "retry";
        retry.disabled = ["downloading", "queued"].includes(
          work.acquisition.status,
        );
        retry.addEventListener(
          "click",
          () =>
            void act(() =>
              options.rpc("literature/retry", { taskId: id, id: work.id }),
            ),
        );
        if (work.acquisition.item) {
          const browser = createWorkspaceButton(doc, "", text("browser"));
          browser.dataset.action = "browser";
          browser.disabled = !work.landingUrl;
          browser.addEventListener(
            "click",
            () =>
              void act(() =>
                options.rpc("literature/browser", { taskId: id, id: work.id }),
              ),
          );
          actions.append(browser);
          const drop = node(doc, "div", text("drop"));
          drop.className = "confucius-literature-drop";
          drop.setAttribute("aria-label", `${text("drop")}: ${work.title}`);
          drop.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.stopPropagation();
            drop.dataset.over = "true";
          });
          drop.addEventListener("dragleave", () => delete drop.dataset.over);
          drop.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            delete drop.dataset.over;
            const paths = droppedFilePaths((e as DragEvent).dataTransfer);
            if (paths.length !== 1) {
              error.textContent = text("drop-one");
              return;
            }
            if (epoch === era)
              void act(() =>
                options.rpc("literature/attach", {
                  taskId: id,
                  id: work.id,
                  path: paths[0],
                }),
              );
          });
          row.append(actions, drop);
        } else row.append(actions);
        actions.append(retry);
      }
      rows.append(row);
    }
    if (offset > 0) {
      const previous = createWorkspaceButton(doc, "", text("previous"));
      previous.addEventListener("click", () => {
        offset = Math.max(0, offset - 20);
        void act(refresh);
      });
      paging.append(previous);
    }
    if (result.nextOffset !== null) {
      const next = createWorkspaceButton(doc, "", text("next"));
      next.addEventListener("click", () => {
        offset = result.nextOffset!;
        void act(refresh);
      });
      paging.append(next);
    }
    for (const saved of result.queries) {
      const line = node(doc, "div");
      line.className = "confucius-literature-query";
      line.append(
        node(doc, "span", `${saved.query} · ${text("total")} ${saved.total}`),
      );
      if (saved.cursor) {
        const more = createWorkspaceButton(doc, "", text("more"));
        more.addEventListener(
          "click",
          () =>
            void act(() =>
              options.rpc("literature/search", {
                taskId: id,
                query: saved.query,
                queryId: saved.id,
              }),
            ),
        );
        line.append(more);
      }
      history.append(line);
    }
    if (focusedWork && focusedAction) {
      const row = Array.from(rows.children).find(
        (n) => (n as HTMLElement).dataset.workId === focusedWork,
      );
      const target =
        row?.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`) ??
        rows.querySelector<HTMLElement>("input[type=checkbox]") ??
        candidateTab;
      target.focus({ preventScroll: true });
    }
    scroll.scrollTop = y;
  }
  for (const tab of [candidateTab, poolTab]) {
    tab.addEventListener("click", () => {
      selection = tab === candidateTab ? "candidates" : "pool";
      offset = 0;
      endConfirmation();
      labels();
      void refresh().catch(message);
    });
    tab.addEventListener("keydown", (event) => {
      const e = event as KeyboardEvent;
      if (
        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) ||
        e.isComposing
      )
        return;
      e.preventDefault();
      const next =
        e.key === "Home"
          ? candidateTab
          : e.key === "End"
            ? poolTab
            : tab === candidateTab
              ? poolTab
              : candidateTab;
      next.click();
      next.focus({ preventScroll: true });
    });
  }
  search.addEventListener("click", () => {
    if (!query.value.trim() || !from.checkValidity() || !to.checkValidity())
      return;
    const id = taskId;
    offset = 0;
    void act(() =>
      options.rpc("literature/search", {
        taskId: id,
        query: query.value,
        fromYear: from.value ? Number(from.value) : undefined,
        toYear: to.value ? Number(to.value) : undefined,
        openAccess: oa.checked,
        sort: sort.value,
      }),
    );
  });
  form.addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      search.click();
    }
  });
  filter.addEventListener("input", () => {
    offset = 0;
    void refresh().catch(message);
  });
  cancel.addEventListener(
    "click",
    () => void act(() => options.rpc("literature/cancel", { taskId })),
  );
  review.addEventListener("click", () => void showConfirmation());
  capsule.addEventListener("click", showPopup);
  close.addEventListener("click", () => {
    if (floating) hidePopup(true);
    else {
      const card = active();
      collapseInline();
      card?.view.focus({ preventScroll: true });
    }
  });
  locate.addEventListener("click", () => {
    hidePopup(false);
    const card = active();
    if (!card) return;
    const y =
      card.root.getBoundingClientRect().top -
      options.viewport.getBoundingClientRect().top;
    options.viewport.scrollTop += y - 16;
    (inlineId ? close : card.view).focus({ preventScroll: true });
    measure();
  });
  const outside = (e: Event) => {
    if (floating && !dock.contains(e.target as Node)) hidePopup(false);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.isComposing) return;
    if (floating) {
      e.preventDefault();
      e.stopPropagation();
      hidePopup(true);
    } else if (inlineId && editor.contains(doc.activeElement)) {
      e.preventDefault();
      e.stopPropagation();
      close.click();
    }
  };
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", key, true);
  options.viewport.addEventListener("scroll", scheduleMeasure, {
    passive: true,
  });
  win?.addEventListener("resize", scheduleMeasure);
  const observer = win?.ResizeObserver
    ? new win.ResizeObserver(scheduleMeasure)
    : undefined;
  observer?.observe(options.viewport);
  observer?.observe(dock);
  return {
    node: dock,
    get docked() {
      return !dock.hidden;
    },
    get floating() {
      return floating;
    },
    placeholder(q: Query) {
      if (!cards.has(q.id)) makeCard(q);
      const anchor = node(doc, "div");
      anchor.dataset.literatureAnchor = q.id;
      return anchor;
    },
    mount() {
      for (const anchor of Array.from(
        options.viewport.querySelectorAll("[data-literature-anchor]"),
      ) as HTMLElement[]) {
        const card = cards.get(anchor.dataset.literatureAnchor!);
        if (card && card.root.parentElement !== anchor)
          anchor.append(card.root);
        if (card) observer?.observe(card.root);
      }
      labels();
      scheduleMeasure();
    },
    update(id: string | undefined, value?: LiteratureSummary) {
      if (id !== taskId) {
        epoch++;
        request++;
        busy = false;
        hidePopup(false);
        collapseInline();
        for (const card of cards.values()) observer?.unobserve(card.root);
        cards.clear();
        taskId = id;
        summary = undefined;
        activeId = undefined;
        revision = -1;
        preview = [];
        offset = 0;
        selection = "auto";
        filter.value = query.value = from.value = to.value = "";
        oa.checked = false;
        sort.value = "relevance";
        refine.open = false;
        localFilter.open = false;
        endConfirmation();
        rows.replaceChildren();
        error.textContent = "";
        dock.hidden = true;
      }
      if (value && (!summary || value.revision >= summary.revision))
        summary = {
          ...value,
          latestQuery: value.latestQuery ?? summary?.latestQuery,
        };
      if (summary?.latestQuery && !cards.has(summary.latestQuery.id)) {
        makeCard(summary.latestQuery);
        if (!floating && !inlineId) activate(summary.latestQuery.id);
      }
      if (!activeId && summary?.latestQuery) activate(summary.latestQuery.id);
      if (summary && revision !== summary.revision && !busy) queueRefresh();
      labels();
      scheduleMeasure();
    },
    /** Old histories may predate search-anchor events. */
    fallbackQuery() {
      return summary?.latestQuery;
    },
    destroy() {
      disposed = true;
      epoch++;
      request++;
      observer?.disconnect();
      if (frame !== undefined) win?.cancelAnimationFrame(frame);
      win?.clearTimeout(refreshTimer);
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("keydown", key, true);
      options.viewport.removeEventListener("scroll", scheduleMeasure);
      win?.removeEventListener("resize", scheduleMeasure);
    },
  };
}
export function createOpenAlexSettings(doc: Document, rpc: Rpc) {
  const section = node(doc, "section");
  section.className = "confucius-literature-settings";
  section.append(node(doc, "h3", "OpenAlex"), node(doc, "p", text("key-help")));
  const input = node(doc, "input");
  input.type = "password";
  input.autocomplete = "new-password";
  input.placeholder = "OpenAlex API Key";
  input.setAttribute("aria-label", "OpenAlex API Key");
  const status = node(doc, "div");
  status.setAttribute("role", "status");
  const run = async (method: string, params?: Record<string, unknown>) => {
    try {
      const result = (await rpc(method, params)) as { hasKey: boolean };
      input.value = "";
      status.textContent = result.hasKey
        ? text("configured")
        : text("not-configured");
      if (method === "literature/test") status.textContent = text("connected");
    } catch (error) {
      status.textContent = String(
        error instanceof Error ? error.message : error,
      );
    }
  };
  section.append(input);
  for (const [label, method, key] of [
    ["save-key", "literature/configure", false],
    ["clear-key", "literature/configure", true],
    ["test-key", "literature/test", false],
  ] as const) {
    const button = createWorkspaceButton(doc, "", text(label));
    button.addEventListener("click", () => {
      void run(
        method,
        method === "literature/configure"
          ? { key: key ? "" : input.value }
          : undefined,
      );
    });
    section.append(button);
  }
  const link = node(doc, "a", text("get-key"));
  link.href = "https://openalex.org/settings/api";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    Zotero.launchURL(link.href);
  });
  section.append(link, status);
  void run("literature/config");
  return section;
}
