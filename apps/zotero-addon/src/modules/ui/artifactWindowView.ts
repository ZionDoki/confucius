import {
  guideFromBody,
  readingBodyForView,
  type ReadingState,
  type ReadingView,
} from "@confucius/protocol";
import {
  mountReadingGuide,
  READING_GUIDE_CSS,
  readingLabel,
} from "./readingGuideView";
import type { ArtifactRecord, ResearchTaskRecord } from "@confucius/protocol";
import {
  DEFAULT_UI_FONT,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_UI_LINE_HEIGHT,
  UI_LINE_HEIGHT_VALUES,
  clampUiFontSize,
  isUiFont,
  isUiLineHeight,
} from "@confucius/protocol";
import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import { getString, configuredUiLanguage } from "../../utils/locale";
import type { WorkspaceHost } from "./WorkspaceView";
import { UI_FONT_STACKS } from "./workspaceTypography";
import { renderReadingSurface } from "./workspaceReading";
import { citationTarget } from "./readingCitations";
import { createWorkspaceButton } from "./workspaceControls";
import { createMenuSurface, bindMenuNavigation } from "./workspaceMenus";
import { ensurePaletteStyles } from "./workspaceSurface";
import { ensureScrollbarStyles } from "./workspaceScrollbars";
import { TUI_CSS } from "./workspaceTheme";
import { showArtifactWriteback } from "./artifactWriteback";
import {
  bindReadingPdfFollow,
  checkpointAtPdfPage,
} from "./readingGuideFollow";

const NS = "http://www.w3.org/1999/xhtml";
export interface ArtifactWindowView {
  select(revision?: number): void;
  dispose(): void | Promise<void>;
}

/** undefined follows the latest version; choosing history pins the reader. */
export function artifactRevisionSelection(
  artifact: ArtifactRecord,
  revision?: number,
): number | undefined {
  return revision !== undefined &&
    revision < artifact.revision &&
    artifact.revisions.some((item) => item.revision === revision)
    ? revision
    : undefined;
}

export function mountArtifactWindow(
  win: Window,
  host: WorkspaceHost,
  initial: ArtifactRecord,
  requestedRevision: number | undefined,
  fillAnswerHtml: (node: HTMLElement, text: string) => void,
  navigation?: {
    back(): void;
    detach(artifact: ArtifactRecord, revision?: number): void;
  },
): ArtifactWindowView {
  const doc = win.document;
  const root = doc.getElementById("confucius-artifact-window") as HTMLElement;
  ensurePaletteStyles(doc);
  ensureScrollbarStyles(doc);
  const style = doc.createElementNS(NS, "style");
  style.textContent = TUI_CSS + ARTIFACT_WINDOW_CSS + READING_GUIDE_CSS;
  (doc.head ?? doc.documentElement)?.append(style);
  const element = (tag: string, className?: string) => {
    const node = doc.createElementNS(NS, tag) as HTMLElement;
    if (className) node.className = className;
    return node;
  };
  root.className = "confucius-artifact-window";
  const toolbar = element("header", "confucius-artifact-toolbar");
  toolbar.setAttribute("role", "toolbar");
  const revisionButton = createWorkspaceButton(
    doc,
    "confucius-artifact-revision-trigger",
    "",
  );
  revisionButton.setAttribute("aria-haspopup", "menu");
  revisionButton.classList.add("confucius-artifact-revision-trigger");
  revisionButton.setAttribute("aria-expanded", "false");
  const status = element("span", "confucius-artifact-window-status");
  status.setAttribute("role", "status");
  const writeback = createWorkspaceButton(
    doc,
    "confucius-artifact-writeback",
    "",
  );
  writeback.disabled = true;
  writeback.classList.add("confucius-artifact-writeback");
  const viewTabs = element("div", "confucius-artifact-view-tabs");
  viewTabs.setAttribute("role", "tablist");
  const tabs = (["guide", "report"] as const).map((view) => {
    const button = createWorkspaceButton(doc, "", "");
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => {
      win.getSelection()?.removeAllRanges();
      changeReadingState({ view });
      render();
    });
    viewTabs.append(button);
    return { view, button };
  });
  const leave = () => (navigation ? navigation.back() : win.close());
  let back: HTMLButtonElement | undefined;
  let detach: HTMLButtonElement | undefined;
  if (navigation) {
    back = createWorkspaceButton(doc, "confucius-artifact-back", "←");
    back.classList.add("confucius-artifact-back");
    back.addEventListener("click", leave);
    toolbar.append(back);
    detach = createWorkspaceButton(doc, "confucius-artifact-detach", "");
    detach.classList.add("confucius-artifact-detach");
    detach.addEventListener("click", () => {
      if (detach) detach.disabled = true;
      guideView?.capturePosition();
      win.clearTimeout(stateTimer);
      saveReadingState();
      void stateSave
        .then(() => {
          if (!disposed) navigation.detach(artifact, selected);
        })
        .catch(error)
        .finally(() => {
          if (detach) detach.disabled = false;
        });
    });
  }
  toolbar.append(viewTabs, status, revisionButton, writeback);
  if (detach) toolbar.append(detach);
  const errors = element("div", "confucius-artifact-window-error");
  errors.id = "confucius-status";
  errors.setAttribute("role", "status");
  const body = element("div", "confucius-artifact-dialog-body");
  body.id = "confucius-artifact-dialog-body";
  body.tabIndex = 0;
  const floatingSummary = element("div", "confucius-guide-floating");
  floatingSummary.hidden = true;
  root.replaceChildren(toolbar, errors, floatingSummary, body);

  let artifact = initial;
  let taskStatus: ResearchTaskRecord["status"] | undefined;
  let selected = artifactRevisionSelection(artifact, requestedRevision);
  let displayedRevision = selected ?? artifact.revision;
  let renderedKey = "";
  let renderedBody: unknown;
  let disposed = false;
  let refreshing = false;
  let guideView: ReturnType<typeof mountReadingGuide> | undefined;
  let stopPdfFollow = () => {};
  let readingState: ReadingState = {
    view: guideFromBody(initial.body) ? "guide" : "report",
    lens: "reading",
    expanded: {},
    drafts: {},
  };
  let stateLoaded = !guideFromBody(initial.body);
  let stateTimer: number | undefined;
  let pendingState: Partial<ReadingState> | undefined;
  let stateSave: Promise<unknown> = Promise.resolve();
  let reportPending = false;
  let reportGenerationStatus: string | undefined;
  let generateReportButton: HTMLButtonElement | undefined;
  const saveReadingState = () => {
    if (!pendingState) return;
    const patch = pendingState;
    pendingState = undefined;
    stateSave = stateSave
      .catch(() => {})
      .then(() =>
        host.rpc("artifact/readingState", {
          artifactId: initial.id,
          state: patch,
        }),
      )
      .catch(error);
  };
  const changeReadingState = (patch: Partial<ReadingState>) => {
    readingState = { ...readingState, ...patch };
    pendingState = { ...pendingState, ...patch };
    if (!stateLoaded) return;
    win.clearTimeout(stateTimer);
    stateTimer = win.setTimeout(saveReadingState, 250);
  };
  let timer: number | undefined;
  let menu: HTMLElement | undefined;
  const scrolls = new Map<string, number>();
  const error = (value: unknown) => {
    if (disposed) return;
    errors.textContent = value ? String(value) : "";
  };
  const closeMenu = (focus = false) => {
    menu?.remove();
    menu = undefined;
    revisionButton.setAttribute("aria-expanded", "false");
    if (focus) revisionButton.focus();
  };
  const locateLink = (
    targetDoc: Document,
    target: {
      libraryID?: number;
      key: string;
      pageIndex?: number;
      annotationKey?: string;
      selectItem?: boolean;
    },
  ) => {
    const link = createWorkspaceButton(
      targetDoc,
      "",
      getString("workspace-locate"),
    );
    link.classList.add("confucius-artifact-locate");
    link.addEventListener(
      "click",
      () => void host.rpc("reader/open", target).catch(error),
    );
    return link;
  };
  const makeReportButton = () => {
    generateReportButton = createWorkspaceButton(
      doc,
      "",
      readingLabel(
        reportGenerationStatus === "interrupted" ||
          reportGenerationStatus === "failed"
          ? "继续生成研究报告"
          : "生成研究报告",
        reportGenerationStatus === "interrupted" ||
          reportGenerationStatus === "failed"
          ? "Continue research report"
          : "Generate research report",
      ),
    );
    generateReportButton.disabled =
      reportPending ||
      taskStatus === "running" ||
      taskStatus === "awaiting_approval" ||
      selected !== undefined;
    generateReportButton.addEventListener("click", () => {
      reportPending = true;
      render();
      void host
        .rpc("artifact/generateReport", {
          artifactId: artifact.id,
          expectedRevision: displayedRevision,
        })
        .then((result) => {
          const response = result as { status: string };
          if (response.status === "busy")
            error(
              readingLabel(
                "主任务正在运行，请等它结束后生成报告。",
                "The main task is running. Generate the report after it finishes.",
              ),
            );
          return refresh();
        })
        .catch(error)
        .finally(() => {
          reportPending = false;
          render();
        });
    });
    return generateReportButton!;
  };
  const render = () => {
    if (disposed || !stateLoaded) return;
    // Keep the visible version, its label and writeback target in agreement.
    // A save must not replace text being selected or reviewed in a dialog.
    if (
      renderedKey &&
      (win.getSelection()?.toString() ||
        menu ||
        doc.getElementById("confucius-writeback-overlay"))
    )
      return;
    const revision = artifact.revisions.find(
      (item) => item.revision === (selected ?? artifact.revision),
    );
    if (!revision) return;
    const guide = guideFromBody(revision.body);
    const view: ReadingView = guide ? readingState.view : "report";
    viewTabs.hidden = !guide;
    for (const tab of tabs) {
      tab.button.textContent =
        tab.view === "guide"
          ? readingLabel("陪读", "Reading companion")
          : readingLabel("研究报告", "Research report");
      tab.button.setAttribute("aria-selected", String(tab.view === view));
    }
    if (generateReportButton)
      generateReportButton.disabled =
        reportPending ||
        taskStatus === "running" ||
        taskStatus === "awaiting_approval" ||
        selected !== undefined;
    doc.title = `${artifact.title} — Confucius`;
    toolbar.setAttribute("aria-label", getString("workspace-artifact-actions"));
    if (back) {
      back.title = readingLabel("返回任务", "Back to task");
      back.setAttribute("aria-label", back.title);
    }
    if (detach) {
      detach.textContent = readingLabel("独立窗口 ↗", "Separate window ↗");
      detach.title = readingLabel(
        "在独立窗口中继续阅读",
        "Continue in a separate window",
      );
    }
    revisionButton.textContent = `${getString("workspace-artifact-version")} ${revision.revision} · ${getString(selected === undefined ? "workspace-artifact-latest" : "workspace-artifact-history")} ▾`;
    revisionButton.title = getString("workspace-artifact-revision");
    const saveLabel = ["annotation_set", "collection_diff"].includes(
      artifact.kind,
    )
      ? getString("workspace-save-artifact")
      : getString("workspace-writeback");
    writeback.textContent = saveLabel;
    writeback.disabled =
      (view === "report" &&
        revision.body.type === "markdown" &&
        !revision.body.markdown.trim()) ||
      !taskStatus ||
      ["running", "awaiting_approval"].includes(taskStatus) ||
      artifact.writeback?.state === "pending";
    writeback.title = writeback.disabled
      ? getString(
          artifact.writeback?.state === "pending"
            ? "workspace-writeback-disabled-pending"
            : "workspace-writeback-disabled-running",
        )
      : saveLabel;
    status.textContent = getString(
      artifact.status === "draft"
        ? "workspace-artifact-draft"
        : "workspace-artifact-ready",
    );
    const writeState = artifact.writeback;
    if (
      writeState &&
      writeState.revision === revision.revision &&
      (!writeState.view || writeState.view === view)
    ) {
      const label = {
        none: undefined,
        pending: "workspace-writeback-pending",
        committed: "workspace-writeback-committed",
        partial: "workspace-writeback-partial",
        unknown: "workspace-writeback-unknown",
        failed: "workspace-writeback-failed",
      }[writeState.state];
      if (label) status.textContent = getString(label);
      status.title = writeState.error ?? "";
    } else status.title = "";
    if (selected !== undefined && selected < artifact.revision)
      status.textContent = getString("workspace-artifact-history-hint");
    const key = `${artifact.id}:${revision.revision}:${view}`;
    const signature = JSON.stringify([
      view,
      view === "report" ? reportGenerationStatus : undefined,
      revision.body,
      revision.citations,
      artifact.title,
      configuredUiLanguage(),
    ]);
    displayedRevision = revision.revision;
    if (renderedBody === signature) return;
    if (renderedKey) scrolls.set(renderedKey, body.scrollTop);
    const scroll =
      selected === undefined && renderedKey.endsWith(`:${view}`)
        ? body.scrollTop
        : (scrolls.get(key) ?? 0);
    guideView?.dispose();
    guideView = undefined;
    generateReportButton = undefined;
    const shell = element("div", "confucius-artifact-shell");
    shell.classList.toggle(
      "confucius-artifact-companion-shell",
      !!guide && view === "guide",
    );
    const paper = element("article", "confucius-artifact-paper");
    const title = element("h1", "confucius-artifact-title");
    title.textContent = artifact.title;
    if (guide && view === "guide") {
      paper.append(title);
      const reading = element("div");
      paper.append(reading);
      guideView = mountReadingGuide(win, reading, {
        artifact,
        revision,
        guide,
        floatingRoot: floatingSummary,
        state: readingState,
        host,
        renderer: { fillAnswerHtml, locateLink },
        change: changeReadingState,
      });
    } else if (
      guide &&
      revision.body.type === "markdown" &&
      !revision.body.markdown.trim()
    ) {
      paper.append(title);
      const info = element("p", "confucius-artifact-report-intro");
      info.textContent = readingLabel(
        "把研究问题、方法、证据与边界整理成一份报告。",
        "Bring the research question, method, evidence and limits into one report.",
      );
      const reportButton = makeReportButton();
      paper.append(info, reportButton);
    } else {
      if (
        guide &&
        reportGenerationStatus &&
        reportGenerationStatus !== "completed"
      ) {
        const progress = element("p");
        progress.textContent = readingLabel(
          "研究报告仍在生成或复核中，陪读可继续阅读。",
          "The research report is being generated or reviewed. You can keep reading the companion.",
        );
        paper.append(progress);
        if (reportGenerationStatus !== "running")
          paper.append(makeReportButton());
      }
      const reading = renderReadingSurface(
        doc,
        readingBodyForView(revision.body, revision.citations, view),
        { fillAnswerHtml, locateLink },
        revision.citations,
      );
      if (!reading.querySelector("h1")) paper.append(title);
      paper.append(reading);
    }
    if (
      revision.citations.length &&
      view === "report" &&
      (revision.body.type !== "markdown" || revision.body.markdown.trim())
    ) {
      const references = element("details", "confucius-artifact-references");
      const summary = element("summary");
      summary.textContent = `${getString("workspace-artifact-citations")} · ${revision.citations.length}`;
      references.append(summary);
      const list = element("ol");
      for (const citation of revision.citations) {
        const row = element("li");
        const quote = element("span");
        quote.textContent = [
          citation.title,
          citation.quote || citation.section || citation.itemKey,
        ]
          .filter(Boolean)
          .join(" — ");
        row.append(quote, locateLink(doc, citationTarget(citation)));
        list.append(row);
      }
      references.append(list);
      paper.append(references);
    }
    shell.append(paper);
    body.replaceChildren(shell);
    body.scrollTop = scroll;
    if (view === "guide") guideView?.restorePosition();
    stopPdfFollow();
    stopPdfFollow = guide
      ? bindReadingPdfFollow(
          win,
          revision.citations,
          ({ location, explicit, move }) => {
            if (disposed || doc.getElementById("confucius-writeback-overlay"))
              return;
            if (!explicit && readingState.view !== "guide") return;
            if (!location) {
              guideView?.follow(undefined, false);
              return;
            }
            const checkpointId = checkpointAtPdfPage(
              guide,
              revision.citations,
              location,
              readingState.checkpointId,
            );
            if (!checkpointId) return;
            if (explicit && readingState.view !== "guide") {
              win.getSelection()?.removeAllRanges();
              changeReadingState({ view: "guide" });
              render();
            }
            guideView?.follow(checkpointId, move);
            if (explicit) {
              if (navigation) win.top?.focus();
              win.focus();
            }
          },
          !readingState.checkpointId,
        )
      : () => {};
    renderedKey = key;
    renderedBody = signature;
  };
  const select = (revision?: number) => {
    const next = artifactRevisionSelection(artifact, revision);
    if (next === selected) return;
    win.getSelection()?.removeAllRanges();
    scrolls.set(renderedKey, body.scrollTop);
    selected = next;
    renderedKey = "";
    renderedBody = undefined;
    closeMenu();
    render();
  };
  const refresh = async () => {
    if (disposed || refreshing) return;
    refreshing = true;
    try {
      const saved = (await host.rpc("artifact/get", { id: initial.id })) as {
        artifact: ArtifactRecord;
        taskStatus: ResearchTaskRecord["status"] | null;
        reportGeneration?: { status: string } | null;
      };
      if (disposed) return;
      if (saved.taskStatus === null) {
        leave();
        return;
      }
      taskStatus = saved.taskStatus;
      artifact = saved.artifact;
      reportGenerationStatus = saved.reportGeneration?.status;
      error("");
      render();
    } catch (cause) {
      error(cause);
    } finally {
      refreshing = false;
    }
  };
  const poll = async () => {
    await refresh();
    if (!disposed) timer = win.setTimeout(() => void poll(), 1500);
  };
  revisionButton.addEventListener("click", () => {
    if (menu) {
      closeMenu(true);
      return;
    }
    menu = createMenuSurface(doc, {
      id: "confucius-artifact-choice-menu",
      role: "menu",
      "aria-label": getString("workspace-artifact-revision"),
    });
    menu.classList.add("confucius-artifact-choice-menu");
    const choices = [
      {
        value: undefined,
        label: `${getString("workspace-artifact-latest")} · ${artifact.revision}`,
      },
      ...artifact.revisions
        .slice(0, -1)
        .reverse()
        .map((item) => ({
          value: item.revision,
          label: `${getString("workspace-artifact-version")} ${item.revision}`,
        })),
    ];
    for (const choice of choices) {
      const button = createWorkspaceButton(doc, "", choice.label);
      button.className = "confucius-artifact-choice";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", String(choice.value === selected));
      const checked = choice.value === selected;
      button.setAttribute("data-selected", String(checked));
      const check = element("span", "confucius-artifact-choice-check");
      check.textContent = checked ? "✓" : "";
      check.setAttribute("aria-hidden", "true");
      button.append(check);
      button.addEventListener("click", () => {
        select(choice.value);
        closeMenu(true);
      });
      menu.append(button);
    }
    const box = revisionButton.getBoundingClientRect();
    Object.assign(menu.style, {
      position: "fixed",
      top: `${box.bottom + 6}px`,
      left: `${box.left}px`,
      width: "220px",
      maxWidth: "calc(100vw - 24px)",
      maxHeight: `${Math.max(80, win.innerHeight - box.bottom - 20)}px`,
      zIndex: "20",
    });
    root.append(menu);
    revisionButton.setAttribute("aria-expanded", "true");
    bindMenuNavigation(menu, () => closeMenu(true));
    (menu.querySelector('[aria-checked="true"]') as HTMLElement)?.focus();
  });
  const dismissMenu = (event: Event) => {
    if (
      menu &&
      !menu.contains(event.target as Node) &&
      !revisionButton.contains(event.target as Node)
    )
      closeMenu();
  };
  doc.addEventListener("pointerdown", dismissMenu);
  const onResize = () => closeMenu();
  win.addEventListener("resize", onResize);
  const onFocus = () => void refresh();
  win.addEventListener("focus", onFocus);
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") {
      event.preventDefault();
      leave();
    } else if (event.key === "Escape" && menu) {
      event.preventDefault();
      closeMenu(true);
    }
  };
  win.addEventListener("keydown", onKey);
  const artifactRevisionBody = () =>
    artifact.revisions.find((r) => r.revision === displayedRevision)?.body ??
    artifact.body;
  writeback.addEventListener("click", () =>
    showArtifactWriteback(
      win,
      root,
      host,
      artifact,
      displayedRevision,
      refresh,
      guideFromBody(artifactRevisionBody()) ? readingState.view : undefined,
    ),
  );
  const appearance = () => {
    const font = getPref("uiFont"),
      lineHeight = getPref("uiLineHeight");
    const size = clampUiFontSize(getPref("uiFontSize") ?? DEFAULT_UI_FONT_SIZE);
    root.style.fontFamily =
      UI_FONT_STACKS[isUiFont(font) ? font : DEFAULT_UI_FONT];
    root.style.fontSize = `${size}px`;
    root.style.setProperty("--confucius-markdown-font-size", `${size}px`);
    root.style.setProperty(
      "--confucius-reading-line-height",
      String(
        UI_LINE_HEIGHT_VALUES[
          isUiLineHeight(lineHeight) ? lineHeight : DEFAULT_UI_LINE_HEIGHT
        ],
      ),
    );
    doc.documentElement?.setAttribute("lang", configuredUiLanguage());
    render();
  };
  const observers = ["uiFont", "uiFontSize", "uiLineHeight", "uiLanguage"].map(
    (key) =>
      Zotero.Prefs.registerObserver(
        `${config.prefsPrefix}.${key}`,
        () =>
          win.setTimeout(() => {
            if (!disposed) appearance();
          }, 0),
        true,
      ),
  );
  if (!stateLoaded)
    void host
      .rpc("artifact/readingState", { artifactId: initial.id })
      .then((result) => {
        if (disposed) return;
        const saved = result as { state?: ReadingState };
        if (saved?.state)
          readingState = {
            ...saved.state,
            ...pendingState,
            expanded: { ...saved.state.expanded, ...pendingState?.expanded },
            drafts: { ...saved.state.drafts, ...pendingState?.drafts },
          };
        stateLoaded = true;
        saveReadingState();
        renderedBody = undefined;
        render();
      })
      .catch((cause) => {
        stateLoaded = true;
        error(cause);
        render();
      });
  appearance();
  body.focus({ preventScroll: true });
  void poll();
  return {
    select,
    dispose() {
      if (disposed) return stateSave.then(() => {});
      disposed = true;
      stopPdfFollow();
      guideView?.dispose();
      win.clearTimeout(stateTimer);
      saveReadingState();
      win.clearTimeout(timer);
      closeMenu();
      for (const observer of observers)
        Zotero.Prefs.unregisterObserver(observer);
      doc.removeEventListener("pointerdown", dismissMenu);
      win.removeEventListener("resize", onResize);
      win.removeEventListener("focus", onFocus);
      win.removeEventListener("keydown", onKey);
      return stateSave.then(() => {});
    },
  };
}

const ARTIFACT_WINDOW_CSS = `
.confucius-artifact-window { display: flex; flex-direction: column; min-width: 0; background: var(--confucius-paper); color: var(--confucius-ink); }
.confucius-artifact-toolbar { display: flex; flex: 0 0 auto; align-items: center; gap: 16px; padding: 8px 20px; min-height: 60px; box-sizing: border-box; border-bottom: 1px solid var(--confucius-line); }
.confucius-artifact-window .confucius-artifact-toolbar button { border: 0; border-radius: 0; padding: 8px 0; background: transparent; box-shadow: none; color: var(--confucius-muted); font-size: 12px; font-weight: 400; }
.confucius-artifact-view-tabs { display: flex; flex: 0 0 auto; gap: 4px; }
.confucius-artifact-window .confucius-artifact-view-tabs button { position: relative; padding: 9px 14px; min-height: 40px; border-radius: 7px; font-size: 13px; }
.confucius-artifact-window .confucius-artifact-view-tabs button:hover { background: var(--confucius-hover); }
.confucius-artifact-window .confucius-artifact-view-tabs button[aria-selected=true] { color: var(--confucius-accent-text); background: var(--confucius-surface); font-weight: 600; }
.confucius-artifact-view-tabs button[aria-selected=true]::after { content: ""; position: absolute; height: 2px; border-radius: 2px; background: var(--confucius-accent); inset: auto 14px 4px; }
.confucius-artifact-window .confucius-artifact-toolbar .confucius-artifact-back { width: 28px; min-width: 28px; border-radius: 6px; font-size: 19px; }
.confucius-artifact-window .confucius-artifact-toolbar .confucius-artifact-back:hover { background: var(--confucius-hover); }
.confucius-artifact-detach { white-space: nowrap; }
.confucius-artifact-window-status { flex: 1; color: var(--confucius-muted); font-size: 11px; }
.confucius-artifact-window .confucius-artifact-writeback { color: var(--confucius-secondary); }
.confucius-artifact-window-error { padding: 10px 24px; color: var(--confucius-danger); font-size: .9em; }
.confucius-artifact-window-error:empty { display: none; }
.confucius-artifact-window .confucius-artifact-dialog-body { flex: 1; height: auto; padding: 16px clamp(24px, 7vw, 80px) 130px; }
.confucius-artifact-window .confucius-artifact-shell { width: min(680px, 100%); }
.confucius-artifact-window .confucius-artifact-paper { margin: 0; padding: 38px 0 0; }
.confucius-guide-floating { flex: 0 0 auto; min-height: 0; max-height: 28vh; overflow-y: auto; padding: 12px clamp(24px, 7vw, 80px); background: var(--confucius-paper); }
.confucius-guide-floating[hidden] { display: none; }
.confucius-guide-floating > .confucius-guide-signpost { box-sizing: border-box; width: min(680px, 100%); margin: 0 auto; }
.confucius-artifact-title { margin: 0 0 24px; font-size: 1.9em; font-weight: 600; line-height: 1.45; letter-spacing: -.025em; overflow-wrap: anywhere; }
.confucius-artifact-window .confucius-artifact-paper .tui-answer { line-height: var(--confucius-reading-line-height, 1.8); }
.confucius-artifact-window .confucius-artifact-paper > .confucius-reading-surface > h2 { margin-top: 2.8em; }
.confucius-artifact-window a { color: var(--confucius-accent); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.confucius-artifact-window .confucius-reading-surface { overflow-x: auto; }
.confucius-artifact-references { margin-top: 48px; border-top: 1px solid var(--confucius-line); padding-top: 20px; font-size: .85em; }
.confucius-artifact-references summary { cursor: pointer; color: var(--confucius-muted); }
.confucius-artifact-references li { margin: 12px 0; }
.confucius-artifact-locate { margin-inline-start: 8px; color: var(--confucius-accent); }
.confucius-artifact-report-intro { color: var(--confucius-muted); margin: 36px 0 24px; }
@media (max-width: 680px) { .confucius-artifact-toolbar { gap: 8px 12px; padding: 8px 12px; flex-wrap: wrap; } .confucius-artifact-window-status { font-size: 10px; } .confucius-artifact-window .confucius-artifact-revision-trigger { font-size: 10px; } .confucius-artifact-window .confucius-artifact-paper { padding-top: 20px; } }
`;
