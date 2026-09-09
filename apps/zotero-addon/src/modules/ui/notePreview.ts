import { renderToString as katexRender } from "katex";

const NS = "http://www.w3.org/1999/xhtml";
const tags = new Set(
  "div p h1 h2 h3 h4 h5 h6 blockquote ul ol li strong b em i u s sub sup pre code table thead tbody tr th td a span br hr".split(
    " ",
  ),
);
const omitted = new Set(
  "script style iframe object embed template svg img audio video link meta".split(
    " ",
  ),
);

/** Render note structure without importing its styles, active content or resources. */
export function renderNotePreview(
  node: HTMLElement,
  html: string,
  openLink: (href: string) => void,
): void {
  const doc = node.ownerDocument;
  if (!doc) return;
  const template = doc.createElementNS(NS, "template") as HTMLTemplateElement;
  template.innerHTML = html;
  node.replaceChildren();
  const copy = (source: Node | null, parent: HTMLElement) => {
    if (!source) return;
    if (source.nodeType === 3) {
      parent.append(doc.createTextNode(source.textContent ?? ""));
      return;
    }
    if (source.nodeType !== 1) return;
    const element = source as Element;
    const tag = element.localName.toLowerCase();
    if (omitted.has(tag)) return;
    let child = parent;
    if (tags.has(tag)) {
      const math =
        ["span", "pre"].includes(tag) &&
        (element.classList.contains("math") ||
          element.classList.contains("tui-math"));
      const display =
        tag === "pre" || element.getAttribute("data-display") === "1";
      child = doc.createElementNS(
        NS,
        math && display ? "div" : tag,
      ) as HTMLElement;
      parent.append(child);
      if (math) {
        const tex = element.classList.contains("tui-math")
          ? (element.getAttribute("data-tex") ?? element.textContent ?? "")
          : (element.textContent ?? "")
              .trim()
              .replace(/^\${1,2}|\${1,2}$/g, "");
        child.className = display ? "confucius-note-math" : "";
        try {
          child.innerHTML = katexRender(tex, {
            displayMode: display,
            throwOnError: false,
            output: "mathml",
          });
        } catch {
          child.textContent = tex;
        }
        return;
      }
      if (tag === "a") {
        const href =
          element.getAttribute("href") ||
          element.getAttribute("data-href") ||
          "";
        if (/^(https?:|mailto:|zotero:)/i.test(href.trim())) {
          child.setAttribute("href", "#");
          child.title = href;
          child.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openLink(href);
          });
        }
      }
      if (["th", "td"].includes(tag)) {
        for (const attr of ["colspan", "rowspan"]) {
          const value = element.getAttribute(attr) ?? "";
          if (/^[1-9]\d?$/.test(value)) child.setAttribute(attr, value);
        }
      }
    }
    for (const nested of Array.from(element.childNodes)) copy(nested, child);
  };
  for (const child of Array.from(template.content.childNodes))
    copy(child, node);
}
