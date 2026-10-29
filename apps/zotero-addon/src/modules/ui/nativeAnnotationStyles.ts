import { WORKSPACE_BUTTON_CSS } from "./workspaceSurface";

/** Only native PDF annotation surfaces opt into the shared Confucius palette. */
export const NATIVE_ANNOTATION_CSS = `
${WORKSPACE_BUTTON_CSS}
:root[data-confucius-reader] .annotation-popup {
  width: var(--confucius-annotation-width, min(420px, calc(100vw - 32px)));
  max-width: calc(100% - 16px);
  height: var(--confucius-annotation-height, auto);
  max-height: var(--confucius-annotation-max-height, calc(100vh - 80px));
  box-sizing: border-box;
}
[data-confucius-annotation] {
  font-family: var(--confucius-font-family);
  font-size: var(--confucius-font-size);
  line-height: var(--confucius-reading-line-height);
  color: var(--confucius-ink);
}
#annotationsView .annotation[data-confucius-annotation] {
  background: var(--confucius-paper);
  border: 0;
  outline: 0;
  border-radius: 8px;
  margin-block: 8px;
  overflow: hidden;
}
#annotationsView .annotation[data-confucius-annotation].selected {
  background: var(--confucius-surface);
  outline: 0;
  box-shadow: inset 3px 0 var(--confucius-accent);
}
#annotationsView .annotation[data-confucius-annotation]:focus-visible {
  outline: 2px solid var(--confucius-focus);
  outline-offset: -2px;
}
.annotation-popup[data-confucius-annotation] {
  background: var(--confucius-elevated);
  border: 0;
  border-radius: 14px;
  box-shadow: var(--confucius-shadow);
  translate: var(--confucius-popup-x, 0px) var(--confucius-popup-y, 0px);
}
.annotation-popup[data-confucius-annotation]::before,
.annotation-popup[data-confucius-annotation]::after { display: none; }
.annotation-popup[data-confucius-annotation] > .preview {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: inherit;
  overflow: hidden;
  border-radius: inherit;
}
.annotation-popup[data-confucius-resized] > .preview { height: 100%; }
.annotation-popup[data-confucius-resized] .comment > .editor { height: 100%; }
.annotation-popup[data-confucius-resized] .comment > .editor .content { height: 100%; min-height: 0; max-height: none; box-sizing: border-box; }
.annotation-popup[data-confucius-resizing] { user-select: none; }
.annotation-popup .confucius-annotation-resize {
  appearance: none;
  position: absolute;
  z-index: 2;
  width: 24px;
  height: 24px;
  min-width: 0;
  min-height: 0;
  padding: 0;
  margin: 0;
  border: 0;
  border-radius: 8px;
  background-color: transparent;
  background-image: linear-gradient(currentColor, currentColor), linear-gradient(currentColor, currentColor);
  background-size: 8px 2px, 2px 8px;
  background-position: 8px 14px, 14px 8px;
  background-repeat: no-repeat;
  color: var(--confucius-muted);
  touch-action: none;
  user-select: none;
}
.confucius-annotation-resize[data-corner=nw] { top: -8px; left: -8px; cursor: nwse-resize; }
.confucius-annotation-resize[data-corner=ne] { top: -8px; right: -8px; cursor: nesw-resize; }
.confucius-annotation-resize[data-corner=sw] { bottom: -8px; left: -8px; cursor: nesw-resize; }
.confucius-annotation-resize[data-corner=se] { bottom: -8px; right: -8px; cursor: nwse-resize; }
.confucius-annotation-resize[data-corner=nw] { rotate: 180deg; }
.confucius-annotation-resize[data-corner=ne] { rotate: 270deg; }
.confucius-annotation-resize[data-corner=sw] { rotate: 90deg; }
.annotation-popup .confucius-annotation-resize:hover,
.annotation-popup .confucius-annotation-resize:focus-visible { color: var(--confucius-ink); background-color: var(--confucius-hover); }
.annotation-popup .confucius-annotation-resize:focus-visible { outline: 2px solid var(--confucius-focus); outline-offset: -2px; }
[data-confucius-annotation] .preview > header {
  flex: none;
  min-height: 34px;
  padding: 8px 12px;
  gap: 8px;
  border: 0;
  line-height: 1.4;
  white-space: normal;
  font-size: .86em;
  color: var(--confucius-secondary);
}
[data-confucius-annotation] .preview > header :is(.start, .end) { min-width: 0; gap: 4px; }
[data-confucius-annotation] .preview > header .start { flex: 1 1 auto; }
[data-confucius-annotation] .preview > header .end { flex: 0 1 auto; flex-wrap: wrap; }
.annotation-popup[data-confucius-annotation] .preview > header { flex-wrap: wrap; }
.annotation-popup[data-confucius-annotation] .preview > header .end { flex: 0 1 auto; flex-wrap: nowrap; max-width: 100%; margin-inline-start: auto; }
.annotation-popup[data-confucius-annotation] .preview > header .author { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
[data-confucius-annotation] .preview > header .page { flex-wrap: wrap; overflow-wrap: anywhere; }
[data-confucius-annotation] .preview > header .author { color: var(--confucius-muted); }
[data-confucius-annotation] .preview > header .icon { flex: none; }
[data-confucius-annotation] .preview > :is(.text, .comment) { border: 0; min-width: 0; }
[data-confucius-annotation] .preview > .text { color: var(--confucius-secondary); }
[data-confucius-annotation] .editor { font: inherit; line-height: inherit; }
[data-confucius-annotation] .editor .content { padding: 8px 12px; font: inherit; line-height: inherit; }
[data-confucius-annotation] .text .editor .content { padding-inline-start: 20px; }
[data-confucius-annotation] .editor .content:focus { background: var(--confucius-surface); color: var(--confucius-ink); }
[data-confucius-annotation] .editor .content:empty::before { color: var(--confucius-muted); }
[data-confucius-annotation] .editor-toolbar { background: var(--confucius-elevated); color: var(--confucius-ink); }
.annotation-popup[data-confucius-annotation] .preview > .comment {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--confucius-scrollbar) transparent;
}
[data-confucius-annotation] .preview > button.tags {
  flex: none;
  min-height: 34px;
  padding: 8px 12px;
  margin: 0;
  border: 0;
  background: transparent;
  color: var(--confucius-secondary);
  font: inherit;
  font-size: .86em;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[data-confucius-annotation] .preview > button.tags:hover { background: var(--confucius-hover); }
[data-confucius-annotation] .preview .tags .tag::after { color: var(--confucius-muted); }
[data-confucius-annotation] .preview > header button.more {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-height: 34px;
  margin: 0;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: var(--confucius-surface);
  color: var(--confucius-ink);
  font: inherit;
  font-size: .86em;
  font-weight: 550;
  cursor: pointer;
}
[data-confucius-annotation] .confucius-annotation-edit { min-height: 34px; padding: 6px 8px; font-size: .86em; }
[data-confucius-annotation] .preview > header button.more { width: 34px; padding: 0; background: transparent; }
[data-confucius-annotation] .preview > header button.more svg { width: 20px; height: 20px; }
[data-confucius-annotation] :is(button.more, .confucius-annotation-edit):hover:not(:disabled) { background: var(--confucius-hover); }
[data-confucius-annotation] :is(button.more, .confucius-annotation-edit):disabled { opacity: .48; cursor: default; }
[data-confucius-annotation] :is(button, a, summary):focus-visible { outline: 2px solid var(--confucius-focus); outline-offset: -2px; }
[data-confucius-rendered]:not([data-confucius-editing]) > :is(.editor, .expandable-editor) { display: none; }
[data-confucius-editing] > .confucius-annotation-rendered { display: none; }
.confucius-annotation-rendered.content { padding: 4px 12px 12px; min-width: 0; min-height: 0; max-height: none; overflow: hidden; }
.confucius-annotation-actions { display: flex; flex: none; justify-content: flex-end; gap: 8px; padding-top: 8px; }
.annotation-popup header .confucius-annotation-actions { padding: 0; min-width: 0; }
.annotation-popup[data-confucius-annotation] header .confucius-annotation-edit { font-size: inherit; white-space: nowrap; }
.annotation-popup:has(.comment[data-confucius-editing]) header .confucius-annotation-actions { visibility: hidden; }
.annotation-popup[data-confucius-annotation] .preview > .comment[data-confucius-rendered]:not([data-confucius-editing]) { display: flex; flex-direction: column; overflow: hidden; }
.annotation-popup .comment:not([data-confucius-editing]) > .confucius-annotation-rendered { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.annotation-popup .confucius-annotation-markdown { min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.confucius-annotation-markdown { user-select: text; cursor: text; overflow-wrap: anywhere; white-space: normal; line-height: var(--confucius-reading-line-height); }
.confucius-annotation-markdown:focus-visible { outline: 2px solid var(--confucius-focus); outline-offset: -2px; }
[data-confucius-annotation=card] .confucius-annotation-markdown { max-height: 280px; overflow-y: auto; overscroll-behavior: contain; }
.confucius-annotation-markdown > :first-child { margin-top: 0; }
.confucius-annotation-markdown > :last-child { margin-bottom: 0; }
.confucius-annotation-markdown p { margin: 0 0 var(--confucius-annotation-paragraph-spacing, 12px); }
.confucius-annotation-markdown :is(h1,h2,h3,h4,h5,h6) { margin: 20px 0 8px; font-size: 1.08em; font-weight: 600; line-height: 1.4; }
.confucius-annotation-markdown :is(ul,ol) { margin: 8px 0 12px; padding-inline-start: 24px; }
.confucius-annotation-markdown li { margin: 4px 0; }
.confucius-annotation-markdown li::marker { color: var(--confucius-muted); }
.confucius-annotation-markdown a { color: var(--confucius-accent-text); text-decoration: underline; text-underline-offset: 3px; }
.confucius-annotation-markdown blockquote { margin: 12px 0; padding-inline-start: 12px; border-inline-start: 2px solid var(--confucius-line-strong); color: var(--confucius-secondary); }
.confucius-annotation-markdown pre { margin: 12px 0; padding: 10px; border-radius: 8px; background: var(--confucius-surface); white-space: pre; }
.confucius-annotation-markdown code { font-family: ui-monospace, Consolas, monospace; font-size: .92em; }
.confucius-annotation-markdown :is(pre,table,.tui-math[data-display="1"]) { display: block; max-width: 100%; overflow-x: auto; overflow-y: hidden; }
.confucius-annotation-markdown table { border-collapse: collapse; margin: 12px 0; }
.confucius-annotation-markdown :is(th,td) { padding: 6px 8px; border-bottom: 1px solid var(--confucius-line); }
.confucius-annotation-markdown th { background: var(--confucius-surface); text-align: start; }
.confucius-annotation-markdown math { font-size: 1.05em; }
.confucius-annotation-markdown hr { height: 0; border: 0; background: none; margin: 24px 0; }
@media (forced-colors: active), (prefers-contrast: more) {
  .annotation-popup[data-confucius-annotation] { outline: 1px solid CanvasText; }
  .annotation-popup .confucius-annotation-resize { border: 1px solid CanvasText; background-color: Canvas; color: CanvasText; }
  #annotationsView .annotation[data-confucius-annotation].selected { outline: 2px solid Highlight; outline-offset: -2px; }
}
`;
