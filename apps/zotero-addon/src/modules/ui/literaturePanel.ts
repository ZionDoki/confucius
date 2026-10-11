import type {
  LiteraturePage,
  LiteratureConfirmation,
  LiteratureSummary,
  LiteratureWork,
} from "@confucius/protocol";
import { createWorkspaceButton } from "./workspaceControls";
import { droppedFilePaths, hasDroppedFiles } from "./fileDrop";
import { createReviewPanel } from "./reviewPanel";
import type { ReviewEntry, ReviewPool, ReviewRow } from "./reviewModel";
import { getString } from "../../utils/locale";
import { createVenueRatingSettings, createVenueRatings } from "./venueRatings";

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

interface CandidateEntry extends ReviewEntry {
  work: LiteratureWork;
}

/** Domain actions plug into the same cards, list, selection and arrival UI as annotations. */
export function createLiteraturePanel(
  doc: Document,
  options: {
    rpc: Rpc;
    viewport: HTMLElement;
    anchor: HTMLElement;
    opened: () => void;
    changed: () => void;
    visibilityChanged: () => void;
  },
) {
  let taskId: string | undefined, summary: LiteratureSummary | undefined;
  let snapshot: LiteraturePage | undefined, activeQuery: Query | undefined;
  let epoch = 0,
    confirmationGeneration = 0;
  let busy = false,
    continuing = false,
    disposed = false;
  let proposal: LiteratureConfirmation | undefined;
  const abstractRequests = new Set<string>();
  const extraViews = new WeakMap<HTMLElement, string>();
  const tools = node(doc, "div");
  tools.className = "ar-tools";
  const refine = node(doc, "details");
  refine.className = "confucius-literature-refine";
  refine.append(node(doc, "summary", text("refine")));
  const form = node(doc, "div");
  form.className = "confucius-literature-controls";
  const query = node(doc, "input"),
    from = node(doc, "input"),
    to = node(doc, "input");
  query.placeholder = text("query");
  query.setAttribute("aria-label", text("query"));
  for (const [input, key] of [
    [from, "from"],
    [to, "to"],
  ] as const) {
    input.type = "number";
    input.min = "1000";
    input.max = "9999";
    input.placeholder = text(key);
    input.setAttribute("aria-label", text(key));
    input.className = "confucius-literature-year";
  }
  const oa = node(doc, "input"),
    oaLabel = node(doc, "label");
  oa.type = "checkbox";
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
  tools.append(refine);
  const ratingTools = node(doc, "details");
  ratingTools.className = "confucius-literature-refine";
  ratingTools.append(node(doc, "summary", text("ratings-manage")));
  const ratingSettings = createVenueRatingSettings(doc, options.rpc, {
    compact: true,
    changed: async () => {
      if (!disposed && taskId) await panel.refresh();
    },
  });
  ratingTools.append(ratingSettings.node);
  ratingTools.addEventListener("toggle", () => {
    if (ratingTools.open && !disposed) void ratingSettings.refresh();
  });
  tools.append(ratingTools);
  const confirmation = node(doc, "section");
  confirmation.className = "confucius-literature-confirmation";
  const footer = node(doc, "div");
  footer.className = "ar-domain-footer";
  const footerCopy = node(doc, "div"),
    footerStatus = node(doc, "span"),
    continueHelp = node(doc, "p");
  footerStatus.className = "confucius-literature-meta";
  continueHelp.className = "confucius-literature-meta ar-domain-help";
  continueHelp.id = "confucius-literature-continue-help";
  const proceed = createWorkspaceButton(
      doc,
      "confucius-literature-continue",
      "",
    ),
    review = createWorkspaceButton(
      doc,
      "confucius-literature-review",
      text("review"),
      "primary",
    ),
    cancel = createWorkspaceButton(doc, "", text("cancel-downloads"));
  proceed.setAttribute("aria-describedby", continueHelp.id);
  const actions = node(doc, "div");
  actions.className = "confucius-literature-controls";
  actions.append(cancel, proceed, review);
  footerCopy.append(footerStatus, continueHelp);
  footer.append(footerCopy, actions);
  const continuationMode = () =>
    summary?.hasCandidateChanges || summary?.awaitingConfirmation
      ? ("abstracts" as const)
      : ("current" as const);
  const statusText = () =>
    summary?.acquiring
      ? `${text("downloading")} ${summary.acquiring}`
      : summary?.hasCandidateChanges || summary?.awaitingConfirmation
        ? text("draft")
        : summary?.continuation
          ? text("continued")
          : summary?.pendingFulltext
            ? `${text("missing")} ${summary.pendingFulltext}`
            : summary?.available
              ? `${text("fulltext")} ${summary.available}`
              : text("found");
  const description = () =>
    `${text("candidates")} ${summary?.candidates ?? 0} · ${text("pool")} ${summary?.pool ?? 0}`;
  const reviewText = (key: string) => {
    const overrides: Record<string, string> = {
      title: "task-title",
      capsule: "capsule",
      search: "filter",
      empty: "empty-results",
      "all-batches": "all-searches",
      batch: "search-batch",
      batches: "searches",
      pending: "not-evaluated",
      accepted: "candidates",
      rejected: "excluded",
      all: "pool",
      accept: "include",
      reject: "exclude",
      restore: "include",
      restored: "candidates",
      writing: "saving-choice",
      "saving-minimized": "saving-choice",
      "to-review": "not-evaluated",
      source: "open-source",
    };
    return overrides[key]
      ? text(overrides[key])
      : getString(`workspace-annotations-${key}`);
  };
  function normalize(value: LiteraturePage): ReviewPool<CandidateEntry> {
    const batches = value.queries
      .slice()
      .reverse()
      .map((q) => ({
        id: q.id,
        title: q.query,
        createdAt: q.createdAt,
        entries: [] as CandidateEntry[],
      }));
    const byId = new Map(batches.map((b) => [b.id, b]));
    for (const work of value.items) {
      const id = work.queryIds[0] ?? "pool";
      let batch = byId.get(id);
      if (!batch) {
        batch = { id, title: text("pool"), createdAt: 0, entries: [] };
        batches.push(batch);
        byId.set(id, batch);
      }
      batch.entries.push({
        id: work.id,
        quote: work.title,
        comment: work.decision.reason ?? text("not-evaluated"),
        status: work.decision.selected
          ? "accepted"
          : work.decision.evaluated
            ? "rejected"
            : "pending",
        searchText: [
          work.abstract,
          ...work.authors,
          work.venue,
          work.year,
        ].join(" "),
        work,
      });
    }
    return {
      taskId: value.summary.id,
      revision: value.summary.revision,
      metadataKey: JSON.stringify(
        value.items.map((work) => [
          work.id,
          work.venueRatings,
          work.venueRatingStatus,
        ]),
      ),
      batches,
    };
  }
  async function load(id: string): Promise<ReviewPool<CandidateEntry>> {
    const era = epoch;
    const value = (await options.rpc("literature/review/list", {
      taskId: id,
    })) as LiteraturePage;
    if (disposed || epoch !== era || taskId !== id) return normalize(value);
    if (snapshot && value.summary.revision < snapshot.summary.revision)
      return normalize(snapshot);
    snapshot = value;
    if (!summary || value.summary.revision >= summary.revision)
      summary = value.summary;
    if (
      summary?.latestQuery &&
      activeQuery?.id !== summary.latestQuery.id &&
      !refine.open
    ) {
      activeQuery = summary.latestQuery;
      query.value = activeQuery.query;
      from.value = activeQuery.fromYear ? String(activeQuery.fromYear) : "";
      to.value = activeQuery.toYear ? String(activeQuery.toYear) : "";
      oa.checked = activeQuery.openAccess ?? false;
    }
    renderQueries(value);
    return normalize(value);
  }
  const panel = createReviewPanel<CandidateEntry>(doc, {
    kind: "literature",
    viewport: options.viewport,
    anchor: options.anchor,
    opened: options.opened,
    visibilityChanged: options.visibilityChanged,
    load,
    text: reviewText,
    tools,
    footer,
    model: { defaultStatus: "all", completion: false, selectable: () => true },
    allowed: (action, row) =>
      action === "accept"
        ? row.entry.status === "pending"
        : action === "reject"
          ? row.entry.status !== "rejected"
          : row.entry.status === "rejected",
    restoredStatus: "accepted",
    busy: () => busy || continuing,
    visible: () => !!summary && !!(summary.pool || summary.latestQuery),
    capsuleCount: () => `${summary?.candidates ?? 0} / ${summary?.pool ?? 0}`,
    summary: description,
    batch: (batch) => batch.title,
    source: () => text("open-source"),
    type: (row) =>
      [row.entry.work.year, row.entry.work.authors.slice(0, 2).join(", ")]
        .filter(Boolean)
        .join(" · "),
    renderEntry,
    renderMetadata,
    rendered: (state) => labels(state.busy),
    locate: async (row) => {
      const work = row.entry.work;
      if (work.acquisition.item)
        return options.rpc("reader/open", {
          libraryID: work.acquisition.item.libraryID,
          key: work.acquisition.attachmentKey ?? work.acquisition.item.key,
          selectItem: !work.acquisition.attachmentKey,
        });
      const url =
        work.landingUrl ??
        (work.doi ? `https://doi.org/${work.doi}` : undefined);
      if (url) Zotero.launchURL(url);
      return undefined;
    },
    decide: async (id, action, rows) => {
      const revision = snapshot?.summary.candidateRevision;
      if (revision === undefined) throw new Error(text("stale"));
      const era = epoch;
      await options.rpc("literature/updateCandidates", {
        taskId: id,
        candidateRevision: revision,
        changes: rows.map((row) => ({
          id: row.entry.id,
          selected: action !== "reject",
          reason: text("user-choice"),
        })),
      });
      const value = await load(id);
      if (epoch === era && !disposed) options.changed();
      return value;
    },
  });
  panel.node.querySelector<HTMLElement>(".ar-capsule")!.id =
    "confucius-literature-capsule";
  const popup = panel.node.querySelector<HTMLElement>(".ar-popup")!;
  popup.id = "confucius-literature-popup";
  panel.node
    .querySelector(".ar-capsule")!
    .setAttribute("aria-controls", popup.id);
  const collapse = popup.querySelector<HTMLButtonElement>(
    ".ar-header > button",
  )!;
  function message(e: unknown) {
    panel.setError(String(e instanceof Error ? e.message : e));
  }
  function labels(locked = busy || continuing) {
    cancel.hidden = !summary?.acquiring;
    footerStatus.textContent = `${statusText()} · ${text("fulltext-count")} ${Math.max(0, (summary?.candidates ?? 0) - (summary?.pendingFulltext ?? 0))} / ${summary?.candidates ?? 0} · ${text("abstracts")} ${summary?.abstracts ?? 0} / ${summary?.candidates ?? 0}`;
    proceed.hidden =
      !!summary?.continuation ||
      !(
        summary?.awaitingConfirmation ||
        summary?.awaitingFulltext ||
        ((summary?.candidates ?? 0) > 0 &&
          (summary?.hasCandidateChanges || summary?.pendingFulltext))
      );
    proceed.textContent = text(
      continuationMode() === "abstracts"
        ? "continue-abstracts"
        : "continue-current",
    );
    proceed.dataset.variant =
      continuationMode() === "current" ? "primary" : "quiet";
    // Continue must stay usable during retrieval, retries and PDF imports.
    proceed.disabled =
      continuing ||
      (!!proposal && proposal.candidateRevision !== summary?.candidateRevision);
    const help = text(
      continuationMode() === "abstracts"
        ? "continue-abstracts-help"
        : "continue-current-help",
    );
    proceed.title = continuing
      ? text("continuing")
      : proceed.disabled
        ? text("stale")
        : help;
    continueHelp.textContent = help;
    continueHelp.hidden = proceed.hidden;
    review.hidden =
      !!proposal ||
      (!summary?.hasCandidateChanges &&
        !summary?.awaitingConfirmation &&
        !(
          summary?.continuation &&
          summary.pendingFulltext &&
          !summary.acquiring
        ));
    const accepted =
      !!summary?.continuation &&
      !summary.hasCandidateChanges &&
      !summary.awaitingConfirmation;
    review.textContent = text(accepted ? "acquire-later" : "review");
    review.dataset.variant = accepted ? "link" : "primary";
    review.disabled = cancel.disabled = search.disabled = locked;
    const apply =
      confirmation.querySelector<HTMLButtonElement>("[data-confirm]");
    if (apply)
      apply.disabled =
        locked || proposal?.candidateRevision !== summary?.candidateRevision;
    const warning = confirmation.querySelector<HTMLElement>("[data-stale]");
    if (warning)
      warning.hidden =
        proposal?.candidateRevision === summary?.candidateRevision;
  }
  async function act(work: () => Promise<unknown>) {
    if (busy || continuing || !taskId || disposed) return;
    const era = epoch;
    busy = true;
    panel.setError("");
    panel.render();
    try {
      await work();
      if (epoch !== era || disposed) return;
      await panel.refresh();
      if (epoch === era && !disposed) options.changed();
    } catch (e) {
      if (epoch === era && !disposed) {
        message(e);
        await panel.refresh();
      }
    } finally {
      if (epoch === era && !disposed) {
        busy = false;
        panel.render();
      }
    }
  }
  function endConfirmation() {
    proposal = undefined;
    confirmationGeneration++;
    panel.setContent();
  }
  async function continueResearch() {
    if (!taskId || !summary || continuing || proceed.disabled) return;
    const id = taskId,
      era = epoch,
      focused = doc.activeElement;
    const candidateRevision =
      proposal?.candidateRevision ?? summary.candidateRevision;
    confirmationGeneration++;
    continuing = true;
    panel.setError("");
    panel.render();
    try {
      await options.rpc("literature/continue", {
        taskId: id,
        candidateRevision,
        mode: continuationMode(),
      });
      if (epoch !== era || disposed) return;
      endConfirmation();
      await panel.refresh();
      if (epoch !== era || disposed) return;
      if (
        panel.floating &&
        doc.activeElement === focused &&
        popup.contains(focused)
      )
        collapse.focus({ preventScroll: true });
      options.changed();
    } catch (e) {
      if (epoch === era && !disposed) {
        message(e);
        await panel.refresh();
      }
    } finally {
      if (epoch === era && !disposed) {
        continuing = false;
        panel.render();
      }
    }
  }
  async function showConfirmation() {
    if (busy || continuing || !taskId) return;
    const id = taskId,
      era = epoch,
      generation = ++confirmationGeneration;
    await act(async () => {
      const value = (await options.rpc("literature/preview", {
        taskId: id,
      })) as LiteratureConfirmation;
      if (epoch !== era || disposed || generation !== confirmationGeneration)
        return;
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
      if (epoch !== era || disposed || generation !== confirmationGeneration)
        return;
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
      for (const [key, ids] of [
        ["added", value.added],
        ["removed", value.removed],
        ["acquire", value.acquire],
      ] as const) {
        if (!ids.length) continue;
        const list = node(doc, "ul");
        list.setAttribute("aria-label", text(key));
        for (const workId of ids)
          list.append(
            node(
              doc,
              "li",
              works.find((w) => w.id === workId)?.title ?? workId,
            ),
          );
        const group = node(doc, "details");
        group.open = key === "added";
        group.append(
          node(doc, "summary", `${text(key)} · ${ids.length}`),
          list,
        );
        confirmation.append(group);
      }
      const warning = node(doc, "p", text("stale"));
      warning.dataset.stale = "true";
      warning.hidden = true;
      const apply = createWorkspaceButton(doc, "", text("confirm"), "primary"),
        back = createWorkspaceButton(doc, "", text("dismiss"));
      apply.dataset.confirm = "true";
      apply.addEventListener("click", () => {
        if (epoch !== era || disposed || generation !== confirmationGeneration)
          return;
        void act(async () => {
          await options.rpc("literature/confirm", {
            taskId: id,
            candidateRevision: value.candidateRevision,
          });
          if (epoch === era && generation === confirmationGeneration)
            endConfirmation();
        });
      });
      back.addEventListener("click", endConfirmation);
      const controls = node(doc, "div");
      controls.className = "confucius-literature-controls";
      controls.append(back, apply);
      confirmation.append(warning, controls);
      panel.setContent(confirmation);
      apply.focus({ preventScroll: true });
    });
  }
  function renderQueries(value: LiteraturePage) {
    // Preserve the query editor and its draft while only replacing saved query metadata.
    const signature = JSON.stringify(value.queries);
    if (history.dataset.signature === signature) return;
    history.dataset.signature = signature;
    history.replaceChildren();
    const id = taskId,
      era = epoch;
    for (const saved of value.queries) {
      const line = node(doc, "div");
      line.className = "confucius-literature-query";
      line.append(
        node(doc, "span", `${saved.query} · ${text("total")} ${saved.total}`),
      );
      if (saved.cursor) {
        const more = createWorkspaceButton(doc, "", text("more"));
        more.addEventListener("click", () => {
          if (epoch === era)
            void act(() =>
              options.rpc("literature/search", {
                taskId: id,
                query: saved.query,
                queryId: saved.id,
              }),
            );
        });
        line.append(more);
      }
      history.append(line);
    }
  }
  function renderMetadata(target: HTMLElement, row: ReviewRow<CandidateEntry>) {
    const work = row.entry.work;
    const signature = JSON.stringify([
      work.venue,
      work.citedBy,
      work.venueRatings?.map((rating) => [
        rating.system,
        rating.year,
        rating.rank,
        rating.source.name,
        rating.source.url,
        rating.source.filename,
      ]),
      work.venueRatingStatus,
    ]);
    if (extraViews.get(target) === signature) return;
    extraViews.set(target, signature);
    const focused =
      target.dataset.workId === work.id && target.contains(doc.activeElement)
        ? (doc.activeElement as HTMLElement).dataset.action
        : undefined;
    target.dataset.workId = work.id;
    const info = node(
      doc,
      "p",
      [work.venue, `${text("citations")} ${work.citedBy}`]
        .filter(Boolean)
        .join(" · "),
    );
    info.className = "confucius-literature-meta";
    target.replaceChildren(
      info,
      createVenueRatings(doc, work, false, "summary"),
    );
    if (focused)
      target
        .querySelector<HTMLElement>(`[data-action="${focused}"]`)
        ?.focus({ preventScroll: true });
  }
  function renderEntry(
    target: HTMLElement,
    row: ReviewRow<CandidateEntry>,
    view: "card" | "list",
  ) {
    const work = row.entry.work,
      id = taskId,
      era = epoch;
    const signature = JSON.stringify([work, abstractRequests.has(work.id)]);
    // Stable content retains focus, expanded abstracts, and internal scroll on receipts.
    if (extraViews.get(target) === signature) return;
    extraViews.set(target, signature);
    const same = target.dataset.workId === work.id;
    const opened = target.querySelector<HTMLDetailsElement>(
      ".confucius-literature-abstract",
    )?.open;
    const ratingsOpened = target.querySelector<HTMLDetailsElement>(
      ".confucius-venue-rating-details",
    )?.open;
    const focused = target.contains(doc.activeElement)
      ? (doc.activeElement as HTMLElement).dataset.action
      : undefined;
    target.dataset.workId = work.id;
    target.replaceChildren();
    const current = () => epoch === era && !disposed && taskId === id;
    target.append(
      createVenueRatings(doc, work, same && !!ratingsOpened, "details"),
    );
    const details = node(doc, "details");
    details.className = "confucius-literature-abstract";
    details.open = same ? !!opened : view === "card";
    details.append(
      node(doc, "summary", text("abstract")),
      node(
        doc,
        "p",
        work.abstract ??
          text(
            work.abstractLookup?.status === "unavailable"
              ? "abstract-unavailable"
              : work.abstractLookup?.status === "missing"
                ? "abstract-missing"
                : "no-abstract",
          ),
      ),
    );
    if (work.abstract && work.abstractLookup?.source)
      details.append(
        node(
          doc,
          "p",
          `${text("abstract-source")} · ${work.abstractLookup.source}`,
        ),
      );
    if (!work.abstract) {
      const fetching = abstractRequests.has(work.id),
        lookup = createWorkspaceButton(
          doc,
          "",
          text(fetching ? "abstract-loading" : "abstract-fetch"),
        );
      lookup.dataset.action = "abstract";
      lookup.disabled =
        fetching ||
        !!(
          work.abstractLookup &&
          Date.now() - work.abstractLookup.checkedAt < 300_000
        );
      lookup.title = fetching
        ? text("abstract-loading")
        : lookup.disabled
          ? text("abstract-cooldown")
          : "";
      lookup.addEventListener("click", async () => {
        if (!current() || lookup.disabled) return;
        abstractRequests.add(work.id);
        lookup.disabled = true;
        lookup.textContent = text("abstract-loading");
        try {
          await options.rpc("literature/abstract", { taskId: id, id: work.id });
        } catch (e) {
          if (current()) message(e);
        } finally {
          if (current()) {
            abstractRequests.delete(work.id);
            await panel.refresh();
          }
        }
      });
      details.append(lookup);
    }
    target.append(details);
    if (work.acquisition.status !== "missing") {
      const state = node(
        doc,
        "p",
        `${work.acquisition.status === "available" && work.acquisition.version ? text(`version-${work.acquisition.version}`) : text(work.acquisition.status)}${work.acquisition.error ? ` · ${text(`error-${work.acquisition.error}`)}` : ""}`,
      );
      state.className = "confucius-literature-meta";
      target.append(state);
    }
    if (work.acquisition.sourceUrl) {
      const source = node(doc, "a", text("fulltext-source"));
      source.href = work.acquisition.sourceUrl;
      source.title = work.acquisition.sourceUrl;
      source.addEventListener("click", (e) => {
        e.preventDefault();
        Zotero.launchURL(source.href);
      });
      target.append(source);
    }
    if (work.acquisition.message)
      target.append(node(doc, "p", work.acquisition.message));
    if (
      work.acquisition.status === "failed" ||
      (work.acquisition.item && work.acquisition.status !== "available")
    ) {
      const controls = node(doc, "div");
      controls.className = "confucius-literature-controls";
      const retry = createWorkspaceButton(doc, "", text("retry"));
      retry.dataset.action = "retry";
      retry.disabled = ["downloading", "queued"].includes(
        work.acquisition.status,
      );
      retry.addEventListener("click", () => {
        if (current())
          void act(() =>
            options.rpc("literature/retry", { taskId: id, id: work.id }),
          );
      });
      if (work.acquisition.item) {
        const browser = createWorkspaceButton(doc, "", text("browser"));
        browser.dataset.action = "browser";
        browser.disabled = !work.landingUrl;
        browser.addEventListener("click", () => {
          if (current())
            void act(() =>
              options.rpc("literature/browser", { taskId: id, id: work.id }),
            );
        });
        controls.append(browser);
        const drop = node(doc, "div", text("drop"));
        drop.className = "confucius-literature-drop";
        drop.setAttribute("aria-label", `${text("drop")}: ${work.title}`);
        const over = (e: Event) => {
          const transfer = (e as DragEvent).dataTransfer;
          if (!hasDroppedFiles(transfer)) return;
          e.preventDefault();
          e.stopPropagation();
          if (transfer) transfer.dropEffect = "copy";
          drop.dataset.over = "true";
        };
        drop.addEventListener("dragenter", over);
        drop.addEventListener("dragover", over);
        drop.addEventListener("dragleave", () => delete drop.dataset.over);
        drop.addEventListener("drop", (e) => {
          if (!hasDroppedFiles((e as DragEvent).dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          delete drop.dataset.over;
          if (!current()) return;
          const paths = droppedFilePaths((e as DragEvent).dataTransfer);
          if (paths.length !== 1) {
            panel.setError(text("drop-one"));
            return;
          }
          void act(() =>
            options.rpc("literature/attach", {
              taskId: id,
              id: work.id,
              path: paths[0],
            }),
          );
        });
        target.append(drop);
      }
      controls.append(retry);
      target.append(controls);
    }
    if (same && focused)
      target
        .querySelector<HTMLElement>(`[data-action="${focused}"]`)
        ?.focus({ preventScroll: true });
  }
  search.addEventListener("click", () => {
    if (!query.value.trim() || !from.checkValidity() || !to.checkValidity())
      return;
    const id = taskId;
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
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      e.stopPropagation();
      search.click();
    }
  });
  cancel.addEventListener(
    "click",
    () => void act(() => options.rpc("literature/cancel", { taskId })),
  );
  review.addEventListener("click", () => void showConfirmation());
  proceed.addEventListener("click", () => void continueResearch());
  return {
    node: panel.node,
    get visible() {
      return panel.visible;
    },
    get floating() {
      return panel.floating;
    },
    close: panel.close,
    refresh: (entryIds: readonly string[] = []) => panel.refresh([], entryIds),
    update(id: string | undefined, value?: LiteratureSummary) {
      const changedTask = taskId !== id;
      if (changedTask) {
        epoch++;
        confirmationGeneration++;
        taskId = id;
        summary = undefined;
        snapshot = undefined;
        activeQuery = undefined;
        proposal = undefined;
        busy = continuing = false;
        abstractRequests.clear();
        query.value = from.value = to.value = "";
        oa.checked = false;
        sort.value = "relevance";
        refine.open = false;
        ratingTools.open = false;
        history.replaceChildren();
        delete history.dataset.signature;
        confirmation.replaceChildren();
      }
      if (value && (!summary || value.revision >= summary.revision))
        summary = {
          ...value,
          latestQuery: value.latestQuery ?? summary?.latestQuery,
        };
      panel.update(id);
      if (
        !changedTask &&
        summary &&
        summary.revision !== snapshot?.summary.revision
      )
        void panel.refresh();
      panel.render();
    },
    destroy() {
      disposed = true;
      epoch++;
      confirmationGeneration++;
      panel.destroy();
    },
  };
}
export function createOpenAlexSettings(doc: Document, rpc: Rpc) {
  const container = node(doc, "div");
  const ratings = createVenueRatingSettings(doc, rpc);
  container.append(
    createLiteratureKeySettings(doc, rpc, "openalex"),
    createLiteratureKeySettings(doc, rpc, "tavily"),
    ratings.node,
  );
  void ratings.refresh();
  return container;
}
function createLiteratureKeySettings(
  doc: Document,
  rpc: Rpc,
  provider: "openalex" | "tavily",
) {
  const name = provider === "tavily" ? "Tavily" : "OpenAlex";
  const section = node(doc, "section");
  section.className = "confucius-literature-settings";
  const help = node(
    doc,
    "p",
    text(provider === "tavily" ? "tavily-key-help" : "key-help"),
  );
  help.className = "confucius-settings-help";
  help.dataset.confuciusL10n = `workspace-literature-${provider === "tavily" ? "tavily-key-help" : "key-help"}`;
  section.append(node(doc, "h3", name), help);
  const input = node(doc, "input");
  input.type = "password";
  input.autocomplete = "new-password";
  input.placeholder = `${name} API Key`;
  input.setAttribute("aria-label", `${name} API Key`);
  const status = node(doc, "div");
  status.setAttribute("role", "status");
  const buttons: HTMLButtonElement[] = [];
  let busy = false;
  const run = async (method: string, params?: Record<string, unknown>) => {
    if (busy) return;
    busy = true;
    section.setAttribute("aria-busy", "true");
    for (const button of buttons) button.disabled = true;
    input.disabled = method !== "literature/config";
    try {
      const result = (await rpc(method, { ...params, provider })) as {
        hasKey: boolean;
      };
      if (!section.isConnected) return;
      if (method === "literature/configure") input.value = "";
      const key =
        method === "literature/test"
          ? "connected"
          : result.hasKey
            ? "configured"
            : "not-configured";
      status.dataset.confuciusL10n = `workspace-literature-${key}`;
      status.textContent = text(key);
    } catch (error) {
      delete status.dataset.confuciusL10n;
      status.textContent = String(
        error instanceof Error ? error.message : error,
      );
    } finally {
      busy = false;
      section.removeAttribute("aria-busy");
      input.disabled = false;
      for (const button of buttons) button.disabled = false;
    }
  };
  section.append(input);
  const actions = node(doc, "div");
  actions.className = "confucius-settings-actions";
  for (const [label, method, key] of [
    ["save-key", "literature/configure", false],
    ["clear-key", "literature/configure", true],
    ["test-key", "literature/test", false],
  ] as const) {
    const button = createWorkspaceButton(doc, "", text(label));
    button.dataset.confuciusL10n = `workspace-literature-${label}`;
    buttons.push(button);
    button.addEventListener("click", () => {
      void run(
        method,
        method === "literature/configure"
          ? { key: key ? "" : input.value }
          : undefined,
      );
    });
    actions.append(button);
  }
  section.append(actions);
  const link = node(
    doc,
    "a",
    text(provider === "tavily" ? "get-tavily-key" : "get-key"),
  );
  link.dataset.confuciusL10n = `workspace-literature-${provider === "tavily" ? "get-tavily-key" : "get-key"}`;
  link.href =
    provider === "tavily"
      ? "https://app.tavily.com/"
      : "https://openalex.org/settings/api";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    Zotero.launchURL(link.href);
  });
  section.append(link, status);
  void run("literature/config");
  return section;
}
