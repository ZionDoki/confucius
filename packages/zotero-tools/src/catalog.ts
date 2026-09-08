import type {
  BuiltinToolName,
  JsonSchemaObject,
  ToolCatalog,
  ToolConcurrency,
  ToolDefinition,
  ToolRuntimeMeta,
} from "@confucius/protocol";
import {
  LIBRARY_READ_TOOLS,
  LIBRARY_WRITE_TOOLS,
  MEMORY_READ_TOOLS,
  MEMORY_WRITE_TOOLS,
  PAPER_READ_TOOLS,
  PAPER_WRITE_TOOLS,
} from "@confucius/protocol";

const itemRef = {
  libraryID: { type: "integer", description: "Zotero libraryID" },
  key: {
    type: "string",
    minLength: 1,
    description: "Item key inside that library",
  },
  attachmentKey: {
    type: "string",
    description: "Explicit PDF attachment key when the item has multiple PDFs",
  },
};

export const annotationSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["highlight", "underline", "image"] },
    anchor: {
      type: "string",
      description:
        "Copy ID from [anchor:ID] in get_pages. Selects that exact native PDF passage; omit page, quote and text. Highlight is the default type. Never invent or edit an ID.",
    },
    page: {
      type: "integer",
      minimum: 1,
      description:
        "1-based physical PDF page returned by get_pages; not the paper's printed page label",
    },
    quote: {
      type: "string",
      description:
        "One continuous verbatim passage on this page. Copy the original wording; do not translate, paraphrase, join separated passages with ellipses, or include your explanation. Choose the shortest passage that preserves the claim and is unique on the page.",
    },
    text: {
      type: "string",
      description: "Compatibility alias for quote on text annotations",
    },
    rect: {
      type: "array",
      description:
        "Image region [x,y,width,height], top-left origin, normalized 0-1000",
      items: { type: "number", minimum: 0, maximum: 1000 },
      minItems: 4,
      maxItems: 4,
    },
    comment: {
      type: "string",
      description:
        "In the user's configured response language, explain what this passage establishes and its evidence, assumptions, limitations, or relevance. Distinguish the paper's findings from your inference; do not merely repeat or translate the quote.",
    },
    importance: { type: "string", enum: ["key", "supporting"] },
    rationale: {
      type: "string",
      description: "Compatibility alias for comment",
    },
    id: {
      type: "string",
      description: "Stable proposal entry ID returned by propose_annotations",
    },
    color: {
      type: "string",
      pattern: "^#[0-9A-Fa-f]{6}$",
      description: "Optional #RRGGBB override",
    },
  },
  required: [],
  additionalProperties: false,
};

const memoryTypes = [
  "preference",
  "fact",
  "project",
  "paper",
  "procedure",
  "insight",
  "note",
  "method",
  "discussion",
  "mindmap",
];

const knowledgeEntryKinds = [
  "paper",
  "note",
  "insight",
  "method",
  "discussion",
  "mindmap",
];

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
  def(
    "search_items",
    "Search library items by title, creator, or everywhere. Each result carries a zoteroUri for clickable linking.",
    {
      query: { type: "string" },
      field: {
        type: "string",
        enum: ["everywhere", "title", "creator", "tag"],
      },
      libraryID: { type: "integer" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["query"],
  ),
  def(
    "search_fulltext",
    "Full-text search across indexed PDFs.",
    {
      query: { type: "string" },
      libraryID: { type: "integer" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["query"],
  ),
  def(
    "search_notes",
    "Search note bodies. Results carry a zoteroUri for clickable linking.",
    {
      query: { type: "string" },
      libraryID: { type: "integer" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["query"],
  ),
  def(
    "search_by_tag",
    "Find items with a tag.",
    {
      tag: { type: "string" },
      libraryID: { type: "integer" },
    },
    ["tag"],
  ),
  def("get_item", "Get one item. libraryID and key are required.", itemRef, [
    "libraryID",
    "key",
  ]),
  def("get_item_metadata", "Get bibliographic fields for one item.", itemRef, [
    "libraryID",
    "key",
  ]),
  def(
    "get_item_notes",
    "List child notes of an item. Each note carries a zoteroUri.",
    itemRef,
    ["libraryID", "key"],
  ),
  def(
    "get_note_content",
    "Read a note. libraryID and key of the note; the result carries a zoteroUri.",
    itemRef,
    ["libraryID", "key"],
  ),
  def("get_collections", "List collections.", {
    libraryID: { type: "integer" },
    parentKey: { type: "string" },
  }),
  def(
    "get_collection_items",
    "List items in a collection.",
    {
      libraryID: { type: "integer" },
      key: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["libraryID", "key"],
  ),
  def("get_tags", "List tags in a library.", {
    libraryID: { type: "integer" },
  }),
  def("get_recent", "Recently modified items.", {
    libraryID: { type: "integer" },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  }),
  def("list_saved_searches", "List saved searches.", {
    libraryID: { type: "integer" },
  }),
  def(
    "run_saved_search",
    "Run a saved search.",
    {
      libraryID: { type: "integer" },
      key: { type: "string" },
    },
    ["libraryID", "key"],
  ),
  def("get_related_items", "Related items for one paper.", itemRef, [
    "libraryID",
    "key",
  ]),
  def(
    "create_collection",
    "Create a collection. Requires approval.",
    {
      name: { type: "string" },
      libraryID: { type: "integer" },
      parentKey: { type: "string" },
    },
    ["name"],
  ),
  def(
    "rename_collection",
    "Rename a collection.",
    {
      libraryID: { type: "integer" },
      key: { type: "string" },
      name: { type: "string" },
    },
    ["libraryID", "key", "name"],
  ),
  def(
    "add_to_collection",
    "Add an item to a collection.",
    {
      libraryID: { type: "integer" },
      key: { type: "string" },
      collectionKey: { type: "string" },
    },
    ["libraryID", "key", "collectionKey"],
  ),
  def(
    "remove_from_collection",
    "Remove an item from a collection.",
    {
      libraryID: { type: "integer" },
      key: { type: "string" },
      collectionKey: { type: "string" },
    },
    ["libraryID", "key", "collectionKey"],
  ),
  def(
    "create_saved_search",
    "Create a saved search.",
    {
      name: { type: "string" },
      query: { type: "string" },
      libraryID: { type: "integer" },
    },
    ["name", "query"],
  ),
  def(
    "add_item",
    "Add an item by DOI, ISBN, PMID, or arXiv id.",
    {
      identifier: { type: "string" },
      libraryID: { type: "integer" },
      collectionKey: { type: "string" },
    },
    ["identifier"],
  ),
  def(
    "create_item",
    "Create a bibliographic item from fields.",
    {
      itemType: { type: "string" },
      title: { type: "string" },
      libraryID: { type: "integer" },
      extra: { type: "object" },
    },
    ["itemType", "title"],
  ),
  def(
    "update_item_metadata",
    "Update fields on an item.",
    {
      ...itemRef,
      fields: { type: "object" },
    },
    ["libraryID", "key", "fields"],
  ),
  def(
    "batch_update_tags",
    "Add or remove tags on an item.",
    {
      ...itemRef,
      add: { type: "array", items: { type: "string" } },
      remove: { type: "array", items: { type: "string" } },
    },
    ["libraryID", "key"],
  ),
  def(
    "link_related_items",
    "Link two items as related.",
    {
      libraryID: { type: "integer" },
      key: { type: "string" },
      relatedKey: { type: "string" },
    },
    ["libraryID", "key", "relatedKey"],
  ),
  def(
    "create_note",
    "Create a note, optionally under an item.",
    {
      content: { type: "string" },
      libraryID: { type: "integer" },
      parentKey: { type: "string" },
    },
    ["content"],
  ),
  def(
    "propose_note",
    "Write a research note into the library from Markdown. The draft is shown to the user for approval before anything is saved. Omit libraryID/key to attach the note under the reader's item or the selected item; without either it becomes a standalone note.",
    {
      title: { type: "string" },
      markdown: { type: "string" },
      libraryID: { type: "integer" },
      parentKey: { type: "string" },
    },
    ["title", "markdown"],
  ),
  def(
    "append_to_note",
    "Append HTML/text to an existing note.",
    {
      ...itemRef,
      content: { type: "string" },
    },
    ["libraryID", "key", "content"],
  ),
  def(
    "update_note",
    "Replace note content.",
    {
      ...itemRef,
      content: { type: "string" },
    },
    ["libraryID", "key", "content"],
  ),
  def(
    "attach_file",
    "Attach a local file or an HTTP(S) URL to an existing Zotero item. Provide exactly one of path or url.",
    {
      libraryID: { type: "integer" },
      key: { type: "string" },
      path: {
        type: "string",
        description: "Absolute path to a local file",
      },
      url: {
        type: "string",
        description: "HTTP(S) URL to download and attach",
      },
    },
    ["libraryID", "key"],
  ),
  def("get_outline", "Paper outline / section headings.", itemRef, [
    "libraryID",
    "key",
  ]),
  def("list_sections", "List detected section names.", itemRef, [
    "libraryID",
    "key",
  ]),
  def(
    "get_paper_section",
    "Get one section's text.",
    {
      ...itemRef,
      section: { type: "string" },
    },
    ["libraryID", "key", "section"],
  ),
  def(
    "get_pages",
    "Read real physical PDF pages (1-based), preserving blank pages. Text includes [anchor:ID] before selectable passages: use that ID with commit_annotations to mark the exact native text without copying quotes or guessing pages. Markers are metadata, not paper text. Repeated pages in the same turn are omitted unless rereadReason explains the evidence gap or missing engine output. If nextPage is not null, continue there; use non-overlapping ranges and do not treat a truncated result as fully read. Indexed text without reliable pages is never assigned invented page numbers.",
    {
      ...itemRef,
      start: { type: "integer", minimum: 1 },
      end: { type: "integer", minimum: 1 },
      rereadReason: {
        type: "string",
        description:
          "Specific evidence gap, verification purpose, or unavailable/truncated earlier output requiring this reread.",
      },
    },
    ["libraryID", "key"],
  ),
  def(
    "get_page_count",
    "Number of real physical PDF pages, including blank and scanned pages.",
    itemRef,
    ["libraryID", "key"],
  ),
  def(
    "search_paper_content",
    "Find a literal, case-insensitive substring inside one paper. The query is one phrase, not Boolean syntax: 'A OR B' searches for those literal characters. Use search_with_regex for alternatives. A missing phrase does not prove that the topic is absent from the paper.",
    {
      ...itemRef,
      query: { type: "string" },
      start: {
        type: "integer",
        minimum: 1,
        description:
          "First physical page to search; use nextPage from a truncated result",
      },
    },
    ["libraryID", "key", "query"],
  ),
  def(
    "search_with_regex",
    "Regex search inside one paper.",
    {
      ...itemRef,
      pattern: { type: "string" },
      start: { type: "integer", minimum: 1 },
    },
    ["libraryID", "key", "pattern"],
  ),
  def(
    "get_annotations",
    "Read actual Zotero annotation text/comments and this task's proposal outcomes. Omit limit for 25 results; page size is capped at 50 even if a larger limit is requested. Each saved annotation includes its Zotero URI. Follow nextOffset until null when reviewing all saved comments; submission reconciles native state automatically.",
    {
      ...itemRef,
      batchIds: { type: "array", items: { type: "string" } },
      includeExisting: { type: "boolean" },
      offset: { type: "integer", minimum: 0 },
      limit: {
        type: "integer",
        minimum: 1,
        description:
          "Requested page size; defaults to 25 and is capped at 50. Follow nextOffset.",
      },
    },
    ["libraryID", "key"],
  ),
  def("get_pdf_selection", "Current PDF reader selection, if any.", itemRef),
  def(
    "inspect_pdf_page",
    "Inspect one physical PDF page to read tables/figures or ground image regions. Returns text aligned by page coordinates, normalized line anchors and, when supported, a temporary page PNG. Use this when flattened text loses table column headers or order; never guess which value belongs to which column. Inspect at most one visual page per model round. Do not guess an image-region rectangle without a page image.",
    {
      ...itemRef,
      page: { type: "integer", minimum: 1 },
    },
    ["libraryID", "key", "page"],
  ),
  def("get_paper_metadata", "Title, authors, year, DOI for a paper.", itemRef, [
    "libraryID",
    "key",
  ]),
  def("open_item", "Open the item in Zotero (library or reader).", itemRef, [
    "libraryID",
    "key",
  ]),
  def(
    "propose_highlights",
    "Compatibility tool: propose highlights without writing the PDF.",
    {
      ...itemRef,
      highlights: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            page: { type: "integer" },
            comment: { type: "string" },
            color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
          },
        },
      },
    },
    ["libraryID", "key", "highlights"],
  ),
  def(
    "propose_annotations",
    "Optional saved draft for a user who wants to review candidates before submission. Normal annotation tasks should call commit_annotations directly with one or more entries. This tool does not save native PDF marks. Image regions must come from inspect_pdf_page.",
    {
      ...itemRef,
      annotations: { type: "array", maxItems: 100, items: annotationSchema },
    },
    ["libraryID", "key", "annotations"],
  ),
  def(
    "commit_annotations",
    "Create native PDF annotations in one call: pass annotations:[{anchor,comment}] using IDs from get_pages. One entry or a batch is supported; no propose call is needed. Type defaults to highlight for anchors; underline and color are optional. Comments must use the user's configured response language. The tool resolves text, page and geometry, previews the actual passages, saves eligible entries, and retains partial successes. Only returned annotationKeys confirm writes. If using an optional saved proposal, pass proposalId alone. Repair only failed entries; do not repeat unchanged non-retryable failures or recreate completed/manually removed marks. Copy returned Zotero URIs exactly.",
    {
      ...itemRef,
      proposalId: {
        type: "string",
        description:
          "ID returned by propose_annotations. When present, omit annotations and highlights.",
      },
      highlights: {
        type: "array",
        description: "Legacy direct batch; omit when using proposalId.",
      },
      annotations: {
        type: "array",
        maxItems: 100,
        items: annotationSchema,
        description:
          "One or more annotations, normally {anchor,comment}; optional type/color. Legacy text entries require type, physical page and exact quote. Image entries require type:image, page, rect and comment. Omit this array when using proposalId.",
      },
    },
    ["libraryID", "key"],
  ),
  def(
    "update_annotation",
    "Update a Confucius Agent annotation's comment or text selection in the same PDF. Other sources are protected. Original batch and creator are retained.",
    {
      libraryID: { type: "integer" },
      key: { type: "string" },
      comment: { type: "string" },
      anchor: { type: "string" },
    },
    ["libraryID", "key"],
  ),
  def(
    "update_annotation_comment",
    "Update the comment of an annotation created by a Confucius Agent, including another task or Agent. Other sources are protected.",
    {
      libraryID: { type: "integer" },
      key: { type: "string" },
      comment: { type: "string" },
    },
    ["libraryID", "key", "comment"],
  ),
  def(
    "delete_annotation",
    "Delete an annotation created by a Confucius Agent, including another task or Agent. Never delete annotations of unknown or other origin.",
    itemRef,
    ["libraryID", "key"],
  ),
  def(
    "memory_search",
    "Search long-term memory for relevant prior knowledge about the user.",
    {
      query: { type: "string", description: "What to look for" },
      type: {
        type: "string",
        enum: memoryTypes,
      },
      tags: { type: "array", items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["query"],
  ),
  def("memory_list", "List recent long-term memories, optionally by type.", {
    type: {
      type: "string",
      enum: memoryTypes,
    },
    tags: { type: "array", items: { type: "string" } },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  }),
  def(
    "memory_save",
    "Save a memory about the user. Requires approval.",
    {
      content: { type: "string" },
      type: {
        type: "string",
        enum: memoryTypes,
      },
      title: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    ["content"],
  ),
  def(
    "memory_update",
    "Revise an existing memory by id. Requires approval.",
    {
      id: { type: "string" },
      content: { type: "string" },
      title: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    ["id", "content"],
  ),
  def(
    "memory_delete",
    "Delete a memory by id. Requires approval.",
    {
      id: { type: "string" },
    },
    ["id"],
  ),
  def(
    "knowledge_base_list",
    "List visible research knowledge bases with entry counts.",
    {
      query: { type: "string", description: "Optional title or topic filter" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  ),
  def(
    "knowledge_base_get",
    "Read one research knowledge base and its organized entries.",
    {
      id: { type: "string", description: "Knowledge base id" },
      kind: { type: "string", enum: knowledgeEntryKinds },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["id"],
  ),
  def(
    "knowledge_base_search",
    "Search papers, notes, insights, methods, discussions, and mind maps across research knowledge bases.",
    {
      query: { type: "string" },
      knowledgeBaseId: {
        type: "string",
        description: "Optional knowledge base id; omit to search every topic",
      },
      kind: { type: "string", enum: knowledgeEntryKinds },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["query"],
  ),
  def(
    "knowledge_base_create",
    "Create a visible research knowledge base. Requires approval.",
    {
      title: { type: "string" },
      description: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    ["title"],
  ),
  def(
    "knowledge_base_update",
    "Update a research knowledge base title, scope, or tags. Requires approval.",
    {
      id: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    ["id"],
  ),
  def(
    "knowledge_base_save_entry",
    "Add or update an organized knowledge-base entry. Mind maps use a Markdown heading/bullet outline. Requires approval.",
    {
      id: {
        type: "string",
        description: "Existing entry id to update; omit to add",
      },
      knowledgeBaseId: { type: "string" },
      kind: { type: "string", enum: knowledgeEntryKinds },
      title: { type: "string" },
      content: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      libraryID: {
        type: "integer",
        description: "Optional Zotero source libraryID for paper entries",
      },
      key: {
        type: "string",
        description: "Optional Zotero source item key for paper entries",
      },
      clearSource: {
        type: "boolean",
        description:
          "Set true when updating an entry to remove its existing Zotero source",
      },
    },
    ["knowledgeBaseId", "kind", "title", "content"],
  ),
  def(
    "conversation_log_search",
    "Search retained conversation logs across sessions. Full transcripts stay on disk even after in-context compaction.",
    {
      query: {
        type: "string",
        description: "What to look for in past conversations",
      },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["query"],
  ),
  def(
    "conversation_log_read",
    "Read one session's conversation log. Always returns an excerpt (query focuses it) plus a truncated transcript. Full files stay on disk after compaction.",
    {
      sessionId: { type: "string", description: "Session id (ses_…)" },
      query: { type: "string" },
      maxChars: { type: "integer" },
    },
    ["sessionId"],
  ),
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
    name === "open_item" || name === "inspect_pdf_page"
      ? "serial"
      : "parallel_safe",
    false,
  );
}
for (const name of PAPER_WRITE_TOOLS) {
  TOOL_META[name] = meta(name, "paper.write", "serial", true);
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
]);

export const READ_ONLY_TOOL_NAMES = new Set<string>([
  ...LIBRARY_READ_TOOLS,
  ...PAPER_READ_TOOLS,
  ...MEMORY_READ_TOOLS,
]);
