import type { ToolErrorCode, ToolResult } from "@confucius/protocol";
import {
  findSection,
  parseSections,
  requireItemRef,
  splitPages,
} from "@confucius/zotero-tools";

const MAX_NOTE = 20_000;

function ok(toolName: string, data: unknown): ToolResult {
  return { ok: true, toolName, data };
}

function fail(
  toolName: string,
  code: ToolErrorCode,
  message: string,
  details?: unknown,
): ToolResult {
  return { ok: false, toolName, code, message, details };
}

function asItem(value: unknown): Zotero.Item | null {
  if (!value || value === false || Array.isArray(value)) {
    return null;
  }
  return value as Zotero.Item;
}

function defaultLibraryID(args: Record<string, unknown>): number {
  if (typeof args.libraryID === "number" && Number.isInteger(args.libraryID)) {
    return args.libraryID;
  }
  return Zotero.Libraries.userLibraryID;
}

function getItem(libraryID: number, key: string): Zotero.Item | null {
  return asItem(Zotero.Items.getByLibraryAndKey(libraryID, key));
}

function summarizeItem(item: Zotero.Item) {
  const creators = item.getCreators?.() || [];
  const authors = creators
    .map((creator) =>
      creator.lastName
        ? `${creator.lastName}${creator.firstName ? `, ${creator.firstName}` : ""}`
        : (creator as { name?: string }).name || "",
    )
    .filter(Boolean);
  return {
    libraryID: item.libraryID,
    key: item.key,
    itemType: item.itemType,
    title: item.getDisplayTitle?.() || item.getField?.("title") || "",
    creators: authors,
    year: item.getField?.("year") || "",
    doi: item.getField?.("DOI") || "",
  };
}

async function findPdf(item: Zotero.Item): Promise<Zotero.Item | null> {
  if (item.isAttachment?.() && item.attachmentContentType === "application/pdf") {
    return item;
  }
  if (item.isNote?.()) {
    return null;
  }
  const ids = item.getAttachments?.() || [];
  for (const id of ids) {
    const attachment = asItem(Zotero.Items.get(id));
    if (attachment?.attachmentContentType === "application/pdf") {
      return attachment;
    }
  }
  return null;
}

async function pdfText(item: Zotero.Item): Promise<string | null> {
  const pdf = await findPdf(item);
  if (!pdf) {
    return null;
  }
  const text = await pdf.attachmentText;
  return text || null;
}

function noteHtml(content: string): string {
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div>${escaped.replace(/\n/g, "<br/>")}</div>`;
}

export class ZoteroToolHost {
  private readonly proposals = new Map<
    string,
    Array<{ text: string; page?: number; comment?: string }>
  >();

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      return await this.dispatch(name, args);
    } catch (error) {
      return fail(
        name,
        "internal",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    switch (name) {
      case "search_items":
        return this.searchItems(args);
      case "search_fulltext":
        return this.searchFulltext(args);
      case "search_notes":
        return this.searchNotes(args);
      case "search_by_tag":
        return this.searchByTag(args);
      case "get_item":
      case "get_item_metadata":
      case "get_paper_metadata":
        return this.getItem(name, args);
      case "get_item_notes":
        return this.getItemNotes(args);
      case "get_note_content":
        return this.getNoteContent(args);
      case "get_collections":
        return this.getCollections(args);
      case "get_collection_items":
        return this.getCollectionItems(args);
      case "get_tags":
        return this.getTags(args);
      case "get_recent":
        return this.getRecent(args);
      case "list_saved_searches":
        return this.listSavedSearches(args);
      case "run_saved_search":
        return this.runSavedSearch(args);
      case "get_related_items":
        return this.getRelated(args);
      case "create_collection":
        return this.createCollection(args);
      case "rename_collection":
        return this.renameCollection(args);
      case "add_to_collection":
        return this.addToCollection(args);
      case "remove_from_collection":
        return this.removeFromCollection(args);
      case "create_saved_search":
        return this.createSavedSearch(args);
      case "add_item":
        return this.addItem(args);
      case "create_item":
        return this.createItem(args);
      case "update_item_metadata":
        return this.updateItemMetadata(args);
      case "batch_update_tags":
        return this.batchUpdateTags(args);
      case "link_related_items":
        return this.linkRelated(args);
      case "create_note":
        return this.createNote(args);
      case "append_to_note":
        return this.appendToNote(args);
      case "update_note":
        return this.updateNote(args);
      case "attach_file":
        return this.attachFile(args);
      case "get_outline":
      case "list_sections":
        return this.getOutline(name, args);
      case "get_paper_section":
        return this.getPaperSection(args);
      case "get_pages":
        return this.getPages(args);
      case "get_page_count":
        return this.getPageCount(args);
      case "search_paper_content":
      case "search_with_regex":
        return this.searchPaper(name, args);
      case "get_annotations":
        return this.getAnnotations(args);
      case "get_pdf_selection":
        return this.getPdfSelection(args);
      case "open_item":
        return this.openItem(args);
      case "propose_highlights":
        return this.proposeHighlights(args);
      case "commit_annotations":
        return this.commitAnnotations(args);
      case "update_annotation_comment":
        return this.updateAnnotationComment(args);
      case "delete_annotation":
        return this.deleteAnnotation(args);
      default:
        return fail(name, "not_found", `Unknown Zotero tool: ${name}`);
    }
  }

  private async searchItems(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return fail("search_items", "invalid_args", "query is required");
    }
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search({ libraryID });
    const field = String(args.field ?? "everywhere");
    if (field === "title") {
      search.addCondition("title", "contains", query);
    } else if (field === "creator") {
      search.addCondition("creator", "contains", query);
    } else if (field === "tag") {
      search.addCondition("tag", "is", query);
    } else {
      search.addCondition("quicksearch-titleCreatorYear", "contains", query);
    }
    const ids = await search.search();
    const limit = Math.min(Number(args.limit) || 20, 50);
    const items = await Zotero.Items.getAsync(ids.slice(0, limit));
    return ok("search_items", {
      query,
      libraryID,
      total: ids.length,
      items: items.map(summarizeItem),
    });
  }

  private async searchFulltext(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return fail("search_fulltext", "invalid_args", "query is required");
    }
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search({ libraryID });
    search.addCondition("fulltextContent", "contains", query);
    const ids = await search.search();
    const limit = Math.min(Number(args.limit) || 20, 50);
    const attachments = await Zotero.Items.getAsync(ids.slice(0, limit));
    const items = attachments.map((item) => {
      const parent = item.parentItemID ? Zotero.Items.get(item.parentItemID) : item;
      return summarizeItem(parent || item);
    });
    return ok("search_fulltext", { query, libraryID, total: ids.length, items });
  }

  private async searchNotes(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return fail("search_notes", "invalid_args", "query is required");
    }
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search({ libraryID });
    search.addCondition("note", "contains", query);
    const ids = await search.search();
    const items = await Zotero.Items.getAsync(ids.slice(0, 20));
    return ok("search_notes", {
      query,
      items: items.map((item) => ({
        ...summarizeItem(item),
        note: (item.getNote?.() || "").replace(/<[^>]+>/g, " ").slice(0, 400),
      })),
    });
  }

  private async searchByTag(args: Record<string, unknown>): Promise<ToolResult> {
    const tag = String(args.tag ?? "").trim();
    if (!tag) {
      return fail("search_by_tag", "invalid_args", "tag is required");
    }
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search({ libraryID });
    search.addCondition("tag", "is", tag);
    const ids = await search.search();
    const items = await Zotero.Items.getAsync(ids.slice(0, 30));
    return ok("search_by_tag", { tag, items: items.map(summarizeItem) });
  }

  private getItem(toolName: string, args: Record<string, unknown>): ToolResult {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail(toolName, "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail(toolName, "not_found", "Item not found");
    }
    return ok(toolName, {
      ...summarizeItem(item),
      extra: item.getField?.("extra") || "",
      abstract: item.getField?.("abstractNote") || "",
      url: item.getField?.("url") || "",
    });
  }

  private getItemNotes(args: Record<string, unknown>): ToolResult {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_item_notes", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("get_item_notes", "not_found", "Item not found");
    }
    const notes = (item.getNotes?.() || []).map((id) => {
      const note = Zotero.Items.get(id);
      return note
        ? {
            libraryID: note.libraryID,
            key: note.key,
            preview: (note.getNote?.() || "")
              .replace(/<[^>]+>/g, " ")
              .trim()
              .slice(0, 240),
          }
        : null;
    });
    return ok("get_item_notes", { notes: notes.filter(Boolean) });
  }

  private getNoteContent(args: Record<string, unknown>): ToolResult {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_note_content", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item?.isNote?.()) {
      return fail("get_note_content", "not_found", "Note not found");
    }
    return ok("get_note_content", {
      libraryID: item.libraryID,
      key: item.key,
      html: (item.getNote?.() || "").slice(0, MAX_NOTE),
    });
  }

  private getCollections(args: Record<string, unknown>): ToolResult {
    const libraryID = defaultLibraryID(args);
    const parentKey = args.parentKey ? String(args.parentKey) : "";
    let collections: Zotero.Collection[] = [];
    if (parentKey) {
      const parent = Zotero.Collections.getByLibraryAndKey(libraryID, parentKey);
      if (!parent) {
        return fail("get_collections", "not_found", "Parent collection not found");
      }
      collections = parent.getChildCollections();
    } else {
      collections = Zotero.Collections.getByLibrary(libraryID).filter(
        (collection) => !collection.parentID,
      );
    }
    return ok("get_collections", {
      libraryID,
      collections: collections.map((collection) => ({
        libraryID,
        key: collection.key,
        name: collection.name,
        itemCount: collection.getChildItems().length,
      })),
    });
  }

  private getCollectionItems(args: Record<string, unknown>): ToolResult {
    const libraryID = defaultLibraryID(args);
    const key = String(args.key ?? "");
    const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
    if (!collection) {
      return fail("get_collection_items", "not_found", "Collection not found");
    }
    const limit = Math.min(Number(args.limit) || 30, 100);
    const items = collection.getChildItems().slice(0, limit);
    return ok("get_collection_items", {
      libraryID,
      key,
      name: collection.name,
      items: items.map(summarizeItem),
    });
  }

  private async getTags(args: Record<string, unknown>): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const tags = await Zotero.Tags.getAll(libraryID);
    const names = (Array.isArray(tags) ? tags : [])
      .slice(0, 200)
      .map((tag) =>
        typeof tag === "string" ? tag : String((tag as { tag?: string }).tag || tag),
      );
    return ok("get_tags", { libraryID, tags: names });
  }

  private async getRecent(args: Record<string, unknown>): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search({ libraryID });
    (search.addCondition as (c: string, op: string, v: string) => void)(
      "dateModified",
      "isThisMonth",
      "true",
    );
    const ids = await search.search();
    const items = await Zotero.Items.getAsync(
      ids.slice(0, Math.min(Number(args.limit) || 20, 50)),
    );
    return ok("get_recent", { items: items.map(summarizeItem) });
  }

  private listSavedSearches(args: Record<string, unknown>): ToolResult {
    const libraryID = defaultLibraryID(args);
    const searches =
      (
        Zotero.Searches as unknown as {
          getByLibrary?: (id: number) => Array<{ key: string; name: string }>;
        }
      ).getByLibrary?.(libraryID) || [];
    return ok("list_saved_searches", {
      searches: searches.map((search) => ({
        libraryID,
        key: search.key,
        name: search.name,
      })),
    });
  }

  private async runSavedSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const key = String(args.key ?? "");
    const saved = Zotero.Searches.getByLibraryAndKey(libraryID, key);
    if (!saved) {
      return fail("run_saved_search", "not_found", "Saved search not found");
    }
    const ids = await saved.search();
    const items = await Zotero.Items.getAsync(ids.slice(0, 30));
    return ok("run_saved_search", {
      key,
      items: items.map(summarizeItem),
    });
  }

  private getRelated(args: Record<string, unknown>): ToolResult {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_related_items", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("get_related_items", "not_found", "Item not found");
    }
    const related = (item.relatedItems || []).map((relKey: string) => {
      const relatedItem = getItem(ref.libraryID, relKey);
      return relatedItem ? summarizeItem(relatedItem) : { key: relKey };
    });
    return ok("get_related_items", { items: related });
  }

  private async createCollection(args: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args.name ?? "").trim();
    if (!name) {
      return fail("create_collection", "invalid_args", "name is required");
    }
    const libraryID = defaultLibraryID(args);
    const collection = new Zotero.Collection();
    (collection as unknown as { libraryID: number }).libraryID = libraryID;
    collection.name = name;
    const parentKey = args.parentKey ? String(args.parentKey) : "";
    if (parentKey) {
      const parent = Zotero.Collections.getByLibraryAndKey(libraryID, parentKey);
      if (!parent) {
        return fail("create_collection", "not_found", "Parent collection not found");
      }
      collection.parentID = parent.id;
    }
    await collection.saveTx();
    return ok("create_collection", {
      libraryID,
      key: collection.key,
      name: collection.name,
    });
  }

  private async renameCollection(args: Record<string, unknown>): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const key = String(args.key ?? "");
    const name = String(args.name ?? "").trim();
    const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
    if (!collection) {
      return fail("rename_collection", "not_found", "Collection not found");
    }
    collection.name = name;
    await collection.saveTx();
    return ok("rename_collection", { libraryID, key, name });
  }

  private async addToCollection(args: Record<string, unknown>): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const item = getItem(libraryID, String(args.key ?? ""));
    const collection = Zotero.Collections.getByLibraryAndKey(
      libraryID,
      String(args.collectionKey ?? ""),
    );
    if (!item || !collection) {
      return fail("add_to_collection", "not_found", "Item or collection not found");
    }
    item.addToCollection(collection.id);
    await item.saveTx();
    return ok("add_to_collection", {
      libraryID,
      key: item.key,
      collectionKey: collection.key,
    });
  }

  private async removeFromCollection(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const item = getItem(libraryID, String(args.key ?? ""));
    const collection = Zotero.Collections.getByLibraryAndKey(
      libraryID,
      String(args.collectionKey ?? ""),
    );
    if (!item || !collection) {
      return fail("remove_from_collection", "not_found", "Item or collection not found");
    }
    item.removeFromCollection(collection.id);
    await item.saveTx();
    return ok("remove_from_collection", {
      libraryID,
      key: item.key,
      collectionKey: collection.key,
    });
  }

  private async createSavedSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args.name ?? "").trim();
    const query = String(args.query ?? "").trim();
    if (!name || !query) {
      return fail("create_saved_search", "invalid_args", "name and query are required");
    }
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search();
    (search as unknown as { libraryID: number }).libraryID = libraryID;
    search.name = name;
    search.addCondition("quicksearch-titleCreatorYear", "contains", query);
    await search.saveTx();
    return ok("create_saved_search", { libraryID, key: search.key, name, query });
  }

  private async addItem(args: Record<string, unknown>): Promise<ToolResult> {
    const identifier = String(args.identifier ?? "").trim();
    if (!identifier) {
      return fail("add_item", "invalid_args", "identifier is required");
    }
    const libraryID = defaultLibraryID(args);
    const identifiers = Zotero.Utilities.extractIdentifiers(identifier);
    if (!identifiers?.length) {
      return fail(
        "add_item",
        "invalid_args",
        "Could not parse DOI, ISBN, PMID, or arXiv id",
      );
    }
    const collections: number[] = [];
    if (args.collectionKey) {
      const collection = Zotero.Collections.getByLibraryAndKey(
        libraryID,
        String(args.collectionKey),
      );
      if (!collection) {
        return fail("add_item", "not_found", "Collection not found");
      }
      collections.push(collection.id);
    }
    const translate = new (Zotero.Translate as unknown as {
      Search: new () => {
        setIdentifier: (id: unknown) => void;
        getTranslators: () => Promise<unknown[]>;
        setTranslator: (translators: unknown) => void;
        translate: (opts: unknown) => Promise<Zotero.Item[]>;
      };
    }).Search();
    translate.setIdentifier(identifiers[0]);
    const translators = await translate.getTranslators();
    if (!translators?.length) {
      return fail("add_item", "unavailable", "No translator for that identifier");
    }
    translate.setTranslator(translators);
    const items = await translate.translate({ libraryID, collections });
    if (!items?.length) {
      return fail("add_item", "not_found", "Lookup returned no items");
    }
    try {
      await Zotero.Attachments.addAvailableFiles(items);
    } catch {
      // PDF attach is best-effort.
    }
    return ok("add_item", { items: items.map(summarizeItem) });
  }

  private async createItem(args: Record<string, unknown>): Promise<ToolResult> {
    const itemType = String(args.itemType ?? "journalArticle");
    const title = String(args.title ?? "").trim();
    if (!title) {
      return fail("create_item", "invalid_args", "title is required");
    }
    const item = new Zotero.Item(itemType as never);
    (item as unknown as { libraryID: number }).libraryID = defaultLibraryID(args);
    item.setField("title", title);
    const extra = args.extra as Record<string, string> | undefined;
    if (extra) {
      for (const [field, value] of Object.entries(extra)) {
        item.setField(field, value);
      }
    }
    await item.saveTx();
    return ok("create_item", summarizeItem(item));
  }

  private async updateItemMetadata(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("update_item_metadata", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    const fields = args.fields as Record<string, string> | undefined;
    if (!item || !fields) {
      return fail("update_item_metadata", "invalid_args", "fields required");
    }
    for (const [field, value] of Object.entries(fields)) {
      item.setField(field, value);
    }
    await item.saveTx();
    return ok("update_item_metadata", summarizeItem(item));
  }

  private async batchUpdateTags(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("batch_update_tags", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("batch_update_tags", "not_found", "Item not found");
    }
    for (const tag of (args.add as string[]) || []) {
      item.addTag(tag);
    }
    for (const tag of (args.remove as string[]) || []) {
      item.removeTag(tag);
    }
    await item.saveTx();
    return ok("batch_update_tags", {
      ...summarizeItem(item),
      tags: item.getTags?.() || [],
    });
  }

  private async linkRelated(args: Record<string, unknown>): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const item = getItem(libraryID, String(args.key ?? ""));
    const other = getItem(libraryID, String(args.relatedKey ?? ""));
    if (!item || !other) {
      return fail("link_related_items", "not_found", "Item not found");
    }
    item.addRelatedItem(other);
    other.addRelatedItem(item);
    await item.saveTx();
    await other.saveTx();
    return ok("link_related_items", {
      key: item.key,
      relatedKey: other.key,
    });
  }

  private async createNote(args: Record<string, unknown>): Promise<ToolResult> {
    const content = String(args.content ?? "").trim();
    if (!content) {
      return fail("create_note", "invalid_args", "content is required");
    }
    const note = new Zotero.Item("note");
    note.libraryID = defaultLibraryID(args);
    note.setNote(noteHtml(content));
    if (args.parentKey) {
      const parent = getItem(note.libraryID, String(args.parentKey));
      if (parent) {
        note.parentID = parent.id;
      }
    }
    await note.saveTx();
    return ok("create_note", { libraryID: note.libraryID, key: note.key });
  }

  private async appendToNote(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("append_to_note", "invalid_args", ref.message);
    }
    const note = getItem(ref.libraryID, ref.key);
    if (!note?.isNote?.()) {
      return fail("append_to_note", "not_found", "Note not found");
    }
    note.setNote(`${note.getNote()}${noteHtml(String(args.content ?? ""))}`);
    await note.saveTx();
    return ok("append_to_note", { libraryID: note.libraryID, key: note.key });
  }

  private async updateNote(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("update_note", "invalid_args", ref.message);
    }
    const note = getItem(ref.libraryID, ref.key);
    if (!note?.isNote?.()) {
      return fail("update_note", "not_found", "Note not found");
    }
    note.setNote(noteHtml(String(args.content ?? "")));
    await note.saveTx();
    return ok("update_note", { libraryID: note.libraryID, key: note.key });
  }

  private async attachFile(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("attach_file", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    const url = String(args.url ?? "");
    if (!item || !url) {
      return fail("attach_file", "invalid_args", "url is required");
    }
    const attachment = await Zotero.Attachments.importFromURL({
      url,
      parentItemID: item.id,
    });
    return ok("attach_file", {
      libraryID: attachment.libraryID,
      key: attachment.key,
    });
  }

  private async getOutline(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail(toolName, "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail(toolName, "not_found", "Item not found");
    }
    const text = await pdfText(item);
    if (!text) {
      return fail(toolName, "unavailable", "No indexed PDF text for this item");
    }
    const sections = parseSections(text);
    return ok(toolName, {
      libraryID: ref.libraryID,
      key: ref.key,
      sections: sections.map((section) => ({
        name: section.name,
        normalizedName: section.normalizedName,
        chars: section.content.length,
      })),
    });
  }

  private async getPaperSection(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_paper_section", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("get_paper_section", "not_found", "Item not found");
    }
    const text = await pdfText(item);
    if (!text) {
      return fail("get_paper_section", "unavailable", "No indexed PDF text");
    }
    const section = findSection(parseSections(text), String(args.section ?? ""));
    if (!section) {
      return fail("get_paper_section", "not_found", "Section not found");
    }
    return ok("get_paper_section", {
      libraryID: ref.libraryID,
      key: ref.key,
      section: section.normalizedName,
      content: section.content.slice(0, MAX_NOTE),
    });
  }

  private async getPages(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_pages", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("get_pages", "not_found", "Item not found");
    }
    const text = await pdfText(item);
    if (!text) {
      return fail("get_pages", "unavailable", "No indexed PDF text");
    }
    const split = splitPages(text);
    const start = Math.max(1, Number(args.start) || 1);
    const end = Math.min(split.pageCount, Number(args.end) || start);
    return ok("get_pages", {
      libraryID: ref.libraryID,
      key: ref.key,
      pageCount: split.pageCount,
      pages: split.pages.filter((page) => page.page >= start && page.page <= end),
    });
  }

  private async getPageCount(args: Record<string, unknown>): Promise<ToolResult> {
    const pages = await this.getPages({ ...args, start: 1, end: 1 });
    if (!pages.ok) {
      return pages;
    }
    const data = pages.data as { pageCount: number };
    return ok("get_page_count", {
      libraryID: args.libraryID,
      key: args.key,
      pageCount: data.pageCount,
    });
  }

  private async searchPaper(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail(toolName, "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail(toolName, "not_found", "Item not found");
    }
    const text = await pdfText(item);
    if (!text) {
      return fail(toolName, "unavailable", "No indexed PDF text");
    }
    const query = String(args.query ?? args.pattern ?? "");
    let regex: RegExp;
    try {
      regex =
        toolName === "search_with_regex"
          ? new RegExp(query, "gi")
          : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    } catch {
      return fail(toolName, "invalid_args", "Invalid pattern");
    }
    const hits: Array<{ index: number; snippet: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) && hits.length < 20) {
      const index = match.index ?? 0;
      hits.push({
        index,
        snippet: text.slice(Math.max(0, index - 80), index + 160),
      });
    }
    return ok(toolName, { libraryID: ref.libraryID, key: ref.key, query, hits });
  }

  private getAnnotations(args: Record<string, unknown>): ToolResult {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_annotations", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("get_annotations", "not_found", "Item not found");
    }
    const raw = item.getAnnotations?.() || [];
    const annotations = raw
      .map((entry) =>
        typeof entry === "object" && entry
          ? asItem(entry)
          : asItem(Zotero.Items.get(entry as number)),
      )
      .filter((ann): ann is Zotero.Item => Boolean(ann))
      .map((ann) => ({
        libraryID: ann.libraryID,
        key: ann.key,
        type: (ann as unknown as { annotationType?: string }).annotationType,
        text: (ann as unknown as { annotationText?: string }).annotationText || "",
        comment:
          (ann as unknown as { annotationComment?: string }).annotationComment ||
          "",
        color: (ann as unknown as { annotationColor?: string }).annotationColor || "",
        pageLabel:
          (ann as unknown as { annotationPageLabel?: string }).annotationPageLabel ||
          "",
      }));
    return ok("get_annotations", { annotations });
  }

  private getPdfSelection(_args: Record<string, unknown>): ToolResult {
    try {
      const reader = Zotero.Reader.getByTabID?.(
        Zotero.getMainWindow()?.Zotero_Tabs?.selectedID,
      );
      const text = (
        reader?._internalReader?._lastView as
          | { getSelectedText?: () => string }
          | undefined
      )?.getSelectedText?.();
      return ok("get_pdf_selection", { text: text || "" });
    } catch {
      return ok("get_pdf_selection", { text: "" });
    }
  }

  private async openItem(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("open_item", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("open_item", "not_found", "Item not found");
    }
    const pane = Zotero.getActiveZoteroPane?.();
    pane?.selectItem?.(item.id);
    const pdf = await findPdf(item);
    if (pdf) {
      await Zotero.Reader.open(pdf.id);
    }
    return ok("open_item", summarizeItem(item));
  }

  private proposeHighlights(args: Record<string, unknown>): ToolResult {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("propose_highlights", "invalid_args", ref.message);
    }
    const highlights = (args.highlights as Array<{
      text: string;
      page?: number;
      comment?: string;
    }>) || [];
    const id = `${ref.libraryID}:${ref.key}`;
    this.proposals.set(id, highlights);
    return ok("propose_highlights", {
      libraryID: ref.libraryID,
      key: ref.key,
      count: highlights.length,
      highlights,
      persisted: false,
    });
  }

  private async commitAnnotations(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("commit_annotations", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("commit_annotations", "not_found", "Item not found");
    }
    const id = `${ref.libraryID}:${ref.key}`;
    const highlights =
      (args.highlights as Array<{ text: string; comment?: string }>) ||
      this.proposals.get(id) ||
      [];
    const note = new Zotero.Item("note");
    note.libraryID = ref.libraryID;
    note.parentID = item.id;
    const body = highlights
      .map(
        (highlight) =>
          `<p><blockquote>${escapeHtml(highlight.text)}</blockquote>${
            highlight.comment ? `<br/>${escapeHtml(highlight.comment)}` : ""
          }</p>`,
      )
      .join("");
    note.setNote(
      body || "<p>Confucius annotation pass (no highlight text provided).</p>",
    );
    await note.saveTx();
    this.proposals.delete(id);
    return ok("commit_annotations", {
      libraryID: note.libraryID,
      key: note.key,
      mode: "note_fallback",
      count: highlights.length,
    });
  }

  private async updateAnnotationComment(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("update_annotation_comment", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("update_annotation_comment", "not_found", "Annotation not found");
    }
    if (item.isAnnotation?.()) {
      item.annotationComment = String(args.comment ?? "");
      await item.saveTx();
      return ok("update_annotation_comment", { key: item.key });
    }
    if (item.isNote?.()) {
      item.setNote(noteHtml(String(args.comment ?? "")));
      await item.saveTx();
      return ok("update_annotation_comment", { key: item.key, mode: "note" });
    }
    return fail("update_annotation_comment", "not_found", "Not an annotation");
  }

  private async deleteAnnotation(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("delete_annotation", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("delete_annotation", "not_found", "Not found");
    }
    await item.eraseTx();
    return ok("delete_annotation", { libraryID: ref.libraryID, key: ref.key });
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
