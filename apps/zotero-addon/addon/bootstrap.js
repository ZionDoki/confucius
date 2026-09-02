/**
 * Zotero 7 bootstrap. Pattern from the Zotero 7 developer docs.
 */

var chromeHandle;

function install(data, reason) {}

function formatBootstrapError(error) {
  if (error && (error.stack || error.message)) {
    return error.stack || error.message;
  }
  if (error === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(error);
  } catch (e) {
    return String(error);
  }
}

function logBootstrapError(label, error) {
  Zotero.debug(`[Confucius] ${label}: ${formatBootstrapError(error)}`);
}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "content/"],
  ]);

  const ctx = { rootURI };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/__addonRef__.js`,
    ctx,
  );
  try {
    const instance = Zotero.__addonInstance__;
    if (!instance?.hooks?.onStartup) {
      throw new Error("Confucius plugin instance missing hooks.onStartup");
    }
    await instance.hooks.onStartup();
  } catch (error) {
    logBootstrapError("startup failed", error);
  }
}

async function onMainWindowLoad({ window }, reason) {
  try {
    await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
  } catch (error) {
    logBootstrapError("main window load failed", error);
  }
}

async function onMainWindowUnload({ window }, reason) {
  try {
    await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
  } catch (error) {
    logBootstrapError("main window unload failed", error);
  }
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    try {
      await Zotero.__addonInstance__?.hooks.onAppShutdown?.();
    } catch (error) {
      logBootstrapError("app shutdown failed", error);
    }
    return;
  }

  try {
    await Zotero.__addonInstance__?.hooks?.onShutdown?.();
  } catch (error) {
    logBootstrapError("shutdown failed", error);
  }

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
