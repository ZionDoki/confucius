import {
  registerAnnotationBatchFilter,
  unregisterAnnotationBatchFilter,
} from "./modules/ui/annotationBatchFilter";
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
} from "./modules/ui/workspaceWindow";
import { AgentHost } from "./modules/host/AgentHost";
import { disposeAppearanceBindings } from "./modules/ui/workspaceAppearance";
import { artifactWindows } from "./modules/ui/artifactWindow";
import {
  bindPrefsWindow,
  registerPreferencePane,
} from "./modules/preferences/prefsPane";

const host = new AgentHost();

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  if (!addon.data.alive) return;

  initLocale();
  ensurePairingToken();
  await host.start();
  if (!addon.data.alive) return;
  registerHttpBridge(host);
  try {
    registerReaderContextMenu();
    registerAnnotationBatchFilter((method, params) => host.rpc(method, params));
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

async function onShutdown(): Promise<void> {
  if (!addon.data.alive) return;
  addon.data.alive = false;
  cleanup(unregisterHttpBridge, "HTTP bridge");
  for (const win of Zotero.getMainWindows()) await onMainWindowUnload(win);
  cleanup(closeWorkspaceWindow, "workspace window");
  cleanup(() => artifactWindows.closeAll(), "artifact windows");
  cleanup(disposeAppearanceBindings, "appearance bindings");
  cleanup(unregisterAnnotationBatchFilter, "annotation batch filter");
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
