import type { TaskAttachment } from "@confucius/protocol";
import { getString } from "../../utils/locale";

export function attachmentKindLabel(item: {
  name: string;
  kind?: TaskAttachment["kind"];
}): string {
  if (item.kind === "pdf" || /\.pdf$/iu.test(item.name)) return "PDF";
  if (item.kind === "markdown" || /\.(?:md|markdown)$/iu.test(item.name))
    return "MD";
  return "TXT";
}

export function taskAttachmentMeta(record: TaskAttachment): string {
  const bytes = record.size;
  const size =
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${Math.ceil(bytes / 1024)} KB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const parts = [size];
  if (record.kind === "pdf" && typeof record.extractedPages === "number") {
    parts.push(
      typeof record.totalPages === "number"
        ? `${record.extractedPages}/${record.totalPages} ${getString("workspace-attachment-pages")}`
        : `${record.extractedPages} ${getString("workspace-attachment-pages")}`,
    );
  }
  if (record.truncated) parts.push(getString("workspace-attachment-truncated"));
  return parts.join(" · ");
}

/** Composer and durable messages share file labels; only the composer adds removal. */
export function createAttachmentChip(
  doc: Document,
  item: {
    name: string;
    kind?: TaskAttachment["kind"];
    meta: string;
    status?: string;
    title?: string;
  },
): HTMLElement {
  const create = (tag: string, className: string) => {
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    node.className = className;
    return node as HTMLElement;
  };
  const chip = create("div", "confucius-attachment-chip");
  chip.title = item.title ?? item.name;
  if (item.status) chip.dataset.status = item.status;
  const kind = create("span", "confucius-attachment-kind");
  kind.textContent = attachmentKindLabel(item);
  const copy = create("span", "confucius-attachment-copy");
  const name = create("span", "confucius-attachment-name");
  name.textContent = item.name;
  const meta = create("span", "confucius-attachment-meta");
  meta.textContent = item.meta;
  copy.append(name, meta);
  chip.append(kind, copy);
  return chip;
}
