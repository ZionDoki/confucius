import { config } from "../../../package.json";
import { isWindowAlive } from "../../utils/window";
import { getPref, setPref } from "../../utils/prefs";
import {
  mountWorkspace,
  unmountWorkspace,
  type WorkspaceHost,
  type WorkspaceLayout,
} from "./WorkspaceView";
import {
  isWorkspaceSidebarVisible,
  workspaceIconAction,
} from "./workspaceToggle";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SIDEBAR_ID = "confucius-sidebar";
const SPLITTER_ID = "confucius-sidebar-splitter";
const ROOT_ID = "confucius-root";
const DEFAULT_SIDEBAR_WIDTH = 400;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 720;

const sidebarCleanups = new WeakMap<HTMLElement, () => void>();

function getHost(): WorkspaceHost | null {
  const plugin = Zotero as typeof Zotero & {
    Confucius?: WorkspaceHost & { hooks?: { host?: WorkspaceHost } };
  };
  const candidate = plugin.Confucius;
  if (candidate && typeof candidate.rpc === "function") {
    return candidate;
  }
  return candidate?.hooks?.host ?? null;
}

export function getWorkspaceLayout(): WorkspaceLayout {
  return getPref("workspaceLayout") === "window" ? "window" : "sidebar";
}

export function bootWorkspace(
  win: Window,
  root?: HTMLElement | null,
  layout: WorkspaceLayout = "window",
): void {
  if (!isWindowAlive(win)) {
    return;
  }
  const mountRoot =
    root ||
    (win.document.getElementById(ROOT_ID) as HTMLElement | null) ||
    undefined;
  if (!mountRoot) {
    return;
  }
  if (
    mountRoot.getAttribute("data-confucius-booted") === "1" &&
    mountRoot.getAttribute("data-confucius-layout") === layout
  ) {
    return;
  }
  mountWorkspace(win, getHost(), {
    root: mountRoot,
    layout,
    onLayoutChange: (nextLayout) => setWorkspaceLayout(nextLayout, win),
  });
  mountRoot.setAttribute("data-confucius-booted", "1");
  mountRoot.setAttribute("data-confucius-layout", layout);
}

export function openWorkspace(): Window | undefined {
  return getWorkspaceLayout() === "sidebar"
    ? openWorkspaceSidebar()
    : openWorkspaceWindow();
}

/** Toolbar icon: open the workspace, or collapse the sidebar if it is already shown. */
export function toggleWorkspace(win?: Window): Window | undefined {
  const main = win ?? Zotero.getMainWindow();
  const sidebarVisible = isWorkspaceSidebarVisible(main.document);
  const action = workspaceIconAction({
    layout: getWorkspaceLayout(),
    sidebarVisible,
  });
  ztoolkit.log("[Confucius] toolbar toggle", {
    action,
    layout: getWorkspaceLayout(),
    sidebarVisible,
  });
  if (action === "close") {
    closeWorkspaceSidebar(main);
    return undefined;
  }
  return openWorkspace();
}

function mainWindows(): Window[] {
  try {
    return Zotero.getMainWindows();
  } catch {
    return [];
  }
}

function closeWorkspaceDialog(source?: Window): void {
  const mainWindowSet = new Set(mainWindows());
  const candidates = new Set<Window>();
  if (source) {
    candidates.add(source);
  }
  if (addon.data.workspaceWindow) {
    candidates.add(addon.data.workspaceWindow);
  }
  for (const candidate of candidates) {
    if (mainWindowSet.has(candidate) || !isWindowAlive(candidate)) {
      continue;
    }
    candidate.close();
  }
  addon.data.workspaceWindow = undefined;
}

function closeOtherWorkspaceSidebars(active?: Window): void {
  for (const main of mainWindows()) {
    if (main !== active) {
      closeWorkspaceSidebar(main);
    }
  }
}

export function setWorkspaceLayout(
  layout: WorkspaceLayout,
  source?: Window,
): void {
  setPref("workspaceLayout", layout);
  if (layout === "sidebar") {
    closeWorkspaceDialog(source);
    openWorkspaceSidebar();
    return;
  }
  if (source && mainWindows().includes(source)) {
    closeWorkspaceSidebar(source);
  }
  openWorkspaceWindow();
}

export function openWorkspaceWindow(): Window | undefined {
  closeOtherWorkspaceSidebars();
  if (isWindowAlive(addon.data.workspaceWindow)) {
    addon.data.workspaceWindow?.focus();
    bootWorkspace(addon.data.workspaceWindow as Window, undefined, "window");
    return addon.data.workspaceWindow;
  }

  const width = getPref("workspaceWidth") || 1100;
  const height = getPref("workspaceHeight") || 760;
  const mainWindow = Zotero.getMainWindow() as Window & {
    openDialog: (url: string, name: string, features: string) => Window | null;
  };
  const win = mainWindow.openDialog(
    `chrome://${config.addonRef}/content/workspace.xhtml`,
    `${config.addonRef}-workspace`,
    `chrome,dialog=no,centerscreen,resizable=yes,width=${width},height=${height}`,
  );
  if (!win) {
    ztoolkit.log("[Confucius] failed to open workspace window");
    return undefined;
  }

  const start = () => {
    try {
      bootWorkspace(win, undefined, "window");
    } catch (error) {
      ztoolkit.log("[Confucius] workspace mount failed", error);
    }
  };
  win.addEventListener("DOMContentLoaded", start);
  win.addEventListener("load", start);
  mainWindow.setTimeout(start, 0);
  mainWindow.setTimeout(start, 50);
  mainWindow.setTimeout(start, 200);
  mainWindow.setTimeout(start, 500);

  win.addEventListener("unload", () => {
    if (addon.data.workspaceWindow === win) {
      addon.data.workspaceWindow = undefined;
    }
  });

  addon.data.workspaceWindow = win;
  return win;
}

function sidebarHost(doc: Document): HTMLElement | null {
  const context = doc.getElementById("zotero-context-pane");
  if (context?.parentElement) {
    return context.parentElement as HTMLElement;
  }
  const item = doc.getElementById("zotero-item-pane");
  if (item?.parentElement) {
    return item.parentElement as HTMLElement;
  }
  return (
    (doc.getElementById("zotero-layout") as HTMLElement | null) ||
    (doc.getElementById("zotero-pane") as HTMLElement | null)
  );
}

function bindSplitter(
  win: Window,
  splitter: HTMLElement,
  pane: HTMLElement,
): () => void {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  const onMouseDown = (event: Event) => {
    const mouse = event as MouseEvent;
    dragging = true;
    startX = mouse.clientX;
    startWidth = pane.getBoundingClientRect().width;
    mouse.preventDefault();
  };
  const onMouseMove = (event: Event) => {
    if (!dragging) {
      return;
    }
    const mouse = event as MouseEvent;
    const next = clampSidebarWidth(win, startWidth + (startX - mouse.clientX));
    pane.style.width = `${next}px`;
    pane.style.flex = `0 0 ${next}px`;
  };
  const onMouseUp = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    setPref(
      "workspaceSidebarWidth",
      Math.round(pane.getBoundingClientRect().width),
    );
  };
  splitter.addEventListener("mousedown", onMouseDown);
  win.addEventListener("mousemove", onMouseMove);
  win.addEventListener("mouseup", onMouseUp);
  return () => {
    dragging = false;
    splitter.removeEventListener("mousedown", onMouseDown);
    win.removeEventListener("mousemove", onMouseMove);
    win.removeEventListener("mouseup", onMouseUp);
  };
}

function sidebarWidthBounds(win: Window): { min: number; max: number } {
  const viewport = Math.max(0, win.innerWidth || 0);
  const usable = Math.max(160, viewport - 160);
  const min = Math.min(MIN_SIDEBAR_WIDTH, usable);
  const max = Math.max(
    min,
    Math.min(MAX_SIDEBAR_WIDTH, usable, Math.floor(viewport * 0.72)),
  );
  return { min, max };
}

function clampSidebarWidth(win: Window, value: number): number {
  const bounds = sidebarWidthBounds(win);
  const requested = Number.isFinite(value) ? value : DEFAULT_SIDEBAR_WIDTH;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, requested)));
}

function bindSidebarSizing(win: Window, pane: HTMLElement): () => void {
  const sync = () => {
    const current =
      pane.getBoundingClientRect().width ||
      Number.parseFloat(pane.style.width) ||
      DEFAULT_SIDEBAR_WIDTH;
    const bounds = sidebarWidthBounds(win);
    const next = clampSidebarWidth(win, current);
    pane.style.minWidth = "0px";
    pane.style.maxWidth = `${bounds.max}px`;
    pane.style.width = `${next}px`;
    pane.style.flex = `0 0 ${next}px`;
  };
  win.addEventListener("resize", sync);
  const cleanup = () => {
    win.removeEventListener("resize", sync);
  };
  sync();
  return cleanup;
}

export function openWorkspaceSidebar(win?: Window): Window | undefined {
  const main = win ?? Zotero.getMainWindow();
  if (!isWindowAlive(main)) {
    return undefined;
  }
  closeWorkspaceDialog();
  closeOtherWorkspaceSidebars(main);
  const doc = main.document;
  const existing = doc.getElementById(SIDEBAR_ID) as HTMLElement | null;
  if (existing) {
    existing.hidden = false;
    const splitter = doc.getElementById(SPLITTER_ID) as HTMLElement | null;
    if (splitter) {
      splitter.hidden = false;
    }
    const root = existing.querySelector(`#${ROOT_ID}`) as HTMLElement | null;
    try {
      bootWorkspace(main, root, "sidebar");
    } catch (error) {
      ztoolkit.log("[Confucius] sidebar remount failed", error);
    }
    return main;
  }

  const host = sidebarHost(doc);
  if (!host) {
    ztoolkit.log("[Confucius] no host for sidebar; opening a window");
    return openWorkspaceWindow();
  }

  const width = clampSidebarWidth(
    main,
    Number(getPref("workspaceSidebarWidth")) || DEFAULT_SIDEBAR_WIDTH,
  );
  const splitter = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  splitter.id = SPLITTER_ID;
  Object.assign(splitter.style, {
    width: "5px",
    flex: "0 0 5px",
    cursor: "col-resize",
    background: "#e5e1d8",
    alignSelf: "stretch",
  });

  const pane = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  pane.id = SIDEBAR_ID;
  Object.assign(pane.style, {
    flex: `0 0 ${width}px`,
    width: `${width}px`,
    minWidth: "0px",
    maxWidth: `${MAX_SIDEBAR_WIDTH}px`,
    height: "100%",
    alignSelf: "stretch",
    position: "relative",
    overflow: "hidden",
    zIndex: "6",
    boxSizing: "border-box",
    borderLeft: "1px solid #e5e1d8",
    background: "#f5f3ee",
  });

  const root = doc.createElementNS(HTML_NS, "div") as HTMLElement;
  root.id = ROOT_ID;
  Object.assign(root.style, {
    width: "100%",
    height: "100%",
    position: "relative",
  });
  pane.appendChild(root);

  let display: string;
  try {
    display = main.getComputedStyle(host)?.display || "";
  } catch {
    display = "";
  }
  if (display !== "flex" && display !== "inline-flex") {
    host.style.display = "flex";
    host.style.flexDirection = "row";
    host.style.alignItems = "stretch";
  }

  host.appendChild(splitter);
  host.appendChild(pane);
  const cleanupSplitter = bindSplitter(main, splitter, pane);
  const cleanupSizing = bindSidebarSizing(main, pane);
  sidebarCleanups.set(pane, () => {
    cleanupSplitter();
    cleanupSizing();
  });

  try {
    bootWorkspace(main, root, "sidebar");
  } catch (error) {
    ztoolkit.log("[Confucius] sidebar mount failed", error);
  }
  return main;
}

export function closeWorkspaceSidebar(win?: Window): void {
  const main = win ?? Zotero.getMainWindow();
  try {
    const pane = main.document.getElementById(SIDEBAR_ID) as HTMLElement | null;
    if (pane) {
      unmountWorkspace(pane.querySelector(`#${ROOT_ID}`) as HTMLElement | null);
      sidebarCleanups.get(pane)?.();
      sidebarCleanups.delete(pane);
      pane.remove();
    }
    main.document.getElementById(SPLITTER_ID)?.remove();
  } catch {
    // Main window may already be gone.
  }
}

export function closeWorkspaceWindow(): void {
  closeWorkspaceDialog();
  for (const main of mainWindows()) {
    closeWorkspaceSidebar(main);
  }
}
