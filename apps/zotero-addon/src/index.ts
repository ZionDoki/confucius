import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";
import { installWebPlatform } from "./utils/webPlatform";

// loadSubScript sandbox is not a Window; AbortController/fetch live on the
// main window. Copy them across (with a polyfill fallback) before any prompt.
installWebPlatform(_globalThis);

const basicTool = new BasicTool();

const instanceKey = config.addonInstance;
const ZoteroGlobal = basicTool.getGlobal("Zotero") as typeof Zotero &
  Record<string, { hooks?: unknown } | undefined>;
// A leftover AgentHost from a previous overwrite has no bootstrap hooks.
if (!ZoteroGlobal[instanceKey]?.hooks) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  ZoteroGlobal[instanceKey] = _globalThis.addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => unknown): void;
function defineGlobal(name: string, getter?: () => unknown) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
