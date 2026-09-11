import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import {
  registerHttpBridge,
  unregisterHttpBridge,
} from "./modules/bridge/HttpBridge";
import { ensurePairingToken } from "./modules/bridge/pairingToken";
import {
  registerToolbarButton,
  unregisterToolbarButton,
} from "./modules/ui/toolbar";
import {
  registerReaderContextMenu,
  unregisterReaderContextMenu,
} from "./modules/ui/readerContextMenu";
import { registerItemMenu, unregisterItemMenu } from "./modules/ui/itemMenu";
import {
  closeWorkspaceSidebar,
  closeWorkspaceWindow,
  consumeWorkspaceReload,
  rememberWorkspaceForReload,
  restoreWorkspaceAfterReload,
} from "./modules/ui/workspaceWindow";
import { AgentHost } from "./modules/host/AgentHost";
import { disposeAppearanceBindings } from "./modules/ui/workspaceAppearance";
import { artifactWindows } from "./modules/ui/artifactWindow";
import {
  bindPrefsWindow,
  registerPreferencePane,
} from "./modules/preferences/prefsPane";

const host = new AgentHost();

async function onStartup(isUpdate = false, isInstall = false) {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  if (!addon.data.alive) return;

  // Zotero can notify startup as ADDON_INSTALL after an update shutdown.
  const workspaceReload = consumeWorkspaceReload(isUpdate || isInstall);
  // An older add-on may have left a window bound to its disposed host.
  cleanup(closeWorkspaceWindow, "previous workspace windows");
  initLocale();
  ensurePairingToken();
  await host.start(isUpdate || workspaceReload !== undefined);
  if (!addon.data.alive) return;
  registerHttpBridge(host);
  try {
    registerReaderContextMenu();
  } catch (error) {
    ztoolkit.log("[Confucius] reader context-menu registration failed", error);
  }
  try {
    await registerPreferencePane();
  } catch (error) {
    // A failed pane registration must not take down startup; the workspace
    // settings dialog covers configuration without it.
    ztoolkit.log("[Confucius] preference pane registration failed", error);
  }

  if (!addon.data.alive) return;

  for (const win of Zotero.getMainWindows()) {
    try {
      await onMainWindowLoad(win);
    } catch (error) {
      ztoolkit.log("[Confucius] main window load failed", error);
    }
  }

  addon.data.initialized = true;
  if (workspaceReload)
    cleanup(
      () => restoreWorkspaceAfterReload(workspaceReload),
      "workspace update restoration",
    );
  ztoolkit.log(`[${config.addonName}] started`);
}

async function onMainWindowLoad(win: Window): Promise<void> {
  if (!addon.data.alive) return;
  try {
    registerToolbarButton(win);
  } catch (error) {
    ztoolkit.log("[Confucius] toolbar registration failed", error);
  }
  try {
    registerItemMenu(win);
  } catch (error) {
    ztoolkit.log("[Confucius] item menu registration failed", error);
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  cleanup(() => unregisterToolbarButton(win), "toolbar");
  cleanup(() => unregisterItemMenu(win), "item menu");
  cleanup(() => closeWorkspaceSidebar(win), "sidebar");
}

async function onShutdown(isUpdate = false): Promise<void> {
  if (!addon.data.alive) return;
  cleanup(
    () => rememberWorkspaceForReload(isUpdate),
    "workspace update handoff",
  );
  addon.data.alive = false;
  cleanup(unregisterHttpBridge, "HTTP bridge");
  for (const win of Zotero.getMainWindows()) await onMainWindowUnload(win);
  cleanup(closeWorkspaceWindow, "workspace window");
  cleanup(() => artifactWindows.closeAll(), "artifact windows");
  cleanup(disposeAppearanceBindings, "appearance bindings");
  cleanup(unregisterReaderContextMenu, "reader context menu");
  try {
    await host.shutdown();
  } catch (error) {
    ztoolkit.log("[Confucius] Runtime Host shutdown failed", error);
  }
  cleanup(() => addon.data.ztoolkit.unregisterAll(), "toolkit");
  // @ts-expect-error Plugin instance is removed on shutdown.
  delete Zotero[addon.data.config.addonInstance];
}

function cleanup(dispose: () => void, name: string): void {
  try {
    dispose();
  } catch (error) {
    ztoolkit.log(`[Confucius] ${name} cleanup failed`, error);
  }
}

function onPrefsEvent(type: string, data: { window: Window }): void {
  if (type === "load") {
    bindPrefsWindow(data.window);
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
  host,
};
