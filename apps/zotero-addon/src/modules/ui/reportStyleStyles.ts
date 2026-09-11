export const REPORT_STYLE_CSS = `
.confucius-report-style-dialog { container-type: inline-size; }
.confucius-report-style-dialog .confucius-dialog-panel { width: min(760px, 100%); padding: 24px; }
.confucius-report-style-dialog h2 { font-size: 20px; line-height: 1.4; margin: 0 0 8px; }
.confucius-report-style-intro { margin: 0 0 24px; color: var(--confucius-secondary); }
.confucius-report-style-groups { display: grid; gap: 20px; }
.confucius-report-style-group h3 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 14px; margin: 0 0 8px; }
.confucius-report-style-group h3 span { font-size: 12px; font-weight: 400; color: var(--confucius-muted); }
.confucius-report-style-choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.confucius-report-style-choice.confucius-button { justify-content: flex-start; align-items: flex-start; gap: 8px; padding: 12px; text-align: left; font-size: 13px; font-weight: 400; background: transparent; min-height: 76px; transition: background-color 120ms ease; }
.confucius-report-style-choice.confucius-button[aria-checked=true] { background: var(--confucius-surface); }
.confucius-report-style-choice.confucius-button:hover:not(:disabled) { background: var(--confucius-hover); }
.confucius-report-style-choice strong { font-weight: 600; }
.confucius-report-style-description { display: block; margin-top: 4px; font-size: 12px; color: var(--confucius-secondary); line-height: 1.5; }
.confucius-report-style-radio { box-sizing: border-box; flex: 0 0 12px; height: 12px; margin-top: 3px; border: 1px solid var(--confucius-muted); border-radius: 50%; }
.confucius-report-style-choice[aria-checked=true] .confucius-report-style-radio { border: 4px solid var(--confucius-accent); }
.confucius-report-style-sample-title { margin: 24px 0 4px; font-size: 12px; color: var(--confucius-muted); }
.confucius-report-style-summary { margin: 0 0 12px; font-size: 12px; color: var(--confucius-secondary); }
.confucius-report-style-preview { font-size: 13px; }
.confucius-report-style-preview > :first-child { margin-top: 0; }
.confucius-report-style-hint { margin: 20px 0 12px; font-size: 12px; color: var(--confucius-muted); }
.confucius-report-style-footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.confucius-report-style-footer .confucius-button { min-height: 34px; }
.confucius-report-style-error { color: var(--confucius-danger); }
#confucius-report-style { flex: none; white-space: nowrap; font-size: 12px; padding: 0 8px; height: var(--confucius-composer-control-size); min-height: var(--confucius-composer-control-size); background: transparent; }
#confucius-report-style[hidden] { display: none; }
#confucius-report-style:hover:not(:disabled) { background: var(--confucius-surface); }
.confucius-reading-parallel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 24px; margin: 20px 0; }
.confucius-reading-parallel > div { min-width: 0; }
.confucius-reading-surface .confucius-reading-parallel blockquote { border: 0; padding: 0; margin: 0; background: transparent; font-size: .92em; }
.confucius-reading-parallel > div > :first-child { margin-top: 0; }
.confucius-reading-parallel > div > :last-child { margin-bottom: 0; }
.confucius-reading-help { margin: 12px 0 20px; }
.confucius-reading-help summary { width: fit-content; max-width: 100%; cursor: pointer; color: var(--confucius-accent-text); font-size: .9em; }
.confucius-reading-help summary:focus-visible { outline: 2px solid var(--confucius-focus); outline-offset: 2px; border-radius: 4px; }
.confucius-reading-help[open] > :not(summary) { margin-left: 16px; }
.confucius-reading-surface { container-type: inline-size; }
@container (max-width: 520px) {
  .confucius-reading-parallel { grid-template-columns: minmax(0, 1fr); gap: 12px; }
}
@container (max-width: 600px) {
  .confucius-report-style-dialog .confucius-dialog-panel { padding: 16px; }
  .confucius-report-style-choices { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .confucius-report-style-choice.confucius-button { min-height: 0; padding: 10px 12px; }
  .confucius-report-style-groups { gap: 16px; }
}
@media (prefers-reduced-motion: reduce) { .confucius-report-style-choice.confucius-button { transition: none; } }
@media (forced-colors: active) {
  .confucius-report-style-choice[aria-checked=true] .confucius-report-style-radio { border-color: Highlight; }
}
`;
