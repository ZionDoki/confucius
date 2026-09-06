import type { ToolExecutionContext } from "@confucius/protocol";
import { HISTORY_TOOL_NAMES } from "./HistoryTools";
import type {
  ArtifactKind,
  TaskTemplateId,
  ToolResult,
} from "@confucius/protocol";
import type { ToolProvider } from "@confucius/harness";

export type PresetWorkflowId = "deep-read" | "evidence-audit" | "synthesis";

export interface PresetWorkflow {
  id: PresetWorkflowId;
  source: "single" | "multi";
  instruction: string;
  version: 1;
  requiredArtifactKinds: readonly ArtifactKind[];
  annotationFirst: boolean;
}

export interface PresetSourceScope {
  itemRefs: ReadonlySet<string>;
  collectionRefs: ReadonlySet<string>;
  savedSearchRefs: ReadonlySet<string>;
}

const PRESET_READ_TOOLS = [
  "get_item",
  "get_item_metadata",
  "get_collection_items",
  "run_saved_search",
  "get_outline",
  "list_sections",
  "get_paper_section",
  "get_pages",
  "get_page_count",
  "search_paper_content",
  "search_with_regex",
  "get_annotations",
  "inspect_pdf_page",
  "get_paper_metadata",
] as const;

const PRESET_ITEM_SOURCE_TOOLS = new Set<string>([
  "get_item",
  "get_item_metadata",
  "get_outline",
  "list_sections",
  "get_paper_section",
  "get_pages",
  "get_page_count",
  "search_paper_content",
  "search_with_regex",
  "get_annotations",
  "inspect_pdf_page",
  "get_paper_metadata",
  "propose_annotations",
  "propose_highlights",
  "commit_annotations",
]);

/**
 * A preset projects its task tools and source scope; it never orders turns.
 */
export function presetToolNames(workflow: PresetWorkflow): ReadonlySet<string> {
  return new Set([
    ...PRESET_READ_TOOLS,
    ...HISTORY_TOOL_NAMES,
    "artifact_upsert",
    "load_skill",
    ...(workflow.annotationFirst
      ? [
          "propose_annotations",
          "propose_highlights",
          "commit_annotations",
          "update_annotation_comment",
        ]
      : []),
  ]);
}

export function presetToolCallInScope(
  scope: PresetSourceScope,
  toolName: string,
  args: Record<string, unknown>,
  context?: ToolExecutionContext,
): boolean {
  if (toolName === "update_annotation_comment")
    return Boolean(
      context?.resources?.some(
        (resource) =>
          resource.startsWith("zotero:") &&
          scope.itemRefs.has(resource.slice(7)),
      ),
    );
  const ref = sourceRef(args);
  if (toolName === "get_collection_items") {
    return Boolean(ref && scope.collectionRefs.has(ref));
  }
  if (toolName === "run_saved_search") {
    return Boolean(ref && scope.savedSearchRefs.has(ref));
  }
  if (PRESET_ITEM_SOURCE_TOOLS.has(toolName)) {
    return Boolean(ref && scope.itemRefs.has(ref));
  }
  return true;
}

/** Enforce the task tool list and the host-resolved source boundary. */
export class PresetToolProvider implements ToolProvider {
  private readonly allowed: ReadonlySet<string>;

  constructor(
    private readonly inner: ToolProvider,
    workflow: PresetWorkflow,
    private readonly scope: PresetSourceScope,
  ) {
    this.allowed = presetToolNames(workflow);
  }

  listTools() {
    return this.inner.listTools().filter((tool) => this.allowed.has(tool.name));
  }

  getMeta(name: string) {
    return this.allowed.has(name) ? this.inner.getMeta(name) : null;
  }

  getSchema(name: string) {
    return this.allowed.has(name) ? this.inner.getSchema(name) : undefined;
  }

  async recordDenied(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<void> {
    await this.inner.recordDenied?.(name, args, context);
  }

  async prepare(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) {
    if (!this.allowed.has(name))
      return {
        ok: false as const,
        toolName: name,
        code: "not_found" as const,
        effect: "none" as const,
        message: "Tool is not available in this task",
      };
    const invalid = await this.inner.prepare?.(name, args, context);
    if (invalid) return invalid;
    if (!presetToolCallInScope(this.scope, name, args, context))
      return {
        ok: false as const,
        toolName: name,
        code: "permission_denied" as const,
        effect: "none" as const,
        message: "Source is outside this task",
      };
    return null;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (!this.allowed.has(name)) {
      return {
        ok: false,
        toolName: name,
        code: "not_found",
        message: "Tool is not available in the preset task",
      };
    }
    if (name === "update_annotation_comment") {
      // The execution dispatch gets a fresh context after approval. Resolve the
      // annotation's current native parent again before checking source scope;
      // do not mistake missing preflight metadata for an out-of-scope item.
      context = { ...context, resources: undefined };
      const invalid = await this.inner.prepare?.(name, args, context);
      if (invalid) return invalid;
    }
    if (!presetToolCallInScope(this.scope, name, args, context)) {
      return {
        ok: false,
        toolName: name,
        code: "permission_denied",
        message:
          "Source is outside this task. Use an item, collection, or saved-search identifier from the task source list.",
      };
    }
    return this.inner.call(name, args, signal, context);
  }
}

const common = [
  "Follow the current user request, source scope, language and format. Use task source identifiers and actual tool results.",
  "Read evidence, prepare candidates and drafts, revise concrete issues, and save the required artifacts in the current context.",
  "Reuse existing evidence and completed writes. Review a saved draft against the source before finalizing it; do not restart completed research or ask about optional preferences.",
].join("\n");
const presets: Record<PresetWorkflowId, PresetWorkflow> = {
  "deep-read": {
    id: "deep-read",
    version: 1,
    source: "single",
    annotationFirst: true,
    requiredArtifactKinds: ["deep_read", "annotation_set"],
    instruction: `${common}\nRead the paper and prepare grounded annotations with propose_annotations. Review the candidate batch and its per-entry feedback, improve key explanations, and commit the current proposal revision using commit_annotations. Exact quotes anchor highlights and underlines; inspect_pdf_page supports image-region evidence. The host reconciles retries; correct only unresolved entries. Never recreate a deleted or completed mark. Save a deep_read report and an annotation_set artifact that accurately distinguish saved, skipped, denied and unresolved results. Use actual returned Zotero identifiers. Default colors are yellow #ffd400 for key points, blue #2ea8e5 for supporting detail and purple #a28ae5 for visual evidence.`,
  },
  "evidence-audit": {
    id: "evidence-audit",
    version: 1,
    source: "single",
    annotationFirst: false,
    requiredArtifactKinds: ["evidence_audit"],
    instruction: `${common}\nEvaluate material claims against supporting evidence, counterevidence and assumptions. Save one evidence_audit artifact with source anchors and residual uncertainty. Include at most ten material claims unless requested otherwise.`,
  },
  synthesis: {
    id: "synthesis",
    version: 1,
    source: "multi",
    annotationFirst: false,
    requiredArtifactKinds: ["report"],
    instruction: `${common}\nCompare the task sources, identify agreements, disagreements, methods and limitations, and save one cited report artifact.`,
  },
};

export function presetWorkflow(
  templateId: TaskTemplateId | string | undefined,
): PresetWorkflow | undefined {
  return templateId && Object.hasOwn(presets, templateId)
    ? presets[templateId as PresetWorkflowId]
    : undefined;
}

function sourceRef(args: Record<string, unknown>): string | null {
  const libraryID = Number(args.libraryID);
  const key = typeof args.key === "string" ? args.key.trim() : "";
  return Number.isInteger(libraryID) && libraryID > 0 && key
    ? `${libraryID}:${key}`
    : null;
}

export function isContinueRequest(text: string): boolean {
  return /^(继续|继续吧|继续执行|繼續|continue|resume)[。.!！\s]*$/i.test(
    text.trim(),
  );
}
