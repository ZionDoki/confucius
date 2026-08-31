export const LIBRARY_READ_TOOLS = [
  "search_items",
  "search_fulltext",
  "search_notes",
  "search_by_tag",
  "get_item",
  "get_item_metadata",
  "get_item_notes",
  "get_note_content",
  "get_collections",
  "get_collection_items",
  "get_tags",
  "get_recent",
  "list_saved_searches",
  "run_saved_search",
  "get_related_items",
] as const;

export const LIBRARY_WRITE_TOOLS = [
  "create_collection",
  "rename_collection",
  "add_to_collection",
  "remove_from_collection",
  "create_saved_search",
  "add_item",
  "create_item",
  "update_item_metadata",
  "batch_update_tags",
  "link_related_items",
  "create_note",
  "append_to_note",
  "update_note",
  "attach_file",
] as const;

export const PAPER_READ_TOOLS = [
  "get_outline",
  "list_sections",
  "get_paper_section",
  "get_pages",
  "get_page_count",
  "search_paper_content",
  "search_with_regex",
  "get_annotations",
  "get_pdf_selection",
  "get_paper_metadata",
  "open_item",
] as const;

export const PAPER_WRITE_TOOLS = [
  "propose_highlights",
  "commit_annotations",
  "update_annotation_comment",
  "delete_annotation",
] as const;

export const BROWSER_TOOLS = [
  "browser.get_active_tab",
  "browser.extract_identifiers",
  "browser.extract_pdf",
  "browser.extract_readable_text",
  "browser.import_current_page",
] as const;

export type LibraryReadTool = (typeof LIBRARY_READ_TOOLS)[number];
export type LibraryWriteTool = (typeof LIBRARY_WRITE_TOOLS)[number];
export type PaperReadTool = (typeof PAPER_READ_TOOLS)[number];
export type PaperWriteTool = (typeof PAPER_WRITE_TOOLS)[number];
export type BrowserTool = (typeof BROWSER_TOOLS)[number];

export type BuiltinToolName =
  | LibraryReadTool
  | LibraryWriteTool
  | PaperReadTool
  | PaperWriteTool
  | BrowserTool;

export type ToolCatalog =
  | "library.read"
  | "library.write"
  | "paper.read"
  | "paper.write"
  | "browser";

export type ToolConcurrency = "parallel_safe" | "serial";

export interface ToolRuntimeMeta {
  name: string;
  catalog: ToolCatalog;
  concurrency: ToolConcurrency;
  mutatesState: boolean;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

export type ToolErrorCode =
  | "invalid_args"
  | "not_found"
  | "permission_denied"
  | "approval_required"
  | "timeout"
  | "unavailable"
  | "internal";

export interface ToolSuccess<T = unknown> {
  ok: true;
  toolName: string;
  data: T;
}

export interface ToolFailure {
  ok: false;
  toolName: string;
  code: ToolErrorCode;
  message: string;
  details?: unknown;
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;

export function mcpToolName(server: string, tool: string): string {
  return `mcp.${server}.${tool}`;
}
