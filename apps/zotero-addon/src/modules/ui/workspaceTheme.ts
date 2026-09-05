import { SURFACE_CSS } from "./workspaceSurface";

export const TUI_CSS = `
@keyframes confucius-waiting-turn {
  0% { transform: rotate(0deg); opacity: 0.85; }
  50% { opacity: 0.4; }
  100% { transform: rotate(360deg); opacity: 0.85; }
}
.confucius-workspace-root {
  min-width: 0;
  max-width: 100%;
}
.confucius-workspace-root > .confucius-topbar,
.confucius-workspace-root > .confucius-columns,
.confucius-workspace-root > .confucius-composer {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-activity-shell,
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-task-overview,
.confucius-workspace-root[data-confucius-layout="sidebar"] .tui-answer {
  min-width: 0;
  max-width: 100%;
}
.tui-waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: #70695f;
}
.tui-waiting-mark {
  width: 11px;
  height: 11px;
  flex: none;
  color: #55504a;
  transform-origin: 50% 50%;
  animation: confucius-waiting-turn 5.6s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}
.tui-answer table { border-collapse: collapse; margin: 8px 0; width: auto; }
.tui-answer {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  font-size: var(--confucius-markdown-font-size, 13px);
  line-height: var(--confucius-reading-line-height, 1.6);
}
.tui-answer table {
  display: block;
  max-width: 100%;
  /* scrollbar-gutter reserves space for vertical scrollbars only. Keep a rail
     even before overflow so streaming tables cannot move the next block. */
  overflow-x: scroll;
  overflow-y: hidden;
}
.tui-answer th, .tui-answer td {
  min-width: 100px;
  border: 0;
  border-bottom: 1px solid #e7e2d8;
  padding: 4px 8px;
  font-size: 1em;
}
.tui-answer th { background: #f0ece3; }
.tui-answer pre {
  background: #f0ece3;
  padding: 8px 10px;
  overflow-x: scroll;
  overflow-y: hidden;
  max-width: 100%;
  box-sizing: border-box;
  overflow-wrap: anywhere;
  font-size: 0.92em;
}
.tui-answer code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.92em;
}
.tui-answer img { max-width: 100%; height: auto; }
.tui-answer .katex-display { max-width: 100%; overflow-x: scroll; overflow-y: hidden; }
.tui-answer h1, .tui-answer h2, .tui-answer h3 { margin: 10px 0 6px; }
.tui-answer p { margin: 0 0 8px; }
.tui-answer math { font-size: 1.05em; }
.confucius-answer-shell { position: relative; }
.confucius-answer-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 26px;
  margin: 1px 0 0 -3px;
  opacity: .62;
  transition: opacity 120ms ease;
}
.confucius-answer-shell:hover .confucius-answer-actions,
.confucius-answer-shell:focus-within .confucius-answer-actions { opacity: 1; }
.confucius-answer-action {
  appearance: none;
  width: 26px;
  height: 26px;
  min-width: 26px;
  min-height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #777166;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, transform 120ms ease;
}
.confucius-answer-action:hover:not(:disabled) {
  background: #eee9df;
  color: #33302a;
}
.confucius-answer-action:active:not(:disabled) { transform: translateY(1px); }
.confucius-answer-action:focus-visible {
  outline: 2px solid #9a6842;
  outline-offset: 1px;
}
.confucius-answer-action:disabled { cursor: default; opacity: .38; }
.confucius-answer-action[data-state="success"] {
  background: #e5eee5;
  color: #3f6d49;
}
.confucius-answer-action svg { width: 15px; height: 15px; display: block; }
.confucius-menu-surface {
  position: fixed;
  z-index: 930;
  min-width: 0;
  max-height: 360px;
  padding: 8px;
  border: 0;
  border-radius: 12px;
  background: #fffefa;
  color: #33302a;
  box-shadow: 0 12px 32px rgba(45, 38, 26, .12), 0 2px 6px rgba(45, 38, 26, .06);
  box-sizing: border-box;
  overscroll-behavior: contain;
  font: inherit;
}
.confucius-menu-picker { display: flex; flex-direction: column; }
.confucius-menu-picker > :not(:last-child) { flex: none; }
.confucius-menu-picker > :last-child { min-height: 0; }
.confucius-menu-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 6px 8px 8px; }
.confucius-menu-header strong { flex: none; font-size: .92em; font-weight: 600; }
.confucius-menu-header > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .82em; color: #80776b; }
.confucius-menu-heading { margin: 12px 8px 4px; color: #80776b; font-size: .82em; font-weight: 500; }
.confucius-menu-heading:first-child { margin-top: 6px; }
.confucius-menu-row, .confucius-composer-menu-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 36px;
  width: 100%;
  margin: 0;
  padding: 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #33302a;
  box-shadow: none;
  box-sizing: border-box;
  appearance: none;
  text-align: left;
  cursor: pointer;
  font: inherit;
  line-height: 1.35;
}
.confucius-composer-menu-row { min-height: 48px; }
.confucius-menu-row:hover,
.confucius-menu-row:focus-visible,
.confucius-menu-row[data-active="true"],
.confucius-menu-row[data-highlighted="true"],
.confucius-composer-menu-row[aria-selected="true"] { background: #f0ede6; box-shadow: none; }
.confucius-menu-row:focus-visible { outline: 2px solid #a79a86; outline-offset: -2px; }
.confucius-menu-glyph { display: inline-flex; flex: 0 0 22px; align-items: center; justify-content: center; height: 24px; color: #8c7b64; font-size: 16px; }
.confucius-menu-back { margin-bottom: 4px; color: #80776b; }
.confucius-context-details p { margin: 6px 8px 12px; line-height: 1.6; overflow-wrap: anywhere; }
.confucius-context-details p + p { color: #80776b; font-size: .9em; }
.confucius-menu-footer { display: flex; justify-content: flex-end; gap: 4px; margin-top: 8px; }
.confucius-menu-footer .confucius-menu-row { width: auto; }
.confucius-composer {
  position: relative;
  flex: 0 0 auto;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 12px 24px 18px;
  box-sizing: border-box;
  background: var(--confucius-paper, #faf9f6);
}
.confucius-composer-card {
  --confucius-composer-control-size: 36px;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 880px;
  min-width: 0;
  margin: 0 auto;
  padding: 12px;
  box-sizing: border-box;
  border: 0;
  border-radius: 16px;
  background: #fffefa;
  box-shadow: 0 4px 24px rgba(70, 59, 43, .055);
}
.confucius-composer-sources {
  min-width: 0;
  max-height: 112px;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.confucius-composer-sources > :not(:empty) { padding: 0 4px 8px; box-sizing: border-box; }
.confucius-source-tray:empty { display: none; }
#confucius-prompt {
  flex: none;
  width: 100%;
  height: 108px;
  min-height: 108px;
  max-height: 108px;
  margin: 0;
  padding: 2px 4px 8px;
  border-radius: 0;
  appearance: none;
  resize: none;
  line-height: var(--confucius-reading-line-height, 1.6);
}
#confucius-prompt:focus { outline: none; box-shadow: none; }
.confucius-composer-toolbar {
  display: grid;
  grid-template-columns: var(--confucius-composer-control-size) minmax(0, 1fr) 30px var(--confucius-composer-control-size);
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding-top: 4px;
}
.confucius-composer-toolbar[data-status-active="true"] { grid-template-columns: minmax(0, max-content) minmax(24px, 1fr) 30px var(--confucius-composer-control-size); }
.confucius-composer-leading { grid-area: 1 / 1; display: flex; align-items: center; gap: 4px; min-width: 0; }
.confucius-composer-leading #confucius-plus { flex: none; }
.confucius-composer-toolbar .confucius-composer-status {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  flex: 0 1 auto; min-width: var(--confucius-composer-control-size); max-width: 100%;
  height: var(--confucius-composer-control-size); min-height: var(--confucius-composer-control-size);
  margin: 0; padding: 0 8px; border: 0; border-radius: 8px; background: #f0ede6; color: #805c37;
  font: inherit; font-size: .9em; line-height: 1; cursor: pointer; box-sizing: border-box;
}
.confucius-composer-toolbar .confucius-composer-status[hidden] { display: none; }
.confucius-composer-status:hover:not(:disabled) { background: #e8e2d6; }
.confucius-composer-status:focus-visible { outline: 2px solid #a79a86; outline-offset: 2px; }
.confucius-composer-status:disabled { cursor: default; opacity: .55; }
.confucius-composer-status-glyph { flex: none; display: grid; place-items: center; width: 16px; height: 16px; }
.confucius-composer-status-glyph svg { grid-area: 1 / 1; display: block; width: 16px; height: 16px; }
.confucius-composer-status-glyph [data-icon=dismiss] { visibility: hidden; }
.confucius-composer-status[data-dismiss-preview=true] [data-icon=state] { visibility: hidden; }
.confucius-composer-status[data-dismiss-preview=true] [data-icon=dismiss] { visibility: visible; }
.confucius-composer-status-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#confucius-plus, .confucius-composer-toolbar .confucius-composer-action {
  width: var(--confucius-composer-control-size);
  height: var(--confucius-composer-control-size);
  min-width: 0;
  min-height: var(--confucius-composer-control-size);
  margin: 0;
  padding: 0;
  border-radius: 50%;
  box-sizing: border-box;
}
#confucius-plus { grid-area: 1 / 1; line-height: 1; }
#confucius-endpoint {
  grid-area: 1 / 2;
  margin: 0;
  justify-self: end;
  min-width: 0;
  max-width: min(260px, 100%);
  height: var(--confucius-composer-control-size);
  padding: 0 8px;
  border-radius: 8px;
}
.confucius-composer-toolbar :is(#confucius-plus, #confucius-endpoint, .confucius-composer-status, .confucius-composer-action) {
  height: var(--confucius-composer-control-size);
  min-height: var(--confucius-composer-control-size);
  max-height: var(--confucius-composer-control-size);
}
#confucius-plus:hover, #confucius-endpoint:hover { background: #f0ece3; }
.confucius-composer-toolbar #confucius-context-ring { grid-area: 1 / 3; margin: 0; }
.confucius-composer-toolbar .confucius-composer-action { grid-area: 1 / 4; border: 0; background: #33302a; color: #fffefa; cursor: pointer; font: inherit; font-size: 20px; line-height: 1; }
.confucius-composer-action:hover:not(:disabled) { background: #51483b; }
.confucius-composer-action:disabled { opacity: .45; cursor: default; }
.confucius-composer-toolbar #confucius-stop { border: 1px solid #8c6a3f; background: transparent; color: #8c6a3f; font-size: 13px; }
.confucius-workspace-root:is([data-confucius-density="compact"], [data-confucius-density="narrow"]) .confucius-composer { padding: 8px 10px 10px; }
.confucius-workspace-root[data-confucius-density="narrow"] .confucius-composer-card { --confucius-composer-control-size: 32px; padding: 10px; }
.confucius-workspace-root[data-confucius-density="narrow"] .confucius-composer-toolbar { grid-template-columns: 32px minmax(0, 1fr) 32px; gap: 4px; }
.confucius-workspace-root[data-confucius-density="narrow"] #confucius-context-ring { display: none; }
.confucius-workspace-root[data-confucius-density="narrow"] .confucius-composer-action { grid-column: 3; }
.confucius-workspace-root[data-confucius-density="narrow"] .confucius-composer-toolbar[data-status-active="true"] { grid-template-columns: minmax(0, 1fr) 24px 32px; }
.confucius-workspace-root[data-confucius-density="narrow"] .confucius-composer-status { padding: 0 6px; }
.confucius-workspace-root[data-confucius-density="narrow"] [data-status-active="true"] #confucius-endpoint { padding: 0 4px; }
.confucius-workspace-root[data-confucius-density="narrow"] [data-status-active="true"] .confucius-endpoint-name { display: none; }
.confucius-attachment-tray {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.confucius-attachment-chip {
  max-width: min(310px, 100%);
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 5px 6px 5px 8px;
  border: 0;
  border-radius: 8px;
  background: #f2efe8;
  color: #33302a;
  box-sizing: border-box;
  box-shadow: none;
}
.confucius-attachment-chip[data-status="preparing"] { color: #7a684e; }
.confucius-attachment-chip[data-status="error"] {
  border-color: #dfb3a6;
  background: #fff8f5;
  color: #9c3f2b;
}
.confucius-attachment-kind {
  min-width: 30px;
  padding: 3px 5px;
  border-radius: 5px;
  background: transparent;
  color: #795b36;
  font-size: .75em;
  font-weight: 800;
  letter-spacing: .06em;
  text-align: center;
}
.confucius-attachment-chip[data-status="error"] .confucius-attachment-kind {
  background: #f4dfd8;
  color: #9c3f2b;
}
.confucius-attachment-copy { min-width: 0; }
.confucius-attachment-name {
  display: block;
  overflow: hidden;
  font-size: .9em;
  font-weight: 650;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-attachment-meta {
  display: block;
  overflow: hidden;
  margin-top: 1px;
  color: #70695f;
  font-size: .78em;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-attachment-remove {
  appearance: none;
  width: 24px;
  height: 24px;
  min-width: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #70695f;
  cursor: pointer;
  font: 600 16px/1 system-ui, sans-serif;
}
.confucius-attachment-remove:hover { background: #eee9df; color: #33302a; }
.confucius-drop-hint {
  position: absolute;
  inset: 6px;
  z-index: 950;
  display: grid;
  place-items: center;
  padding: 24px;
  border: 1px dashed rgba(138, 90, 43, .72);
  border-radius: 12px;
  background: rgba(250, 248, 242, .91);
  backdrop-filter: blur(4px);
  color: #795b36;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .01em;
  text-align: center;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 120ms ease, visibility 0s linear 120ms;
}
.confucius-workspace-root[data-file-drop-active="true"] .confucius-drop-hint {
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}
.confucius-icon-button {
  margin: 0 !important;
  width: 34px !important;
  height: 34px !important;
  min-width: 34px !important;
  min-height: 34px !important;
  flex: 0 0 34px;
  padding: 0 !important;
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
  justify-self: center;
  border: 0 !important;
  border-radius: 8px !important;
  background: transparent !important;
  color: #33302a !important;
  box-sizing: border-box;
  cursor: pointer;
  line-height: 1;
  transition: background 120ms ease, color 120ms ease;
}
.confucius-icon-button:hover {
  background: #f0ece3 !important;
  color: #33302a !important;
}
.confucius-icon-button:focus-visible {
  outline: 2px solid #33302a;
  outline-offset: 2px;
}
.confucius-icon-button svg {
  width: 20px;
  height: 20px;
  display: block;
}
.confucius-knowledge-overlay {
  position: absolute;
  inset: 0;
  z-index: 1200;
  display: flex;
  padding: 24px;
  box-sizing: border-box;
  background: #332a1c22;
  backdrop-filter: blur(8px);
}
.confucius-knowledge-shell {
  width: min(1180px, 100%);
  height: 100%;
  min-width: 0;
  min-height: 0;
  margin: auto;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 0;
  border-radius: 16px;
  background: #fffefa;
  box-shadow: 0 18px 50px rgba(90, 80, 60, 0.16);
}
.confucius-knowledge-header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 20px 24px 16px;
  border-bottom: 0;
  background: #fffefa;
}
.confucius-knowledge-header-copy { min-width: 0; flex: 1; }
.confucius-knowledge-eyebrow {
  color: #70695f;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.confucius-knowledge-heading {
  overflow: hidden;
  color: #33302a;
  font: inherit; font-size: 1.3em; font-weight: 650;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-knowledge-body {
  display: grid;
  grid-template-columns: minmax(170px, 220px) minmax(220px, .85fr) minmax(280px, 1.15fr);
  min-width: 0;
  min-height: 0;
}
.confucius-knowledge-pane {
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
  box-sizing: border-box;
}
.confucius-knowledge-topics {
  padding: 8px 16px 20px;
  border-right: 0;
  background: #fffefa;
}
.confucius-knowledge-entries {
  padding: 8px 16px 20px;
  border-right: 0;
  background: #fffefa;
}
.confucius-knowledge-editor { padding: 8px 24px 20px; background: #fffefa; }
.confucius-kb-row, .confucius-kb-entry-row {
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #33302a;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
}
.confucius-kb-row:hover, .confucius-kb-entry-row:hover { background: #efece4; }
.confucius-kb-row.active, .confucius-kb-entry-row.active {
  background: #f0ece3;
  color: #33302a;
  box-shadow: none;
}
.confucius-kb-meta { margin-top: 2px; color: #70695f; font-size: .86em; }
.confucius-kb-section-label {
  margin: 12px 0 8px;
  color: #70695f;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.confucius-kb-toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
.confucius-kb-toolbar input { flex: 1; min-width: 0; }
.confucius-kb-filters { display: flex; flex-wrap: wrap; gap: 4px; overflow-x: scroll; overflow-y: hidden; padding-bottom: 8px; }
.confucius-kb-filter {
  flex: 0 0 auto;
  padding: 4px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #6b665c;
  cursor: pointer;
  font: inherit;
  font-size: .9em;
}
.confucius-kb-filter.active { background: #f0ece3; border-color: #33302a; color: #33302a; }
.confucius-kb-field { display: grid; gap: 5px; margin-bottom: 12px; color: #555046; font-size: 11px; }
.confucius-kb-field input, .confucius-kb-field textarea, .confucius-kb-field select,
.confucius-kb-toolbar input {
  min-width: 0;
  width: 100%;
  padding: 8px 9px;
  border: 0;
  border-radius: 8px;
  background: #f2efe8;
  color: #33302a;
  box-sizing: border-box;
  font: inherit;
}
.confucius-kb-field input:focus, .confucius-kb-field textarea:focus, .confucius-kb-field select:focus,
.confucius-kb-toolbar input:focus {
  outline: 2px solid #b5a68d;
  outline-offset: 0;
}
.confucius-kb-field textarea { min-height: 180px; resize: vertical; line-height: 1.5; }
.confucius-mindmap-workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.confucius-mindmap-preview {
  min-height: 220px;
  overflow-x: scroll;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 12px;
  border: 0;
  border-radius: 8px;
  background: #f7f5ef;
}
.confucius-mindmap-preview ul { margin: 4px 0 4px 14px; padding-left: 12px; border-left: 1px solid #ddd8cc; }
.confucius-mindmap-preview > ul { margin-left: 0; padding-left: 0; border-left: 0; }
.confucius-mindmap-preview li { margin: 5px 0; color: #33302a; }
.confucius-kb-actions { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
.confucius-kb-danger { margin-left: auto; color: #b3452f !important; background: transparent !important; border-color: #e3c0b6 !important; }
.confucius-kb-empty { display: grid; place-items: center; min-height: 180px; padding: 18px; color: #70695f; text-align: center; }
.confucius-kb-error { margin: 8px 0; color: #b3452f; font-size: 12px; white-space: pre-wrap; }
@media (max-width: 760px) {
  .confucius-knowledge-overlay { padding: 0; }
  .confucius-knowledge-shell { border: 0; border-radius: 0; }
  .confucius-knowledge-body { grid-template-columns: 132px minmax(0, 1fr); }
  .confucius-knowledge-editor { grid-column: 1 / -1; border-top: 0; }
  .confucius-knowledge-entries { border-right: 0; }
  .confucius-mindmap-workspace { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 430px) {
  .confucius-knowledge-header { padding: 9px 10px; }
  .confucius-knowledge-body { display: block; overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; }
  .confucius-knowledge-pane { overflow: visible; }
  .confucius-knowledge-topics { border-right: 0; border-bottom: 0; }
  .confucius-knowledge-entries { border-right: 0; border-bottom: 0; }
  .confucius-kb-topic-list { display: flex; gap: 6px; overflow-x: scroll; overflow-y: hidden; }
  .confucius-kb-row { flex: 0 0 140px; }
  .confucius-kb-field textarea { min-height: 150px; }
}
.confucius-workspace-root a {
  color: #8a5a2b;
  text-decoration: underline;
  text-decoration-color: #cbb890;
  text-underline-offset: 2px;
  cursor: pointer;
}
.confucius-task-row {
  border: 0;
  transition: background 120ms ease, border-color 120ms ease;
}
.confucius-task-row:hover { background: #f0ece3 !important; }

.confucius-activity-shell {
  width: min(900px, 100%);
  min-width: 0;
  max-width: 100%;
  margin: 0 auto;
  padding-bottom: 28px;
  box-sizing: border-box;
}
.confucius-activity-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 14px;
}
.confucius-task-overview {
  margin-bottom: 18px;
  padding: 4px 0 18px;
  border: 0;
}
.confucius-task-overview-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.confucius-task-overview h1 {
  margin: 5px 0 4px;
  overflow-wrap: anywhere;
  font-size: clamp(21px, 3.2vw, 27px);
  line-height: 1.2;
  letter-spacing: -.02em;
}
.confucius-task-empty {
  margin: 4px 0 18px;
  padding: 18px 0 20px;
  border: 0;
}
.confucius-artifact-file {
  appearance: none;
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  margin: 10px 0;
  padding: 13px 14px;
  border: 0;
  border-radius: 12px;
  background: #fffefa;
  color: #33302a;
  box-sizing: border-box;
  box-shadow: 0 4px 20px rgba(70, 59, 43, .045);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}
.confucius-artifact-file:hover {
  border-color: #b8ad9d;
  box-shadow: 0 8px 22px rgba(70, 59, 43, .09);
  transform: translateY(-1px);
}
.confucius-artifact-file:focus-visible {
  outline: 2px solid #8a5a2b;
  outline-offset: 2px;
}
.confucius-artifact-file-icon {
  width: 34px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #8a5a2b;
  font: 700 17px/1 Georgia, serif;
  box-shadow: none;
}
.confucius-artifact-file[data-update="true"] .confucius-artifact-file-icon {
  border-color: #9db09f;
  background: transparent;
  color: #4f7657;
}
.confucius-artifact-file-copy { min-width: 0; }
.confucius-artifact-file-kind {
  display: block;
  margin-bottom: 2px;
  color: #70695f;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.confucius-artifact-file-title {
  display: block;
  overflow: hidden;
  color: #33302a;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-artifact-file-meta {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  color: #777166;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-artifact-file-open {
  color: #8a5a2b;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file {
  height: auto;
  min-height: 50px;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: 9px;
  margin: 8px 0;
  padding: 8px 9px;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-icon {
  width: 28px;
  height: 34px;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-copy {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 45%);
  grid-template-areas:
    "title title"
    "kind meta";
  align-items: center;
  column-gap: 8px;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-kind {
  grid-area: kind;
  min-width: 0;
  margin: 1px 0 0;
  overflow: hidden;
  font-size: 9px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-title {
  grid-area: title;
  line-height: 1.3;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-meta {
  grid-area: meta;
  min-width: 0;
  margin: 1px 0 0;
  font-size: 10px;
  line-height: 1.25;
  text-align: right;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-open {
  display: none;
}
.confucius-artifact-overlay {
  position: absolute;
  inset: 0;
  z-index: 1000;
  display: block;
  padding: 0;
  box-sizing: border-box;
  background:
    #faf9f6;
  backdrop-filter: none;
  animation: confucius-artifact-overlay-in 150ms ease-out;
}
.confucius-artifact-overlay[data-refresh="true"] { animation: none; }
.confucius-artifact-overlay[data-mount="window"] { position: fixed; }
.confucius-artifact-overlay a {
  color: #8a5a2b;
  text-decoration: underline;
  text-decoration-color: #cbb890;
  text-underline-offset: 2px;
  cursor: pointer;
}
.confucius-artifact-dialog {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.confucius-artifact-action-rail {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 12px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 40px;
  min-width: 0;
  min-height: 0;
  padding: 14px 0;
  border: 0;
  background: transparent;
  box-sizing: border-box;
  pointer-events: none;
}
.confucius-artifact-rail-spacer { flex: 1 1 auto; }
.confucius-artifact-rail-divider {
  width: 16px;
  height: 1px;
  flex: 0 0 1px;
  margin: 1px 0 3px;
  background: transparent;
}
.confucius-artifact-rail-button,
.confucius-artifact-menu-trigger {
  appearance: none;
  position: relative;
  width: 40px;
  height: 40px;
  min-width: 40px;
  min-height: 40px;
  flex: 0 0 40px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 10px;
  background: transparent;
  backdrop-filter: none;
  color: #5d574d;
  box-sizing: border-box;
  box-shadow: none;
  font: inherit;
  cursor: pointer;
  pointer-events: auto;
  transition: background 110ms ease, border-color 110ms ease, color 110ms ease, transform 110ms ease, box-shadow 110ms ease;
}
.confucius-artifact-rail-button:hover,
.confucius-artifact-menu-trigger:hover {
  border-color: #c5b9a8;
  background: #eeebe3;
  color: #33302a;
  transform: none;
  box-shadow: none;
}
.confucius-artifact-menu-trigger[aria-expanded="true"] {
  border-color: #c5b9a8;
  background: #fffefa;
  color: #8a5a2b;
}
.confucius-artifact-rail-button:focus-visible,
.confucius-artifact-menu-trigger:focus-visible {
  outline: 2px solid #8a5a2b;
  outline-offset: 1px;
}
.confucius-artifact-rail-button svg,
.confucius-artifact-menu-trigger svg { width: 18px; height: 18px; display: block; }
.confucius-artifact-menu-trigger-value {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: -.02em;
  white-space: nowrap;
}
.confucius-artifact-menu-trigger-chevron {
  position: absolute;
  right: 4px;
  bottom: 2px;
  color: #9a9387;
  font-size: 11px;
  line-height: 1;
  transition: transform 100ms ease;
}
.confucius-artifact-revision-badge {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  backdrop-filter: blur(10px);
  color: #6f695f;
  box-sizing: border-box;
  font-size: 11px;
  font-weight: 700;
  pointer-events: auto;
}
#confucius-artifact-writeback {
  color: #8a5a2b;
}
#confucius-artifact-writeback:hover {
  border-color: #cabca9;
  background: #fffefa;
}
.confucius-artifact-rail-button:disabled {
  opacity: .38;
  cursor: default;
  transform: none;
}
.confucius-artifact-choice-menu {
  animation: confucius-artifact-menu-in 110ms ease-out;
}
.confucius-settings-choice-menu {
  animation: confucius-settings-menu-in 110ms ease-out;
}
.confucius-settings-select {
  appearance: none;
  width: 100%;
  height: 34px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 18px;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 0 9px 0 10px;
  border: 1px solid #ddd8cc;
  border-radius: 7px;
  background: #fff;
  color: #33302a;
  box-sizing: border-box;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 100ms ease, background 100ms ease,
    box-shadow 100ms ease;
}
.confucius-settings-select:hover:not(:disabled) {
  border-color: #c4bbad;
  background: #fffefa;
}
.confucius-settings-select:focus-visible,
.confucius-settings-select[aria-expanded="true"] {
  outline: none;
  border-color: #9a6430;
  box-shadow: 0 0 0 2px rgba(154, 100, 48, 0.14);
}
.confucius-settings-select:disabled {
  opacity: .48;
  cursor: default;
}
.confucius-settings-select-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-settings-select-chevron {
  color: #70695f;
  font-size: 12px;
  line-height: 1;
  text-align: center;
  transition: transform 100ms ease;
}
.confucius-settings-select[aria-expanded="true"]
  .confucius-settings-select-chevron {
  transform: rotate(180deg);
}
.confucius-artifact-choice,
.confucius-settings-choice {
  appearance: none;
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 18px;
  align-items: center;
  gap: 10px;
  padding: 8px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #33302a;
  box-sizing: border-box;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.confucius-artifact-choice:hover,
.confucius-artifact-choice:focus-visible,
.confucius-settings-choice:hover,
.confucius-settings-choice:focus-visible {
  outline: none;
  background: #f0ede6;
}
.confucius-artifact-choice[data-selected="true"],
.confucius-settings-choice[data-selected="true"] {
  background: #f0ede6;
  box-shadow: none;
}
.confucius-settings-choice-label {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-settings-choice-check {
  color: #8c6a3f;
  font-weight: 700;
  text-align: center;
}
.confucius-artifact-choice-copy { min-width: 0; }
.confucius-artifact-choice-title {
  display: block;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-artifact-choice-meta {
  display: block;
  margin-top: 1px;
  color: #70695f;
  font-size: 10px;
}
.confucius-artifact-choice-check {
  color: #8a5a2b;
  font-weight: 700;
  text-align: center;
}
.confucius-artifact-dialog-body {
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: clamp(26px, 5vh, 54px) max(clamp(18px, 5vw, 68px), 68px) 64px clamp(18px, 5vw, 68px);
  background: transparent;
  box-sizing: border-box;
}
.confucius-artifact-shell {
  width: min(780px, 100%);
  min-width: 0;
  min-height: calc(100% - 50px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
}
.confucius-artifact-paper {
  min-width: 0;
  flex: 1 0 auto;
  margin: 20px 0 30px;
  padding: clamp(26px, 4vw, 44px) clamp(22px, 4.5vw, 52px) 56px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-action-rail {
  right: 6px;
  width: 36px;
  padding: 10px 0;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-rail-button,
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-menu-trigger,
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-revision-badge {
  width: 36px;
  height: 36px;
  min-width: 36px;
  min-height: 36px;
  flex-basis: 36px;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-dialog-body {
  padding: 18px 48px 40px 10px;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-paper {
  margin: 10px 0 18px;
  padding: 18px 16px 34px;
  border-radius: 8px;
}
.confucius-artifact-paper .tui-answer {
  font-size: 1.02em;
  line-height: var(--confucius-reading-line-height, 1.6);
}
.confucius-artifact-paper table {
  width: 100%;
  border-collapse: collapse;
  font-size: .92em;
}
.confucius-artifact-paper th,
.confucius-artifact-paper td {
  padding: 8px 10px;
  border-bottom: 1px solid #e5e1d8;
  text-align: left;
  vertical-align: top;
}
.confucius-artifact-paper th { color: #6b665c; font-size: .82em; letter-spacing: .05em; text-transform: uppercase; }
.confucius-template-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: minmax(86px, auto);
  gap: 8px;
  margin-top: 18px;
  border: 0;
}
.confucius-template-button {
  appearance: none;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  min-width: 0;
  min-height: 86px;
  padding: 16px;
  border: 0;
  border-radius: 12px;
  background: #f2efe880;
  color: #33302a;
  box-sizing: border-box;
  white-space: normal;
  text-align: left;
  cursor: pointer;
}
.confucius-template-button:hover { color: #8c6a3f; background: #eeebe3; }
.confucius-template-title { display: block; margin-bottom: 3px; font-weight: 700; }
.confucius-template-copy { display: block; color: #777166; font-size: .9em; line-height: 1.4; }
.confucius-runtime-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: #9b968b;
}
.confucius-runtime-dot[data-state="ready"] { background: #4f7657; }
.confucius-runtime-dot[data-state="auth_required"] { background: #bf762f; }
.confucius-runtime-dot[data-state="error"] { background: #b3452f; }
.confucius-before-after {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 8px;
}
.confucius-before-after pre {
  max-height: 180px;
  margin: 3px 0 0;
  padding: 8px;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
  border: 0;
  border-radius: 6px;
  background: #fffefa;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 11px/1.45 ui-monospace, Consolas, monospace;
}
@media (max-width: 620px) {
  .confucius-template-grid,
  .confucius-before-after { grid-template-columns: minmax(0, 1fr); }
  .confucius-template-grid { grid-auto-rows: minmax(70px, auto); }
  .confucius-template-button { min-height: 70px; }
  .confucius-artifact-action-rail { right: 6px; width: 36px; padding: 10px 0; }
  .confucius-artifact-rail-button,
  .confucius-artifact-menu-trigger,
  .confucius-artifact-revision-badge {
    width: 36px;
    height: 36px;
    min-width: 36px;
    min-height: 36px;
    flex-basis: 36px;
  }
  .confucius-artifact-dialog-body { padding: 18px 48px 40px 10px; }
  .confucius-artifact-file { grid-template-columns: 38px minmax(0, 1fr); gap: 9px; padding: 11px; }
  .confucius-artifact-file-open { display: none; }
  .confucius-artifact-paper { margin: 8px 0 14px; padding: 16px 12px 30px; border-radius: 8px; }
}
@keyframes confucius-artifact-overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes confucius-artifact-menu-in {
  from { opacity: 0; transform: translateX(4px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes confucius-settings-menu-in {
  from { opacity: 0; transform: scale(.985); }
  to { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .confucius-artifact-overlay,
  .confucius-artifact-choice-menu,
  .confucius-settings-choice-menu { animation: none; }
  .confucius-artifact-menu-trigger-chevron,
  .confucius-settings-select-chevron,
  .confucius-drop-hint { transition: none; }
}


.confucius-workspace-root :is(button, input, textarea, select, summary):focus-visible,
#confucius-settings-overlay :is(button, input, textarea, select, summary):focus-visible,
#confucius-knowledge-overlay :is(button, input, textarea, select, summary):focus-visible,
#confucius-artifact-overlay :is(button, a, summary):focus-visible {
  outline: 2px solid var(--confucius-accent, #8c6a3f); outline-offset: 3px;
}
.confucius-workspace-root :is(input, textarea, select) { color: var(--confucius-ink); accent-color: var(--confucius-accent); }
:is(#confucius-settings-overlay, #confucius-knowledge-overlay) :is(input, textarea, select) { color: var(--confucius-ink); accent-color: var(--confucius-accent); }
.confucius-workspace-root :is(button, input, select, summary) { min-height: 28px; }
.confucius-workspace-root textarea::placeholder { color: var(--confucius-muted); opacity: 1; }
.confucius-workspace-root .confucius-task-search { width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 12px; border: 0; border-radius: 10px; background: #f0ede6; font: inherit; }
.confucius-session-pane h3 { margin: 16px 8px 8px; font-size: .82em; font-weight: 600; color: var(--confucius-muted); }
.confucius-session-pane .confucius-task-row { position: relative; display: flex; align-items: center; gap: 4px; margin-bottom: 4px; padding: 4px; border-radius: 8px; }
.confucius-task-row[data-active=true] { background: #ede7db; }
.confucius-task-row:hover { background: #f1ede5; }
.confucius-task-open { flex: 1; min-width: 0; padding: 8px; border: 0; background: transparent; color: var(--confucius-ink); text-align: left; cursor: pointer; font: inherit; }
.confucius-task-open span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.confucius-task-open small { display: block; margin-top: 4px; color: var(--confucius-muted); font-size: .82em; }
.confucius-task-row[data-task-status=running] .confucius-task-open small,
.confucius-task-row[data-task-status=awaiting_approval] .confucius-task-open small { color: #86521f; }
.confucius-task-empty { padding: 8px; color: var(--confucius-muted); font-size: .9em; }
.confucius-activity-shell { max-width: 880px; margin: 0 auto; padding-bottom: 16px; }
.confucius-activity-head { display: none; }
.confucius-task-overview { border: 0; padding: 8px 0 20px; }
.confucius-source-tray { display: flex; flex-wrap: wrap; gap: 8px; }
.confucius-source-tag { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; border: 0; border-radius: 8px; background: #f2efe8; padding: 2px 4px 2px 8px; font-size: .86em; }
.confucius-source-tag button { min-width: 24px; border: 0; background: transparent; color: #665036; cursor: pointer; font: inherit; }
.confucius-source-tag .confucius-source-title { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.confucius-source-tag[data-unavailable=true] { color: var(--confucius-muted); border-style: dashed; }
.confucius-source-unavailable { flex-shrink: 0; color: var(--confucius-muted); font-size: .9em; }
.confucius-history-sources { margin: 12px 0; border: 0; padding: 12px 0; font-size: .9em; color: var(--confucius-muted); }
.confucius-history-sources > summary { cursor: pointer; }
.confucius-history-sources button { border: 0; background: transparent; color: #715230; text-align: left; cursor: pointer; font: inherit; }
.confucius-history-sources pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; max-height: 240px; overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; padding: 12px; background: var(--confucius-surface); }
.confucius-mention-tabs { display: flex; gap: 4px; padding: 0 2px 6px; }
.confucius-mention-tabs button { appearance: none; border: 0; border-radius: 6px; background: transparent; color: #80776b; padding: 6px 10px; cursor: pointer; font: inherit; font-size: .9em; }
.confucius-mention-tabs button[aria-pressed=true] { background: #f0ede6; color: #33302a; }
.confucius-mention-tabs button:focus-visible { outline: 2px solid #a79a86; outline-offset: -2px; }
.confucius-reading-surface { color: #33302a; font-size: var(--confucius-markdown-font-size, 13px); line-height: var(--confucius-reading-line-height, 1.6); overflow-wrap: anywhere; }
.confucius-reading-surface table { display: block; border-collapse: collapse; max-width: 100%; overflow-x: scroll; overflow-y: hidden; }
.confucius-reading-surface :is(th, td) { min-width: 100px; padding: 10px 12px; border: 0; border-bottom: 1px solid #e7e2d8; text-align: left; vertical-align: top; }
.confucius-reading-surface th { background: #f2efe8; font-weight: 600; }
.confucius-reading-surface blockquote { border-left: 3px solid #c9b697; padding-left: 16px; margin-left: 0; color: #5b5348; }
@media (prefers-reduced-motion: reduce) { .confucius-workspace-root * { animation: none !important; transition: none !important; } }
.confucius-workspace-root[data-confucius-layout=sidebar] .confucius-source-title { max-width: 170px; }
.confucius-workspace-root[data-confucius-layout=sidebar] .confucius-task-overview { padding: 4px 0 12px; }

.confucius-workspace-root[data-confucius-layout=sidebar] .confucius-template-grid { grid-template-columns: 1fr; }
.confucius-workspace-root[data-confucius-layout=sidebar] .confucius-template-button { min-height: 64px; padding: 12px; }
.confucius-attachment-chip { border-radius: 8px; }
${SURFACE_CSS}
`;
