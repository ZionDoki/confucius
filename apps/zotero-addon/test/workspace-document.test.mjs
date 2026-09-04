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
});

test("HTTP bridge registers health, RPC, events, and MCP, not Chrome pair/probe", () => {
  const bridge = readFileSync(
    join(root, "src/modules/bridge/HttpBridge.ts"),
    "utf8",
  );
  assert.equal(bridge.includes("CONFUCIUS_HEALTH_PATH"), true);
  assert.equal(bridge.includes("CONFUCIUS_RPC_PATH"), true);
  assert.equal(bridge.includes("CONFUCIUS_EVENTS_PATH"), true);
  assert.equal(bridge.includes("CONFUCIUS_MCP_PATH"), true);
  assert.equal(bridge.includes("CONFUCIUS_WORKSPACE_PROBE_PATH"), false);
  assert.equal(bridge.includes("CONFUCIUS_PAIR_PATH"), false);
  assert.equal(bridge.includes("openAndInspectWorkspace"), false);
  assert.equal(
    bridge.includes("allowRequestsFromUnsafeWebContent: true"),
    true,
  );
  assert.equal(
    bridge.includes("init: (_options) => json(200, host.health())"),
    true,
  );
});

test("external runtimes are hosted in the add-on with auto and manual paths", () => {
  const host = readFileSync(
    join(root, "src/modules/host/AgentHost.ts"),
    "utf8",
  );
  const runtime = readFileSync(
    join(root, "src/modules/host/RuntimeProcess.ts"),
    "utf8",
  );
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const prefs = readFileSync(join(root, "addon/prefs.js"), "utf8");
  const prefsPane = readFileSync(
    join(root, "addon/content/preferences.xhtml"),
    "utf8",
  );
  const readme = readFileSync(join(root, "../../README.md"), "utf8");

  assert.equal(host.includes('from "./PluginRuntimeHost"'), true);
  assert.equal(host.includes('from "./SidecarClient"'), false);
  assert.equal(prefs.includes('pref("pluginRuntimeHost", true)'), true);
  assert.equal(prefs.includes('pref("codexExecutable", "")'), true);
  assert.equal(prefs.includes('pref("kimiExecutable", "")'), true);
  assert.equal(prefsPane.includes("confucius-pref-pluginRuntimeHost"), true);
  assert.equal(prefsPane.includes("confucius-pref-codexExecutable"), true);
  assert.equal(prefsPane.includes("confucius-pref-kimiExecutable"), true);
  assert.equal(view.includes("pickRuntimeExecutable"), true);
  assert.equal(
    runtime.includes('PathUtils.join(localAppData, "OpenAI", "Codex", "bin")'),
    true,
  );
  assert.equal(runtime.includes('".kimi-code", "bin", "kimi.exe"'), true);
  assert.equal(readme.includes("npm run sidecar"), false);
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
  assert.equal(view.includes('id: "confucius-settings"'), true);
  assert.equal(view.includes("config/get"), true);
  assert.equal(view.includes("config/set"), true);
  assert.equal(view.includes("workspace-config-banner"), true);
  assert.equal(host.includes("configGet"), true);
  assert.equal(host.includes("applyEndpointPatch"), true);
});

test("composer has plus menu, slash commands, context ring, single send/stop", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  assert.equal(view.includes("slashCommands"), true);
  assert.equal(view.includes("task/setPermissions"), true);
  assert.equal(view.includes("task/compact"), true);
  assert.equal(view.includes("task/context"), true);
  assert.equal(view.includes("logs/list"), true);
  assert.equal(view.includes("reasoningEffort"), true);
  assert.equal(view.includes("contextWindowTokens"), true);
  assert.equal(view.includes("config/listModels"), true);
  assert.equal(view.includes('id: "confucius-plus"'), true);
  assert.equal(view.includes('id: "confucius-endpoint"'), true);
  assert.equal(view.includes("confucius-endpoint-menu"), true);
  assert.equal(view.includes("confucius-endpoint-submenu"), true);
  assert.equal(view.includes("toggleEndpointMenu"), true);
  assert.equal(view.includes('id: "confucius-context-ring"'), true);
  assert.equal(view.includes('id: "confucius-slash-menu"'), true);
  assert.equal(view.includes('id: "confucius-attachment-tray"'), true);
  assert.equal(view.includes('rpc("attachment/prepare"'), true);
  assert.equal(view.includes('rpc("attachment/release"'), true);
  assert.equal(view.includes('root.addEventListener("drop"'), true);
  assert.equal(view.includes('composer.addEventListener("drop"'), false);
  assert.equal(view.includes("function canAcceptFileDrop"), true);
  assert.equal(view.includes("root.appendChild(dropHint)"), true);
  assert.equal(view.includes('data-file-drop-active="true"'), true);
  assert.equal(view.includes("droppedFilePaths"), true);
  assert.equal(view.includes('kind: "skill"'), true);
  assert.equal(view.includes("slashMenuToken"), true);
  const skillSelect = view.slice(view.indexOf('command.kind === "skill"'));
  const skillBlock = skillSelect.slice(
    0,
    skillSelect.indexOf("function closePlusMenu"),
  );
  assert.equal(skillBlock.includes("prompt.focus()"), true);
  assert.equal(skillBlock.includes("void sendPrompt()"), false);
  assert.equal(view.includes("workspace-skill-none"), false);
  assert.equal(view.includes("applySkill"), false);
  assert.equal(view.includes("updateRunningUI"), true);
  assert.equal(view.includes("workspace-waiting-model"), true);
  assert.equal(view.includes("turnAwaitingReply"), true);
  assert.equal(
    view.includes('const plusMenu = doc.getElementById("confucius-plus-menu")'),
    true,
  );
  assert.equal(
    view.includes(
      'const slashMenu = doc.getElementById("confucius-slash-menu")',
    ),
    true,
  );
});

test("pending approvals render as timeline cards", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  assert.equal(view.includes("renderApprovalCard"), true);
  assert.equal(view.includes("newApprovalsArrived"), true);
  assert.equal(view.includes("showReview"), false);
  assert.equal(view.includes("reviewPane"), false);
});

test("approval cards show tool + object summary, args behind a toggle", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const host = readFileSync(
    join(root, "src/modules/host/AgentHost.ts"),
    "utf8",
  );
  const summary = readFileSync(
    join(root, "src/modules/tools/approvalSummary.ts"),
    "utf8",
  );
  const enFtl = readFileSync(
    join(root, "addon/locale/en-US/addon.ftl"),
    "utf8",
  );
  const zhFtl = readFileSync(
    join(root, "addon/locale/zh-CN/addon.ftl"),
    "utf8",
  );

  // The card renders the summary line and hides raw args by default.
  assert.equal(view.includes("item.summary"), true);
  assert.equal(view.includes('getString("workspace-approval-params")'), true);
  assert.equal(view.includes("paramsOpen = false"), true);
  assert.equal(view.includes("paramsToggle.nextSibling"), true);

  // The host stamps a human summary (resolved titles, not bare keys).
  assert.equal(host.includes("describeApprovalCall"), true);
  assert.equal(host.includes("describeCall: this.describeApprovalCall"), true);
  assert.equal(summary.includes("describeCallForApproval"), true);
  assert.equal(enFtl.includes("confucius-workspace-approval-params"), true);
  assert.equal(zhFtl.includes("confucius-workspace-approval-params"), true);
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
  assert.equal(view.includes("pendingPermissionUpdate"), true);
  assert.equal(
    view.includes("pendingPermissionUpdate, pendingContextUpdate"),
    true,
  );
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
  // The effort control stays a paintable button group even though Runtime,
  // revision, and safety choices now legitimately use native selects.
  const effortBlock = view.slice(
    view.indexOf("const effortRow"),
    view.indexOf("const stream = check"),
  );
  assert.equal(/,\s*"select"/.test(effortBlock), false);
  assert.equal(view.includes("effortPicker"), true);
  assert.equal(view.includes('"confucius-cfg-effort"'), true);
  assert.equal(view.includes('role: "radiogroup"'), true);
});

test("settings are tabbed with font appearance controls", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const host = readFileSync(
    join(root, "src/modules/host/AgentHost.ts"),
    "utf8",
  );
  const prefs = readFileSync(join(root, "addon/prefs.js"), "utf8");
  assert.equal(view.includes('"confucius-cfg-tab-model"'), true);
  assert.equal(view.includes('"confucius-cfg-tab-appearance"'), true);
  assert.equal(view.includes('"confucius-cfg-font"'), true);
  assert.equal(view.includes('"confucius-cfg-font-size"'), true);
  assert.equal(view.includes("uiFont: fontChoice"), true);
  assert.equal(view.includes("uiFontSize: sizeChoice"), true);
  assert.equal(host.includes('setPref("uiFont"'), true);
  assert.equal(host.includes('setPref("uiFontSize"'), true);
  assert.equal(prefs.includes('pref("uiFont", "sans")'), true);
  assert.equal(prefs.includes('pref("uiFontSize", 13)'), true);
  assert.equal(view.includes("renderReasoning"), true);
  assert.equal(view.includes("mask-image"), true);
});

test("timeline is TUI-style: foldable thinking/tools, unfolded answers", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  assert.equal(view.includes("nextReasoningFold"), true);
  assert.equal(view.includes("renderAnswer"), true);
  assert.equal(view.includes("tui-tools") || view.includes("toolsOpen"), true);
  assert.equal(view.includes("renderReasoning"), true);
  assert.equal(view.includes("justifyContent"), true);
  assert.equal(view.includes("renderMarkdownHtml"), true);
  assert.equal(view.includes("tui-waiting"), true);
  assert.equal(view.includes("tui-waiting-bar"), false);
  assert.equal(view.includes("followTimeline"), true);
  assert.equal(view.includes("timelinePane.scrollHeight"), true);
});

test("activity stream is the primary workspace and artifacts open as files", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  assert.equal(view.includes('id: "confucius-activity-stream"'), true);
  assert.equal(view.includes("confucius-activity-shell"), true);
  assert.equal(view.includes("renderActivityOverview"), true);
  assert.equal(view.includes("renderArtifactFileBlock"), true);
  assert.equal(view.includes("confucius-artifact-file"), true);
  assert.equal(view.includes("openArtifactViewer"), true);
  assert.equal(view.includes('role: "dialog"'), true);
  assert.equal(view.includes('"aria-modal": "true"'), true);
  assert.equal(view.includes("confucius-artifact-dialog-body"), true);
  assert.equal(view.includes('key === "Escape"'), true);
  assert.equal(view.includes("confucius-activity-toggle"), false);
  assert.equal(view.includes("confucius-artifact-canvas"), false);
  assert.equal(view.includes("setActivityOpen"), false);
  assert.equal(view.includes("renderArtifactCanvas"), false);
});

test("artifact viewer uses unclipped custom menus instead of native selects", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const viewer = view.slice(
    view.indexOf("function renderArtifactViewer"),
    view.indexOf(
      "const dialogBody",
      view.indexOf("function renderArtifactViewer"),
    ),
  );
  assert.equal(view.includes("confucius-artifact-choice-menu"), true);
  assert.equal(view.includes("artifactMenuTrigger"), true);
  assert.equal(view.includes('"aria-haspopup": "listbox"'), true);
  assert.equal(view.includes('role: "option"'), true);
  assert.equal(view.includes('key === "ArrowDown"'), true);
  assert.equal(view.includes("placeMenu(anchor, menu"), true);
  assert.equal(view.includes('kind === "artifact" ? 320 : 176, "left"'), true);
  assert.equal(/,\s*"select"/.test(viewer), false);
  assert.equal(view.includes('id: "confucius-artifact-switcher",'), false);
  assert.equal(view.includes('id: "confucius-artifact-revision",'), false);
});

test("artifact viewer is a full-bleed reading surface with a right action rail", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const viewer = view.slice(
    view.indexOf("function renderArtifactViewer"),
    view.indexOf("let lastListSignature"),
  );
  assert.equal(view.includes("backdrop-filter: blur(22px)"), true);
  assert.equal(view.includes("right: 12px;"), true);
  assert.equal(viewer.includes("confucius-artifact-action-rail"), true);
  assert.equal(viewer.includes('"aria-orientation": "vertical"'), true);
  assert.equal(viewer.includes('artifactActionIcon(doc, "close")'), true);
  assert.equal(viewer.includes('artifactActionIcon(doc, "writeback")'), true);
  assert.equal(viewer.includes("confucius-artifact-dialog-header"), false);
  assert.equal(view.includes("box-shadow: none;"), true);
});

test("sidebar artifact files use a compact two-line layout", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  assert.equal(
    view.includes(
      '.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file',
    ),
    true,
  );
  assert.equal(view.includes('"title title"\n    "kind meta"'), true);
  assert.equal(view.includes("minmax(0, 1fr) minmax(0, 45%)"), true);
  assert.equal(
    view.includes(
      '[data-confucius-layout="sidebar"] .confucius-artifact-file-open {\n  display: none;',
    ),
    true,
  );
  assert.equal(view.includes("repeat(6, minmax(0, 1fr))"), false);
  assert.equal(view.includes('width: compact ? "100%" : "auto"'), false);
});

test("composer model picker is the single cascading Runtime/model control", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  assert.equal(view.includes("config/listModels"), true);
  assert.equal(view.includes("activeEndpointId"), true);
  assert.equal(view.includes("data-model"), true);
  assert.equal(view.includes("toggleEndpointMenu"), true);
  assert.equal(view.includes("openModelsSubmenu"), true);
  assert.equal(view.includes("applyModelSelection"), true);
  assert.equal(view.includes("confucius-endpoint-submenu"), true);
  const composerBlock = view.slice(
    view.indexOf('id: "confucius-endpoint"'),
    view.indexOf("const contextRing"),
  );
  assert.equal(/,\s*"select"/.test(composerBlock), false);
  assert.equal(view.includes('id: "confucius-task-runtime"'), false);
  assert.equal(view.includes("onEnter: clearEndpointSubmenuHighlight"), true);
  assert.equal(view.includes("highlighted: open"), true);
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
  assert.equal(view.includes("workspace-endpoint-add"), true);
  assert.equal(view.includes("deleteEndpointId"), true);
  assert.equal(host.includes("applyEndpointPatch"), true);
  assert.equal(host.includes("endpointsJson"), true);
  assert.equal(view.includes("activeEndpointId"), true);
  assert.equal(view.includes("maxIterations"), true);
  assert.equal(view.includes("maxToolCalls"), true);
  assert.equal(host.includes("maxIterations"), true);
  assert.equal(host.includes("maxToolCalls"), true);
  assert.equal(host.includes("new BudgetAccountant"), true);
});

test("workspace exposes an editable research knowledge base and mind maps", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  assert.equal(view.includes("knowledge/list"), true);
  assert.equal(view.includes("knowledge/get"), true);
  assert.equal(view.includes("knowledge/saveEntry"), true);
  assert.equal(view.includes("knowledge/deleteEntry"), true);
  assert.equal(view.includes("parseMindMapOutline"), true);
  assert.equal(view.includes("mindmap-preview"), true);
  assert.equal(view.includes('id: "confucius-knowledge"'), true);
  assert.equal(view.includes("workspaceKnowledgeIcon"), true);
});

test("tasks lock context and expose on-demand context controls", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const host = readFileSync(
    join(root, "src/modules/host/AgentHost.ts"),
    "utf8",
  );
  const tools = readFileSync(
    join(root, "src/modules/tools/ZoteroToolHost.ts"),
    "utf8",
  );
  const rpc = readFileSync(
    join(root, "../../packages/protocol/src/rpc.ts"),
    "utf8",
  );
  assert.equal(rpc.includes('contextLive: "context/live"'), true);
  assert.equal(rpc.includes('readerOpen: "reader/open"'), true);
  assert.equal(rpc.includes("lockedSnapshot"), true);
  assert.equal(tools.includes("export function liveReaderContext"), true);
  assert.equal(host.includes("case RPC_METHODS.contextLive"), true);
  assert.equal(host.includes("case RPC_METHODS.readerOpen"), true);
  assert.equal(host.includes("Locked task context captured at"), true);
  assert.equal(
    host.includes("Do not replace it with the live Zotero selection"),
    true,
  );
  assert.equal(host.includes("firstSelectedItem"), false);
  assert.equal(host.includes("Current Zotero selection"), false);
  assert.equal(view.includes('id: "confucius-context-bar"'), false);
  assert.equal(view.includes('rpc("context/live"'), true);
  assert.equal(view.includes('rpc("reader/open"'), true);
  assert.equal(view.includes('rpc("task/setContext"'), true);
  assert.equal(
    view.includes('section(getString("workspace-context-heading"))'),
    true,
  );
  assert.equal(view.includes('updateTaskContext("add")'), true);
  assert.equal(view.includes('updateTaskContext("replace")'), true);
  assert.equal(view.includes("suppressedSelectionKey"), false);
});

test("composer @ picker searches and incrementally adds library papers", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const host = readFileSync(
    join(root, "src/modules/host/AgentHost.ts"),
    "utf8",
  );
  const rpc = readFileSync(
    join(root, "../../packages/protocol/src/rpc.ts"),
    "utf8",
  );
  assert.equal(
    rpc.includes('contextSearchItems: "context/search-items"'),
    true,
  );
  assert.equal(host.includes("case RPC_METHODS.contextSearchItems"), true);
  assert.equal(host.includes('"quicksearch-titleCreatorYear"'), true);
  assert.equal(host.includes("Zotero.Items.getAll(libraryID, true)"), true);
  assert.equal(view.includes('id: "confucius-mention-menu"'), true);
  assert.equal(view.includes("const MENTION_PAGE_SIZE = 10"), true);
  assert.equal(view.includes('maxHeight: "258px"'), true);
  assert.equal(view.includes('list.addEventListener("scroll"'), true);
  assert.equal(view.includes('rpc("task/setContext"'), true);
});

test("reading loop: selection menu, locate links and write-back navigation", () => {
  const entry = readFileSync(
    join(root, "src/modules/ui/readerContextMenu.ts"),
    "utf8",
  );
  const hooks = readFileSync(join(root, "src/hooks.ts"), "utf8");
  const tools = readFileSync(
    join(root, "src/modules/tools/ZoteroToolHost.ts"),
    "utf8",
  );
  const host = readFileSync(
    join(root, "src/modules/host/AgentHost.ts"),
    "utf8",
  );
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const enFtl = readFileSync(
    join(root, "addon/locale/en-US/addon.ftl"),
    "utf8",
  );
  const zhFtl = readFileSync(
    join(root, "addon/locale/zh-CN/addon.ftl"),
    "utf8",
  );

  // The selection context menu is registered once from hooks. The workspace
  // has one global toolbar entry; no duplicate control is injected into the
  // PDF annotation toolbar.
  assert.equal(entry.includes("registerEventListener"), true);
  assert.equal(entry.includes('"renderToolbar"'), false);
  assert.equal(entry.includes("confucius-reader-entry"), false);
  assert.equal(entry.includes('"createSelectorContextMenu"'), true);
  assert.equal(entry.includes('"createViewContextMenu"'), true);
  assert.equal(entry.includes("captureLockedContext"), true);
  assert.equal(
    entry.includes("focusWorkspacePrompt(templateId, context)"),
    true,
  );
  assert.equal(entry.includes("openWorkspace"), true);
  assert.equal(entry.includes("confucius-prompt"), true);
  assert.equal(hooks.includes("registerReaderContextMenu()"), true);
  assert.equal(hooks.includes("unregisterReaderContextMenu()"), true);
  assert.equal(enFtl.includes("confucius-reader-entry-tooltip"), false);
  assert.equal(zhFtl.includes("confucius-reader-entry-tooltip"), false);

  // open_item location args map annotationKey to the reader's annotationID.
  assert.equal(tools.includes("function readerLocation"), true);
  assert.equal(tools.includes("annotationID: annotationKey"), true);
  assert.equal(
    tools.includes("await Zotero.Reader.open(pdf.id, location as never)"),
    true,
  );
  assert.equal(tools.includes("export async function findPdf"), true);

  // Commit write-back auto-navigates to the first new highlight.
  assert.equal(
    tools.includes("reader.navigate?.({ position: first.position })"),
    true,
  );
  assert.equal(tools.includes("pageIndex: first?.position?.pageIndex"), true);
  assert.equal(tools.includes("attachmentKey: pdf?.key"), true);
  assert.equal(tools.includes("annotationKey: first?.key"), true);

  // reader/open resolves parent items to their PDF attachment.
  assert.equal(host.includes("annotationID: annotationKey"), true);
  assert.equal(host.includes("const pdf = await findPdf(item)"), true);

  // Timeline tool lines and approval cards render locate links.
  assert.equal(view.includes("function locateFromData"), true);
  assert.equal(view.includes("function locateFromApproval"), true);
  assert.equal(view.includes("function locateLink"), true);
  assert.equal(view.includes('getString("workspace-locate")'), true);
  assert.equal(
    view.includes("locateFromApproval(item.toolName, item.args)"),
    true,
  );
  assert.equal(view.includes("locateFromData(call.result.data)"), true);
  assert.equal(enFtl.includes("confucius-workspace-locate"), true);
  assert.equal(zhFtl.includes("confucius-workspace-locate"), true);
});

test("triage entry and knowledge output: item menu, launch queue, propose_note", () => {
  const itemMenu = readFileSync(
    join(root, "src/modules/ui/itemMenu.ts"),
    "utf8",
  );
  const readerContextMenu = readFileSync(
    join(root, "src/modules/ui/readerContextMenu.ts"),
    "utf8",
  );
  const hooks = readFileSync(join(root, "src/hooks.ts"), "utf8");
  const host = readFileSync(
    join(root, "src/modules/host/AgentHost.ts"),
    "utf8",
  );
  const tools = readFileSync(
    join(root, "src/modules/tools/ZoteroToolHost.ts"),
    "utf8",
  );
  const catalog = readFileSync(
    join(root, "../../packages/zotero-tools/src/catalog.ts"),
    "utf8",
  );
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const rpc = readFileSync(
    join(root, "../../packages/protocol/src/rpc.ts"),
    "utf8",
  );
  const enFtl = readFileSync(
    join(root, "addon/locale/en-US/addon.ftl"),
    "utf8",
  );
  const zhFtl = readFileSync(
    join(root, "addon/locale/zh-CN/addon.ftl"),
    "utf8",
  );

  // Slice 2: two #zotero-itemmenu entries gated on selection shape + PDF.
  assert.equal(itemMenu.includes('"zotero-itemmenu"'), true);
  assert.equal(itemMenu.includes('templateId: "deep-read"'), true);
  assert.equal(itemMenu.includes('templateId: "triage"'), true);
  assert.equal(itemMenu.includes("queueLaunch"), true);
  assert.equal(itemMenu.includes("popupshowing"), true);
  assert.equal(itemMenu.includes("items.length < 2"), true);
  assert.equal(hooks.includes("registerItemMenu(win)"), true);
  assert.equal(hooks.includes("unregisterItemMenu(win)"), true);
  assert.equal(enFtl.includes("confucius-itemmenu-deep-read"), true);
  assert.equal(zhFtl.includes("confucius-itemmenu-triage"), true);
  for (const key of [
    "itemmenu-evidence-audit",
    "itemmenu-related-work",
    "itemmenu-paper-note",
    "itemmenu-compare",
    "itemmenu-synthesis",
    "itemmenu-literature-map",
  ]) {
    assert.equal(itemMenu.includes(`labelKey: "${key}"`), true);
    assert.equal(enFtl.includes(`confucius-${key}`), true);
    assert.equal(zhFtl.includes(`confucius-${key}`), true);
  }
  for (const key of [
    "reader-explain-selection",
    "reader-verify-claim",
    "reader-save-insight",
    "reader-selection-note",
  ]) {
    assert.equal(readerContextMenu.includes(`"${key}"`), true);
    assert.equal(enFtl.includes(`confucius-${key}`), true);
    assert.equal(zhFtl.includes(`confucius-${key}`), true);
  }

  // LaunchIntent is one-shot, carries click-time context, then is cleared.
  assert.equal(
    host.includes("queueLaunch(intent: LaunchIntent | string)"),
    true,
  );
  assert.equal(
    host.includes("context: intent.context ?? this.captureLockedContext()"),
    true,
  );
  assert.equal(host.includes("this.pendingLaunch = null"), true);
  assert.equal(rpc.includes('launchConsume: "workspace/launch-consume"'), true);
  assert.equal(view.includes('"workspace/launch-consume"'), true);
  assert.equal(view.includes("context: initialContext,"), true);
  assert.equal(
    view.includes("const initialContext = pendingMentionItems.size"),
    true,
  );
  assert.equal(host.includes("pane?.getCollectionTreeRows?.()"), true);
  assert.equal(host.includes("pane?.getSelectedCollections?.()?.[0]"), true);
  assert.equal(host.includes("pane?.getSelectedSavedSearches?.()?.[0]"), true);

  // Slice 3: each assistant response owns its actions. A deliberate click
  // saves directly; autonomous Agent note writes keep the normal tool gate.
  assert.equal(catalog.includes('"propose_note"'), true);
  assert.equal(tools.includes('"propose_note"'), true);
  assert.equal(
    tools.includes("markdownToNoteHtml(`# ${title}\\n\\n${markdown}`)"),
    true,
  );
  assert.equal(host.includes("noteProposeFromSession"), true);
  assert.equal(
    rpc.includes('noteProposeFromSession: "note/propose-from-session"'),
    true,
  );
  assert.equal(host.includes("noteProposeFromReply"), true);
  assert.equal(
    rpc.includes('noteProposeFromReply: "note/propose-from-reply"'),
    true,
  );
  assert.equal(rpc.includes('taskBranch: "task/branch"'), true);
  const directReplyNote = host.slice(
    host.indexOf("private async noteProposeFromReply"),
    host.indexOf("private queueReplyNote"),
  );
  assert.equal(directReplyNote.includes('executeTool("propose_note"'), true);
  assert.equal(directReplyNote.includes("queueReplyNote"), false);
  assert.equal(directReplyNote.includes("approval_required"), false);
  assert.equal(view.includes('rpc("note/propose-from-session"'), false);
  assert.equal(view.includes('rpc("note/propose-from-reply"'), true);
  assert.equal(view.includes('rpc("task/branch"'), true);
  assert.equal(view.includes("data-action: kind"), false);
  assert.equal(view.includes('"data-action": kind'), true);
  assert.equal(enFtl.includes("confucius-workspace-reply-copy"), true);
  assert.equal(zhFtl.includes("confucius-workspace-reply-copy"), true);
});

test("zotero uri links render as underlined anchors and navigate on click", () => {
  const view = readFileSync(
    join(root, "src/modules/ui/WorkspaceView.ts"),
    "utf8",
  );
  const navigatorSource = readFileSync(
    join(root, "src/modules/ui/linkNavigator.ts"),
    "utf8",
  );
  const addonSource = readFileSync(join(root, "src/addon.ts"), "utf8");
  const host = readFileSync(
    join(root, "src/modules/host/AgentHost.ts"),
    "utf8",
  );
  const tools = readFileSync(
    join(root, "src/modules/tools/ZoteroToolHost.ts"),
    "utf8",
  );
  const catalog = readFileSync(
    join(root, "../../packages/zotero-tools/src/catalog.ts"),
    "utf8",
  );
  const css = readFileSync(join(root, "addon/content/workspace.css"), "utf8");

  // Answers render markdown (fillAnswerHtml) and anchors get prominent
  // underlined styling inside the workspace root.
  assert.equal(view.includes("fillAnswerHtml(body, text)"), true);
  assert.equal(view.includes(".confucius-workspace-root a {"), true);
  assert.equal(view.includes("text-decoration: underline"), true);

  // Root-level click delegation hands anchors to the host's openLink.
  // Firefox XHTML click targets are often the text node, so we walk the
  // parent chain (hrefFromEvent) instead of event.target.closest("a").
  assert.equal(view.includes("hrefFromEvent(event)"), true);
  assert.equal(
    view.includes("node.innerHTML = renderMarkdownHtml(text)"),
    true,
  );
  assert.equal(view.includes("hydrateAnswerLinks(node)"), true);
  assert.equal(view.includes("onWorkspaceLink"), true);
  assert.equal(
    view.includes('addEventListener("click", onWorkspaceLink, true)'),
    true,
  );
  assert.equal(view.includes("openWorkspaceHref(start, href)"), true);
  assert.equal(view.includes("pluginOpenLink()"), true);
  assert.equal(addonSource.includes("openLink(href: string)"), true);

  // Zotero.Reader.open(itemID, location, options) takes the location object
  // directly — wrapping it in { location } silently drops navigation.
  assert.equal(navigatorSource.includes("open(attachment.id, location"), true);
  assert.equal(
    navigatorSource.includes("open(attachment.id, location ? { location }"),
    false,
  );
  assert.equal(
    navigatorSource.includes("{ annotationID: uri.annotationKey }"),
    true,
  );
  assert.equal(navigatorSource.includes("{ pageIndex: uri.page - 1 }"), true);

  // Items, PDFs, annotations AND notes all carry linkable zoteroUri fields.
  assert.equal(tools.includes("zoteroUri: buildSelectUri(item.key"), true);
  assert.equal(tools.includes("zoteroUri: buildOpenPdfUri(pdf.key"), true);
  assert.equal(
    tools.includes("zoteroUri: buildSelectUri(\n              note.key"),
    true,
  );
  assert.equal(host.includes("when mentioning a paper, a note,"), true);
  assert.equal(catalog.includes("Each note carries a zoteroUri"), true);

  // Knowledge-base markdown preview shares the same anchor styling.
  assert.equal(css.includes(".confucius-kb-md-preview"), true);
});
