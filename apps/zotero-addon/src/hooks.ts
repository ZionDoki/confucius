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
import { closeWorkspaceWindow } from "./modules/ui/workspaceWindow";
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
  // @ts-expect-error runtime host for workspace + Chrome.
  Zotero.Confucius = host;
  await registerPreferencePane();

  for (const win of Zotero.getMainWindows()) {
    await onMainWindowLoad(win);
  }

  addon.data.initialized = true;
  ztoolkit.log(`[${config.addonName}] started`);
}

async function onMainWindowLoad(win: Window): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  registerToolbarButton(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterToolbarButton(win);
}

function onShutdown(): void {
  closeWorkspaceWindow();
  unregisterHttpBridge();
  addon.data.alive = false;
  // @ts-expect-error Plugin instance is removed on shutdown.
  delete Zotero[addon.data.config.addonInstance];
  // @ts-expect-error runtime host.
  delete Zotero.Confucius;
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
