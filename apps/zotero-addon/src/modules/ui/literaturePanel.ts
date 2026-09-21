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

/** One task-wide pool and editor, anchored above the composer. */
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
  const capsuleLabel = node(doc, "span", text("capsule")),
    capsuleCount = node(doc, "span"),
    capsuleCopy = node(doc, "span");
  capsuleCopy.className = "confucius-literature-capsule-copy";
  capsuleCount.className = "confucius-literature-capsule-count";
  capsuleCopy.append(capsuleLabel, capsuleCount);
  const caret = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  caret.classList.add("confucius-literature-caret");
  caret.setAttribute("viewBox", "0 0 20 20");
  caret.setAttribute("aria-hidden", "true");
  caret.setAttribute("focusable", "false");
  const chevron = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  chevron.setAttribute("d", "m5 12 5-5 5 5");
  chevron.setAttribute("fill", "none");
  chevron.setAttribute("stroke", "currentColor");
  chevron.setAttribute("stroke-width", "1.6");
  chevron.setAttribute("stroke-linecap", "round");
  chevron.setAttribute("stroke-linejoin", "round");
  caret.append(chevron);
  capsule.append(researchIcon(doc, "search"), capsuleCopy, caret);
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
  const footerStatus = node(doc, "span");
  footerStatus.className = "confucius-literature-meta";
  const review = createWorkspaceButton(doc, "", text("review"), "primary");
  const cancel = createWorkspaceButton(doc, "", text("cancel-downloads"));
  const actions = node(doc, "div");
  actions.className = "confucius-literature-controls";
  actions.append(cancel, review);
  footer.append(footerStatus, actions);
  scroll.append(controls, count, rows, paging, confirmation);
  editor.append(header, tabs, error, scroll, footer);
  popup.append(editor);

  let taskId: string | undefined,
    summary: LiteratureSummary | undefined,
    activeQuery: Query | undefined;
  let floating = false,
    disposed = false;
  let epoch = 0,
    request = 0,
    revision = -1,
    busy = false,
    offset = 0;
  let selection: "auto" | "candidates" | "pool" = "auto";
  let proposal: LiteratureConfirmation | undefined;
  let savedScrollTop = 0;
  let refreshTimer: number | undefined, frame: number | undefined;
  const selected = () =>
    selection === "candidates" ||
    (selection === "auto" && (summary?.candidates ?? 0) > 0);
  function activate(q: Query) {
    if (activeQuery?.id === q.id) return;
    activeQuery = q;
    query.value = q.query;
    from.value = q.fromYear ? String(q.fromYear) : "";
    to.value = q.toYear ? String(q.toYear) : "";
    oa.checked = q.openAccess ?? false;
  }
  const message = (e: unknown) => {
    error.textContent = String(e instanceof Error ? e.message : e);
  };
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
    capsuleCount.textContent = `${summary?.candidates ?? 0} / ${summary?.pool ?? 0}`;
    const description = `${text("candidates")} ${summary?.candidates ?? 0} · ${text("retrieved")} ${summary?.pool ?? 0}`;
    capsule.title = `${description} · ${status()}`;
    capsule.setAttribute("aria-label", description);
    title.textContent = text("task-title");
    metadata.textContent = description;
    footerStatus.textContent = status();
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
    const viewport = options.viewport.getBoundingClientRect();
    dock.hidden =
      !taskId ||
      !summary ||
      !(summary.pool || summary.latestQuery || activeQuery);
    if (dock.hidden && floating) hidePopup(false);
    options.visibilityChanged();
    // The popup stays inside the workbench, even in a short Zotero sidebar.
    const bottom = capsule.getBoundingClientRect().top;
    popup.style.maxHeight = `${Math.max(100, bottom - Math.max(8, viewport.top) - 8)}px`;
  }
  function scheduleMeasure() {
    if (frame === undefined) frame = win?.requestAnimationFrame(measure);
  }
  function hidePopup(focus: boolean) {
    if (!floating) return;
    savedScrollTop = scroll.scrollTop;
    floating = false;
    popup.hidden = true;
    capsule.setAttribute("aria-expanded", "false");
    if (focus && !dock.hidden) capsule.focus({ preventScroll: true });
    labels();
  }
  function showPopup() {
    if (floating) {
      hidePopup(true);
      return;
    }
    popup.hidden = false;
    floating = true;
    capsule.setAttribute("aria-expanded", "true");
    labels();
    measure();
    scroll.scrollTop = savedScrollTop;
    close.focus({ preventScroll: true });
    void refresh().catch(message);
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
    const result = await (
      options.rpc("literature/list", params) as Promise<LiteraturePage>
    ).catch((e: unknown) => {
      if (taskId !== id || epoch !== era || stamp !== request || disposed)
        return undefined;
      throw e;
    });
    if (!result) return;
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
    if (!activeQuery && result.queries[0]) activate(result.queries[0]);
    labels();
    renderRows(result);
    scheduleMeasure();
  }
  function queueRefresh() {
    if (disposed || !floating || refreshTimer !== undefined) return;
    refreshTimer = win?.setTimeout(() => {
      refreshTimer = undefined;
      if (!busy && floating) void refresh().catch(message);
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
    savedScrollTop = scroll.scrollTop = 0;
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
    const y = floating ? scroll.scrollTop : savedScrollTop;
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
    savedScrollTop = y;
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
  close.addEventListener("click", () => hidePopup(true));
  const outside = (e: Event) => {
    if (floating && !dock.contains(e.target as Node)) hidePopup(false);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.isComposing) return;
    if (floating) {
      e.preventDefault();
      e.stopPropagation();
      hidePopup(true);
    }
  };
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", key, true);
  win?.addEventListener("resize", scheduleMeasure);
  const observer = win?.ResizeObserver
    ? new win.ResizeObserver(scheduleMeasure)
    : undefined;
  observer?.observe(options.viewport);
  observer?.observe(dock);
  return {
    node: dock,
    get visible() {
      return !dock.hidden;
    },
    get floating() {
      return floating;
    },
    close: () => hidePopup(false),
    update(id: string | undefined, value?: LiteratureSummary) {
      if (id !== taskId) {
        epoch++;
        request++;
        busy = false;
        hidePopup(false);
        taskId = id;
        summary = undefined;
        activeQuery = undefined;
        revision = -1;
        savedScrollTop = 0;
        offset = 0;
        selection = "auto";
        filter.value = query.value = from.value = to.value = "";
        oa.checked = false;
        sort.value = "relevance";
        refine.open = false;
        localFilter.open = false;
        endConfirmation();
        rows.replaceChildren();
        paging.replaceChildren();
        history.replaceChildren();
        error.textContent = "";
        dock.hidden = true;
      }
      if (value && (!summary || value.revision >= summary.revision))
        summary = {
          ...value,
          latestQuery: value.latestQuery ?? summary?.latestQuery,
        };
      if (summary?.latestQuery && !floating) activate(summary.latestQuery);
      if (summary && revision !== summary.revision && !busy) queueRefresh();
      labels();
      scheduleMeasure();
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
