import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const workspaceUrl = "chrome://confucius/content/workspace.xhtml";
const source = await readFile(
  new URL("../src/modules/ui/workspaceWindow.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

function fixture() {
  const unmounted = [];
  const all = [];
  const addon = { data: {} };
  const prefs = { workspaceLayout: "window" };
  function window(url, id) {
    const listeners = new Map();
    const root = { id, getAttribute: () => "1" };
    const win = {
      closed: false,
      location: { href: url },
      document: {
        documentURI: url,
        getElementById: (name) =>
          name === "confucius-root" && url === workspaceUrl ? root : null,
      },
      focus() {},
      setTimeout() {},
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(callback);
      },
      removeEventListener(type, callback) {
        listeners.get(type)?.delete(callback);
      },
      emit(type, target = win.document) {
        for (const callback of [...(listeners.get(type) ?? [])])
          callback({ target });
      },
      close() {
        if (win.closed) return;
        win.emit("unload");
        win.closed = true;
      },
      openDialog() {
        return window(workspaceUrl, "workspace");
      },
      listenerCount: (type) => listeners.get(type)?.size ?? 0,
    };
    all.push(win);
    return win;
  }
  const first = window("chrome://zotero/content/zoteroPane.xhtml", "first");
  const second = window("chrome://zotero/content/zoteroPane.xhtml", "second");
  let current = first;
  const modules = {
    "../../../package.json": { config: { addonRef: "confucius" } },
    "../../utils/window": { isWindowAlive: (win) => win && !win.closed },
    "../../utils/prefs": {
      getPref: (key) => prefs[key],
      setPref: (key, value) => (prefs[key] = value),
    },
    "./WorkspaceView": {
      mountWorkspace() {},
      unmountWorkspace(root) {
        if (root) unmounted.push(root.id);
      },
    },
    "./workspaceToggle": { isWorkspaceSidebarVisible: () => false },
    "./workspaceReload": {},
    "./workspaceSurface": { ensurePaletteStyles() {} },
  };
  const context = {
    exports: {},
    addon,
    Zotero: {
      getMainWindow: () => current,
      getMainWindows: () => [first, second].filter((win) => !win.closed),
    },
    Services: { wm: { getEnumerator: () => all.filter((win) => !win.closed) } },
    ztoolkit: { log() {} },
    require: (name) => {
      assert.ok(modules[name], name);
      return modules[name];
    },
  };
  vm.runInNewContext(compiled, context);
  return {
    api: context.exports,
    first,
    second,
    addon,
    unmounted,
    current: (win) => (current = win),
  };
}

test("closing the owning library closes its workspace and disposes its view", () => {
  const f = fixture();
  const win = f.api.openWorkspaceWindow();
  f.first.close();
  assert.equal(win.closed, true);
  assert.ok(f.unmounted.includes("workspace"));
  assert.equal(f.addon.data.workspaceWindow, undefined);
  assert.equal(f.addon.data.workspaceOwnerWindow, undefined);
  assert.equal(f.first.listenerCount("unload"), 0);
});

test("closing a different library or a nested document preserves the workspace", () => {
  const f = fixture();
  const win = f.api.openWorkspaceWindow();
  f.api.closeWorkspaceForMainWindow(f.second);
  f.second.close();
  f.first.emit("unload", { documentURI: "about:blank" });
  // The embedded editor uses the same URL as the owning chrome window.
  win.emit("unload", { documentURI: workspaceUrl });
  assert.equal(win.closed, false);
  assert.equal(f.addon.data.workspaceWindow, win);
  assert.equal(f.addon.data.workspaceOwnerWindow, f.first);
});

test("initial blank-document replacement preserves ownership, while manual close releases it", () => {
  const f = fixture();
  const win = f.api.openWorkspaceWindow();
  win.emit("unload", { documentURI: "about:blank" });
  assert.equal(f.addon.data.workspaceWindow, win);
  assert.equal(f.first.listenerCount("unload"), 1);
  win.close();
  assert.equal(f.addon.data.workspaceWindow, undefined);
  assert.equal(f.first.listenerCount("unload"), 0);
  f.current(f.second);
  const reopened = f.api.openWorkspaceWindow();
  f.first.close();
  assert.equal(reopened.closed, false);
  f.second.close();
  assert.equal(reopened.closed, true);
});

test("the explicit toolbar owner wins over the currently active library", () => {
  const f = fixture();
  f.current(f.second);
  const win = f.api.openWorkspace(f.first);
  f.api.closeWorkspaceForMainWindow(f.second);
  assert.equal(win.closed, false);
  f.api.closeWorkspaceForMainWindow(f.first);
  assert.equal(win.closed, true);
});

test("a missing library window prevents opening rather than dereferencing null", () => {
  const f = fixture();
  f.current(null);
  assert.equal(f.api.openWorkspaceWindow(), undefined);
  assert.equal(f.addon.data.workspaceWindow, undefined);
});

test("plugin-wide cleanup releases ownership and can run repeatedly", () => {
  const f = fixture();
  const win = f.api.openWorkspaceWindow();
  f.api.closeWorkspaceWindow();
  f.api.closeWorkspaceWindow();
  assert.equal(win.closed, true);
  assert.equal(f.first.listenerCount("unload"), 0);
});
