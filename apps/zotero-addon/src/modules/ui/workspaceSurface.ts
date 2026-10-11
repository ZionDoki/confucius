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
.confucius-subagent-popup [hidden] { display:none !important; }
.confucius-literature-review { min-width:0; color:var(--confucius-ink); font-size:13px; line-height:1.5; }
.confucius-literature-review h3 { margin:0; font:inherit; font-size:14px; font-weight:600; overflow-wrap:anywhere; }
.confucius-research-icon { width:18px; height:18px; flex-shrink:0; color:var(--confucius-muted); margin-top:2px; }
.confucius-composer-dock { position:relative; z-index:12; display:grid; grid-template-columns:minmax(0,1fr) 34px; align-items:center; gap:8px; width:100%; max-width:880px; min-width:0; margin:0 auto 8px; }
.confucius-composer-dock[hidden] { display:none !important; }
.confucius-composer-capsules { grid-column:1; display:flex; align-items:center; flex-wrap:wrap; gap:8px; min-width:0; }
.confucius-button[data-variant=link] { background:transparent; box-shadow:none; color:var(--confucius-secondary); text-decoration:underline; text-underline-offset:3px; font-weight:400; }
.confucius-button[data-variant=link]:hover:not(:disabled) { background:var(--confucius-hover); color:var(--confucius-ink); }
.confucius-literature-controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.confucius-literature-controls input { min-width:0; flex:1 1 160px; }
.confucius-literature-controls .confucius-literature-year { flex:0 1 90px; width:90px; }
.confucius-literature-review input:not([type=checkbox]):not(.ar-range):not(.ar-search),.confucius-literature-review select,.confucius-literature-settings input { box-sizing:border-box; max-width:100%; min-width:0; color:var(--confucius-ink); background:var(--confucius-surface); border:1px solid var(--confucius-line); border-radius:8px; padding:7px 10px; font:inherit; }
.confucius-literature-review input:focus-visible,.confucius-literature-review select:focus-visible,.confucius-literature-review summary:focus-visible { outline:2px solid var(--confucius-focus); outline-offset:2px; }
.confucius-literature-meta { color:var(--confucius-muted); font-size:12px; margin:4px 0; }
.confucius-workspace-root .confucius-literature-review summary { min-height:20px; cursor:pointer; color:var(--confucius-secondary); font-size:12px; padding:4px 0; }
.confucius-literature-review details p { line-height:1.65; color:var(--confucius-secondary); }
.confucius-literature-refine { font-size:12px; }
.confucius-literature-review .ar-tools { display:flex; flex-wrap:wrap; align-items:flex-start; gap:4px 12px; }
.confucius-literature-refine[open] { flex:1 1 100%; min-width:0; }
.confucius-literature-refine > .confucius-literature-controls { margin-top:8px; }
.confucius-literature-history { display:grid; gap:8px; margin-top:12px; color:var(--confucius-muted); }
.confucius-literature-query { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.confucius-literature-query > span { flex:1 1 160px; overflow-wrap:anywhere; }
.confucius-literature-drop { padding:12px; margin-top:8px; border:1px dashed var(--confucius-line-strong); border-radius:8px; font-size:12px; color:var(--confucius-secondary); }
.confucius-literature-drop[data-over=true] { outline:2px solid var(--confucius-focus); background:var(--confucius-surface); }
.confucius-literature-confirmation { padding-bottom:8px; overflow-wrap:anywhere; }
.confucius-literature-confirmation h4 { margin:8px 0; font-size:14px; }
.confucius-literature-confirmation ul { padding-left:20px; }
.confucius-literature-confirmation .confucius-literature-controls { justify-content:flex-end; margin-top:16px; }
.confucius-literature-settings { margin-bottom:24px; }
.confucius-literature-settings > input { width:100%; }
.confucius-literature-settings a { color:var(--confucius-accent-text); overflow-wrap:anywhere; }
.confucius-venue-rating-badges { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
.confucius-venue-rating { display:inline-flex; flex-wrap:wrap; align-items:baseline; gap:4px 8px; max-width:100%; box-sizing:border-box; padding:4px 8px; border-radius:8px; background:var(--confucius-surface); color:var(--confucius-secondary); font-size:12px; overflow-wrap:anywhere; }
.confucius-venue-rating strong { font-weight:550; color:var(--confucius-ink); }
.confucius-venue-ratings a { color:var(--confucius-secondary); text-decoration:underline; text-underline-offset:3px; overflow-wrap:anywhere; }
.confucius-venue-ratings a:focus-visible { outline:2px solid var(--confucius-focus); outline-offset:2px; border-radius:4px; }
.confucius-venue-rating-details ul { margin:8px 0; padding-left:20px; }
.confucius-venue-rating-settings { margin-bottom:24px; min-width:0; overflow-wrap:anywhere; }
.ar-tools .confucius-venue-rating-settings { font-size:12px; margin:8px 0; }
.confucius-venue-rating-settings h3 { margin:0 0 8px; }
.confucius-venue-rating-settings p { margin:8px 0; }
.confucius-venue-rating-catalogs { display:grid; gap:8px; margin-top:12px; }
.confucius-venue-rating-catalog { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.confucius-venue-rating-catalog > span { flex:1 1 180px; min-width:0; }
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
.confucius-subagent-trace { margin:12px 0 20px; }
.confucius-subagent-trace-item { min-width:0; overflow-wrap:anywhere; }
.confucius-subagent-popup .confucius-answer-shell { max-width:100%; }
.confucius-subagent-popup summary:focus-visible { outline:2px solid var(--confucius-focus); outline-offset:2px; border-radius:4px; }
.confucius-subagent-details pre,.confucius-subagent-raw pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; line-height:1.5; margin:8px 0; }
.confucius-subagent-details { margin:12px 0; }
.confucius-subagent-details summary,.confucius-subagent-raw summary { cursor:pointer; color:var(--confucius-secondary); overflow-wrap:anywhere; }
.confucius-subagent-details > div > details { margin:12px 0; }
.confucius-subagent-raw { font-size:12px; }
.confucius-subagent-error { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:8px 0; color:var(--confucius-danger); overflow-wrap:anywhere; }
.confucius-subagent-footer { display:flex; flex-shrink:0; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; padding:12px 20px 16px; }
.confucius-subagent-footer .confucius-literature-controls { margin-left:auto; }
@media (max-width:619px) {
 .confucius-literature-controls,.confucius-subagent-entries { gap:4px; }
 .confucius-subagent-header { padding:12px; gap:8px; }
 .confucius-subagent-filter,.confucius-subagent-navigation { padding:0 12px 8px; }
 .confucius-subagent-scroll { padding:0 12px; }
 .confucius-subagent-footer { padding:8px 12px 12px; gap:4px; }
}
@media (forced-colors:active), (prefers-contrast:more) { .confucius-subagent-popup { border:1px solid CanvasText; } }

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
.confucius-settings-shell { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr) auto; width: min(860px, 100%); height: min(740px, 100%); padding: 0; overflow: hidden; line-height: 1.5; }
:is(.confucius-settings-shell, #confucius-preferences) button.confucius-button { min-height: 34px; margin: 0; }
:is(.confucius-settings-shell, #confucius-preferences) :is(button.confucius-button:not([role=tab]), .confucius-color-tabs button) { padding: 6px 8px; }
.confucius-settings-header { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; padding: 20px 24px 16px; gap: 12px; }
.confucius-settings-title { margin: 0; font: inherit; font-size: 1.3em; font-weight: 650; letter-spacing: -.02em; }
.confucius-settings-tabs { display: flex; flex-direction: row; gap: 4px; padding: 0 24px 12px; overflow-x: auto; overflow-y: hidden; min-width: 0; scroll-padding: 8px; }
.confucius-settings-tabs [role=tab] { flex-shrink: 0; height: auto; max-height: none; min-height: 34px; margin: 0; padding: 6px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--confucius-muted); font: inherit; text-align: left; white-space: nowrap; cursor: pointer; }
.confucius-settings-tabs [role=tab]:hover { background: var(--confucius-surface); }
.confucius-settings-tabs [aria-selected=true] { background: var(--confucius-surface); color: var(--confucius-ink); font-weight: 600; }
.confucius-settings-content { overflow-wrap: anywhere; min-height: 0; min-width: 0; overflow-x: hidden; overflow-y: auto; padding: 8px 24px 24px; scrollbar-gutter: stable; scroll-padding-block: 8px; }
.confucius-settings-footer { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 24px 20px; }
.confucius-settings-feedback { flex: 1 1 180px; min-width: 0; font-size: .9em; color: var(--confucius-danger); }
.confucius-settings-feedback:empty { display: none; }
.confucius-settings-footer .confucius-button { height: auto; min-height: 34px; }
.confucius-settings-feedback[data-state=saved] { color: var(--confucius-success); }
.confucius-settings-field { margin-bottom: 20px; }
.confucius-settings-field > label { display: block; color: var(--confucius-muted); margin: 0 0 8px; font-size: .92em; }
.confucius-settings-advanced { margin: 12px 0 20px; }
.confucius-settings-advanced > summary { cursor: pointer; color: var(--confucius-muted); padding: 8px 0; }
.confucius-settings-help { display: block; margin: 6px 0 12px; font-size: .92em; line-height: 1.5; color: var(--confucius-secondary); }
.confucius-settings-help:empty { display: none; }
.confucius-settings-section { min-width: 0; container-type: inline-size; container-name: confucius-appearance-section; }
.confucius-settings-section h3, .confucius-runtime-settings h3 { margin: 0 0 16px; font-size: 1.05em; font-weight: 600; }
.confucius-appearance-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 19em), 1fr)); gap: 28px; margin: 24px 0; }
.confucius-settings-options, .confucius-settings-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px; }
.confucius-settings-options .confucius-button { height: auto; min-height: 34px; white-space: normal; overflow-wrap: anywhere; }
.confucius-settings-options [aria-checked=true], .confucius-settings-options [aria-selected=true] { background: var(--confucius-selected); color: var(--confucius-ink); font-weight: 600; }
.confucius-appearance-settings [hidden], .confucius-runtime-settings [hidden], #confucius-preferences [hidden] { display: none !important; }
.confucius-range-controls { display: grid; grid-template-columns: minmax(40px, 1fr) 5.5em auto; align-items: center; gap: 8px; }
:is(.confucius-settings-shell, #confucius-preferences) .confucius-range-controls input[type=range] { appearance: auto; width: 100%; height: 36px; min-width: 0; min-height: 36px; max-height: none; margin: 0; padding: 0; border: 0; border-radius: 0; box-sizing: border-box; background: transparent !important; color: var(--confucius-ink); font: inherit; accent-color: var(--confucius-accent); }
@container confucius-appearance-section (max-width: 14em) {
  .confucius-range-controls { grid-template-columns: minmax(0, 1fr) auto; }
  .confucius-range-controls input[type=range] { grid-column: 1 / -1; }
}
.confucius-settings-unit { color: var(--confucius-secondary); }
.confucius-font-picker > summary { display: flex; align-items: center; justify-content: space-between; height: auto; min-height: 36px; padding: 8px 10px; list-style: none; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.confucius-font-picker > summary::after { content: "⌄"; margin-inline-start: 8px; color: var(--confucius-secondary); }
.confucius-font-picker-body { padding: 8px 0; }
.confucius-font-picker-body > input { width: 100%; }
.confucius-font-results { max-height: 220px; overflow-y: auto; overscroll-behavior: contain; margin-top: 8px; padding: 4px; border-radius: 8px; background: var(--confucius-paper); }
.confucius-font-results .confucius-font-option { display: block; width: 100%; min-height: 34px; height: auto; margin: 0; background: transparent; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.confucius-font-option[aria-selected=true] { background: var(--confucius-selected) !important; }
.confucius-font-option[data-active=true] { outline: 2px solid var(--confucius-focus); outline-offset: -2px; }
.confucius-color-fields { display: grid; gap: 12px; margin: 16px 0; }
.confucius-color-panel { container-type: inline-size; container-name: confucius-colors; }
.confucius-color-field { display: grid; grid-template-columns: minmax(0, 1fr) 36px minmax(6.5em, 7em); align-items: center; gap: 8px; }
.confucius-color-field label { margin: 0; color: var(--confucius-secondary); font-size: .92em; }
:is(.confucius-settings-shell, #confucius-preferences) .confucius-color-field input[type=color] { appearance: auto; width: 36px; height: 36px; min-width: 36px; min-height: 36px; max-height: 36px; margin: 0; padding: 3px; border: 1px solid var(--confucius-line-strong); border-radius: 8px; box-sizing: border-box; background: var(--confucius-surface); color: var(--confucius-ink); font: inherit; }
.confucius-color-field input[type=color]::-moz-color-swatch { border: 0; border-radius: 4px; }
.confucius-color-field input[type=text] { width: 100%; font-variant-numeric: tabular-nums; }
:is(.confucius-settings-shell, #confucius-preferences) .confucius-color-field [aria-invalid=true] { outline: 2px solid var(--confucius-danger); outline-offset: 0; }
@container confucius-colors (max-width: 22em) {
  .confucius-color-field { grid-template-columns: 36px minmax(0, 1fr); }
  .confucius-color-field label { grid-column: 1 / -1; }
}
.confucius-runtime-host-row { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 8px; align-items: start; margin: 0; cursor: pointer; }
.confucius-runtime-card { margin: 20px 0; padding: 16px; border-radius: 8px; background: var(--confucius-paper); min-width: 0; }
.confucius-runtime-header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
.confucius-runtime-header h3 { flex: 1; margin: 0; }
.confucius-runtime-state { display: inline-flex; align-items: center; gap: 6px; font-size: .92em; color: var(--confucius-secondary); }
.confucius-runtime-state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.confucius-runtime-state[data-state=ready] { color: var(--confucius-success); }
.confucius-runtime-state[data-state=error], .confucius-runtime-error { color: var(--confucius-danger); }
.confucius-runtime-error:empty { display: none; }
.confucius-runtime-path-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.confucius-runtime-path-row input { flex: 1 1 180px; width: 100%; }
.confucius-runtime-path { overflow-wrap: anywhere; white-space: pre-wrap; }
.confucius-runtime-path-mode { display: flex; align-items: center; gap: 8px; max-width: 100%; min-width: 0; margin: 0; color: var(--confucius-secondary); }
.confucius-runtime-path-mode span { min-width: 0; overflow-wrap: anywhere; }
.confucius-runtime-settings input:is([type=checkbox], [type=radio]) { appearance: auto; width: 16px; height: 16px; min-width: 16px; min-height: 16px; max-width: 16px; max-height: none; margin: 0; padding: 0; flex-shrink: 0; color: var(--confucius-ink); font: inherit; }
.confucius-runtime-host-row input { margin-top: max(0px, calc((1.5em - 16px) / 2)); }
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
:is(.confucius-settings-shell, .confucius-dialog-panel, #confucius-preferences) :is(input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea, select) {
  appearance: none; height: auto; max-height: none; min-width: 0; max-width: 100%; min-height: 36px; margin: 0; padding: 8px 10px;
  border: 0 !important; border-radius: 8px; box-sizing: border-box; background: var(--confucius-surface) !important; color: var(--confucius-ink); font: inherit;
}
:is(.confucius-settings-shell, .confucius-dialog-panel, #confucius-preferences) :is(input, textarea, select):focus { outline: 2px solid var(--confucius-focus); outline-offset: 0; box-shadow: none; }
:is(.confucius-settings-shell, #confucius-preferences) [role=radio] { border: 0 !important; background: transparent !important; color: var(--confucius-muted) !important; }
:is(.confucius-settings-shell, #confucius-preferences) [role=radio]:hover:not(:disabled),
:is(.confucius-settings-shell, #confucius-preferences) [role=radio][aria-checked=true] { background: var(--confucius-surface) !important; color: var(--confucius-ink) !important; }
.confucius-settings-shell .confucius-settings-select { border: 0; background: var(--confucius-surface); }
.confucius-settings-shell .confucius-button { border: 0 !important; }
@media (forced-colors: active), (prefers-contrast: more) {
  :is(.confucius-settings-shell, #confucius-preferences) :is([role=tab][aria-selected=true], [role=option][aria-selected=true], [role=radio][aria-checked=true]) { text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 2px; }
  :is(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-window, #confucius-knowledge-overlay, #confucius-preferences) .confucius-button[data-variant=primary]:focus-visible,
  [data-confucius-input=keyboard] :is(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-window, #confucius-knowledge-overlay, #confucius-preferences) .confucius-button[data-variant=primary]:focus { outline-color: var(--confucius-primary-ink); }
}
[data-confucius-preferences-scroll] { background: var(--confucius-paper); color: var(--confucius-ink); scroll-padding-top: calc(var(--confucius-font-size, 13px) * 1.5 + 40px); scroll-padding-bottom: calc(var(--confucius-font-size, 13px) * 5 + 32px); }
#confucius-preferences { --confucius-control-height: 36px; background: var(--confucius-paper); color: var(--confucius-ink); padding: 8px 16px 32px; font-family: var(--confucius-font-family, system-ui); font-size: var(--confucius-font-size, 13px); line-height: 1.5; }
#confucius-preferences groupbox { appearance: none; margin: 0 0 20px; padding: 16px 0; border: 0; background: transparent; }
#confucius-preferences h2 { margin: 0 0 8px; font-size: 17px; font-weight: 650; letter-spacing: -.02em; }
#confucius-preferences groupbox > p { color: var(--confucius-muted); margin: 4px 0 16px; }
#confucius-preferences groupbox > label { margin: 10px 0 4px; }
#confucius-preferences .confucius-settings-tabs { position: sticky; top: 0; z-index: 3; padding: 8px 0 12px; background: var(--confucius-paper); }
#confucius-preferences .confucius-settings-tabs [role=tab] { min-height: 34px; margin: 0; }
#confucius-pref-appearance > .confucius-settings-footer { position: sticky; bottom: 0; z-index: 2; margin: 0; padding: 12px 0; background: var(--confucius-paper); }
#confucius-preferences groupbox > :is(input:not([type=checkbox]):not([type=radio]), textarea, select) { margin-bottom: 8px; }
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
.confucius-workspace-root:is([data-confucius-density=compact], [data-confucius-density=narrow]) .confucius-settings-tabs [role=tab] { padding: 6px 8px; white-space: nowrap; }
.confucius-workspace-root:is([data-confucius-density=compact], [data-confucius-density=narrow]) .confucius-settings-content { padding: 12px 16px 24px; }
.confucius-workspace-root:is([data-confucius-density=compact], [data-confucius-density=narrow]) .confucius-settings-footer { padding: 12px 16px; }
.confucius-workspace-root[data-confucius-compact-panels=true] .confucius-knowledge-overlay { padding: 8px; }
@media (prefers-reduced-motion: reduce) { .confucius-dialog *, #confucius-knowledge-overlay *, #confucius-artifact-window * { animation: none !important; transition: none !important; } }
`;
