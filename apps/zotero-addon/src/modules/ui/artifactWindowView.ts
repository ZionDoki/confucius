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
import { createWorkspaceButton } from "./workspaceControls";
import { createMenuSurface, bindMenuNavigation } from "./workspaceMenus";
import { ensurePaletteStyles } from "./workspaceSurface";
import { ensureScrollbarStyles } from "./workspaceScrollbars";
import { TUI_CSS } from "./workspaceTheme";
import { showArtifactWriteback } from "./artifactWriteback";

const NS = "http://www.w3.org/1999/xhtml";
export interface ArtifactWindowView {
  select(revision?: number): void;
  dispose(): void;
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
  revisionButton.setAttribute("aria-expanded", "false");
  const status = element("span", "confucius-artifact-window-status");
  status.setAttribute("role", "status");
  const writeback = createWorkspaceButton(
    doc,
    "confucius-artifact-writeback",
    "",
  );
  writeback.disabled = true;
  toolbar.append(revisionButton, status, writeback);
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
    target: { libraryID?: number; key: string; pageIndex?: number },
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
    doc.title = `${artifact.title} — Confucius`;
    toolbar.setAttribute("aria-label", getString("workspace-artifact-actions"));
    revisionButton.textContent = `${getString("workspace-artifact-version")} ${revision.revision} · ${getString(selected === undefined ? "workspace-artifact-latest" : "workspace-artifact-history")} ▾`;
    revisionButton.title = getString("workspace-artifact-revision");
    writeback.textContent = getString("workspace-writeback");
    writeback.disabled =
      !taskStatus ||
      ["running", "awaiting_approval"].includes(taskStatus) ||
      artifact.writeback?.state === "pending";
    writeback.title = getString(
      writeback.disabled
        ? artifact.writeback?.state === "pending"
          ? "workspace-writeback-disabled-pending"
          : "workspace-writeback-disabled-running"
        : "workspace-writeback",
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
    const reading = renderReadingSurface(doc, revision.body, {
      fillAnswerHtml,
      locateLink,
    });
    if (reading.firstElementChild?.localName !== "h1") paper.append(title);
    paper.append(reading);
    if (revision.citations.length) {
      const references = element("details", "confucius-artifact-references");
      const summary = element("summary");
      summary.textContent = `${getString("workspace-artifact-citations")} · ${revision.citations.length}`;
      references.append(summary);
      const list = element("ol");
      for (const citation of revision.citations) {
        const row = element("li");
        const quote = element("span");
        quote.textContent =
          citation.quote || citation.section || citation.itemKey;
        row.append(
          quote,
          locateLink(doc, {
            libraryID: citation.itemLibraryID,
            key: citation.itemKey,
            pageIndex:
              citation.page === undefined ? undefined : citation.page - 1,
          }),
        );
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
        win.close();
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
      win.close();
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
.confucius-artifact-toolbar { display: flex; flex: 0 0 auto; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--confucius-line); }
.confucius-artifact-window-status { flex: 1; color: var(--confucius-muted); font-size: .85em; }
.confucius-artifact-window-error { padding: 10px 20px; color: var(--confucius-danger); font-size: .9em; }
.confucius-artifact-window-error:empty { display: none; }
.confucius-artifact-window .confucius-artifact-dialog-body { flex: 1; height: auto; padding: 24px clamp(20px, 5vw, 56px) 48px; }
.confucius-artifact-window .confucius-artifact-shell { width: min(800px, 100%); }
.confucius-artifact-window .confucius-artifact-paper { margin: 0; padding: 16px 0 32px; }
.confucius-artifact-title { margin: 0 0 28px; font-size: 1.8em; line-height: 1.3; overflow-wrap: anywhere; }
.confucius-artifact-window a { color: var(--confucius-accent); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.confucius-artifact-window .confucius-reading-surface { overflow-x: auto; }
.confucius-artifact-references { margin-top: 32px; border-top: 1px solid var(--confucius-line); padding-top: 16px; }
.confucius-artifact-references summary { cursor: pointer; color: var(--confucius-secondary); }
.confucius-artifact-references li { margin: 12px 0; }
.confucius-artifact-locate { margin-inline-start: 8px; color: var(--confucius-accent); }
@media (max-width: 540px) { .confucius-artifact-toolbar { gap: 8px; padding: 8px; flex-wrap: wrap; } .confucius-artifact-window-status { order: 3; flex-basis: 100%; padding: 0 8px; } #confucius-artifact-writeback { margin-inline-start: auto; } }
`;
