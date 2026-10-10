import { renderMarkdownHtml } from "@confucius/protocol";
import type { KnowledgeDocument } from "../host/KnowledgeIndex";
import { writeRuntimeText } from "../host/RuntimeStorage";
import { renderNotePreview } from "./notePreview";
import { getString } from "../../utils/locale";

export function knowledgeFilename(title: string): string {
  return (
    (title
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100)
      .replace(/[. ]+$/, "") || "Confucius") + ".html"
  );
}

export function knowledgeHtml(
  doc: Document,
  value: Pick<KnowledgeDocument, "title" | "content" | "format">,
): string {
  const body = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "article",
  ) as HTMLElement;
  renderNotePreview(
    body,
    value.format === "html" ? value.content : renderMarkdownHtml(value.content),
    () => {},
  );
  // Preview links use delegated clicks; a portable file needs the checked URL itself.
  for (const link of Array.from(
    body.querySelectorAll("a[title]"),
  ) as Element[]) {
    const href = link.getAttribute("title") ?? "";
    if (/^(https?:|mailto:|zotero:)/i.test(href))
      link.setAttribute("href", href);
  }
  const title = doc.createElementNS("http://www.w3.org/1999/xhtml", "title");
  title.textContent = value.title;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">${title.outerHTML}<style>body{font:17px/1.7 system-ui,sans-serif;margin:40px auto;padding:0 20px;max-width:760px;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid;padding:6px}pre{overflow:auto}blockquote{margin-left:0;padding-left:16px;border-left:2px solid}hr{border:0;margin:24px 0}a{color:inherit}</style></head><body>${body.outerHTML}</body></html>`;
}

export async function exportKnowledgeDocument(
  win: Window,
  value: Pick<KnowledgeDocument, "title" | "content" | "format">,
): Promise<void> {
  const path = await new ztoolkit.FilePicker(
    getString("workspace-knowledge-export"),
    "save",
    [["HTML", "*.html"]],
    knowledgeFilename(value.title),
    win,
  ).open();
  if (path) await writeRuntimeText(path, knowledgeHtml(win.document, value));
}
