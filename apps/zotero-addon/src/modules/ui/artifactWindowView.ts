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
import { markdownForDisplay } from "@confucius/protocol";
import { renderReadingSurface } from "./workspaceReading";
import { citationTarget } from "./readingCitations";
import { createWorkspaceButton } from "./workspaceControls";
import { createMenuSurface, bindMenuNavigation } from "./workspaceMenus";
import { ensurePaletteStyles } from "./workspaceSurface";
import { ensureScrollbarStyles } from "./workspaceScrollbars";
import { TUI_CSS } from "./workspaceTheme";
import { showArtifactWriteback } from "./artifactWriteback";

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
  style.textContent = TUI_CSS + ARTIFACT_WINDOW_CSS;
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
  let back: HTMLButtonElement | undefined;
  let detach: HTMLButtonElement | undefined;
  const context = element("div", "confucius-artifact-header-context");
  const actions = element("div", "confucius-artifact-header-actions");
  const leave = () => (navigation ? navigation.back() : win.close());
  if (navigation) {
    back = createWorkspaceButton(doc, "confucius-artifact-back", "←");
    back.classList.add("confucius-artifact-back", "confucius-icon-button");
    back.addEventListener("click", leave);
    context.append(back);
    detach = createWorkspaceButton(doc, "confucius-artifact-detach", "");
    detach.classList.add("confucius-artifact-detach");
    detach.addEventListener("click", () => {
      if (detach) detach.disabled = true;
      try {
        navigation.detach(artifact, selected);
      } finally {
        if (detach) detach.disabled = false;
      }
    });
  }
  context.append(status);
  actions.append(revisionButton, writeback);
  if (detach) actions.append(detach);
  toolbar.append(context, actions);
  const errors = element("div", "confucius-artifact-window-error");
  errors.id = "confucius-status";
  errors.setAttribute("role", "status");
  const body = element("div", "confucius-artifact-dialog-body");
  body.id = "confucius-artifact-dialog-body";
  body.tabIndex = 0;
  root.replaceChildren(toolbar, errors, body);

  let artifact = initial;
  let taskStatus: ResearchTaskRecord["status"] | undefined;
  let selected = artifactRevisionSelection(artifact, requestedRevision);
  let displayedRevision = selected ?? artifact.revision;
  let renderedKey = "";
  let renderedBody: unknown;
  let disposed = false;
  let refreshing = false;
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
  const render = () => {
    if (disposed) return;
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
    doc.title = `${artifact.title} — Confucius`;
    toolbar.setAttribute("aria-label", getString("workspace-artifact-actions"));
    if (back) {
      back.title = getString("workspace-back");
      back.setAttribute("aria-label", back.title);
    }
    if (detach) {
      detach.textContent =
        configuredUiLanguage() === "en-US" ? "Separate window ↗" : "独立窗口 ↗";
      detach.title = detach.textContent;
    }
    revisionButton.textContent = `${getString("workspace-artifact-version")} ${revision.revision} · ${getString(selected === undefined ? "workspace-artifact-latest" : "workspace-artifact-history")} ▾`;
    revisionButton.title = getString("workspace-artifact-revision");
    const saveLabel = ["annotation_set", "collection_diff"].includes(
      artifact.kind,
    )
      ? getString("workspace-save-artifact")
      : getString("workspace-writeback");
    writeback.textContent = saveLabel;
    const emptyBody =
      revision.body.type === "markdown" &&
      !markdownForDisplay(revision.body, revision.citations).trim();
    const busyTask =
      !taskStatus || ["running", "awaiting_approval"].includes(taskStatus);
    const pendingWriteback = artifact.writeback?.state === "pending";
    writeback.disabled = emptyBody || busyTask || pendingWriteback;
    writeback.title = !writeback.disabled
      ? saveLabel
      : getString(
          pendingWriteback
            ? "workspace-writeback-disabled-pending"
            : emptyBody
              ? "workspace-writeback-disabled-empty"
              : "workspace-writeback-disabled-running",
        );
    status.textContent = getString(
      artifact.status === "draft"
        ? "workspace-artifact-draft"
        : "workspace-artifact-ready",
    );
    const writeState = artifact.writeback;
    if (writeState && writeState.revision === revision.revision) {
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
    const key = `${artifact.id}:${revision.revision}`;
    const signature = JSON.stringify([
      revision.body,
      revision.citations,
      artifact.title,
      configuredUiLanguage(),
    ]);
    displayedRevision = revision.revision;
    if (renderedBody === signature) return;
    if (renderedKey) scrolls.set(renderedKey, body.scrollTop);
    const scroll =
      selected === undefined && renderedKey
        ? body.scrollTop
        : (scrolls.get(key) ?? 0);
    const shell = element("div", "confucius-artifact-shell");
    const paper = element("article", "confucius-artifact-paper");
    const title = element("h1", "confucius-artifact-title");
    title.textContent = artifact.title;
    const reading = renderReadingSurface(
      doc,
      revision.body,
      {
        fillAnswerHtml,
        locateLink,
      },
      revision.citations,
    );
    if (reading.firstElementChild?.localName !== "h1") paper.append(title);
    paper.append(reading);
    if (emptyBody) {
      const empty = element("div", "confucius-artifact-empty");
      empty.textContent = getString("workspace-artifact-empty");
      paper.append(empty);
    }
    if (revision.citations.length) {
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
      };
      if (disposed) return;
      if (saved.taskStatus === null) {
        leave();
        return;
      }
      taskStatus = saved.taskStatus;
      artifact = saved.artifact;
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
      width: "220px",
      maxWidth: "calc(100vw - 24px)",
      maxHeight: `${Math.max(80, win.innerHeight - box.bottom - 20)}px`,
      zIndex: "20",
    });
    root.append(menu);
    const menuWidth = menu.getBoundingClientRect().width;
    menu.style.left = `${Math.max(8, Math.min(box.left, win.innerWidth - menuWidth - 8))}px`;
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
  writeback.addEventListener("click", () =>
    showArtifactWriteback(
      win,
      root,
      host,
      artifact,
      displayedRevision,
      refresh,
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
  appearance();
  body.focus({ preventScroll: true });
  void poll();
  return {
    select,
    dispose() {
      if (disposed) return;
      disposed = true;
      win.clearTimeout(timer);
      closeMenu();
      for (const observer of observers)
        Zotero.Prefs.unregisterObserver(observer);
      doc.removeEventListener("pointerdown", dismissMenu);
      win.removeEventListener("resize", onResize);
      win.removeEventListener("focus", onFocus);
      win.removeEventListener("keydown", onKey);
    },
  };
}

const ARTIFACT_WINDOW_CSS = `
.confucius-artifact-window { display: flex; flex-direction: column; min-width: 0; background: var(--confucius-paper); color: var(--confucius-ink); }
.confucius-artifact-toolbar { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; padding: 10px 14px; min-height: 48px; box-sizing: border-box; border: 0; background: var(--confucius-paper); }
.confucius-artifact-header-context { display: flex; flex: 1 1 auto; align-items: center; gap: 8px; min-width: 0; }
.confucius-artifact-header-actions { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: 8px; margin-left: auto; max-width: 100%; }
.confucius-artifact-header-actions .confucius-button { overflow-wrap: anywhere; }
.confucius-artifact-back { font-size: 16px; }
.confucius-artifact-window-status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--confucius-muted); font-size: 12px; }
.confucius-artifact-window-error { padding: 10px 14px; color: var(--confucius-danger); font-size: .9em; }
.confucius-artifact-window-error:empty { display: none; }
.confucius-artifact-window .confucius-artifact-dialog-body { flex: 1 1 auto; min-height: 0; height: auto; overflow-y: auto; padding: 16px clamp(24px, 7vw, 80px) 130px; }
/* Gecko outlines this auto-focused scroll region directly below the header. Keep keyboard scrolling without framing the reading surface. */
.confucius-artifact-window .confucius-artifact-dialog-body:focus { outline: none; }
.confucius-artifact-window .confucius-artifact-shell { width: min(680px, 100%); }
.confucius-artifact-window .confucius-artifact-paper { margin: 0; padding: 8px 0 0; }
.confucius-artifact-title { margin: 0 0 24px; font-size: 1.9em; font-weight: 600; line-height: 1.45; letter-spacing: 0; overflow-wrap: anywhere; }
.confucius-artifact-window .confucius-artifact-paper .tui-answer { line-height: var(--confucius-reading-line-height, 1.8); }
.confucius-artifact-window .confucius-artifact-paper .tui-answer :is(h1, h2, h3) { margin: 1.6em 0 .6em; line-height: 1.4; }
.confucius-artifact-window .confucius-artifact-paper .tui-answer > :first-child { margin-top: 0; }
.confucius-artifact-window a { color: var(--confucius-accent); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.confucius-artifact-window .confucius-reading-surface { overflow-x: auto; }
.confucius-artifact-references { margin-top: 40px; border: 0; padding-top: 0; font-size: .85em; }
.confucius-artifact-references summary { cursor: pointer; color: var(--confucius-muted); }
.confucius-artifact-references ol { padding-left: 22px; margin: 12px 0 0; }
.confucius-artifact-references li { margin: 8px 0; }
.confucius-artifact-references li::marker { color: var(--confucius-muted); }
.confucius-artifact-window .confucius-artifact-paper .tui-answer :is(table, pre, .katex-display) { overflow-x: auto; }
.confucius-artifact-window .confucius-reading-surface hr { border: 0; height: 0; background: transparent; margin: 24px 0; }
.confucius-artifact-empty { color: var(--confucius-muted); font-size: .92em; padding: 12px 0 4px; }
.confucius-artifact-locate { margin-inline-start: 8px; color: var(--confucius-accent); }
@media (width < 620px) {
  .confucius-artifact-toolbar { align-items: stretch; flex-direction: column; gap: 6px; padding: 8px; min-height: 0; }
  .confucius-artifact-header-context { min-height: 24px; }
  .confucius-artifact-header-actions { flex-wrap: wrap; gap: 4px; width: 100%; }
  .confucius-artifact-toolbar .confucius-button { height: auto; font-size: 12px; }
  .confucius-artifact-window-error { padding: 8px; }
  .confucius-artifact-window .confucius-artifact-dialog-body { padding-inline: 10px; }
}
@media (width < 300px) { .confucius-artifact-toolbar .confucius-button { padding: 5px 4px; } }
`;
