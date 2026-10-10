import {
  isKnowledgeRecord,
  tokenize,
  type MemoryEngine,
} from "@confucius/memory";

export interface KnowledgeItem {
  id: string;
  title: string;
  kind: "note" | "project" | "preference" | "memory" | "legacy";
  updatedAt: number;
  source: { libraryID: number; key: string } | { memoryId: string };
  excerpt?: string;
}

export interface KnowledgeDocument extends KnowledgeItem {
  content: string;
  format: "html" | "markdown";
  sourceRefs?: string[];
  protected?: boolean;
}

export interface KnowledgeNotes {
  list(): Promise<KnowledgeDocument[]>;
  read(libraryID: number, key: string): Promise<KnowledgeDocument | null>;
}

/** A derived catalogue: source documents are never copied into another store. */
export class KnowledgeIndex {
  constructor(
    private memory: MemoryEngine,
    private notes: KnowledgeNotes,
  ) {}

  async search(query = "", offset = 0, limit = 50) {
    const terms = [...new Set(tokenize(query))];
    const documents = await this.notes.list();
    for (const record of await this.memory.refresh()) {
      // Old topic containers carry descriptions too, so retain them as readable files.
      documents.push({
        id: `memory:${record.id}`,
        title: record.title,
        kind: isKnowledgeRecord(record)
          ? "legacy"
          : record.type === "project"
            ? "project"
            : record.type === "preference"
              ? "preference"
              : "memory",
        updatedAt: record.updatedAt,
        source: { memoryId: record.id },
        content: record.content,
        format: "markdown",
      });
    }
    const hits = documents
      .map((document) => {
        const text =
          document.format === "html"
            ? plainNoteText(document.content)
            : document.content;
        const words = new Set(tokenize(`${document.title}\n${text}`));
        const score = terms.reduce((n, term) => n + Number(words.has(term)), 0);
        const { content: _content, format: _format, ...item } = document;
        return { item: { ...item, excerpt: text.slice(0, 180) }, score };
      })
      .filter(({ score }) => !terms.length || score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.item.updatedAt - a.item.updatedAt ||
          a.item.id.localeCompare(b.item.id),
      );
    const start = Math.max(0, Math.trunc(offset) || 0);
    const count = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
    return {
      items: hits.slice(start, start + count).map(({ item }) => item),
      total: hits.length,
      nextOffset: start + count < hits.length ? start + count : undefined,
    };
  }

  async read(id: string, explicit = false): Promise<KnowledgeDocument> {
    if (id.startsWith("memory:")) {
      const memoryId = id.slice(7);
      const record = explicit
        ? await this.memory.read(memoryId)
        : await this.memory.reconcile(memoryId);
      if (record)
        return {
          id,
          title: record.title,
          content: record.content,
          format: "markdown",
          kind: isKnowledgeRecord(record)
            ? "legacy"
            : record.type === "project"
              ? "project"
              : record.type === "preference"
                ? "preference"
                : "memory",
          updatedAt: record.updatedAt,
          source: { memoryId },
          sourceRefs: record.sourceRefs,
          protected: record.protection === "user",
        };
    } else {
      const match = /^note:(\d+):([A-Z0-9]{8})$/.exec(id);
      const document =
        match && (await this.notes.read(Number(match[1]), match[2]));
      if (document) return document;
    }
    throw new Error(
      "The source was deleted or is unavailable; refresh the knowledge index",
    );
  }
}

export function plainNoteText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function zoteroKnowledgeNotes(): KnowledgeNotes {
  const available = async (item: Zotero.Item): Promise<boolean> => {
    const ancestors = [item];
    let current = item;
    while (current.parentItemID) {
      // isInTrash() needs cached ancestors; direct reads can start in a cold library.
      const parent = await Zotero.Items.getAsync(current.parentItemID);
      if (!parent) return false;
      ancestors.push(parent);
      current = parent;
    }
    return ancestors.every((ancestor) => !ancestor.deleted);
  };
  const document = (item: Zotero.Item): KnowledgeDocument => ({
    id: `note:${item.libraryID}:${item.key}`,
    title: item.getDisplayTitle() || item.key,
    kind: "note",
    updatedAt:
      Date.parse(String(item.dateModified).replace(" ", "T") + "Z") || 0,
    source: { libraryID: item.libraryID, key: item.key },
    content: item.getNote(),
    format: "html",
  });
  return {
    async list() {
      const result: KnowledgeDocument[] = [];
      for (const library of Zotero.Libraries.getAll()) {
        const notes = (
          await Zotero.Items.getAll(library.libraryID, false, false)
        ).filter((item) => item.isNote() && !item.deleted);
        // getAll/getByLibraryAndKeyAsync only guarantee primary data. Other
        // libraries may not have loaded note titles or bodies yet.
        await Zotero.Items.loadDataTypes(notes, ["itemData", "note"]);
        for (const item of notes)
          if (await available(item)) result.push(document(item));
      }
      return result;
    },
    async read(libraryID, key) {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
      if (!item || !item.isNote() || item.deleted) return null;
      await Zotero.Items.loadDataTypes([item], ["itemData", "note"]);
      return (await available(item)) ? document(item) : null;
    },
  };
}
