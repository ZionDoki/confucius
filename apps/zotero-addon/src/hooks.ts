import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
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
  closeWorkspaceSidebar,
  closeWorkspaceWindow,
} from "./modules/ui/workspaceWindow";
import { AgentHost } from "./modules/host/AgentHost";
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

  initLocale();
  ensurePairingToken();
  await host.start();
  registerHttpBridge(host);
  try {
    await registerPreferencePane();
  } catch (error) {
    // A failed pane registration must not take down startup; the workspace
    // settings dialog covers configuration without it.
    ztoolkit.log("[Confucius] preference pane registration failed", error);
  }

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
  addon.data.ztoolkit = createZToolkit();
  try {
    registerToolbarButton(win);
  } catch (error) {
    ztoolkit.log("[Confucius] toolbar registration failed", error);
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterToolbarButton(win);
  closeWorkspaceSidebar(win);
}

function onShutdown(): void {
  closeWorkspaceWindow();
  unregisterHttpBridge();
  addon.data.alive = false;
  // @ts-expect-error Plugin instance is removed on shutdown.
  delete Zotero[addon.data.config.addonInstance];
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
