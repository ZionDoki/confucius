import { config, version } from "../../../package.json";
import { bindAppearance } from "./workspaceAppearance";

const focusDocuments = new WeakSet<Document>();

/** Chrome documents can retain a visible focus ring after a pointer click.
 * Track input modality without blurring controls or changing keyboard focus. */
function bindFocusModality(doc: Document): void {
  if (focusDocuments.has(doc)) return;
  focusDocuments.add(doc);
  const attribute = "data-confucius-input";
  const pointer = () => doc.documentElement?.setAttribute(attribute, "pointer");
  const keyboard = (event: Event) => {
    const key = event as KeyboardEvent;
    if (
      key.isComposing ||
      key.keyCode === 229 ||
      ["Shift", "Control", "Alt", "Meta"].includes(key.key)
    )
      return;
    doc.documentElement?.setAttribute(attribute, "keyboard");
  };
  doc.addEventListener("pointerdown", pointer, true);
  doc.addEventListener("keydown", keyboard, true);
  doc.defaultView?.addEventListener(
    "unload",
    () => {
      doc.removeEventListener("pointerdown", pointer, true);
      doc.removeEventListener("keydown", keyboard, true);
      doc.documentElement?.removeAttribute(attribute);
      focusDocuments.delete(doc);
    },
    { once: true },
  );
}

/** One palette for the startup page, embedded surfaces and portalled menus. */
export function ensurePaletteStyles(doc: Document): void {
  bindFocusModality(doc);
  bindAppearance(doc);
  const href = `chrome://${config.addonRef}/content/workspacePalette.css?v=${version}`;
  const existing = doc.getElementById("confucius-palette-css");
  const link =
    existing ?? doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
  if (!existing) {
    link.id = "confucius-palette-css";
    link.setAttribute("rel", "stylesheet");
  }
  // A Zotero window can survive an add-on update with the old palette loaded.
  // Refresh that link once per product version, without reloading on each mount.
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  if (!existing) (doc.head ?? doc.documentElement)?.appendChild(link);
}

/** Shared product primitives. Also installed in Zotero's preferences document. */
export const SURFACE_CSS = `
.confucius-literature [hidden],.confucius-literature-dock[hidden],.confucius-literature-popup[hidden],.confucius-subagent-popup [hidden] { display:none !important; }
.confucius-literature { min-width:0; color:var(--confucius-ink); font-size:13px; line-height:1.5; }
.confucius-literature-header { display:flex; align-items:flex-start; gap:12px; padding:16px 20px 12px; }
.confucius-literature-header > div { flex:1; min-width:0; }
.confucius-literature h3 { margin:0; font:inherit; font-size:14px; font-weight:600; overflow-wrap:anywhere; }
.confucius-research-icon { width:18px; height:18px; flex-shrink:0; color:var(--confucius-muted); margin-top:2px; }
.confucius-literature-footer { display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:space-between; padding:12px 20px 16px; }
.confucius-literature-footer > :last-child { margin-left:auto; }
.confucius-literature .confucius-literature-quiet { background:transparent; color:var(--confucius-secondary); padding-left:8px; padding-right:8px; }
.confucius-literature .confucius-literature-quiet:hover { background:var(--confucius-surface); }
.confucius-composer-dock { position:relative; z-index:12; display:grid; grid-template-columns:minmax(0,1fr) 34px; align-items:center; gap:8px; width:100%; max-width:880px; min-width:0; margin:0 auto 8px; }
.confucius-composer-dock[hidden] { display:none !important; }
.confucius-literature-dock { grid-column:1; min-width:0; }
.confucius-literature-capsule.confucius-button { display:flex; align-items:center; gap:8px; max-width:100%; min-height:34px; padding:6px 12px; border-radius:24px; background:var(--confucius-elevated); box-shadow:var(--confucius-shadow-soft); font-size:12px; }
.confucius-literature-capsule-copy { display:flex; flex-wrap:wrap; align-items:baseline; gap:0 4px; min-width:0; text-align:left; overflow-wrap:anywhere; }
.confucius-literature-capsule-count { white-space:nowrap; font-variant-numeric:tabular-nums; }
.confucius-literature-capsule .confucius-research-icon,.confucius-literature-caret { display:block; flex:0 0 16px; width:16px; height:16px; margin:0; }
.confucius-literature-capsule[aria-expanded=true] .confucius-literature-caret { transform:rotate(180deg); }
.confucius-literature-popup { position:absolute; bottom:calc(100% + 8px); left:0; width:100%; max-width:680px; box-sizing:border-box; border-radius:14px; background:var(--confucius-elevated); box-shadow:var(--confucius-shadow); overflow:hidden; display:flex; }
.confucius-literature-editor > :not(.confucius-literature-scroll) { flex-shrink:0; }
.confucius-literature-editor { display:flex; flex:1; flex-direction:column; min-width:0; min-height:0; max-height:inherit; }
.confucius-literature-tabs { display:flex; gap:4px; padding:0 20px 8px; }
.confucius-literature-tabs .confucius-button { font-size:12px; background:transparent; color:var(--confucius-muted); padding:6px 10px; }
.confucius-literature-tabs [aria-selected=true] { color:var(--confucius-ink); background:var(--confucius-surface); }
.confucius-literature-scroll { flex:1 1 auto; min-height:0; overflow:auto; overscroll-behavior:contain; padding:0 20px; scrollbar-width:thin; }
.confucius-literature-tools { display:flex; flex-wrap:wrap; align-items:flex-start; gap:4px 16px; margin:0 0 8px; }
.confucius-literature-tools > details[open] { flex-basis:100%; }
.confucius-literature-local-filter input { width:100%; margin:4px 0 8px; }
.confucius-literature-controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.confucius-literature-controls input { min-width:0; flex:1 1 160px; }
.confucius-literature-controls .confucius-literature-year { flex:0 1 90px; width:90px; }
.confucius-literature input:not([type=checkbox]),.confucius-literature select,.confucius-literature-settings input { box-sizing:border-box; max-width:100%; min-width:0; color:var(--confucius-ink); background:var(--confucius-surface); border:1px solid var(--confucius-line); border-radius:8px; padding:7px 10px; font:inherit; }
.confucius-literature input:focus-visible,.confucius-literature select:focus-visible,.confucius-literature summary:focus-visible { outline:2px solid var(--confucius-focus); outline-offset:2px; }
.confucius-literature label { display:flex; gap:10px; align-items:flex-start; font-weight:550; }
.confucius-workspace-root .confucius-literature input[type=checkbox] { width:14px; height:14px; min-height:14px; flex:0 0 auto; margin:3px 0 0; accent-color:var(--confucius-accent); }
.confucius-literature-row { padding:10px 0 12px; overflow-wrap:anywhere; }
.confucius-literature-row > .confucius-literature-meta,.confucius-literature-row > .confucius-literature-reason,.confucius-literature-row > details { margin-left:24px; }
.confucius-literature-reason { margin:6px 0; font-size:12px; color:var(--confucius-secondary); }
.confucius-literature-meta { color:var(--confucius-muted); font-size:12px; margin:4px 0; }
.confucius-workspace-root .confucius-literature summary { min-height:20px; cursor:pointer; color:var(--confucius-secondary); font-size:12px; padding:4px 0; }
.confucius-literature details p { line-height:1.65; color:var(--confucius-secondary); }
.confucius-literature-refine { font-size:12px; }
.confucius-literature-refine > .confucius-literature-controls { margin-top:8px; }
.confucius-literature-history { display:grid; gap:8px; margin-top:12px; color:var(--confucius-muted); }
.confucius-literature-query { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.confucius-literature-query > span { flex:1 1 160px; overflow-wrap:anywhere; }
.confucius-literature-drop { padding:12px; margin-top:8px; border:1px dashed var(--confucius-line-strong); border-radius:8px; font-size:12px; color:var(--confucius-secondary); }
.confucius-literature-drop[data-over=true] { outline:2px solid var(--confucius-focus); background:var(--confucius-surface); }
.confucius-literature-error:empty { display:none; }
.confucius-literature-error { color:var(--confucius-danger); padding:0 20px 8px; overflow-wrap:anywhere; }
.confucius-literature-confirmation { padding-bottom:8px; overflow-wrap:anywhere; }
.confucius-literature-confirmation h4 { margin:8px 0; font-size:14px; }
.confucius-literature-confirmation ul { padding-left:20px; }
.confucius-literature-confirmation .confucius-literature-controls { justify-content:flex-end; margin-top:16px; }
.confucius-literature-paging { padding:8px 0; }
.confucius-literature-settings { margin-bottom:24px; }
.confucius-literature-settings .confucius-button { margin:4px; }
.confucius-subagent-entries { display:flex; width:100%; min-width:0; flex-wrap:wrap; gap:8px; margin:8px 0 16px; }
.confucius-subagent-entry.confucius-button { width:100%; max-width:100%; gap:12px; padding:10px 12px; text-align:left; font-size:13px; white-space:normal; }
.confucius-subagent-entry[aria-expanded=true] { background:var(--confucius-hover); }
.confucius-subagent-entry .confucius-research-icon { width:18px; height:18px; margin:0; }
.confucius-subagent-entry-copy { display:flex; flex:1; min-width:0; flex-direction:column; gap:4px; overflow-wrap:anywhere; }
.confucius-subagent-entry-copy strong { font-weight:550; }
.confucius-subagent-meta { color:var(--confucius-muted); font-size:12px; font-weight:400; overflow-wrap:anywhere; }
.confucius-subagent-badge { flex-shrink:0; color:var(--confucius-secondary); font-size:12px; font-weight:400; }
.confucius-subagent-entry[data-status=failed] .confucius-subagent-badge { color:var(--confucius-danger); }
.confucius-subagent-popup { position:fixed; z-index:10000; left:50%; top:50%; transform:translate(-50%,-50%); box-sizing:border-box; display:flex; flex-direction:column; width:min(680px,calc(100vw - 16px)); height:min(640px,calc(100vh - 16px)); overflow:hidden; border-radius:14px; background:var(--confucius-elevated); color:var(--confucius-ink); box-shadow:var(--confucius-shadow); font-size:13px; line-height:1.5; }
.confucius-subagent-pane { display:flex; flex-direction:column; flex:1; min-height:0; }
.confucius-subagent-navigation { display:flex; flex-shrink:0; align-items:center; justify-content:space-between; gap:8px; padding:0 20px 12px; }
.confucius-subagent-navigation > span { font-variant-numeric:tabular-nums; }
.confucius-subagent-header { display:flex; flex-shrink:0; align-items:flex-start; gap:12px; padding:16px 20px 12px; }
.confucius-subagent-header > div { flex:1; min-width:0; }
.confucius-subagent-header .confucius-button,.confucius-subagent-footer .confucius-button,.confucius-subagent-navigation .confucius-button { min-height:34px; padding:6px 8px; }
.confucius-subagent-popup h3 { margin:0 0 4px; font-size:14px; font-weight:600; overflow-wrap:anywhere; }
.confucius-subagent-popup h4 { margin:16px 0 8px; font-size:13px; font-weight:550; }
.confucius-subagent-popup h5 { margin:12px 0 4px; font-size:12px; font-weight:550; color:var(--confucius-secondary); }
.confucius-subagent-filter { display:flex; flex-shrink:0; flex-wrap:wrap; align-items:center; gap:8px; padding:0 20px 12px; }
.confucius-subagent-filter input { flex:1 1 200px; min-width:0; width:100%; box-sizing:border-box; height:34px; padding:6px 8px; margin:0; border:1px solid var(--confucius-line); border-radius:8px; background:var(--confucius-paper); color:var(--confucius-ink); font:inherit; }
.confucius-subagent-filter input:focus-visible { outline:2px solid var(--confucius-focus); outline-offset:2px; }
.confucius-subagent-scroll { flex:1; overflow:auto; min-height:0; padding:0 20px; overscroll-behavior:contain; scrollbar-gutter:stable; }
.confucius-subagent-result { white-space:pre-wrap; overflow-wrap:anywhere; margin:8px 0 16px; line-height:1.6; }
.confucius-subagent-trace { display:flex; flex-direction:column; gap:8px; margin:12px 0 20px; }
.confucius-subagent-trace-item { min-width:0; background:var(--confucius-surface); border-radius:8px; }
.confucius-subagent-trace-item > summary { display:grid; grid-template-columns:8px max-content minmax(0,1fr) auto; gap:8px; align-items:baseline; padding:10px 12px; cursor:pointer; list-style:none; overflow-wrap:anywhere; }
.confucius-subagent-trace-item > summary::before { content:'›'; color:var(--confucius-muted); transform-origin:center; }
.confucius-subagent-trace-item[open] > summary::before { transform:rotate(90deg); }
.confucius-subagent-trace-item > summary:hover { background:var(--confucius-hover); border-radius:8px; }
.confucius-subagent-trace-item > summary time,.confucius-subagent-trace-item > summary > :last-child { color:var(--confucius-muted); font-size:12px; font-variant-numeric:tabular-nums; }
.confucius-subagent-trace-item[data-state=failed] > summary > :last-child { color:var(--confucius-danger); }
.confucius-subagent-trace-item > div { padding:0 12px 12px; }
.confucius-subagent-popup summary:focus-visible { outline:2px solid var(--confucius-focus); outline-offset:2px; border-radius:4px; }
.confucius-subagent-popup pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; line-height:1.5; margin:8px 0; }
.confucius-subagent-details { margin:12px 0; }
.confucius-subagent-details summary,.confucius-subagent-raw summary { cursor:pointer; color:var(--confucius-secondary); overflow-wrap:anywhere; }
.confucius-subagent-details > div > details { margin:12px 0; }
.confucius-subagent-raw { font-size:12px; }
.confucius-subagent-error { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:8px 0; color:var(--confucius-danger); overflow-wrap:anywhere; }
.confucius-subagent-footer { display:flex; flex-shrink:0; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; padding:12px 20px 16px; }
.confucius-subagent-footer .confucius-literature-controls { margin-left:auto; }
@media (max-width:619px) {
 .confucius-literature-header { padding:12px; gap:8px; flex-wrap:wrap; }
 .confucius-literature-header > div { flex-basis:120px; }
 .confucius-literature-footer { padding:8px 12px 12px; }
 .confucius-literature-scroll { padding:0 12px; }
 .confucius-literature-tabs { padding:0 12px 8px; }
 .confucius-literature-controls,.confucius-subagent-entries { gap:4px; }
 .confucius-subagent-header { padding:12px; gap:8px; }
 .confucius-subagent-filter,.confucius-subagent-navigation { padding:0 12px 8px; }
 .confucius-subagent-scroll { padding:0 12px; }
 .confucius-subagent-footer { padding:8px 12px 12px; gap:4px; }
 .confucius-subagent-trace-item > summary { grid-template-columns:8px minmax(0,1fr) auto; gap:4px 8px; }
 .confucius-subagent-trace-item > summary time { grid-column:2 / -1; }
 .confucius-subagent-trace-item > summary::before { grid-row:2; }
}
@media (forced-colors:active) { .confucius-literature-popup,.confucius-literature-capsule,.confucius-subagent-popup { border:1px solid CanvasText; } }

/* Zotero's native button height limits are intended for single-line controls.
   Let text controls grow with their content; explicit icon/composer sizes win. */
:where(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-window, #confucius-knowledge-overlay, #confucius-preferences) button {
  height: auto; max-height: none; margin: 0; box-sizing: border-box;
}
:is(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-window, #confucius-knowledge-overlay, #confucius-preferences) {
  --confucius-space: 4px;
  --confucius-radius: 8px;
  --confucius-control-height: 32px;
  accent-color: var(--confucius-accent);
}
:is(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-window, #confucius-knowledge-overlay, #confucius-preferences) ::selection {
  background: var(--confucius-selection); color: var(--confucius-selection-ink);
}
:is(.confucius-workspace-root, .confucius-dialog, #confucius-knowledge-overlay, #confucius-preferences) :is(input, textarea)::placeholder {
  color: var(--confucius-muted); opacity: 1;
}
.confucius-button {
  appearance: none; display: inline-flex; align-items: center; justify-content: center;
  height: auto; max-height: none; min-height: 32px; min-width: 0; max-width: 100%; margin: 0; padding: 6px 12px;
  border: 0; border-radius: 8px; background: var(--confucius-surface);
  color: var(--confucius-ink); font: inherit; font-weight: 550;
  line-height: 1.4; cursor: pointer; box-sizing: border-box;
}
.confucius-button:hover:not(:disabled) { background: var(--confucius-hover); }
.confucius-button[data-variant=primary] { background: var(--confucius-primary); color: var(--confucius-primary-ink); }
.confucius-button[data-variant=primary]:hover:not(:disabled) { background: var(--confucius-primary-hover); }
.confucius-button:disabled { opacity: .48; cursor: default; }
.confucius-button:focus-visible { outline: 2px solid var(--confucius-focus); outline-offset: 2px; }
.confucius-menu-row[data-danger=true] { color: var(--confucius-danger); }
.confucius-topbar :is(#confucius-new-session, #confucius-toggle-sessions) { min-height: 34px; height: 34px; margin: 0; }
.confucius-topbar #confucius-new-session, .confucius-artifact-toolbar .confucius-button { min-height: 34px; height: 34px; padding: 6px 8px; font-size: 13px; }
.confucius-task-menu-trigger { width: 28px; min-width: 28px; height: 28px; padding: 0; background: transparent; color: var(--confucius-muted); opacity: 0; }
.confucius-task-row:is(:hover, :focus-within) .confucius-task-menu-trigger,
.confucius-task-menu-trigger[aria-expanded=true] { opacity: 1; }
@media (hover: none) { .confucius-task-menu-trigger { opacity: 1; } }
.confucius-task-search { position: sticky; top: 0; z-index: 1; }
.confucius-user-message { width: fit-content; max-width: 88%; margin: 20px 0 24px auto; padding: 12px 16px; border-radius: 16px 16px 4px 16px; background: var(--confucius-surface); color: var(--confucius-ink); white-space: pre-wrap; overflow-wrap: anywhere; box-sizing: border-box; }
.confucius-plan, .confucius-command { margin: 12px 0; padding: 12px 16px; border-radius: 12px; background: var(--confucius-surface); }
.confucius-command { font-family: ui-monospace, Consolas, monospace; font-size: .88em; }
.confucius-approval { margin: 16px 0; padding: 16px; border: 0; border-radius: 12px; background: var(--confucius-warning-surface); }
.confucius-notice { padding: 12px 16px; margin: 12px 0; border-radius: 12px; background: var(--confucius-surface); color: var(--confucius-accent-text); }
.confucius-workbench-pane { position: relative; }
.confucius-composer-dock > .confucius-latest { grid-column:2; justify-self:end; }
.confucius-latest svg { transform:rotate(180deg); }
.confucius-latest[hidden] { display:none !important; }
.confucius-composer { position: relative; }
.confucius-dialog { position: absolute; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; background: var(--confucius-scrim); backdrop-filter: blur(8px); }
.confucius-dialog-panel { width: min(720px, 100%); max-height: 100%; min-width: 0; padding: 24px; overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; box-sizing: border-box; border: 0; border-radius: 16px; color: var(--confucius-ink); background: var(--confucius-elevated); box-shadow: var(--confucius-shadow); }
.confucius-settings-shell { display: grid; grid-template-columns: 144px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; width: min(760px, 100%); height: min(680px, 100%); padding: 0; overflow: hidden; }
.confucius-settings-header { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; padding: 20px 24px 16px; gap: 12px; }
.confucius-settings-title { margin: 0; font: inherit; font-size: 1.3em; font-weight: 650; letter-spacing: -.02em; }
.confucius-settings-tabs { display: flex; flex-direction: column; gap: 8px; padding: 8px 8px 20px 16px; overflow-y: auto; min-width: 0; scrollbar-gutter: stable; scroll-padding: 8px; }
.confucius-settings-tabs [role=tab] { flex-shrink: 0; height: auto; max-height: none; min-height: 40px; margin: 0; padding: 10px 12px; border: 0; border-radius: 8px; background: transparent; color: var(--confucius-muted); font: inherit; text-align: left; cursor: pointer; }
.confucius-settings-tabs [role=tab]:hover { background: var(--confucius-surface); }
.confucius-settings-tabs [aria-selected=true] { background: var(--confucius-surface); color: var(--confucius-ink); font-weight: 600; }
.confucius-settings-content { overflow-wrap: anywhere; min-height: 0; min-width: 0; overflow-x: hidden; overflow-y: auto; padding: 8px 24px 24px 20px; scrollbar-gutter: stable; scroll-padding-block: 8px; }
.confucius-settings-footer { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 24px 20px; }
.confucius-settings-feedback { flex: 1 1 180px; min-width: 0; font-size: .9em; color: var(--confucius-danger); }
.confucius-settings-feedback[data-state=saved] { color: var(--confucius-success); }
.confucius-settings-field { margin-bottom: 20px; }
.confucius-settings-field > label { display: block; color: var(--confucius-muted); margin-bottom: 8px; font-size: .92em; }
.confucius-settings-advanced { margin: 12px 0 20px; }
.confucius-settings-advanced > summary { cursor: pointer; color: var(--confucius-muted); padding: 8px 0; }
.confucius-model-catalog [hidden] { display: none !important; }
.confucius-model-catalog > .confucius-settings-field { margin-bottom: 8px; }
.confucius-model-catalog [role=status] { margin: 8px 0; font-size: .9em; }
.confucius-catalog-results { position: relative; box-sizing: border-box; max-width: 100%; max-height: min(280px, 36vh); padding: 4px; margin: 8px 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--confucius-line); border-radius: 8px; background: var(--confucius-paper); scrollbar-gutter: stable; }
.confucius-catalog-option { margin: 0; }
.confucius-catalog-option[data-active=true] { background: var(--confucius-surface); outline: 2px solid var(--confucius-focus); outline-offset: -2px; }
.confucius-catalog-option-copy { display: block; min-width: 0; overflow-wrap: anywhere; }
.confucius-catalog-option-name { display: block; font-weight: 550; line-height: 1.4; }
.confucius-catalog-option-meta { display: block; margin-top: 4px; font-size: .9em; line-height: 1.4; color: var(--confucius-muted); }
.confucius-catalog-preview { margin: 12px 0; line-height: 1.5; }
.confucius-catalog-actions, .confucius-reasoning-transports { display: flex; flex-wrap: wrap; gap: 8px; }
.confucius-reasoning-transports .confucius-button { height: auto; min-height: 34px; max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.confucius-endpoint-choice { display: flex; flex: 1; align-items: center; gap: 8px; height: auto; max-height: none; min-width: 0; margin: 0; padding: 4px 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.confucius-endpoint-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-bottom: 12px; }
/* Legacy settings controls still carry geometry inline. These surface rules
   deliberately leave their layout and visibility intact. */
:is(.confucius-settings-shell, .confucius-dialog-panel) :is(input:not([type=checkbox]):not([type=radio]), textarea, select),
#confucius-preferences :is(input:not([type=checkbox]):not([type=radio]), textarea, select) {
  appearance: none; height: auto; max-height: none; min-width: 0; max-width: 100%; min-height: 36px; margin: 0; padding: 8px 10px;
  border: 0 !important; border-radius: 8px; box-sizing: border-box; background: var(--confucius-surface) !important; color: var(--confucius-ink); font: inherit;
}
:is(.confucius-settings-shell, .confucius-dialog-panel, #confucius-preferences) :is(input, textarea, select):focus { outline: 2px solid var(--confucius-focus); outline-offset: 0; box-shadow: none; }
.confucius-settings-shell [role=radio] { border: 0 !important; background: transparent !important; color: var(--confucius-muted) !important; }
.confucius-settings-shell [role=radio][aria-checked=true] { background: var(--confucius-surface) !important; color: var(--confucius-ink) !important; }
.confucius-settings-shell .confucius-settings-select { border: 0; background: var(--confucius-surface); }
.confucius-settings-shell .confucius-button { border: 0 !important; }
.confucius-kb-back { display: none; }
.confucius-kb-memories { margin-top: 20px; color: var(--confucius-muted); }
.confucius-kb-memories > summary { cursor: pointer; padding: 8px; font-size: .9em; }
.confucius-kb-entry-row .confucius-kb-meta { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.5; }
.confucius-kb-memory { padding: 12px 8px; margin: 4px 0; border-radius: 8px; }
.confucius-kb-actions { position: sticky; bottom: -16px; padding: 12px 0; background: var(--confucius-elevated); }
.confucius-kb-preview-toggle { margin-bottom: 12px; }
.confucius-kb-editor-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 16px; }
.confucius-kb-draft-hint { color: var(--confucius-muted); font-size: .86em; }
#confucius-preferences { --confucius-control-height: 36px; color: var(--confucius-ink); padding: 8px 16px 32px; font: 13px/1.55 system-ui, sans-serif; }
#confucius-preferences groupbox { appearance: none; margin: 0 0 20px; padding: 16px 0; border: 0; background: transparent; }
#confucius-preferences h2 { margin: 0 0 8px; font-size: 17px; font-weight: 650; letter-spacing: -.02em; }
#confucius-preferences p { color: var(--confucius-muted); margin: 4px 0 16px; }
#confucius-preferences label { margin: 10px 0 4px; }
#confucius-preferences :is(input:not([type=checkbox]):not([type=radio]), textarea, select) { margin-bottom: 8px; }
#confucius-preferences button { appearance: none; min-height: 32px; padding: 6px 10px; margin: 0 0 8px; border: 0; border-radius: 8px; background: var(--confucius-surface); color: var(--confucius-ink); font: inherit; cursor: pointer; }
#confucius-preferences button:hover { background: var(--confucius-hover); }
#confucius-preferences :is(button, summary):focus-visible { outline: 2px solid var(--confucius-focus); outline-offset: 2px; }
:is(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-window, #confucius-knowledge-overlay, #confucius-preferences) :is(button, summary, a):focus-visible,
[data-confucius-input=keyboard] :is(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-window, #confucius-knowledge-overlay, #confucius-preferences) :is(button, summary, a):focus {
  outline: 2px solid var(--confucius-focus); outline-offset: -2px;
}
[data-confucius-input=pointer] :where(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-window, #confucius-knowledge-overlay, #confucius-preferences) :is(button, summary, a):focus {
  outline: none !important; box-shadow: none !important;
}
.confucius-workspace-root:is([data-confucius-density=compact], [data-confucius-density=narrow]) .confucius-dialog { padding: 8px; }
.confucius-workspace-root:is([data-confucius-density=compact], [data-confucius-density=narrow]) .confucius-settings-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr) auto; height: 100%; }
.confucius-workspace-root:is([data-confucius-density=compact], [data-confucius-density=narrow]) .confucius-settings-header { padding: 16px 16px 12px; }
.confucius-workspace-root:is([data-confucius-density=compact], [data-confucius-density=narrow]) .confucius-settings-tabs { flex-direction: row; padding: 8px 12px 12px; overflow-x: scroll; overflow-y: hidden; scrollbar-gutter: stable; }
.confucius-workspace-root:is([data-confucius-density=compact], [data-confucius-density=narrow]) .confucius-settings-tabs [role=tab] { padding: 10px 12px; white-space: nowrap; }
.confucius-workspace-root:is([data-confucius-density=compact], [data-confucius-density=narrow]) .confucius-settings-content { padding: 12px 16px 24px; }
.confucius-workspace-root:is([data-confucius-density=compact], [data-confucius-density=narrow]) .confucius-settings-footer { padding: 12px 16px; }
.confucius-workspace-root[data-confucius-compact-panels=true] .confucius-knowledge-overlay { padding: 8px; }
.confucius-workspace-root[data-confucius-compact-panels=true] .confucius-knowledge-body { display: block; overflow: hidden; }
.confucius-workspace-root[data-confucius-compact-panels=true] .confucius-knowledge-pane { display: none; height: 100%; overflow-x: hidden; overflow-y: auto; padding: 16px; }
.confucius-workspace-root[data-confucius-compact-panels=true] .confucius-knowledge-shell[data-stage=topics] .confucius-knowledge-topics,
.confucius-workspace-root[data-confucius-compact-panels=true] .confucius-knowledge-shell[data-stage=entries] .confucius-knowledge-entries,
.confucius-workspace-root[data-confucius-compact-panels=true] .confucius-knowledge-shell[data-stage=editor] .confucius-knowledge-editor { display: block; }
.confucius-workspace-root[data-confucius-compact-panels=true] .confucius-kb-topic-list { display: block; }
.confucius-workspace-root[data-confucius-compact-panels=true] .confucius-kb-back { display: inline-flex; padding: 4px; background: transparent; }
.confucius-knowledge-shell[data-stage=topics] .confucius-kb-back { display: none !important; }
@media (prefers-reduced-motion: reduce) { .confucius-dialog *, #confucius-knowledge-overlay *, #confucius-artifact-window * { animation: none !important; transition: none !important; } }
`;
