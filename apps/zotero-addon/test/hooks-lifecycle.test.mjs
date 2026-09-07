import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { URL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(
  new URL("../src/hooks.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

function fixture({ failShutdown = false, failToolbar = false } = {}) {
  const calls = [];
  const windows = [{ id: "first" }, { id: "second" }];
  const registered = new Map(windows.map((win) => [win, new Set()]));
  const toolkit = {
    unregisterAll() {
      calls.push("toolkit.dispose");
    },
  };
  const addon = {
    data: {
      alive: true,
      config: { addonInstance: "Confucius" },
      ztoolkit: toolkit,
    },
  };
  let hostStart = async () => {};
  const modules = {
    "../package.json": { config: { addonName: "Confucius" } },
    "./utils/locale": { initLocale() {} },
    "./utils/ztoolkit": {
      createZToolkit() {
        throw new Error("Window load must reuse the Addon toolkit");
      },
    },
    "./modules/bridge/HttpBridge": {
      registerHttpBridge() {
        calls.push("http.register");
      },
      unregisterHttpBridge() {
        calls.push("http.dispose");
      },
    },
    "./modules/bridge/pairingToken": { ensurePairingToken() {} },
    "./modules/ui/toolbar": {
      registerToolbarButton(win) {
        registered.get(win).add("toolbar");
      },
      unregisterToolbarButton(win) {
        calls.push(`toolbar.dispose.${win.id}`);
        registered.get(win).delete("toolbar");
        if (failToolbar) throw new Error("window closed");
      },
    },
    "./modules/ui/itemMenu": {
      registerItemMenu(win) {
        registered.get(win).add("item-menu");
      },
      unregisterItemMenu(win) {
        calls.push(`menu.dispose.${win.id}`);
        registered.get(win).delete("item-menu");
      },
    },
    "./modules/ui/annotationBatchFilter": {
      registerAnnotationBatchFilter: () => calls.push("batch-filter-register"),
      unregisterAnnotationBatchFilter: () =>
        calls.push("batch-filter-unregister"),
    },
    "./modules/ui/readerContextMenu": {
      registerReaderContextMenu() {},
      unregisterReaderContextMenu() {
        calls.push("reader.dispose");
      },
    },
    "./modules/ui/workspaceWindow": {
      closeWorkspaceSidebar(win) {
        calls.push(`sidebar.dispose.${win.id}`);
      },
      closeWorkspaceWindow() {
        calls.push("workspace.dispose");
      },
    },
    "./modules/ui/workspaceAppearance": {
      disposeAppearanceBindings() {
        calls.push("appearance.dispose");
      },
    },
    "./modules/ui/artifactWindow": {
      artifactWindows: {
        closeAll() {
          calls.push("artifacts.dispose");
        },
      },
    },
    "./modules/preferences/prefsPane": {
      registerPreferencePane: async () => {},
      bindPrefsWindow() {},
    },
    "./modules/host/AgentHost": {
      AgentHost: class {
        start() {
          return hostStart();
        }
        async shutdown() {
          calls.push("host.dispose");
          if (failShutdown) throw new Error("storage failed");
        }
      },
    },
  };
  const Zotero = { getMainWindows: () => windows, Confucius: addon };
  const context = {
    exports: {},
    addon,
    Zotero,
    ztoolkit: { log() {} },
    require: (name) => {
      if (!modules[name])
        throw new Error(`Unexpected hooks dependency: ${name}`);
      return modules[name];
    },
  };
  vm.runInNewContext(compiled, context, { filename: "hooks.ts" });
  return {
    hooks: context.exports.default,
    calls,
    windows,
    registered,
    addon,
    Zotero,
    toolkit,
    setStart: (value) => {
      hostStart = value;
    },
  };
}

it("real hooks reuse one Addon toolkit and release every main-window surface on shutdown", async () => {
  const f = fixture();
  for (const win of f.windows) {
    await f.hooks.onMainWindowLoad(win);
    await f.hooks.onMainWindowLoad(win);
  }
  assert.equal(f.addon.data.ztoolkit, f.toolkit);
  assert.deepEqual(
    [...f.registered.values()].map((value) => [...value]),
    [
      ["toolbar", "item-menu"],
      ["toolbar", "item-menu"],
    ],
  );
  await f.hooks.onShutdown();
  assert.equal(f.addon.data.alive, false);
  assert.equal(f.Zotero.Confucius, undefined);
  assert.equal(
    [...f.registered.values()].every((value) => value.size === 0),
    true,
  );
  assert.equal(
    f.calls.filter((value) => value.startsWith("sidebar.dispose")).length,
    2,
  );
  assert.equal(
    f.calls.filter((value) => value === "toolkit.dispose").length,
    1,
  );
  assert.ok(f.calls.indexOf("http.dispose") < f.calls.indexOf("host.dispose"));
  assert.equal(
    f.calls.filter((value) => value === "artifacts.dispose").length,
    1,
  );
  await f.hooks.onShutdown();
  await f.hooks.onMainWindowLoad(f.windows[0]);
  assert.equal(
    f.calls.filter((value) => value === "toolkit.dispose").length,
    1,
  );
  assert.equal(f.registered.get(f.windows[0]).size, 0);
});

it("real hooks continue cleanup after window or host disposal fails", async () => {
  const f = fixture({ failShutdown: true, failToolbar: true });
  await f.hooks.onStartup();
  await f.hooks.onShutdown();
  for (const value of [
    "menu.dispose.first",
    "sidebar.dispose.first",
    "menu.dispose.second",
    "reader.dispose",
    "appearance.dispose",
    "artifacts.dispose",
    "toolkit.dispose",
  ])
    assert.ok(f.calls.includes(value));
  assert.equal(f.Zotero.Confucius, undefined);
});

it("a startup that returns after shutdown cannot register old window handlers", async () => {
  const f = fixture();
  let release;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  f.setStart(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const starting = f.hooks.onStartup();
  await ready;
  await f.hooks.onShutdown();
  release();
  await starting;
  assert.equal(f.calls.includes("http.register"), false);
  assert.equal(
    [...f.registered.values()].every((value) => value.size === 0),
    true,
  );
});
