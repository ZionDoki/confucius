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
  assert.equal(source.includes("openWorkspaceSidebar"), true);
  assert.equal(source.includes("setWorkspaceLayout"), true);
  assert.equal(source.includes("mountWorkspace"), true);
  assert.equal(source.includes("workspace-app.js"), false);
  assert.equal(view.includes('id: "confucius-prompt"'), true);
  assert.equal(view.includes('type: "text"'), true);
  assert.equal(view.includes("createElementNS"), true);
  assert.equal(view.includes('minHeight: "40px"'), true);
  assert.equal(view.includes('id: "confucius-layout"'), true);
  assert.equal(view.includes("workspace-layout-sidebar"), true);
});

test("plugin instance keeps bootstrap hooks and is not overwritten by AgentHost", () => {
  const hooks = readFileSync(join(root, "src/hooks.ts"), "utf8");
  const index = readFileSync(join(root, "src/index.ts"), "utf8");
  const addon = readFileSync(join(root, "src/addon.ts"), "utf8");
  assert.equal(hooks.includes("Zotero.Confucius = host"), false);
  assert.equal(index.includes("?.hooks"), true);
  assert.equal(addon.includes("this.hooks.host.rpc"), true);
});

test("toolbar icon uses toggleWorkspace so a second click can close the sidebar", () => {
  const toolbar = readFileSync(join(root, "src/modules/ui/toolbar.ts"), "utf8");
  const source = readFileSync(
    join(root, "src/modules/ui/workspaceWindow.ts"),
    "utf8",
  );
  const toggle = readFileSync(
    join(root, "src/modules/ui/workspaceToggle.ts"),
    "utf8",
  );
  assert.equal(toolbar.includes("toggleWorkspace"), true);
  assert.equal(toolbar.includes("openWorkspace()"), false);
  assert.equal(source.includes("workspaceIconAction"), true);
  assert.equal(source.includes("closeWorkspaceSidebar(main)"), true);
  assert.equal(toggle.includes('"close"'), true);
});

test("workspace layout can switch between window and sidebar", () => {
  const source = readFileSync(
    join(root, "src/modules/ui/workspaceWindow.ts"),
    "utf8",
  );
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const chrome = readFileSync(
    join(root, "..", "chrome-extension", "workspace-app.js"),
    "utf8",
  );
  const chromeCss = readFileSync(
    join(root, "..", "chrome-extension", "workspace.css"),
    "utf8",
  );
  const prefs = readFileSync(join(root, "addon/prefs.js"), "utf8");
  assert.equal(prefs.includes('pref("workspaceLayout", "sidebar")'), true);
  assert.equal(source.includes('SIDEBAR_ID = "confucius-sidebar"'), true);
  assert.equal(source.includes("closeWorkspaceDialog(source)"), true);
  assert.equal(source.includes("closeOtherWorkspaceSidebars"), true);
  assert.equal(source.includes("unmountWorkspace"), true);
  assert.equal(view.includes("confucius-toggle-sessions"), true);
  assert.equal(view.includes("data-confucius-density"), true);
  assert.equal(view.includes("ResizeObserver"), true);
  assert.equal(view.includes("workspaceLayoutIcon"), true);
  assert.equal(view.includes("workspaceSettingsIcon"), true);
  assert.equal(view.includes('className = "confucius-icon-button"'), true);
  assert.equal(chrome.includes("layout-sidebar"), true);
  assert.equal(chrome.includes("confuciusLayout"), true);
  assert.equal(chrome.includes('layout: "sidebar"'), true);
  assert.equal(chrome.includes("function layoutIcon"), true);
  assert.equal(chrome.includes('class="icon-button"'), true);
  assert.equal(chromeCss.includes(".topbar .icon-button"), true);
  assert.equal(chromeCss.includes("#layout::after"), false);
  assert.equal(chromeCss.includes("@media (max-width: 300px)"), true);
  assert.equal(chromeCss.includes("grid-template-areas"), true);
});

test("workspace probe endpoint is registered on the Zotero HTTP server", () => {
  const bridge = readFileSync(
    join(root, "src/modules/bridge/HttpBridge.ts"),
    "utf8",
  );
  assert.equal(bridge.includes("CONFUCIUS_WORKSPACE_PROBE_PATH"), true);
  assert.equal(bridge.includes("openAndInspectWorkspace"), true);
  assert.equal(
    bridge.includes("allowRequestsFromUnsafeWebContent: true"),
    true,
  );
  assert.equal(
    bridge.includes("init: (_options) => json(200, host.health())"),
    true,
  );
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
  assert.equal(host.includes("applyEndpointPatch"), true);
});

test("composer has plus menu, slash commands, context ring, single send/stop", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const chrome = readFileSync(
    join(root, "..", "chrome-extension", "workspace-app.js"),
    "utf8",
  );
  for (const source of [view, chrome]) {
    // Mode/skills/permission live in the plus menu; model lives beside the prompt.
    assert.equal(source.includes("slashCommands"), true);
    assert.equal(source.includes("session/setPermissions"), true);
    assert.equal(source.includes("session/compact"), true);
    assert.equal(source.includes("session/context"), true);
    assert.equal(source.includes("logs/list"), true);
    assert.equal(source.includes("reasoningEffort"), true);
    assert.equal(source.includes("contextWindowTokens"), true);
    assert.equal(source.includes("config/listModels"), true);
  }
  // Topbar no longer owns the mode/skill widgets.
  assert.equal(view.includes('id: "confucius-plus"'), true);
  assert.equal(view.includes('id: "confucius-endpoint"'), true);
  assert.equal(view.includes("confucius-endpoint-menu"), true);
  assert.equal(view.includes("confucius-endpoint-submenu"), true);
  assert.equal(view.includes("toggleEndpointMenu"), true);
  assert.equal(view.includes('id: "confucius-context-ring"'), true);
  assert.equal(view.includes('id: "confucius-slash-menu"'), true);
  assert.equal(chrome.includes('id="endpoint"'), true);
  assert.equal(chrome.includes("toggleModelMenu"), true);
  assert.equal(chrome.includes("model-submenu"), true);
  // One button swaps between send and stop.
  assert.equal(view.includes("updateRunningUI"), true);
  assert.equal(view.includes("workspace-waiting-model"), true);
  assert.equal(view.includes("turnAwaitingReply"), true);
  assert.equal(chrome.includes("updateSendStopButtons"), true);
});

test("pending write approvals automatically reveal the review pane", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const chrome = readFileSync(
    join(root, "..", "chrome-extension", "workspace-app.js"),
    "utf8",
  );
  for (const source of [view, chrome]) {
    assert.equal(source.includes("hadPendingApprovals"), true);
    assert.equal(source.includes("showReview = true"), true);
  }
});

test("permission changes are committed before prompts and gate auto memory", () => {
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
  for (const source of [view, chrome]) {
    assert.equal(source.includes("pendingPermissionUpdate"), true);
    assert.equal(source.includes("await pendingPermissionUpdate"), true);
  }
  assert.equal(
    host.includes('state.record.permissionMode === "auto_allow"'),
    true,
  );
});

test("settings effort control is a button group, not a native select", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  // Native select popups do not paint or click in Zotero chrome windows.
  assert.equal(view.includes("HTMLSelectElement"), false);
  assert.equal(/,\s*"select"/.test(view), false);
  assert.equal(view.includes("effortPicker"), true);
  assert.equal(view.includes('"confucius-cfg-effort"'), true);
  assert.equal(view.includes('role: "radiogroup"'), true);
});

test("timeline is TUI-style: foldable thinking/tools, unfolded answers", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const chrome = readFileSync(
    join(root, "..", "chrome-extension", "workspace-app.js"),
    "utf8",
  );
  for (const source of [view, chrome]) {
    assert.equal(source.includes("nextReasoningFold"), true);
    assert.equal(
      source.includes("tui-answer") || source.includes("renderAnswer"),
      true,
    );
    assert.equal(
      source.includes("toolsOpen") || source.includes("tui-tools"),
      true,
    );
  }
  assert.equal(view.includes("renderReasoning"), true);
  assert.equal(view.includes("justifyContent"), true);
  assert.equal(view.includes("renderMarkdownHtml"), true);
  assert.equal(view.includes("tui-waiting"), true);
  assert.equal(view.includes("followTimeline"), true);
  assert.equal(view.includes("timelinePane.scrollHeight"), true);
  assert.equal(chrome.includes("followTimeline"), true);
  assert.equal(chrome.includes("scrollHeight"), true);
  assert.equal(chrome.includes("tui-clamp-3"), true);
  assert.equal(chrome.includes("tui-thinking-clip"), true);
  assert.equal(chrome.includes("tui-waiting"), true);
  assert.equal(chrome.includes("renderAnswerHtml"), true);
  assert.equal(chrome.includes("tui-answer"), true);
  assert.equal(chrome.includes("data-reasoning"), true);
  assert.equal(chrome.includes("data-tools"), true);
});

test("composer model picker is a cascading menu, not a native select", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const chrome = readFileSync(
    join(root, "..", "chrome-extension", "workspace-app.js"),
    "utf8",
  );
  for (const source of [view, chrome]) {
    assert.equal(source.includes("config/listModels"), true);
    assert.equal(source.includes("activeEndpointId"), true);
    assert.equal(source.includes("data-model"), true);
  }
  assert.equal(view.includes("toggleEndpointMenu"), true);
  assert.equal(view.includes("openModelsSubmenu"), true);
  assert.equal(view.includes("applyModelSelection"), true);
  assert.equal(view.includes("confucius-endpoint-submenu"), true);
  assert.equal(chrome.includes("toggleModelMenu"), true);
  assert.equal(chrome.includes("model-submenu"), true);
  assert.equal(chrome.includes('id="endpoint"'), true);
  // Native select popups do not work in Zotero chrome windows.
  assert.equal(view.includes("HTMLSelectElement"), false);
});

test("settings can add and save multiple model endpoints", () => {
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
  assert.equal(view.includes("workspace-endpoint-add"), true);
  assert.equal(view.includes("deleteEndpointId"), true);
  assert.equal(chrome.includes("Add endpoint"), true);
  assert.equal(chrome.includes("deleteEndpointId"), true);
  assert.equal(host.includes("applyEndpointPatch"), true);
  assert.equal(host.includes("endpointsJson"), true);
  for (const source of [view, chrome]) {
    assert.equal(source.includes("activeEndpointId"), true);
    assert.equal(source.includes("deleteEndpointId"), true);
    assert.equal(source.includes("maxIterations"), true);
    assert.equal(source.includes("maxToolCalls"), true);
  }
  assert.equal(host.includes("maxIterations"), true);
  assert.equal(host.includes("maxToolCalls"), true);
  assert.equal(host.includes("new BudgetAccountant"), true);
});

test("both plugin workspaces expose an editable research knowledge base and mind maps", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const chrome = readFileSync(
    join(root, "..", "chrome-extension", "workspace-app.js"),
    "utf8",
  );
  const chromeCss = readFileSync(
    join(root, "..", "chrome-extension", "workspace.css"),
    "utf8",
  );
  for (const source of [view, chrome]) {
    assert.equal(source.includes("knowledge/list"), true);
    assert.equal(source.includes("knowledge/get"), true);
    assert.equal(source.includes("knowledge/saveEntry"), true);
    assert.equal(source.includes("knowledge/deleteEntry"), true);
    assert.equal(source.includes("parseMindMapOutline"), true);
    assert.equal(source.includes("mindmap-preview"), true);
  }
  assert.equal(view.includes('id: "confucius-knowledge"'), true);
  assert.equal(view.includes("workspaceKnowledgeIcon"), true);
  assert.equal(chrome.includes('id="knowledge"'), true);
  assert.equal(chrome.includes("knowledgeIcon"), true);
  assert.equal(chromeCss.includes("@media (max-width: 560px)"), true);
  assert.equal(
    chromeCss.includes(".knowledge-content-layout.is-mindmap"),
    true,
  );
});
