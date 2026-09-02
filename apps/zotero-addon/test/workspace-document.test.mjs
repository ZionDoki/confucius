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
  assert.equal(view.includes("session/setPermissions"), true);
  assert.equal(view.includes("session/compact"), true);
  assert.equal(view.includes("session/context"), true);
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
  assert.equal(view.includes("await pendingPermissionUpdate"), true);
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
  assert.equal(view.includes("followTimeline"), true);
  assert.equal(view.includes("timelinePane.scrollHeight"), true);
});

test("composer model picker is a cascading menu, not a native select", () => {
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

test("live context spine renders chips and injects Live context", () => {
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
  assert.equal(rpc.includes("suppressSelection"), true);
  assert.equal(tools.includes("export function liveReaderContext"), true);
  assert.equal(host.includes("case RPC_METHODS.contextLive"), true);
  assert.equal(host.includes("case RPC_METHODS.readerOpen"), true);
  assert.equal(host.includes("Live context:"), true);
  assert.equal(host.includes("firstSelectedItem"), false);
  assert.equal(host.includes("Current Zotero selection"), false);
  assert.equal(view.includes('id: "confucius-context-bar"'), true);
  assert.equal(view.includes('rpc("context/live"'), true);
  assert.equal(view.includes('rpc("reader/open"'), true);
  assert.equal(view.includes("suppressedSelectionKey"), true);
  assert.equal(
    view.includes("context: { suppressSelection: isSelectionSuppressed() }"),
    true,
  );
});

test("reading loop: reader entry, locate links and write-back navigation", () => {
  const entry = readFileSync(
    join(root, "src/modules/ui/readerEntry.ts"),
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

  // Reader toolbar badge + selection context menu, registered once from hooks.
  assert.equal(entry.includes("registerEventListener"), true);
  assert.equal(entry.includes('"renderToolbar"'), true);
  assert.equal(entry.includes('"createSelectorContextMenu"'), true);
  assert.equal(entry.includes("openWorkspace"), true);
  assert.equal(entry.includes("confucius-prompt"), true);
  assert.equal(hooks.includes("registerReaderEntry()"), true);
  assert.equal(hooks.includes("unregisterReaderEntry()"), true);
  assert.equal(enFtl.includes("confucius-reader-ask"), true);
  assert.equal(zhFtl.includes("confucius-reader-ask"), true);

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
  assert.equal(itemMenu.includes("paper-deep-reading"), true);
  assert.equal(itemMenu.includes("library-triage"), true);
  assert.equal(itemMenu.includes("queueLaunch"), true);
  assert.equal(itemMenu.includes("popupshowing"), true);
  assert.equal(itemMenu.includes("items.length < 2"), true);
  assert.equal(hooks.includes("registerItemMenu(win)"), true);
  assert.equal(hooks.includes("unregisterItemMenu(win)"), true);
  assert.equal(enFtl.includes("confucius-itemmenu-deep-read"), true);
  assert.equal(zhFtl.includes("confucius-itemmenu-triage"), true);

  // Skill launch queue is one-shot: consumed then cleared by the poll.
  assert.equal(host.includes("queueLaunch(skillSlug: string)"), true);
  assert.equal(host.includes("this.pendingLaunch = null"), true);
  assert.equal(rpc.includes('launchConsume: "workspace/launch-consume"'), true);
  assert.equal(view.includes('"workspace/launch-consume"'), true);

  // Slice 3: propose_note approval pipeline and the timeline write-note button.
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
  assert.equal(view.includes('rpc("note/propose-from-session"'), true);
  assert.equal(view.includes('getString("workspace-note-propose")'), true);
  assert.equal(enFtl.includes("confucius-workspace-note-propose"), true);
  assert.equal(zhFtl.includes("confucius-workspace-note-propose"), true);
});
