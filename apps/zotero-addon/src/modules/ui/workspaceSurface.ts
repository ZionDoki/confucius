import { config } from "../../../package.json";
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
  if (doc.getElementById("confucius-palette-css")) return;
  const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
  link.id = "confucius-palette-css";
  link.setAttribute("rel", "stylesheet");
  link.setAttribute(
    "href",
    `chrome://${config.addonRef}/content/workspacePalette.css`,
  );
  (doc.head ?? doc.documentElement)?.appendChild(link);
}

/** Shared product primitives. Also installed in Zotero's preferences document. */
export const SURFACE_CSS = `
/* Zotero's native button height limits are intended for single-line controls.
   Let text controls grow with their content; explicit icon/composer sizes win. */
:where(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-overlay, #confucius-knowledge-overlay, #confucius-preferences) button {
  height: auto; max-height: none; margin: 0; box-sizing: border-box;
}
:is(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-overlay, #confucius-knowledge-overlay, #confucius-preferences) {
  --confucius-space: 4px;
  --confucius-radius: 8px;
  --confucius-control-height: 32px;
  accent-color: var(--confucius-accent);
}
:is(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-overlay, #confucius-knowledge-overlay, #confucius-preferences) ::selection {
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
.confucius-latest { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); z-index: 8; margin-bottom: 12px; border-radius: 20px; background: var(--confucius-elevated); box-shadow: var(--confucius-shadow); white-space: nowrap; }
.confucius-latest[hidden] { display: none; }
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
:is(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-overlay, #confucius-knowledge-overlay, #confucius-preferences) :is(button, summary, a):focus-visible,
[data-confucius-input=keyboard] :is(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-overlay, #confucius-knowledge-overlay, #confucius-preferences) :is(button, summary, a):focus {
  outline: 2px solid var(--confucius-focus); outline-offset: -2px;
}
[data-confucius-input=pointer] :where(.confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-overlay, #confucius-knowledge-overlay, #confucius-preferences) :is(button, summary, a):focus {
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
@media (prefers-reduced-motion: reduce) { .confucius-dialog *, #confucius-knowledge-overlay *, #confucius-artifact-overlay * { animation: none !important; transition: none !important; } }
`;
