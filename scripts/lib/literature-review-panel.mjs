import { build } from "esbuild";
import { join } from "node:path";

/** Exercise the candidate adapter and shared review interactions in actual Gecko. */
export async function literatureReviewPanelRegressions(root, ui) {
  const bundle = await build({
    entryPoints: [
      join(root, "apps/zotero-addon/src/modules/ui/literaturePanel.ts"),
    ],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "candidatePanelFixture",
    banner: { js: "var addon = Zotero.Confucius;" },
  });
  return ui(
    `${bundle.outputFiles[0].text}\nreturn (${regressions.toString()})(d, candidatePanelFixture.createLiteraturePanel);`,
  );
}
async function regressions(doc, createPanel) {
  const win = doc.defaultView,
    checks = [],
    clone = (value) => JSON.parse(JSON.stringify(value));
  const tick = () => new Promise((resolve) => win.setTimeout(resolve, 0));
  const check = (name, value, details) => {
    if (!value) throw new Error(`${name}: ${JSON.stringify(details ?? "")}`);
    checks.push(name);
  };
  const work = (id) => ({
    id,
    openAlexIds: [id],
    title: `Paper ${id}`,
    authors: ["Author 中文"],
    year: 2026,
    abstract: "Evidence and limitations. ".repeat(90),
    citedBy: 3,
    openAccess: true,
    landingUrl: "https://example.org/paper",
    pdfUrls: [],
    locations: [],
    queryIds: ["query"],
    decision: {
      selected: false,
      evaluated: false,
      actor: "agent",
      revision: 0,
    },
    acquisition: { status: "missing" },
  });
  const page = (id, count) => ({
    summary: {
      id,
      revision: 1,
      candidateRevision: 0,
      pool: count,
      evaluated: 0,
      candidates: 0,
      pendingFulltext: 0,
      available: 0,
      read: 0,
      awaitingConfirmation: false,
      latestQuery: {
        id: "query",
        query: "Evidence",
        createdAt: 1,
        total: count,
      },
    },
    queries: [
      {
        id: "query",
        query: "Evidence",
        createdAt: 1,
        total: count,
        pages: 1,
        cursor: null,
      },
    ],
    items: Array.from({ length: count }, (_, index) => work(`W${index}`)),
    total: count,
    nextOffset: null,
  });
  const pages = {
    nine: page("nine", 9),
    ten: page("ten", 10),
    eleven: page("eleven", 11),
  };
  const calls = [],
    wrapper = doc.createElementNS("http://www.w3.org/1999/xhtml", "div"),
    anchor = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  wrapper.style.cssText =
    "position:fixed;inset:8px;z-index:99999;background:var(--confucius-paper)";
  anchor.style.cssText =
    "position:absolute;bottom:0;left:0;right:0;min-height:34px";
  wrapper.append(anchor);
  doc.body.append(wrapper);
  let nextRead, abstractLookup;
  const panel = createPanel(doc, {
    viewport: wrapper,
    anchor,
    opened() {},
    changed() {},
    visibilityChanged() {},
    rpc: async (method, params) => {
      calls.push({ method, params });
      const p = pages[params.taskId];
      if (method === "literature/review/list") {
        if (nextRead) {
          const pending = nextRead;
          nextRead = undefined;
          return pending;
        }
        return clone(p);
      }
      if (method === "literature/updateCandidates") {
        if (params.candidateRevision !== p.summary.candidateRevision)
          throw new Error("Stale candidate selection");
        p.summary.candidateRevision++;
        p.summary.revision++;
        for (const change of params.changes)
          Object.assign(p.items.find((w) => w.id === change.id).decision, {
            selected: change.selected,
            evaluated: true,
            actor: "user",
            revision: p.summary.candidateRevision,
            reason: change.reason,
          });
        p.summary.candidates = p.items.filter(
          (w) => w.decision.selected,
        ).length;
        p.summary.pendingFulltext = p.summary.candidates;
        p.summary.hasCandidateChanges = true;
        return clone(p);
      }
      if (method === "literature/preview")
        return {
          candidateRevision: p.summary.candidateRevision,
          added: p.items.filter((w) => w.decision.selected).map((w) => w.id),
          removed: [],
          acquire: [],
        };
      if (method === "literature/get")
        return clone(p.items.find((w) => w.id === params.id));
      if (method === "literature/confirm" || method === "literature/continue") {
        if (params.candidateRevision !== p.summary.candidateRevision)
          throw new Error("Stale confirmation");
        p.summary.revision++;
        p.summary.hasCandidateChanges = false;
        return clone(p);
      }
      if (method === "literature/abstract") return abstractLookup;
      if (
        [
          "literature/retry",
          "literature/browser",
          "literature/attach",
          "literature/search",
          "reader/open",
        ].includes(method)
      )
        return {};
      throw new Error(`Unexpected candidate RPC: ${method}`);
    },
  });
  anchor.append(panel.node);
  const root = panel.node,
    $ = (selector) => root.querySelector(selector);
  const visibleRows = () =>
    [...root.querySelectorAll(".ar-list-row")].filter(
      (r) => !r.hidden && !r.parentElement.hidden,
    );
  const show = () => {
    if (!panel.floating) $(".ar-capsule").click();
  };
  try {
    for (const [id, count] of [
      ["nine", 9],
      ["ten", 10],
      ["eleven", 11],
    ]) {
      panel.update(id, pages[id].summary);
      await panel.refresh();
      await tick();
      check(
        `${count} papers choose the shared default view`,
        root.dataset.view === (count < 10 ? "card" : "list"),
      );
      check(`${count} historical papers do not auto-open`, !panel.floating);
    }
    panel.update("nine", pages.nine.summary);
    await panel.refresh();
    const focus = doc.getElementById("confucius-prompt");
    focus.focus();
    focus.dispatchEvent(
      new win.CompositionEvent("compositionstart", { bubbles: true }),
    );
    await panel.refresh(); // A history read remains quiet.
    check(
      "history leaves the composer focused",
      !panel.floating && doc.activeElement === focus,
    );
    await panel.refresh(pages.nine.items.map((w) => w.id));
    await tick();
    check(
      "first live candidates open cards without taking composition focus",
      panel.floating &&
        doc.activeElement === focus &&
        root.dataset.view === "card",
      {
        open: panel.floating,
        focus: doc.activeElement?.id,
        mode: root.dataset.view,
        error: $(".ar-error").textContent,
      },
    );
    focus.dispatchEvent(
      new win.CompositionEvent("compositionend", { bubbles: true }),
    );
    check(
      "candidates use the shared paper stack and navigation",
      !!$(".ar-paper") && !!$(".ar-card-next"),
    );
    const paper = $(".ar-paper"),
      cardArea = $(".ar-card-area"),
      scope = $(".ar-scope-row");
    check(
      "candidate card fills the remaining height",
      Math.abs(
        paper.getBoundingClientRect().bottom -
          cardArea.getBoundingClientRect().bottom,
      ) < 16 &&
        paper.getBoundingClientRect().height >=
          cardArea.getBoundingClientRect().height -
            scope.getBoundingClientRect().height -
            20,
    );
    $(".ar-card-next").click();
    check(
      "candidate edge click advances the shared slider",
      $(".ar-range").value === "2",
    );
    const body = $(".ar-card-body"),
      position = $(".ar-range").value;
    check(
      "long abstracts scroll inside the card",
      body.clientHeight >= 48 && body.scrollHeight > body.clientHeight,
    );
    body.dispatchEvent(
      new win.WheelEvent("wheel", {
        deltaY: 100,
        bubbles: true,
        cancelable: true,
      }),
    );
    check(
      "scrolling an abstract does not flip the card",
      $(".ar-range").value === position,
    );
    const accept = [
      ...$(".ar-card-footer .ar-actions").querySelectorAll("button"),
    ].find((b) => b.dataset.variant === "primary");
    accept.click();
    await tick();
    await tick();
    check(
      "card inclusion saves a versioned user choice",
      pages.nine.items[1].decision.selected &&
        calls.some(
          (c) =>
            c.method === "literature/updateCandidates" &&
            c.params.candidateRevision === 0,
        ),
    );
    check(
      "inclusion does not import or confirm papers",
      !calls.some((c) => c.method === "literature/confirm"),
    );
    const range = $(".ar-range");
    range.value = "2";
    range.dispatchEvent(new win.Event("input", { bubbles: true }));
    $(".ar-card-footer .ar-actions button:first-child").click();
    await tick();
    await tick();
    check(
      "included papers remain removable in the shared card",
      !pages.nine.items[1].decision.selected &&
        pages.nine.items[1].decision.evaluated,
    );
    range.value = "2";
    range.dispatchEvent(new win.Event("input", { bubbles: true }));
    $(".ar-card-footer .ar-actions button:nth-child(3)").click();
    await tick();
    await tick();
    check(
      "excluded papers can be restored to candidates",
      pages.nine.items[1].decision.selected,
    );
    $(".ar-view-switch button:last-child").click();
    const query = $(".ar-search");
    query.dispatchEvent(
      new win.CompositionEvent("compositionstart", { bubbles: true }),
    );
    query.value = "中文";
    query.dispatchEvent(
      new win.InputEvent("input", { bubbles: true, isComposing: true }),
    );
    check(
      "candidate local filtering waits for IME",
      visibleRows().length === 9,
    );
    query.dispatchEvent(
      new win.CompositionEvent("compositionend", { bubbles: true }),
    );
    check(
      "candidate local filter includes source authors",
      visibleRows().length === 9 && query.value === "中文",
    );
    const firstCheck = visibleRows()[0].querySelector("input");
    firstCheck.checked = true;
    firstCheck.dispatchEvent(new win.Event("change", { bubbles: true }));
    const selectedBefore = [
      ...root.querySelectorAll(".ar-list-row input:checked"),
    ].length;
    $(".ar-capsule").click();
    for (const id of ["W9", "W10"]) pages.nine.items.push(work(id));
    pages.nine.summary.pool = pages.nine.total = 11;
    pages.nine.summary.revision++;
    await panel.refresh(["W9", "W10"]);
    check(
      "later candidates preserve minimized state and manual list choice",
      !panel.floating && root.dataset.view === "list",
    );
    check(
      "same-search arrivals keep the current filter and selection snapshot",
      query.value === "中文" &&
        [...root.querySelectorAll(".ar-list-row input:checked")].length ===
          selectedBefore,
    );
    const animations = $(".ar-capsule")
      .getAnimations()
      .filter((a) => a.animationName === "confucius-ar-reminder");
    check(
      "later candidates use the shared floating reminder",
      animations.length === 1,
    );
    animations[0].pause();
    animations[0].currentTime = 420;
    check(
      "candidate reminder enlarges to 1.12",
      Math.abs(
        new win.DOMMatrix(win.getComputedStyle($(".ar-capsule")).transform).a -
          1.12,
      ) < 0.001,
    );
    const animation = animations[0];
    animation.finish();
    await tick();
    await panel.refresh(["W9", "W10"]);
    check(
      "duplicate events do not replay the reminder",
      !$(".ar-capsule").dataset.reminder,
    );
    show();
    query.focus();
    root.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    check(
      "keyboard minimize returns focus to the candidate capsule",
      !panel.floating && doc.activeElement === $(".ar-capsule"),
    );
    show();
    check("reopening preserves the local filter", query.value === "中文");
    $("#confucius-literature-review").click();
    await tick();
    await tick();
    check(
      "candidate confirmation occupies the shared content slot",
      !$(".ar-custom-content").hidden &&
        $(".ar-list").hidden &&
        !!$("[data-confirm]"),
    );
    pages.nine.summary.candidateRevision++;
    pages.nine.summary.revision++;
    await panel.refresh();
    check(
      "late candidate changes disable stale confirmation",
      $("[data-confirm]").disabled && !$("[data-stale]").hidden,
    );
    check(
      "stale preview never imports automatically",
      !calls.some((c) => c.method === "literature/confirm"),
    );
    // Task changes clear preview content and generation-fence an old read.
    let release;
    nextRead = new Promise((resolve) => (release = resolve));
    const pending = panel.refresh();
    panel.update("ten", pages.ten.summary);
    await panel.refresh();
    release(clone(pages.nine));
    await pending;
    await tick();
    check(
      "old reads cannot overwrite a newly selected task",
      root.dataset.view === "list" &&
        $(".ar-capsule-count").textContent === "0 / 10" &&
        $(".ar-custom-content").hidden,
    );
    show();
    check(
      "task switch clears the old filter and preview",
      $(".ar-search").value === "" && !$("[data-confirm]"),
    );
    // Source controls use the same reader action with the correct paper/PDF target.
    pages.ten.items[0].acquisition = {
      status: "available",
      item: {
        id: "item:1:PARENT",
        libraryID: 1,
        key: "PARENT",
        title: "Paper",
        source: "library",
      },
      attachmentKey: "PDF",
    };
    pages.ten.summary.revision++;
    await panel.refresh();
    $(".ar-view-switch button:first-child").click();
    $(".ar-paper .ar-source").click();
    await tick();
    check(
      "candidate source opens its available PDF",
      calls.at(-1).method === "reader/open" &&
        calls.at(-1).params.key === "PDF" &&
        calls.at(-1).params.selectItem === false,
    );
    delete pages.ten.items[0].acquisition.attachmentKey;
    pages.ten.items[0].acquisition.status = "failed";
    pages.ten.summary.revision++;
    await panel.refresh();
    $(".ar-paper .ar-source").click();
    await tick();
    check(
      "candidate without a PDF opens its saved library item",
      calls.at(-1).method === "reader/open" &&
        calls.at(-1).params.key === "PARENT" &&
        calls.at(-1).params.selectItem === true,
    );
    panel.update("nine", pages.nine.summary);
    await panel.refresh();
    check(
      "task revisits retain their manual presentation",
      root.dataset.view === "list",
    );
    return { checks, total: checks.length };
  } finally {
    panel.destroy();
    wrapper.remove();
  }
}
