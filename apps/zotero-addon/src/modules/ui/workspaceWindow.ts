import { config } from "../../../package.json";
import { isWindowAlive } from "../../utils/window";
import { getPref } from "../../utils/prefs";
import {
  inspectWorkspace,
  mountWorkspace,
  type WorkspaceHost,
  type WorkspaceInspect,
} from "./WorkspaceView";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const win = Zotero.getMainWindow();
    win.setTimeout(resolve, ms);
  });
}

function getHost(): WorkspaceHost | null {
  const host = (
    Zotero as typeof Zotero & { Confucius?: WorkspaceHost }
  ).Confucius;
  return host ?? null;
}

export function bootWorkspace(win: Window): void {
  if (!isWindowAlive(win)) {
    return;
  }
  const rootEl = win.document.documentElement;
  if (!rootEl) {
    return;
  }
  if (rootEl.getAttribute("data-confucius-mounted") === "1") {
    return;
  }
  mountWorkspace(win, getHost());
  rootEl.setAttribute("data-confucius-mounted", "1");
}

export function openWorkspaceWindow(): Window | undefined {
  if (isWindowAlive(addon.data.workspaceWindow)) {
    addon.data.workspaceWindow?.focus();
    bootWorkspace(addon.data.workspaceWindow as Window);
    return addon.data.workspaceWindow;
  }

  const width = getPref("workspaceWidth") || 1100;
  const height = getPref("workspaceHeight") || 760;
  const mainWindow = Zotero.getMainWindow() as Window & {
    openDialog: (
      url: string,
      name: string,
      features: string,
    ) => Window | null;
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
      bootWorkspace(win);
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

export function closeWorkspaceWindow(): void {
  if (isWindowAlive(addon.data.workspaceWindow)) {
    addon.data.workspaceWindow?.close();
  }
  addon.data.workspaceWindow = undefined;
}

export async function openAndInspectWorkspace(): Promise<WorkspaceInspect> {
  const win = openWorkspaceWindow();
  if (!win) {
    return {
      open: false,
      title: "",
      hasRoot: false,
      hasPrompt: false,
      hasSend: false,
      promptTag: "",
      promptType: "",
      childCount: 0,
      visibleText: "",
    };
  }
  for (const ms of [0, 50, 150, 400]) {
    await delay(ms);
    try {
      bootWorkspace(win);
    } catch (error) {
      ztoolkit.log("[Confucius] workspace inspect mount failed", error);
    }
    const info = inspectWorkspace(win);
    if (info.hasPrompt && info.hasSend) {
      return info;
    }
  }
  return inspectWorkspace(win);
}
