import type { HistoryItemRef } from "@confucius/protocol";

export interface SourceReadRef {
  libraryID: number;
  key?: string;
  attachmentKey?: string;
  page: number;
  zoteroUri?: string;
  truncated: boolean;
  history: HistoryItemRef;
}

/** Navigation metadata from archived tool results, never model-authored notes.
 * Page text stays in history. An archived page is not proof it reached the model. */
export class SourceReadIndex {
  private pages = new Map<string, SourceReadRef>();
  constructor(initial: readonly SourceReadRef[] = []) {
    for (const entry of initial) this.add(entry);
  }
  private add(entry: SourceReadRef): void {
    const key = `${entry.libraryID}:${entry.attachmentKey ?? entry.key}:${entry.page}`;
    this.pages.delete(key);
    this.pages.set(key, entry);
    while (this.pages.size > 120)
      this.pages.delete(this.pages.keys().next().value!);
  }
  record(content: string, history: HistoryItemRef): void {
    let result;
    try {
      result = JSON.parse(content);
    } catch {
      return;
    }
    if (!result?.ok || result.toolName !== "get_pages") return;
    const data = result.data;
    if (
      !data ||
      !Number.isInteger(data.libraryID) ||
      !Array.isArray(data.pages)
    )
      return;
    const key = typeof data.key === "string" ? data.key : undefined;
    const attachmentKey =
      typeof data.attachmentKey === "string" ? data.attachmentKey : undefined;
    if (!key && !attachmentKey) return;
    for (const page of data.pages) {
      if (!page || !Number.isInteger(page.page) || page.page < 1) continue;
      this.add({
        libraryID: data.libraryID,
        key,
        attachmentKey,
        page: page.page,
        zoteroUri:
          typeof page.zoteroUri === "string" ? page.zoteroUri : undefined,
        truncated: page.truncated === true,
        history,
      });
    }
  }
  snapshot(): SourceReadRef[] {
    return [...this.pages.values()].map((entry) => ({
      ...entry,
      history: { ...entry.history },
    }));
  }
  hint(maxChars = 8000): string {
    const selected: SourceReadRef[] = [];
    for (const page of this.snapshot().reverse()) {
      if (JSON.stringify([...selected, page]).length > maxChars) break;
      selected.push(page);
    }
    if (!selected.length) return "";
    return (
      "\nArchived source index (metadata only, not proof of reading or review):\n" +
      JSON.stringify(selected) +
      "\nThese are 1-based physical PDF pages and tool-returned source URIs. Reuse this mapping; do not reread page 1 just to rediscover page numbering. Use context_read with ref=h:<taskId>:<windowId>:<itemId> from each history reference for an evidence gap, or context_search for a specific passage. A required post-draft source check still uses get_pages or inspect_pdf_page, only for decisive evidence; do not reread the full paper. Older entries may be omitted from this bounded index or cleared by retention; use surviving original sources when necessary."
    );
  }
}
