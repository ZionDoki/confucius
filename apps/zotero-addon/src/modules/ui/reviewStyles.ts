export const REVIEW_CSS = `
.confucius-review { min-width:0; max-width:100%; color:var(--confucius-ink); font-size:13px; line-height:1.6; }
.confucius-review[hidden],.confucius-review [hidden] { display:none !important; }
.confucius-review * { box-sizing:border-box; }
.confucius-review :is(h3,p,blockquote) { margin:0; }
.confucius-review .confucius-button { min-height:34px; height:34px; padding:6px 8px; font-size:13px; gap:6px; flex-shrink:0; white-space:nowrap; }
.confucius-review svg { display:block; width:16px; height:16px; flex:0 0 16px; }
.confucius-review .confucius-icon-button { width:34px; height:34px; padding:0; background:transparent; }
.confucius-review .confucius-icon-button svg { width:20px; height:20px; flex-basis:20px; }
.confucius-review .ar-capsule.confucius-button { position:relative; display:flex; height:auto; min-height:34px; max-width:100%; padding:6px 12px; border-radius:24px; gap:8px; background:var(--confucius-elevated); box-shadow:var(--confucius-shadow-soft); font-size:12px; white-space:normal; }
.confucius-review .ar-capsule[data-reminder=true] { z-index:2; transform-origin:left center; animation:confucius-ar-reminder 1100ms cubic-bezier(.22,1,.36,1); }
@keyframes confucius-ar-reminder {
 0%,100% { transform:translateY(0) scale(1); box-shadow:var(--confucius-shadow-soft); }
 30%,52% { transform:translateY(-6px) scale(1.12); box-shadow:var(--confucius-shadow); }
}
.confucius-review .ar-capsule:hover { background:var(--confucius-hover); }
.confucius-review .ar-capsule-copy { display:flex; flex-wrap:wrap; align-items:baseline; gap:0 6px; min-width:0; text-align:left; }
.confucius-review .ar-capsule-count { font-variant-numeric:tabular-nums; }
.confucius-review .ar-capsule-new { color:var(--confucius-accent-text); white-space:nowrap; }
.confucius-review .ar-capsule:is([data-attention=true],[data-error=true]) .ar-capsule-count { color:var(--confucius-danger); }
.confucius-review .ar-caret { transform:rotate(180deg); }
.confucius-review .ar-capsule[aria-expanded=true] .ar-caret { transform:none; }
.confucius-review .ar-header { width:100%; display:flex; align-items:center; gap:8px; min-height:34px; }
.confucius-review h3 { display:flex; align-items:center; gap:8px; font-size:14px; font-weight:550; }
.confucius-review .ar-header > h3 { margin-right:auto; }
.confucius-review .ar-header > button { background:transparent; }
.confucius-review .ar-header > button:hover { background:var(--confucius-surface); }
.confucius-review .ar-muted { color:var(--confucius-muted); font-size:12px; }
.confucius-review .ar-view-switch { display:flex; flex-shrink:0; align-items:center; gap:2px; padding:2px; border-radius:8px; background:var(--confucius-surface); }
.confucius-review .ar-view-switch [aria-pressed=true] { background:var(--confucius-elevated) !important; }
.confucius-review .ar-scope-row,.confucius-review .ar-summary-row { display:flex; align-items:center; gap:8px; height:42px; min-width:0; }
.confucius-review .ar-scope-row > button:first-child { background:transparent; }
.confucius-review .ar-summary-row > button { margin-left:auto; color:var(--confucius-accent-text); font-size:12px; }
.confucius-review .ar-card-area { display:flex; flex-direction:column; flex:1; min-height:0; padding:0 20px 4px; overflow:auto; scrollbar-width:thin; overscroll-behavior:contain; }
.confucius-review .ar-card-area > .ar-scope-row { flex-shrink:0; }
.confucius-review .ar-completion { flex:1; min-height:0; padding:24px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; text-align:center; overflow:auto; }
.confucius-review .ar-completion > svg { color:var(--confucius-success); width:24px; height:24px; }
.confucius-review .ar-stack { position:relative; display:flex; flex:1; min-height:0; padding-bottom:10px; }
.confucius-review .ar-stack::before,.confucius-review .ar-stack::after { content:''; position:absolute; pointer-events:none; border-radius:14px; }
.confucius-review .ar-stack::before { inset:4px 14px 0; background:var(--confucius-hover); transform:rotate(-.6deg); }
.confucius-review .ar-stack::after { inset:2px 7px 4px; background:var(--confucius-surface); transform:rotate(.4deg); }
.confucius-review .ar-paper { --ar-edge-size:34px; position:relative; z-index:1; display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; padding:12px var(--ar-edge-size); border-radius:14px; background:var(--confucius-elevated); touch-action:pan-y; }
.confucius-review .ar-paper > :is(.ar-meta,.ar-card-footer) { flex-shrink:0; }
.confucius-review .ar-meta { display:flex; align-items:center; gap:8px; min-height:34px; color:var(--confucius-muted); font-size:12px; }
.confucius-review .ar-batch-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.confucius-review .ar-paper .ar-source { margin-left:auto; }
.confucius-review .ar-source { background:transparent; color:var(--confucius-accent-text); font-size:12px; }
.confucius-review .ar-source:hover { background:var(--confucius-surface); }
.confucius-review .ar-status { white-space:nowrap; font-size:12px; }
.confucius-review [data-status=accepted] { color:var(--confucius-success); }
.confucius-review :is([data-status=failed],[data-status=unknown]) { color:var(--confucius-danger); }
.confucius-review .ar-card-content { position:relative; display:flex; flex:1; min-height:0; }
.confucius-review .ar-card-body { flex:1; min-width:0; min-height:0; padding:8px 0; overflow:auto; overscroll-behavior:contain; scrollbar-width:thin; touch-action:pan-y; }
.confucius-review .ar-card-nav.confucius-button { position:absolute; top:0; bottom:0; width:var(--ar-edge-size); height:auto; padding:0; border-radius:8px; color:var(--confucius-secondary); opacity:0; transition:opacity 120ms; }
.confucius-review .ar-card-nav svg { width:20px; height:20px; flex-basis:20px; }
.confucius-review .ar-card-previous { left:calc(-1 * var(--ar-edge-size)); background:linear-gradient(to right,var(--confucius-hover),transparent); }
.confucius-review .ar-card-next { right:calc(-1 * var(--ar-edge-size)); background:linear-gradient(to left,var(--confucius-hover),transparent); }
.confucius-review .ar-paper:is(:hover,:focus-within) .ar-card-nav:enabled { opacity:1; }
.confucius-review .ar-card-previous:enabled:hover { background:linear-gradient(to right,var(--confucius-line),transparent); }
.confucius-review .ar-card-next:enabled:hover { background:linear-gradient(to left,var(--confucius-line),transparent); }
.confucius-review .ar-card-nav:disabled { visibility:hidden; }
.confucius-review .ar-quote { border-left:3px solid var(--ar-color); padding-left:10px; font-size:14px; line-height:1.65; overflow-wrap:anywhere; }
.confucius-review .ar-comment { padding:6px 0 0 13px; color:var(--confucius-secondary); font-size:13px; line-height:1.7; overflow-wrap:anywhere; }
.confucius-review .ar-card-footer { display:flex; align-items:center; gap:10px; min-height:38px; padding-top:4px; }
.confucius-review .ar-position { min-width:46px; font-size:12px; font-variant-numeric:tabular-nums; color:var(--confucius-secondary); }
.confucius-review .ar-range { appearance:none; background:transparent; flex:1; height:34px; width:110px; min-width:40px; margin:0; padding:0; border:0; touch-action:none; }
.confucius-review .ar-range::-moz-range-track { height:3px; border:0; background:var(--confucius-line-strong); }
.confucius-review .ar-range::-moz-range-thumb { height:12px; width:12px; border:0; border-radius:50%; background:var(--confucius-accent); }
.confucius-review .ar-range::-webkit-slider-runnable-track { height:3px; background:var(--confucius-line-strong); }
.confucius-review .ar-range::-webkit-slider-thumb { appearance:none; width:12px; height:12px; margin-top:-4.5px; border:0; border-radius:50%; background:var(--confucius-accent); }
.confucius-review .ar-actions { display:flex; align-items:center; gap:8px; margin-left:auto; }
.confucius-review .ar-decision { min-width:76px; }
.confucius-review .ar-error:empty,.confucius-review .ar-row-error:empty { display:none; }
.confucius-review .ar-error,.confucius-review .ar-row-error { color:var(--confucius-danger); font-size:12px; overflow-wrap:anywhere; }
.confucius-review .ar-popup { position:absolute; z-index:3; bottom:calc(100% + 8px); left:0; width:min(680px,100%); display:flex; flex-direction:column; border:0; border-radius:14px; background:var(--confucius-elevated); box-shadow:var(--confucius-shadow); overflow:auto; overscroll-behavior:contain; container-type:inline-size; }
.confucius-review .ar-popup > :not(.ar-list):not(.ar-card-area):not(.ar-completion):not(.ar-custom-content) { flex-shrink:0; }
.confucius-review .ar-popup-error { padding:0 20px; }
.confucius-review .ar-popup-header { display:block; width:100%; padding:12px 20px 0; }
.confucius-review .ar-summary-row { height:auto; min-height:36px; flex-wrap:wrap; }
.confucius-review .ar-search-row { display:flex; align-items:center; gap:8px; padding:8px 20px; }
.confucius-review .ar-search { flex:1; width:100%; min-width:0; height:34px; border:0; border-radius:8px; background:var(--confucius-surface); color:var(--confucius-ink); padding:6px 10px; margin:0; font:inherit; }
.confucius-review .ar-search-row > button { max-width:48%; overflow:hidden; text-overflow:ellipsis; background:transparent; font-size:12px; }
.confucius-review .ar-select-row { display:flex; align-items:center; gap:8px; height:38px; padding:0 20px; }
.confucius-review .ar-select-row > button { margin-left:auto; font-size:12px; background:transparent; }
.confucius-review .ar-select-label { display:flex; align-items:center; gap:10px; min-height:34px; font-size:12px; color:var(--confucius-muted); }
.confucius-review input:is([type=checkbox],[type=radio]) { appearance:auto; width:15px; height:15px; min-width:15px; margin:0; accent-color:var(--confucius-accent); }
.confucius-review .ar-list { flex:1; min-height:48px; overflow:auto; overscroll-behavior:contain; overflow-anchor:none; scrollbar-width:thin; padding:0 20px; }
.confucius-review .ar-group-title { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0 4px; min-height:36px; font-size:12px; color:var(--confucius-secondary); }
.confucius-review .ar-group-title strong { font-weight:550; }
.confucius-review .ar-list-row { display:grid; grid-template-columns:28px minmax(0,1fr); gap:4px; padding:6px 0 14px; }
.confucius-review .ar-row-content { min-width:0; }
.confucius-review .ar-checkbox,.confucius-review .ar-readonly { width:28px; height:34px; display:flex; align-items:center; }
.confucius-review .ar-list-row .ar-status { margin-left:auto; }
.confucius-review .ar-list-row .ar-quote { margin-top:4px; font-size:13px; }
.confucius-review .ar-empty { padding:32px 12px; color:var(--confucius-muted); text-align:center; }
.confucius-review .ar-popup-footer { display:flex; align-items:center; gap:8px; min-height:68px; padding:12px 20px 16px; }
.confucius-review .ar-popup-footer > .ar-muted { flex:1; min-width:0; overflow-wrap:anywhere; }
.confucius-review .ar-popup-footer .ar-actions { flex-shrink:0; }
.confucius-review .ar-filter-menu { position:absolute; z-index:5; max-height:400px; overflow:auto; border-radius:14px; background:var(--confucius-elevated); box-shadow:var(--confucius-shadow); padding:12px; }
.confucius-review .ar-filter-menu > p { margin:0 8px 6px; }
.confucius-review .ar-filter-option { display:flex; align-items:center; gap:8px; padding:6px 8px; min-height:38px; border-radius:8px; }
.confucius-review .ar-filter-option:hover,.confucius-review .ar-filter-option:has(input:checked) { background:var(--confucius-surface); }
.confucius-review .ar-filter-option small { margin-left:auto; }
.confucius-review .ar-status-choices { display:grid; grid-template-columns:1fr 1fr; gap:4px; padding-top:12px; }
.confucius-review .ar-status-choices .ar-filter-option { font-size:12px; }
.confucius-review .ar-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
/* Query editing, candidate confirmation and acquisition controls use shared slots. */
.confucius-review .ar-tools { max-height:112px; overflow:auto; overscroll-behavior:contain; padding:0 20px 4px; }
.confucius-review .ar-custom-content { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:0 20px; }
.confucius-review .ar-domain-footer { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; width:100%; }
.confucius-review .ar-domain-footer > :first-child { flex:1 1 180px; min-width:0; }
.confucius-review .ar-domain-footer > :last-child { margin-left:auto; justify-content:flex-end; }
.confucius-review .ar-popup-footer:has(.ar-domain-footer) { flex-wrap:wrap; flex-shrink:1; min-height:0; max-height:55%; overflow:auto; overscroll-behavior:contain; }
.confucius-review .ar-entry-extra { overflow-wrap:anywhere; }
.confucius-review .ar-entry-extra details { margin:8px 0; }
.confucius-review .ar-entry-extra summary { cursor:pointer; color:var(--confucius-secondary); }
.confucius-review .ar-entry-extra p { margin:4px 0; line-height:1.65; }
.confucius-literature-review .ar-quote { border:0; padding-left:0; font-weight:550; }
.confucius-review .ar-domain-footer .confucius-button { height:auto; min-height:34px; white-space:normal; }
@container (max-width:619px) {
 .confucius-review .confucius-button { font-size:12px; }
 .confucius-review .ar-tools,.confucius-review .ar-custom-content { padding-left:12px; padding-right:12px; }
 .confucius-review .ar-scope-row > .ar-muted { display:none; }
 .confucius-review .ar-actions { gap:4px; }
 .confucius-review .ar-decision { min-width:68px; }
 .confucius-review .ar-range { width:64px; }
 .confucius-review .ar-card-area { padding:0 12px 4px; }
 .confucius-review .ar-popup-header { padding:12px 12px 0; }
 .confucius-review .ar-search-row { padding:8px 12px; gap:4px; }
 .confucius-review .ar-select-row { padding:0 12px; }
 .confucius-review .ar-list { padding:0 12px; }
 .confucius-review .ar-popup-footer { flex-wrap:wrap; min-height:76px; padding:10px 12px; gap:4px; justify-content:flex-end; }
 .confucius-review .ar-popup-footer > .ar-muted { flex-basis:100%; }
 .confucius-review .ar-meta { gap:4px; flex-wrap:wrap; }
}
@container (max-width:339px) {
 .confucius-review .ar-domain-help { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
 .confucius-review .ar-popup-footer:has(.ar-domain-footer) { min-height:104px; }
 .confucius-review .ar-domain-footer { flex-direction:column-reverse; flex-wrap:nowrap; align-items:stretch; }
 .confucius-review .ar-domain-footer > :first-child { flex:0 0 auto; }
 .confucius-review .ar-card-footer { flex-wrap:wrap; }
 .confucius-review .ar-range { flex:1; }
 .confucius-review .ar-card-footer .ar-actions { width:100%; justify-content:flex-end; }
 .confucius-review .ar-type { display:none; }
}
@media (pointer:coarse) {
 .confucius-review .ar-paper { --ar-edge-size:44px; }
 .confucius-review .confucius-button,.confucius-review .ar-range,.confucius-review .ar-checkbox,.confucius-review .ar-filter-option { min-height:44px; height:44px; }
 .confucius-review .confucius-icon-button { width:44px !important; min-width:44px !important; height:44px !important; min-height:44px !important; flex-basis:44px; }
 .confucius-review .ar-list-row { grid-template-columns:44px minmax(0,1fr); }
 .confucius-review .ar-checkbox { width:44px; }
 .confucius-review .ar-search { height:44px; font-size:16px; }
 .confucius-review .ar-scope-row,.confucius-review .ar-summary-row,.confucius-review .ar-select-row { min-height:48px; }
 .confucius-review .ar-capsule.confucius-button { min-height:44px; height:auto; }
}
@media (hover:none) { .confucius-review .ar-card-nav:enabled { opacity:1; } }
@media (prefers-reduced-motion:reduce) { .confucius-review .ar-card-nav.confucius-button { transition:none; } }
@media (prefers-reduced-motion:reduce),(forced-colors:active),(prefers-contrast:more) {
 .confucius-review .ar-capsule[data-reminder=true] { animation:none; }
}
@media (forced-colors:active),(prefers-contrast:more) {
 .confucius-review .ar-popup,.confucius-review .ar-filter-menu,.confucius-review .ar-paper,.confucius-review .ar-capsule { border:1px solid CanvasText; }
 .confucius-review .ar-card-nav:enabled,.confucius-review .ar-card-nav:enabled:hover { opacity:1; background:var(--confucius-surface); border:1px solid var(--confucius-line-strong); }
}
`;
