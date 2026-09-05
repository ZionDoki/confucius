// Scope to Confucius-owned elements, including menus portalled into a Zotero
// document. Do not change the library, reader, or other preference panes.
const scope =
  ':where([id^="confucius-"], [id^="confucius-"] *, [data-confucius-scroll], [data-confucius-preferences-scroll])';

export const SCROLLBAR_CSS = `
${scope} {
  scrollbar-width: thin;
  scrollbar-color: #9c9283 transparent;
}
${scope}:is(:hover, :focus-within) { scrollbar-color: #807565 transparent; }
[data-confucius-scroll], [data-confucius-preferences-scroll] { scrollbar-gutter: stable; }
/* Gecko's native textarea does not reserve its anonymous inner scrollbar
   with gutter: stable. A permanent, transparent rail keeps line wrapping fixed. */
${scope} textarea { overflow-x: hidden; overflow-y: scroll; scrollbar-gutter: stable; }
/* Gecko uses the standard properties above; this fallback covers engines
   with only the WebKit scrollbar API. Keep the empty track transparent. */
${scope}::-webkit-scrollbar { width: 6px; height: 6px; }
${scope}::-webkit-scrollbar-track,
${scope}::-webkit-scrollbar-corner { background: transparent; }
${scope}::-webkit-scrollbar-thumb { background: #9c9283; border-radius: 999px; }
${scope}::-webkit-scrollbar-thumb:hover { background: #807565; }
@media (forced-colors: active) {
  ${scope}, ${scope}:is(:hover, :focus-within) { scrollbar-color: auto; }
  ${scope}::-webkit-scrollbar-thumb,
  ${scope}::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;

/** Only scroll containers reserve a gutter; clipped layout wrappers must not. */
export function markScrollContainer(node: HTMLElement): void {
  if (
    node.localName === "textarea" ||
    [node.style.overflowX, node.style.overflowY].some(
      (value) => value === "auto" || value === "scroll",
    )
  ) {
    node.setAttribute("data-confucius-scroll", "");
  }
}

export function ensureScrollbarStyles(doc: Document): void {
  const existing = doc.getElementById("confucius-scrollbar-css");
  if (existing) {
    if (existing.textContent !== SCROLLBAR_CSS)
      existing.textContent = SCROLLBAR_CSS;
    return;
  }
  const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
  style.id = "confucius-scrollbar-css";
  style.textContent = SCROLLBAR_CSS;
  (doc.head ?? doc.documentElement)?.appendChild(style);
}

const preferenceBindings = new WeakMap<Document, () => void>();

/** Zotero owns the outer preferences scroller and reuses it for every pane. */
export function bindPreferenceScrollbars(win: Window): void {
  const doc = win.document;
  ensureScrollbarStyles(doc);
  preferenceBindings.get(doc)?.();
  const pane = doc
    .getElementById("confucius-preferences")
    ?.closest(".pane-container");
  const scroller = doc.getElementById("prefs-content");
  if (!pane || !scroller) return;
  const attr = "data-confucius-preferences-scroll";
  const cleanup = () => {
    observer.disconnect();
    scroller.removeAttribute(attr);
    win.removeEventListener("unload", cleanup);
    preferenceBindings.delete(doc);
  };
  const sync = () => {
    if (!pane.isConnected) return cleanup();
    scroller.toggleAttribute(attr, !pane.hasAttribute("hidden"));
  };
  const observer = new win.MutationObserver(sync);
  observer.observe(pane, { attributes: true, attributeFilter: ["hidden"] });
  observer.observe(scroller, { childList: true });
  win.addEventListener("unload", cleanup, { once: true });
  preferenceBindings.set(doc, cleanup);
  sync();
}
