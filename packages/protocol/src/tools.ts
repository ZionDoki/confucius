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
  "propose_note",
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
  "inspect_pdf_page",
  "get_paper_metadata",
  "open_item",
] as const;

export const PAPER_WRITE_TOOLS = [
  "propose_highlights",
  "propose_annotations",
  "commit_annotations",
  "update_annotation",
  "update_annotation_comment",
  "delete_annotation",
] as const;

export const MEMORY_READ_TOOLS = [
  "memory_search",
  "memory_list",
  "knowledge_base_list",
  "knowledge_base_get",
  "knowledge_base_search",
  "conversation_log_search",
  "conversation_log_read",
] as const;

export const MEMORY_WRITE_TOOLS = [
  "memory_save",
  "memory_update",
  "memory_delete",
  "knowledge_base_create",
  "knowledge_base_update",
  "knowledge_base_save_entry",
] as const;

export type LibraryReadTool = (typeof LIBRARY_READ_TOOLS)[number];
export type LibraryWriteTool = (typeof LIBRARY_WRITE_TOOLS)[number];
export type PaperReadTool = (typeof PAPER_READ_TOOLS)[number];
export type PaperWriteTool = (typeof PAPER_WRITE_TOOLS)[number];
export type MemoryReadTool = (typeof MEMORY_READ_TOOLS)[number];
export type MemoryWriteTool = (typeof MEMORY_WRITE_TOOLS)[number];

export type BuiltinToolName =
  | LibraryReadTool
  | LibraryWriteTool
  | PaperReadTool
  | PaperWriteTool
  | MemoryReadTool
  | MemoryWriteTool;

export type ToolCatalog =
  | "library.read"
  | "library.write"
  | "paper.read"
  | "paper.write"
  | "memory.read"
  | "memory.write"
  | "mcp"
  | "agent";

export type ToolConcurrency = "parallel_safe" | "serial";

export interface ToolRuntimeMeta {
  name: string;
  catalog: ToolCatalog;
  concurrency: ToolConcurrency;
  mutatesState: boolean;
  effectClass?: "read" | "write" | "unknown";
}

/** Absolute host deadline shared by preparation, resource waits and execution. */
export interface ToolExecutionScope {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  /** Only the host approval boundary excludes user waiting from active time. */
  pause?(): void;
  resume?(): void;
}

/**
 * A domain-owned, serializable description of one concrete operation.
 * The executor persists this value as the operation intent; it never infers
 * native targets or recovery rules from a public tool name or its arguments.
 */
export interface PreparedOperation {
  readonly schemaVersion: 1;
  readonly domain: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly resources: readonly string[];
  readonly recovery: Readonly<Record<string, unknown>>;
}

export interface ToolExecutionContext {
  annotationBatchId?: string;
  taskTitle?: string;
  taskCreatedAt?: number;
  agent?: string;
  runtime?: "native" | "plugin" | "sidecar";
  taskId?: string;
  runId?: string;
  intentRevision?: number;
  signal?: AbortSignal;
  turnId?: string;
  operationId?: string;
  /** Host-only immutable intent returned by the owning domain. */
  preparedOperation?: PreparedOperation;
  /** Ephemeral cancellation/deadline state; never persisted in an intent. */
  executionScope?: ToolExecutionScope;
  /** Host-only replay receipt; never supplied by a model. */
  replayResult?: ToolResult;
  source?: { libraryID: number; key: string; attachmentKey?: string };
  resources?: string[];
  expected?: Record<string, string>;
  expectedAfter?: Record<string, string>;
  plannedKeys?: Record<string, string>;
  annotationPolicy?: "key_explanations" | "all_explanations" | "advisory";
  onProgress?: (progress: {
    stage: string;
    elapsedMs: number;
    message?: string;
  }) => void;
}

export interface ToolExecutionOutcome {
  operationId?: string;
  effect?: "none" | "applied" | "partial" | "unknown";
  retryable?: boolean;
  issues?: Array<{
    path: string;
    reason: string;
    message: string;
    nextAction?: string;
  }>;
  warnings?: string[];
  diagnostics?: {
    stage: string;
    elapsedMs: number;
    retryCount: number;
    persistence: "saved" | "pending" | "not_required";
  };
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

export interface ToolSuccess<T = unknown> extends ToolExecutionOutcome {
  ok: true;
  toolName: string;
  data: T;
  /** Ephemeral model-only media. Hosts must strip this before persistence. */
  transientMedia?: ToolTransientMedia[];
}

export interface ToolTransientMedia {
  type: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** Base64 payload without a data-URL prefix. */
  data: string;
  description?: string;
}

export interface ToolFailure extends ToolExecutionOutcome {
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
