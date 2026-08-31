import type {
  BuiltinToolName,
  JsonSchemaObject,
  ToolCatalog,
  ToolConcurrency,
  ToolDefinition,
  ToolRuntimeMeta,
} from "@confucius/protocol";
import {
  BROWSER_TOOLS,
  LIBRARY_READ_TOOLS,
  LIBRARY_WRITE_TOOLS,
  MEMORY_READ_TOOLS,
  MEMORY_WRITE_TOOLS,
  PAPER_READ_TOOLS,
  PAPER_WRITE_TOOLS,
} from "@confucius/protocol";

const itemRef = {
  libraryID: { type: "integer", description: "Zotero libraryID" },
  key: { type: "string", description: "Item key inside that library" },
};

function def(
  name: BuiltinToolName,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition {
  const inputSchema: JsonSchemaObject = {
    type: "object",
    properties,
    required,
    additionalProperties: true,
  };
  return { name, description, inputSchema };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  def("search_items", "Search library items by title, creator, or everywhere.", {
    query: { type: "string" },
    field: { type: "string", enum: ["everywhere", "title", "creator", "tag"] },
    libraryID: { type: "integer" },
    limit: { type: "integer" },
  }, ["query"]),
  def("search_fulltext", "Full-text search across indexed PDFs.", {
    query: { type: "string" },
    libraryID: { type: "integer" },
    limit: { type: "integer" },
  }, ["query"]),
  def("search_notes", "Search note bodies.", {
    query: { type: "string" },
    libraryID: { type: "integer" },
    limit: { type: "integer" },
  }, ["query"]),
  def("search_by_tag", "Find items with a tag.", {
    tag: { type: "string" },
    libraryID: { type: "integer" },
  }, ["tag"]),
  def("get_item", "Get one item. libraryID and key are required.", itemRef, ["libraryID", "key"]),
  def("get_item_metadata", "Get bibliographic fields for one item.", itemRef, ["libraryID", "key"]),
  def("get_item_notes", "List child notes of an item.", itemRef, ["libraryID", "key"]),
  def("get_note_content", "Read a note. libraryID and key of the note.", itemRef, ["libraryID", "key"]),
  def("get_collections", "List collections.", {
    libraryID: { type: "integer" },
    parentKey: { type: "string" },
  }),
  def("get_collection_items", "List items in a collection.", {
    libraryID: { type: "integer" },
    key: { type: "string" },
    limit: { type: "integer" },
  }, ["libraryID", "key"]),
  def("get_tags", "List tags in a library.", { libraryID: { type: "integer" } }),
  def("get_recent", "Recently modified items.", {
    libraryID: { type: "integer" },
    limit: { type: "integer" },
  }),
  def("list_saved_searches", "List saved searches.", { libraryID: { type: "integer" } }),
  def("run_saved_search", "Run a saved search.", {
    libraryID: { type: "integer" },
    key: { type: "string" },
  }, ["libraryID", "key"]),
  def("get_related_items", "Related items for one paper.", itemRef, ["libraryID", "key"]),
  def("create_collection", "Create a collection. Requires approval.", {
    name: { type: "string" },
    libraryID: { type: "integer" },
    parentKey: { type: "string" },
  }, ["name"]),
  def("rename_collection", "Rename a collection.", {
    libraryID: { type: "integer" },
    key: { type: "string" },
    name: { type: "string" },
  }, ["libraryID", "key", "name"]),
  def("add_to_collection", "Add an item to a collection.", {
    libraryID: { type: "integer" },
    key: { type: "string" },
    collectionKey: { type: "string" },
  }, ["libraryID", "key", "collectionKey"]),
  def("remove_from_collection", "Remove an item from a collection.", {
    libraryID: { type: "integer" },
    key: { type: "string" },
    collectionKey: { type: "string" },
  }, ["libraryID", "key", "collectionKey"]),
  def("create_saved_search", "Create a saved search.", {
    name: { type: "string" },
    query: { type: "string" },
    libraryID: { type: "integer" },
  }, ["name", "query"]),
  def("add_item", "Add an item by DOI, ISBN, PMID, or arXiv id.", {
    identifier: { type: "string" },
    libraryID: { type: "integer" },
    collectionKey: { type: "string" },
  }, ["identifier"]),
  def("create_item", "Create a bibliographic item from fields.", {
    itemType: { type: "string" },
    title: { type: "string" },
    libraryID: { type: "integer" },
    extra: { type: "object" },
  }, ["itemType", "title"]),
  def("update_item_metadata", "Update fields on an item.", {
    ...itemRef,
    fields: { type: "object" },
  }, ["libraryID", "key", "fields"]),
  def("batch_update_tags", "Add or remove tags on an item.", {
    ...itemRef,
    add: { type: "array", items: { type: "string" } },
    remove: { type: "array", items: { type: "string" } },
  }, ["libraryID", "key"]),
  def("link_related_items", "Link two items as related.", {
    libraryID: { type: "integer" },
    key: { type: "string" },
    relatedKey: { type: "string" },
  }, ["libraryID", "key", "relatedKey"]),
  def("create_note", "Create a note, optionally under an item.", {
    content: { type: "string" },
    libraryID: { type: "integer" },
    parentKey: { type: "string" },
  }, ["content"]),
  def("append_to_note", "Append HTML/text to an existing note.", {
    ...itemRef,
    content: { type: "string" },
  }, ["libraryID", "key", "content"]),
  def("update_note", "Replace note content.", {
    ...itemRef,
    content: { type: "string" },
  }, ["libraryID", "key", "content"]),
  def("attach_file", "Attach a PDF or snapshot from a local path or URL.", {
    libraryID: { type: "integer" },
    key: { type: "string" },
    url: { type: "string" },
  }, ["libraryID", "key", "url"]),
  def("get_outline", "Paper outline / section headings.", itemRef, ["libraryID", "key"]),
  def("list_sections", "List detected section names.", itemRef, ["libraryID", "key"]),
  def("get_paper_section", "Get one section's text.", {
    ...itemRef,
    section: { type: "string" },
  }, ["libraryID", "key", "section"]),
  def("get_pages", "Get text for page numbers (1-based).", {
    ...itemRef,
    start: { type: "integer" },
    end: { type: "integer" },
  }, ["libraryID", "key"]),
  def("get_page_count", "Number of pages in the PDF text extraction.", itemRef, ["libraryID", "key"]),
  def("search_paper_content", "Search inside one paper.", {
    ...itemRef,
    query: { type: "string" },
  }, ["libraryID", "key", "query"]),
  def("search_with_regex", "Regex search inside one paper.", {
    ...itemRef,
    pattern: { type: "string" },
  }, ["libraryID", "key", "pattern"]),
  def("get_annotations", "List annotations as JSON.", itemRef, ["libraryID", "key"]),
  def("get_pdf_selection", "Current PDF reader selection, if any.", itemRef),
  def("get_paper_metadata", "Title, authors, year, DOI for a paper.", itemRef, ["libraryID", "key"]),
  def("open_item", "Open the item in Zotero (library or reader).", itemRef, ["libraryID", "key"]),
  def("propose_highlights", "Propose highlights without writing the PDF.", {
    ...itemRef,
    highlights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          page: { type: "integer" },
          comment: { type: "string" },
        },
      },
    },
  }, ["libraryID", "key", "highlights"]),
  def("commit_annotations", "Write previously proposed or provided highlights.", {
    ...itemRef,
    highlights: { type: "array" },
  }, ["libraryID", "key"]),
  def("update_annotation_comment", "Update an annotation comment.", {
    libraryID: { type: "integer" },
    key: { type: "string" },
    comment: { type: "string" },
  }, ["libraryID", "key", "comment"]),
  def("delete_annotation", "Delete an annotation.", itemRef, ["libraryID", "key"]),
  def("browser.get_active_tab", "Last browser tab pushed by the Chrome extension.", {}),
  def("browser.extract_identifiers", "DOI / arXiv / PMID extracted from the active tab.", {}),
  def("browser.extract_pdf", "PDF URL on the active tab, if any.", {}),
  def("browser.extract_readable_text", "Readable text snapshot from the active tab.", {}),
  def("browser.import_current_page", "Import the active tab identifier via add_item (still requires approval).", {}),
  def("memory_search", "Search long-term memory for relevant prior knowledge about the user.", {
    query: { type: "string", description: "What to look for" },
    type: {
      type: "string",
      enum: ["preference", "fact", "project", "paper", "procedure", "insight"],
    },
    tags: { type: "array", items: { type: "string" } },
    limit: { type: "integer" },
  }, ["query"]),
  def("memory_list", "List recent long-term memories, optionally by type.", {
    type: {
      type: "string",
      enum: ["preference", "fact", "project", "paper", "procedure", "insight"],
    },
    limit: { type: "integer" },
  }),
  def("memory_save", "Save a durable memory about the user. Requires approval.", {
    content: { type: "string" },
    type: {
      type: "string",
      enum: ["preference", "fact", "project", "paper", "procedure", "insight"],
    },
    title: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  }, ["content"]),
  def("memory_update", "Revise an existing memory by id. Requires approval.", {
    id: { type: "string" },
    content: { type: "string" },
    title: { type: "string" },
  }, ["id", "content"]),
  def("memory_delete", "Delete a memory by id. Requires approval.", {
    id: { type: "string" },
  }, ["id"]),
];

function meta(
  name: BuiltinToolName,
  catalog: ToolCatalog,
  concurrency: ToolConcurrency,
  mutatesState: boolean,
): ToolRuntimeMeta {
  return { name, catalog, concurrency, mutatesState };
}

export const TOOL_META: Record<string, ToolRuntimeMeta> = {};

for (const name of LIBRARY_READ_TOOLS) {
  TOOL_META[name] = meta(name, "library.read", "parallel_safe", false);
}
for (const name of LIBRARY_WRITE_TOOLS) {
  TOOL_META[name] = meta(name, "library.write", "serial", true);
}
for (const name of PAPER_READ_TOOLS) {
  TOOL_META[name] = meta(
    name,
    "paper.read",
    name === "open_item" ? "serial" : "parallel_safe",
    false,
  );
}
for (const name of PAPER_WRITE_TOOLS) {
  TOOL_META[name] = meta(name, "paper.write", "serial", true);
}
for (const name of BROWSER_TOOLS) {
  TOOL_META[name] = meta(
    name,
    "browser",
    name === "browser.import_current_page" ? "serial" : "parallel_safe",
    name === "browser.import_current_page",
  );
}
for (const name of MEMORY_READ_TOOLS) {
  TOOL_META[name] = meta(name, "memory.read", "parallel_safe", false);
}
for (const name of MEMORY_WRITE_TOOLS) {
  TOOL_META[name] = meta(name, "memory.write", "serial", true);
}

export const WRITE_TOOL_NAMES = new Set<string>([
  ...LIBRARY_WRITE_TOOLS,
  ...PAPER_WRITE_TOOLS,
  ...MEMORY_WRITE_TOOLS,
  "browser.import_current_page",
]);

export const READ_ONLY_TOOL_NAMES = new Set<string>([
  ...LIBRARY_READ_TOOLS,
  ...PAPER_READ_TOOLS,
  ...MEMORY_READ_TOOLS,
]);
