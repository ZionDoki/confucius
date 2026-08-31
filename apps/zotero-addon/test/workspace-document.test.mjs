import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("workspace document is HTML with a visible loading fallback", () => {
  const xhtml = readFileSync(
    join(root, "addon/content/workspace.xhtml"),
    "utf8",
  );
  assert.equal(xhtml.includes("there.is.only.xul"), false);
  assert.equal(xhtml.includes('xmlns="http://www.w3.org/1999/xhtml"'), true);
  assert.equal(xhtml.includes('id="confucius-root"'), true);
  assert.equal(xhtml.includes("Loading Confucius workspace"), true);
  assert.equal(xhtml.includes("position: fixed"), true);
  assert.equal(xhtml.includes("<script"), false);
  assert.equal(xhtml.includes("there.is.only.xul"), false);
});

test("Zotero workspace UI is mounted from privileged TypeScript, not an injected script", () => {
  const source = readFileSync(
    join(root, "src/modules/ui/workspaceWindow.ts"),
    "utf8",
  );
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  assert.equal(source.includes("openDialog"), true);
  assert.equal(source.includes("mountWorkspace"), true);
  assert.equal(source.includes("workspace-app.js"), false);
  assert.equal(view.includes('id: "confucius-prompt"'), true);
  assert.equal(view.includes('type: "text"'), true);
  assert.equal(view.includes("createElementNS"), true);
  assert.equal(view.includes("minHeight: \"40px\""), true);
});

test("workspace probe endpoint is registered on the Zotero HTTP server", () => {
  const bridge = readFileSync(
    join(root, "src/modules/bridge/HttpBridge.ts"),
    "utf8",
  );
  assert.equal(bridge.includes("CONFUCIUS_WORKSPACE_PROBE_PATH"), true);
  assert.equal(bridge.includes("openAndInspectWorkspace"), true);
  assert.equal(bridge.includes("allowRequestsFromUnsafeWebContent: true"), true);
  assert.equal(bridge.includes("init: (_options) => json(200, host.health())"), true);
});

test("dev server does not launch the Firefox debugger toolbox", () => {
  const config = readFileSync(join(root, "zotero-plugin.config.ts"), "utf8");
  assert.equal(config.includes("devtools: false"), true);
});

test("workspace exposes in-window model settings and config RPC wiring", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const host = readFileSync(
    join(root, "src/modules/host/AgentHost.ts"),
    "utf8",
  );
  const chrome = readFileSync(
    join(root, "..", "chrome-extension", "workspace-app.js"),
    "utf8",
  );
  // Settings entry point in the topbar.
  assert.equal(view.includes('id: "confucius-settings"'), true);
  assert.equal(chrome.includes('id="settings"'), true);
  // Both UIs read/write config through the gated RPCs.
  for (const source of [view, chrome]) {
    assert.equal(source.includes("config/get"), true);
    assert.equal(source.includes("config/set"), true);
  }
  // Unconfigured sends surface an error instead of failing silently.
  assert.equal(view.includes("workspace-config-banner"), true);
  assert.equal(chrome.includes("sendError"), true);
  assert.equal(host.includes("configGet"), true);
  assert.equal(host.includes("validateConfigPatch"), true);
});
