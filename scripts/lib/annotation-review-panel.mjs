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
    check = (name, value, details) => {
      if (!value)
        throw new Error(
          `${name}${details ? `: ${JSON.stringify(details)}` : ""}`,
        );
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
      D: { taskId: "D", revision: 0, batches: [] },
      E: { taskId: "E", revision: 0, batches: [] },
      F: { taskId: "F", revision: 1, batches: [batch("first-F", 2)] },
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
    const draft = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "textarea",
    );
    draft.style.cssText =
      "position:absolute;top:0;right:0;width:180px;height:34px";
    wrapper.append(draft);
    panel.update("D");
    await tick();
    draft.value = "正在输入";
    draft.focus();
    draft.dispatchEvent(
      new win.CompositionEvent("compositionstart", { bubbles: true }),
    );
    pools.D.batches.push(batch("first-D", 2));
    pools.D.revision++;
    await panel.refresh(["first-D"]);
    check(
      "The first live Agent batch opens cards without stealing composer focus or the draft",
      panel.floating &&
        root.dataset.view === "card" &&
        doc.activeElement === draft &&
        draft.value === "正在输入" &&
        !$(".ar-capsule").dataset.reminder,
    );
    draft.dispatchEvent(
      new win.CompositionEvent("compositionend", { bubbles: true }),
    );
    $(".ar-header > button").click();
    draft.focus();
    const capsule = $(".ar-capsule"),
      capsuleBox = capsule.getBoundingClientRect().toJSON(),
      anchorBox = anchor.getBoundingClientRect().toJSON(),
      restingShadow = win.getComputedStyle(capsule).boxShadow;
    pools.D.batches.push(batch("second-D", 2));
    pools.D.revision++;
    await panel.refresh(["second-D"]);
    const animations = () =>
      capsule
        .getAnimations({ subtree: true })
        .filter((animation) =>
          animation.animationName?.startsWith("confucius-ar-reminder"),
        );
    const floating = animations()[0];
    floating.pause();
    floating.currentTime = floating.effect.getTiming().duration * 0.4;
    await tick();
    const transform = new win.DOMMatrix(
        win.getComputedStyle(capsule).transform,
      ),
      raisedBox = capsule.getBoundingClientRect();
    check(
      "Later live batches float the minimized capsule up 6px and enlarge it to 1.12 without shifting layout or focus",
      !panel.floating &&
        animations().length === 1 &&
        animations().every(
          (animation) => animation.effect.getTiming().iterations === 1,
        ) &&
        doc.activeElement === draft &&
        Math.abs(transform.a - 1.12) < 0.001 &&
        Math.abs(transform.d - 1.12) < 0.001 &&
        Math.abs(transform.m42 + 6) < 0.01 &&
        Math.abs(raisedBox.height / capsule.offsetHeight - 1.12) < 0.001 &&
        Math.abs(capsule.offsetHeight - capsuleBox.height) < 1 &&
        Math.abs(anchor.getBoundingClientRect().y - anchorBox.y) < 1 &&
        win.getComputedStyle(capsule).boxShadow !== restingShadow &&
        capsule.contains(
          doc.elementFromPoint(
            raisedBox.x + raisedBox.width / 2,
            raisedBox.y + raisedBox.height / 2,
          ),
        ) &&
        $(".ar-capsule-new").textContent === "+2",
    );
    for (const animation of animations()) animation.currentTime = 300;
    pools.D.batches.push(batch("third-D", 1));
    pools.D.revision++;
    await panel.refresh(["third-D"]);
    check(
      "Another live batch restarts one finite reminder rather than stacking animations",
      animations().length === 1 &&
        animations().every((animation) => animation.currentTime < 100),
      animations().map((animation) => ({
        name: animation.animationName,
        time: animation.currentTime,
        state: animation.playState,
      })),
    );
    await Promise.all(animations().map((animation) => animation.finished));
    await tick();
    check(
      "The capsule reminder settles without a persistent animation or decoration",
      animations().length === 0 &&
        !capsule.dataset.reminder &&
        win.getComputedStyle(capsule).transform === "none" &&
        Math.abs(capsule.getBoundingClientRect().y - capsuleBox.y) < 1 &&
        Math.abs(capsule.getBoundingClientRect().height - capsuleBox.height) <
          1,
    );
    await panel.refresh(["first-D", "third-D"]);
    pools.D.revision++;
    await panel.refresh();
    check(
      "Repeated events and receipt-only refreshes neither reopen nor animate review",
      !panel.floating && animations().length === 0 && !capsule.dataset.reminder,
    );
    list();
    const notifySearch = $(".ar-search");
    input(notifySearch, "row-0001");
    $(".ar-list-row:not([hidden]) input").click();
    notifySearch.focus();
    notifySearch.dispatchEvent(
      new win.CompositionEvent("compositionstart", { bubbles: true }),
    );
    notifySearch.value = "unfinished";
    pools.D.batches.push(batch("fourth-D", 1));
    pools.D.revision++;
    await panel.refresh(["fourth-D"]);
    check(
      "Reminder arrivals preserve an open list, selection, search composition and focus",
      panel.floating &&
        root.dataset.view === "list" &&
        notifySearch.value === "unfinished" &&
        doc.activeElement === notifySearch &&
        [...root.querySelectorAll(".ar-list-row input")].some(
          (input) => input.checked,
        ) &&
        animations().length === 1,
    );
    panel.update("B");
    await tick();
    check(
      "Switching tasks cancels a reminder and keeps historical batches minimized",
      !panel.floating && animations().length === 0 && !capsule.dataset.reminder,
    );

    nextRead = deferred();
    const initialRead = nextRead;
    panel.update("E");
    pools.E.batches.push(batch("first-E", 1));
    pools.E.revision++;
    await panel.refresh(["first-E"]);
    initialRead.resolve({ taskId: "E", revision: 0, batches: [] });
    await tick();
    await tick();
    check(
      "A first live arrival during initial loading survives a stale empty snapshot and coalesced refresh",
      panel.floating && $(".ar-range").max === "1" && !capsule.dataset.reminder,
    );
    panel.update("F");
    await tick();
    check(
      "Initial snapshot loading does not automatically open review",
      !panel.floating,
    );
    await panel.refresh(["first-F"]);
    check(
      "A live submission event arriving after its snapshot still opens first review",
      panel.floating && $(".ar-range").max === "2",
    );
    nextRead = deferred();
    const delayedArrival = nextRead,
      delayedRefresh = panel.refresh(["second-F"]);
    panel.update("B");
    await tick();
    delayedArrival.resolve({
      taskId: "F",
      revision: 2,
      batches: [...pools.F.batches, batch("second-F", 1)],
    });
    await delayedRefresh;
    check(
      "A stale live arrival cannot open or animate another task",
      !panel.floating && !capsule.dataset.reminder && animations().length === 0,
    );
    draft.remove();
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
    await panel.refresh(["arrival"]);
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

    panel.update("A");
    await tick();
    const longEntry = pools.A.batches.at(-1).entries.at(-1);
    longEntry.quote = "Long source passage with preserved quotation. ".repeat(
      240,
    );
    pools.A.revision++;
    await panel.refresh();
    card();
    win.resizeTo(1040, 850);
    await new Promise((resolve) => win.setTimeout(resolve, 200));
    wrapper.style.right = wrapper.style.bottom = "auto";
    const paper = $(".ar-paper"),
      body = $(".ar-card-body"),
      previous = $(".ar-card-previous"),
      next = $(".ar-card-next"),
      range = $(".ar-range");
    for (const width of [680, 480, 320, 280]) {
      for (const height of [520, 400]) {
        wrapper.style.width = `${width}px`;
        wrapper.style.height = `${height}px`;
        win.dispatchEvent(new win.Event("resize"));
        input(range, "1");
        const area = $(".ar-card-area").getBoundingClientRect(),
          stack = $(".ar-stack").getBoundingClientRect(),
          cardBox = paper.getBoundingClientRect(),
          footer = $(".ar-card-footer").getBoundingClientRect();
        check(
          `Cards fill remaining space with fixed controls at ${width}×${height}`,
          Math.abs(stack.bottom - (area.bottom - 4)) < 1 &&
            Math.abs(cardBox.height - (stack.height - 10)) < 1 &&
            footer.bottom <= cardBox.bottom - 11 &&
            body.clientHeight > 0 &&
            paper.scrollWidth <= paper.clientWidth + 1,
        );
        input(range, range.max);
        check(
          `Long passages scroll inside the card at ${width}×${height}`,
          body.scrollHeight > body.clientHeight &&
            $(".ar-card-area").scrollHeight <=
              $(".ar-card-area").clientHeight + 1 &&
            next.getBoundingClientRect().left >=
              body.getBoundingClientRect().right - 1 &&
            previous.getBoundingClientRect().right <=
              body.getBoundingClientRect().left + 1,
          {
            bodyHeight: body.clientHeight,
            bodyScroll: body.scrollHeight,
            areaHeight: $(".ar-card-area").clientHeight,
            areaScroll: $(".ar-card-area").scrollHeight,
            previousRight: previous.getBoundingClientRect().right,
            bodyLeft: body.getBoundingClientRect().left,
            nextLeft: next.getBoundingClientRect().left,
            bodyRight: body.getBoundingClientRect().right,
          },
        );
      }
    }
    const wheel = new win.WheelEvent("wheel", {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    });
    body.scrollTop = 80;
    body.dispatchEvent(wheel);
    check(
      "Scrolling a long passage leaves the current card and native scrolling intact",
      range.value === range.max &&
        !wheel.defaultPrevented &&
        body.scrollTop > 0,
    );
    body.click();
    check(
      "Clicking source text does not turn the card",
      range.value === range.max,
    );
    next.click();
    check(
      "The last card cannot turn past the end",
      next.disabled && range.value === range.max,
    );
    previous.click();
    check(
      "The left edge opens the previous card and resets its scroll",
      Number(range.value) === Number(range.max) - 1 && body.scrollTop === 0,
    );
    next.focus();
    next.click();
    check(
      "Reaching the last card keeps keyboard focus on the slider",
      next.disabled && doc.activeElement === range,
    );
    input(range, "1");
    previous.click();
    check(
      "The first card cannot turn before the start",
      previous.disabled && range.value === "1",
    );
    next.click();
    check(
      "The right edge opens the next card",
      range.value === "2" && !previous.disabled && !next.disabled,
    );
    previous.focus();
    previous.click();
    check(
      "Reaching the first card keeps keyboard focus on the slider",
      previous.disabled && doc.activeElement === range,
    );
    input(range, "2");
    wrapper.style.width = "680px";
    wrapper.style.height = "520px";
    win.dispatchEvent(new win.Event("resize"));
    $(".ar-header > button").focus();
    win.windowUtils.sendMouseEvent("mousemove", 0, 0, 0, 0, 0);
    await new Promise((resolve) => win.setTimeout(resolve, 200));
    check(
      "Edge cues stay unobtrusive while the card is idle",
      win.getComputedStyle(next).opacity === "0",
    );
    const box = paper.getBoundingClientRect();
    win.windowUtils.sendMouseEvent(
      "mousemove",
      box.x + box.width / 2,
      box.y + 16,
      0,
      0,
      0,
    );
    await new Promise((resolve) => win.setTimeout(resolve, 200));
    check(
      "Native mouse hover reveals both narrow gradient arrows",
      [previous, next].every(
        (button) =>
          win.getComputedStyle(button).opacity === "1" &&
          win
            .getComputedStyle(button)
            .backgroundImage.startsWith("linear-gradient") &&
          button.getBoundingClientRect().width === 34,
      ),
    );
    win.windowUtils.sendMouseEvent("mousemove", 0, 0, 0, 0, 0);
    win.focus();
    next.focus();
    await new Promise((resolve) => win.setTimeout(resolve, 200));
    check(
      "Edge controls remain keyboard focusable",
      doc.activeElement === next,
    );
    // Native focus selectors require the desktop process to be foreground.
    if (doc.hasFocus())
      check(
        "Keyboard focus reveals the edge cues without a mouse",
        win.getComputedStyle(next).opacity === "1",
      );
    $(".ar-header > button").focus();
    Services.prefs.setIntPref("ui.primaryPointerCapabilities", 1);
    await new Promise((resolve) => win.setTimeout(resolve, 200));
    check(
      "Coarse-pointer mode keeps 44px edge cues visible without hover",
      win.matchMedia("(pointer: coarse)").matches &&
        win.matchMedia("(hover: none)").matches &&
        next.getBoundingClientRect().width === 44 &&
        win.getComputedStyle(next).opacity === "1",
    );
    Services.prefs.clearUserPref("ui.primaryPointerCapabilities");
    Services.prefs.setIntPref("ui.prefersReducedMotion", 1);
    await new Promise((resolve) => win.setTimeout(resolve, 200));
    check(
      "Reduced-motion mode removes the edge fade transition",
      win.matchMedia("(prefers-reduced-motion: reduce)").matches &&
        win.getComputedStyle(next).transitionDuration === "0s",
    );
    pools.A.batches.push(batch("quiet-motion", 1));
    pools.A.revision++;
    await panel.refresh(["quiet-motion"]);
    await tick();
    check(
      "Reduced motion keeps new counts and announcements without decorative reminder motion",
      animations().length === 0 &&
        !capsule.dataset.reminder &&
        !$(".ar-capsule-new").hidden &&
        $("[aria-live=polite]").textContent ===
          $(".ar-summary-row button").textContent,
    );
    Services.prefs.clearUserPref("ui.prefersReducedMotion");
    Services.prefs.setIntPref("ui.useAccessibilityTheme", 1);
    Services.prefs.setCharPref("ui.windowForeground", "#FFFFFF");
    Services.prefs.setCharPref("ui.windowBackground", "#000000");
    await new Promise((resolve) => win.setTimeout(resolve, 200));
    check(
      "High contrast keeps available direction controls visible and legible",
      win.matchMedia("(prefers-contrast: more)").matches &&
        win.getComputedStyle(next).opacity === "1" &&
        win.getComputedStyle(next).backgroundImage === "none" &&
        win.getComputedStyle(next).borderTopWidth === "1px" &&
        win.getComputedStyle(next).color !==
          win.getComputedStyle(next).backgroundColor,
    );
    pools.A.batches.push(batch("quiet-contrast", 1));
    pools.A.revision++;
    await panel.refresh(["quiet-contrast"]);
    await tick();
    check(
      "High contrast uses a legible static new count instead of decorative reminder motion",
      animations().length === 0 &&
        !capsule.dataset.reminder &&
        !$(".ar-capsule-new").hidden &&
        win.getComputedStyle(capsule).borderTopWidth === "1px",
    );
    return checks;
  } finally {
    for (const pref of [
      "ui.primaryPointerCapabilities",
      "ui.prefersReducedMotion",
      "ui.useAccessibilityTheme",
      "ui.windowForeground",
      "ui.windowBackground",
    ])
      Services.prefs.clearUserPref(pref);
    panel.destroy();
    wrapper.remove();
  }
}
