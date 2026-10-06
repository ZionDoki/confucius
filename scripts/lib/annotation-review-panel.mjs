import { build } from "esbuild";
import { join } from "node:path";

/** Exercise the real panel in Gecko, with controllable RPC timing and long queues. */
export async function annotationReviewPanelRegressions(root, ui) {
  const bundle = await build({
    entryPoints: [
      join(root, "apps/zotero-addon/src/modules/ui/annotationReviewPanel.ts"),
    ],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "reviewPanelFixture",
    banner: { js: "var addon = Zotero.Confucius;" },
  });
  return ui(`${bundle.outputFiles[0].text}
    return (${panelRegressions.toString()})(d, reviewPanelFixture.createAnnotationReviewPanel);`);
}

async function panelRegressions(doc, createPanel) {
  const win = doc.defaultView,
    checks = [],
    clone = (value) => JSON.parse(JSON.stringify(value)),
    tick = () => new Promise((resolve) => win.setTimeout(resolve, 0)),
    check = (name, value) => {
      if (!value) throw new Error(name);
      checks.push(name);
    },
    deferred = () => {
      let resolve, reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      return { promise, resolve, reject };
    },
    batch = (id, count) => ({
      id,
      createdAt: 1,
      title: id,
      libraryID: 1,
      attachmentKey: "QA",
      entries: Array.from({ length: count }, (_, index) => ({
        id: String(index),
        type: "highlight",
        page: 1,
        quote: `row-${String(index).padStart(4, "0")}`,
        comment: "Note",
        color: "#ffd400",
        status: "pending",
      })),
    }),
    pools = {
      A: { taskId: "A", revision: 1, batches: [batch("long", 240)] },
      B: { taskId: "B", revision: 1, batches: [batch("short", 2)] },
      C: { taskId: "C", revision: 1, batches: [batch("invalid", 2)] },
    };
  pools.C.batches[0].entries[0].status = "unavailable";
  pools.C.batches[0].entries[0].error = "Invalid anchor";
  const wrapper = doc.createElementNS("http://www.w3.org/1999/xhtml", "div"),
    anchor = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  wrapper.style.cssText =
    "position:fixed;inset:8px;z-index:99999;background:var(--confucius-paper)";
  anchor.style.cssText =
    "position:absolute;bottom:0;left:0;right:0;min-height:34px";
  wrapper.append(anchor);
  doc.body.append(wrapper);
  let nextRead, decision, reader;
  const panel = createPanel(doc, {
    viewport: wrapper,
    anchor,
    opened() {},
    visibilityChanged() {},
    rpc(method, params) {
      if (method === "annotation/review/list") {
        if (nextRead) {
          const current = nextRead;
          nextRead = undefined;
          return current.promise;
        }
        return Promise.resolve(clone(pools[params.taskId]));
      }
      if (method === "annotation/review/decide") {
        decision = { ...deferred(), params };
        return decision.promise;
      }
      if (method === "reader/open") {
        reader = deferred();
        return reader.promise;
      }
      throw new Error(`Unexpected RPC: ${method}`);
    },
  });
  anchor.append(panel.node);
  const root = panel.node,
    $ = (selector) => root.querySelector(selector),
    input = (element, value) => {
      element.value = value;
      element.dispatchEvent(new win.Event("input", { bubbles: true }));
    },
    visible = () =>
      [...root.querySelectorAll(".ar-list-row")].filter(
        (row) => !row.hidden && !row.parentElement.hidden,
      ),
    open = () => {
      if (!panel.floating) $(".ar-capsule").click();
    },
    list = () => {
      open();
      $(".ar-view-switch button:last-child").click();
    },
    card = () => {
      open();
      $(".ar-view-switch button:first-child").click();
    },
    finish = async (status) => {
      const pool = pools[decision.params.taskId];
      for (const ref of decision.params.entries) {
        const entry = pool.batches
          .find((b) => b.id === ref.batchId)
          .entries.find((e) => e.id === ref.entryId);
        entry.status = status;
      }
      pool.revision++;
      decision.resolve(clone(pool));
      await tick();
    };
  try {
    panel.update("A");
    await tick();
    list();
    input($(".ar-search"), "row-0199");
    check(
      "Search can reach entries beyond the initially mounted page",
      visible().length === 1 &&
        JSON.parse(visible()[0].dataset.key)[1] === "199",
    );
    input($(".ar-search"), "");
    for (let index = 0; index < 3; index++) {
      const scroll = $(".ar-list");
      scroll.scrollTop = scroll.scrollHeight;
      scroll.dispatchEvent(new win.Event("scroll"));
    }
    check(
      "Search followed by progressive loading preserves all 240 entries in source order",
      visible().length === 240 &&
        visible().every(
          (row, index) => JSON.parse(row.dataset.key)[1] === String(index),
        ),
    );

    const search = $(".ar-search");
    search.focus();
    search.dispatchEvent(
      new win.CompositionEvent("compositionstart", { bubbles: true }),
    );
    search.value = "zhong";
    search.dispatchEvent(
      new win.InputEvent("input", { bubbles: true, isComposing: true }),
    );
    const arrival = batch("arrival", 2);
    arrival.entries[0].status = "accepted";
    arrival.entries[1].quote = "中文证据";
    pools.A.batches.push(arrival);
    pools.A.revision++;
    await panel.refresh();
    search.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    check(
      "New batches and Escape preserve an in-progress Chinese composition",
      search.value === "zhong" && panel.floating && visible().length >= 240,
    );
    search.value = "中文";
    search.dispatchEvent(
      new win.CompositionEvent("compositionend", { bubbles: true }),
    );
    check(
      "Chinese search applies once composition finishes",
      search.value === "中文" && visible().length === 1,
    );
    $(".ar-summary-row button").click();
    check(
      "View new reaches the pending entry after a saved entry and a long backlog",
      visible().length === 241 &&
        !$(".ar-group[data-batch=arrival]").hidden &&
        $(".ar-list").scrollTop > 0,
    );

    search.dispatchEvent(
      new win.CompositionEvent("compositionstart", { bubbles: true }),
    );
    search.value = "unfinished";
    panel.update("B");
    await tick();
    list();
    search.dispatchEvent(
      new win.CompositionEvent("compositionend", { bubbles: true }),
    );
    input(search, "row-0001");
    check(
      "Switching tasks resets composition without disabling the next task's search",
      search.value === "row-0001" && visible().length === 1,
    );

    panel.update("A");
    await tick();
    nextRead = deferred();
    const oldRead = nextRead,
      refreshing = panel.refresh();
    panel.update("B");
    await tick();
    check(
      "A delayed read for one task does not block opening another",
      panel.visible && $(".ar-group[data-batch=short]") !== null,
    );
    panel.update("A");
    await tick();
    oldRead.reject(new Error("Stale A read"));
    await refreshing;
    check(
      "Returning to a task ignores errors from its previous display generation",
      !$(".ar-popup-error").textContent,
    );

    card();
    $(".ar-paper .ar-source").click();
    panel.update("B");
    await tick();
    reader.reject(new Error("Stale reader error"));
    await tick();
    check(
      "Source navigation errors stay with their originating task",
      !$(".ar-popup-error").textContent,
    );

    panel.update("A");
    await tick();
    card();
    input($(".ar-range"), "1");
    $(".ar-card-footer [data-variant=primary]").click();
    panel.update("B");
    await tick();
    panel.update("A");
    await tick();
    card();
    await finish("accepted");
    check(
      "A late decision updates its outcome without moving the card after task switching",
      $(".ar-range").value === "1" &&
        $(".ar-paper .ar-status").dataset.status === "accepted",
    );

    input($(".ar-range"), "2");
    $(".ar-card-footer [data-variant=primary]").click();
    panel.close();
    open();
    await finish("accepted");
    check(
      "Minimizing and reopening during a write preserves the chosen card",
      $(".ar-range").value === "2" && panel.floating,
    );

    panel.update("C");
    await tick();
    card();
    input($(".ar-range"), "1");
    check(
      "Unlocatable cards offer rejection but never acceptance",
      $(".ar-card-footer [data-variant=primary]").hidden &&
        !$(".ar-card-footer .ar-decision").hidden,
    );
    list();
    const checkbox = visible()[0].querySelector("input");
    checkbox.checked = true;
    checkbox.dispatchEvent(new win.Event("change", { bubbles: true }));
    check(
      "Selecting only an unlocatable entry offers no bulk write",
      !$(".ar-popup-footer .ar-actions").hidden &&
        $(".ar-popup-footer [data-variant=primary]").hidden,
    );
    card();
    $(".ar-card-footer .ar-decision").click();
    await finish("rejected");
    input($(".ar-range"), "1");
    $(".ar-card-footer .ar-actions button:nth-child(3)").click();
    await finish("unavailable");
    check(
      "Restoring an unlocatable entry keeps its warning and reports no false failure",
      !$(".ar-popup-error").textContent &&
        $(".ar-paper .ar-status").dataset.status === "unavailable",
    );
    return checks;
  } finally {
    panel.destroy();
    wrapper.remove();
  }
}
