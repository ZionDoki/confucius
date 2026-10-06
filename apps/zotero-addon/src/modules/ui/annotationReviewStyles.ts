export const ANNOTATION_REVIEW_CSS = `
.confucius-annotation-review { min-width:0; max-width:100%; color:var(--confucius-ink); font-size:13px; line-height:1.6; }
.confucius-annotation-review[hidden],.confucius-annotation-review [hidden] { display:none !important; }
.confucius-annotation-review * { box-sizing:border-box; }
.confucius-annotation-review :is(h3,p,blockquote) { margin:0; }
.confucius-annotation-review .confucius-button { min-height:34px; height:34px; padding:6px 8px; font-size:13px; gap:6px; flex-shrink:0; white-space:nowrap; }
.confucius-annotation-review svg { display:block; width:16px; height:16px; flex:0 0 16px; }
.confucius-annotation-review .confucius-icon-button { width:34px; height:34px; padding:0; background:transparent; }
.confucius-annotation-review .confucius-icon-button svg { width:20px; height:20px; flex-basis:20px; }
.confucius-annotation-review .ar-capsule.confucius-button { display:flex; height:auto; min-height:34px; max-width:100%; padding:6px 12px; border-radius:24px; gap:8px; background:var(--confucius-elevated); box-shadow:var(--confucius-shadow-soft); font-size:12px; white-space:normal; }
.confucius-annotation-review .ar-capsule:hover { background:var(--confucius-hover); }
.confucius-annotation-review .ar-capsule-copy { display:flex; flex-wrap:wrap; align-items:baseline; gap:0 6px; min-width:0; text-align:left; }
.confucius-annotation-review .ar-capsule-count { font-variant-numeric:tabular-nums; }
.confucius-annotation-review .ar-capsule-new { color:var(--confucius-accent-text); white-space:nowrap; }
.confucius-annotation-review .ar-capsule:is([data-attention=true],[data-error=true]) .ar-capsule-count { color:var(--confucius-danger); }
.confucius-annotation-review .ar-caret { transform:rotate(180deg); }
.confucius-annotation-review .ar-capsule[aria-expanded=true] .ar-caret { transform:none; }
.confucius-annotation-review .ar-header { width:100%; display:flex; align-items:center; gap:8px; min-height:34px; }
.confucius-annotation-review h3 { display:flex; align-items:center; gap:8px; font-size:14px; font-weight:550; }
.confucius-annotation-review .ar-header > h3 { margin-right:auto; }
.confucius-annotation-review .ar-header > button { background:transparent; }
.confucius-annotation-review .ar-header > button:hover { background:var(--confucius-surface); }
.confucius-annotation-review .ar-muted { color:var(--confucius-muted); font-size:12px; }
.confucius-annotation-review .ar-view-switch { display:flex; flex-shrink:0; align-items:center; gap:2px; padding:2px; border-radius:8px; background:var(--confucius-surface); }
.confucius-annotation-review .ar-view-switch [aria-pressed=true] { background:var(--confucius-elevated) !important; }
.confucius-annotation-review .ar-scope-row,.confucius-annotation-review .ar-summary-row { display:flex; align-items:center; gap:8px; height:42px; min-width:0; }
.confucius-annotation-review .ar-scope-row > button:first-child { background:transparent; }
.confucius-annotation-review .ar-summary-row > button { margin-left:auto; color:var(--confucius-accent-text); font-size:12px; }
.confucius-annotation-review .ar-card-area { flex:1; min-height:0; padding:0 20px 4px; overflow:auto; scrollbar-width:thin; overscroll-behavior:contain; }
.confucius-annotation-review .ar-completion { flex:1; min-height:0; padding:24px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; text-align:center; overflow:auto; }
.confucius-annotation-review .ar-completion > svg { color:var(--confucius-success); width:24px; height:24px; }
.confucius-annotation-review .ar-stack { position:relative; padding-bottom:10px; }
.confucius-annotation-review .ar-stack::before,.confucius-annotation-review .ar-stack::after { content:''; position:absolute; pointer-events:none; border-radius:14px; }
.confucius-annotation-review .ar-stack::before { inset:4px 14px 0; background:var(--confucius-hover); transform:rotate(-.6deg); }
.confucius-annotation-review .ar-stack::after { inset:2px 7px 4px; background:var(--confucius-surface); transform:rotate(.4deg); }
.confucius-annotation-review .ar-paper { position:relative; z-index:1; padding:12px 0; border-radius:14px; background:var(--confucius-elevated); touch-action:pan-y; }
.confucius-annotation-review .ar-meta { display:flex; align-items:center; gap:8px; min-height:34px; color:var(--confucius-muted); font-size:12px; }
.confucius-annotation-review .ar-batch-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.confucius-annotation-review .ar-paper .ar-source { margin-left:auto; }
.confucius-annotation-review .ar-source { background:transparent; color:var(--confucius-accent-text); font-size:12px; }
.confucius-annotation-review .ar-source:hover { background:var(--confucius-surface); }
.confucius-annotation-review .ar-status { white-space:nowrap; font-size:12px; }
.confucius-annotation-review [data-status=accepted] { color:var(--confucius-success); }
.confucius-annotation-review :is([data-status=failed],[data-status=unknown]) { color:var(--confucius-danger); }
.confucius-annotation-review .ar-card-body { height:106px; padding:8px 0; overflow:auto; overscroll-behavior:contain; scrollbar-width:thin; touch-action:pan-y; }
.confucius-annotation-review .ar-quote { border-left:3px solid var(--ar-color); padding-left:10px; font-size:14px; line-height:1.65; overflow-wrap:anywhere; }
.confucius-annotation-review .ar-comment { padding:6px 0 0 13px; color:var(--confucius-secondary); font-size:13px; line-height:1.7; overflow-wrap:anywhere; }
.confucius-annotation-review .ar-card-footer { display:flex; align-items:center; gap:10px; min-height:38px; padding-top:4px; }
.confucius-annotation-review .ar-position { min-width:46px; font-size:12px; font-variant-numeric:tabular-nums; color:var(--confucius-secondary); }
.confucius-annotation-review .ar-range { appearance:none; background:transparent; flex:1; height:34px; width:110px; min-width:40px; margin:0; padding:0; border:0; touch-action:none; }
.confucius-annotation-review .ar-range::-moz-range-track { height:3px; border:0; background:var(--confucius-line-strong); }
.confucius-annotation-review .ar-range::-moz-range-thumb { height:12px; width:12px; border:0; border-radius:50%; background:var(--confucius-accent); }
.confucius-annotation-review .ar-range::-webkit-slider-runnable-track { height:3px; background:var(--confucius-line-strong); }
.confucius-annotation-review .ar-range::-webkit-slider-thumb { appearance:none; width:12px; height:12px; margin-top:-4.5px; border:0; border-radius:50%; background:var(--confucius-accent); }
.confucius-annotation-review .ar-actions { display:flex; align-items:center; gap:8px; margin-left:auto; }
.confucius-annotation-review .ar-decision { min-width:76px; }
.confucius-annotation-review .ar-error:empty,.confucius-annotation-review .ar-row-error:empty { display:none; }
.confucius-annotation-review .ar-error,.confucius-annotation-review .ar-row-error { color:var(--confucius-danger); font-size:12px; overflow-wrap:anywhere; }
.confucius-annotation-review .ar-popup { position:absolute; z-index:3; bottom:calc(100% + 8px); left:0; width:min(680px,100%); display:flex; flex-direction:column; border:0; border-radius:14px; background:var(--confucius-elevated); box-shadow:var(--confucius-shadow); overflow:hidden; container-type:inline-size; }
.confucius-annotation-review .ar-popup > :not(.ar-list):not(.ar-card-area):not(.ar-completion) { flex-shrink:0; }
.confucius-annotation-review .ar-popup-error { padding:0 20px; }
.confucius-annotation-review .ar-popup-header { display:block; width:100%; padding:12px 20px 0; }
.confucius-annotation-review .ar-summary-row { height:auto; min-height:36px; flex-wrap:wrap; }
.confucius-annotation-review .ar-search-row { display:flex; align-items:center; gap:8px; padding:8px 20px; }
.confucius-annotation-review .ar-search { flex:1; width:100%; min-width:0; height:34px; border:0; border-radius:8px; background:var(--confucius-surface); color:var(--confucius-ink); padding:6px 10px; margin:0; font:inherit; }
.confucius-annotation-review .ar-search-row > button { max-width:48%; overflow:hidden; text-overflow:ellipsis; background:transparent; font-size:12px; }
.confucius-annotation-review .ar-select-row { display:flex; align-items:center; gap:8px; height:38px; padding:0 20px; }
.confucius-annotation-review .ar-select-row > button { margin-left:auto; font-size:12px; background:transparent; }
.confucius-annotation-review .ar-select-label { display:flex; align-items:center; gap:10px; min-height:34px; font-size:12px; color:var(--confucius-muted); }
.confucius-annotation-review input:is([type=checkbox],[type=radio]) { appearance:auto; width:15px; height:15px; min-width:15px; margin:0; accent-color:var(--confucius-accent); }
.confucius-annotation-review .ar-list { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; overflow-anchor:none; scrollbar-width:thin; padding:0 20px; }
.confucius-annotation-review .ar-group-title { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0 4px; min-height:36px; font-size:12px; color:var(--confucius-secondary); }
.confucius-annotation-review .ar-group-title strong { font-weight:550; }
.confucius-annotation-review .ar-list-row { display:grid; grid-template-columns:28px minmax(0,1fr); gap:4px; padding:6px 0 14px; }
.confucius-annotation-review .ar-row-content { min-width:0; }
.confucius-annotation-review .ar-checkbox,.confucius-annotation-review .ar-readonly { width:28px; height:34px; display:flex; align-items:center; }
.confucius-annotation-review .ar-list-row .ar-status { margin-left:auto; }
.confucius-annotation-review .ar-list-row .ar-quote { margin-top:4px; font-size:13px; }
.confucius-annotation-review .ar-empty { padding:32px 12px; color:var(--confucius-muted); text-align:center; }
.confucius-annotation-review .ar-popup-footer { display:flex; align-items:center; gap:8px; min-height:68px; padding:12px 20px 16px; }
.confucius-annotation-review .ar-popup-footer > .ar-muted { flex:1; min-width:0; overflow-wrap:anywhere; }
.confucius-annotation-review .ar-popup-footer .ar-actions { flex-shrink:0; }
.confucius-annotation-review .ar-filter-menu { position:absolute; z-index:5; max-height:400px; overflow:auto; border-radius:14px; background:var(--confucius-elevated); box-shadow:var(--confucius-shadow); padding:12px; }
.confucius-annotation-review .ar-filter-menu > p { margin:0 8px 6px; }
.confucius-annotation-review .ar-filter-option { display:flex; align-items:center; gap:8px; padding:6px 8px; min-height:38px; border-radius:8px; }
.confucius-annotation-review .ar-filter-option:hover,.confucius-annotation-review .ar-filter-option:has(input:checked) { background:var(--confucius-surface); }
.confucius-annotation-review .ar-filter-option small { margin-left:auto; }
.confucius-annotation-review .ar-status-choices { display:grid; grid-template-columns:1fr 1fr; gap:4px; padding-top:12px; }
.confucius-annotation-review .ar-status-choices .ar-filter-option { font-size:12px; }
.confucius-annotation-review .ar-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
@container (max-width:619px) {
 .confucius-annotation-review .confucius-button { font-size:12px; }
 .confucius-annotation-review .ar-scope-row > .ar-muted { display:none; }
 .confucius-annotation-review .ar-paper { padding:12px 0; }
 .confucius-annotation-review .ar-card-body { height:138px; }
 .confucius-annotation-review .ar-actions { gap:4px; }
 .confucius-annotation-review .ar-decision { min-width:68px; }
 .confucius-annotation-review .ar-range { width:64px; }
 .confucius-annotation-review .ar-card-area { padding:0 12px 4px; }
 .confucius-annotation-review .ar-popup-header { padding:12px 12px 0; }
 .confucius-annotation-review .ar-search-row { padding:8px 12px; gap:4px; }
 .confucius-annotation-review .ar-select-row { padding:0 12px; }
 .confucius-annotation-review .ar-list { padding:0 12px; }
 .confucius-annotation-review .ar-popup-footer { flex-wrap:wrap; min-height:76px; padding:10px 12px; gap:4px; justify-content:flex-end; }
 .confucius-annotation-review .ar-popup-footer > .ar-muted { flex-basis:100%; }
 .confucius-annotation-review .ar-meta { gap:4px; flex-wrap:wrap; }
}
@container (max-width:339px) {
 .confucius-annotation-review .ar-card-footer { flex-wrap:wrap; }
 .confucius-annotation-review .ar-range { flex:1; }
 .confucius-annotation-review .ar-card-footer .ar-actions { width:100%; justify-content:flex-end; }
 .confucius-annotation-review .ar-type { display:none; }
}
@media (pointer:coarse) {
 .confucius-annotation-review .confucius-button,.confucius-annotation-review .ar-range,.confucius-annotation-review .ar-checkbox,.confucius-annotation-review .ar-filter-option { min-height:44px; height:44px; }
 .confucius-annotation-review .confucius-icon-button { width:44px !important; min-width:44px !important; height:44px !important; min-height:44px !important; flex-basis:44px; }
 .confucius-annotation-review .ar-list-row { grid-template-columns:44px minmax(0,1fr); }
 .confucius-annotation-review .ar-checkbox { width:44px; }
 .confucius-annotation-review .ar-search { height:44px; font-size:16px; }
 .confucius-annotation-review .ar-scope-row,.confucius-annotation-review .ar-summary-row,.confucius-annotation-review .ar-select-row { min-height:48px; }
 .confucius-annotation-review .ar-capsule.confucius-button { min-height:44px; height:auto; }
}
@media (forced-colors:active),(prefers-contrast:more) { .confucius-annotation-review .ar-popup,.confucius-annotation-review .ar-filter-menu,.confucius-annotation-review .ar-paper,.confucius-annotation-review .ar-capsule { border:1px solid CanvasText; } }
`;
