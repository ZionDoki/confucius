import {
  LITERATURE_TOOL_NAMES,
  type LiteratureSearch,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
  type ToolRuntimeMeta,
} from "@confucius/protocol";
import type { ToolProvider } from "@confucius/harness";
import type { LiteratureService } from "./LiteratureService";

const definition = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});
const definitions: ToolDefinition[] = [
  definition(
    "literature_search",
    "Search OpenAlex into this task's pool; at most 100 per page. queryId continues a saved query. Does not select, import or download papers.",
    {
      query: { type: "string" },
      queryId: { type: "string" },
      fromYear: { type: "integer" },
      toYear: { type: "integer" },
      openAccess: { type: "boolean" },
      sort: { type: "string", enum: ["relevance", "date", "citations"] },
    },
  ),
  definition(
    "literature_list",
    "Page through fetched metadata/abstracts. filter searches the LOCAL pool; it does not search the internet.",
    {
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 25 },
      filter: { type: "string" },
      selected: { type: "boolean" },
      queryOffset: {
        type: "integer",
        minimum: 0,
        description: "Page saved queries, newest first, ten at a time",
      },
    },
  ),
  definition(
    "literature_get",
    "Read one pooled paper, abstract, provenance, candidate reason and fulltext status. When its abstract is missing, try local Zotero, OpenAlex and Crossref metadata with bounded deadlines and cached attempts. This never imports papers or downloads PDFs; unavailable abstracts remain explicitly missing.",
    { id: { type: "string" } },
    ["id"],
  ),
  definition(
    "literature_update_candidates",
    "Evaluate/select/exclude draft candidates with reasons. Requires latest candidateRevision; conflicts must be re-read. No library writes or downloads.",
    {
      candidateRevision: { type: "integer", minimum: 0 },
      changes: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            selected: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["id", "selected", "reason"],
          additionalProperties: false,
        },
      },
    },
    ["candidateRevision", "changes"],
  ),
  definition(
    "literature_acquire",
    "Wait for the user's candidate decision in the Literature capsule. Users may confirm import/download, continue with abstracts without importing, or continue with currently available results before downloads finish. Honor that choice; never repeatedly request the same missing PDFs. Do not poll; this call waits on a host event. Only import confirmation applies sources at this paused execution boundary. Set waitForFulltext only if the user explicitly needs these files; abstracts and partial evidence are sufficient for ordinary discovery/screening. Collection alone leaves it false.",
    { waitForFulltext: { type: "boolean" } },
  ),
];
export class LiteratureToolProvider implements ToolProvider {
  constructor(
    private readonly service: LiteratureService,
    private readonly taskId: string,
    private readonly readOnly = false,
  ) {}
  listTools() {
    return definitions.filter(
      (d) =>
        !this.readOnly ||
        !["literature_update_candidates", "literature_acquire"].includes(
          d.name,
        ),
    );
  }
  getSchema(name: string) {
    return this.listTools().find((t) => t.name === name)?.inputSchema;
  }
  getMeta(name: string): ToolRuntimeMeta | null {
    return this.getSchema(name)
      ? {
          name,
          catalog: "agent",
          concurrency: "serial",
          mutatesState: false,
          effectClass: "read",
        }
      : null;
  }
  // These tools only mutate the task's working context, like context_note. Native
  // Zotero writes are exclusively owned by the user-confirmation RPC domain.
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (!LITERATURE_TOOL_NAMES.has(name) || !this.getSchema(name))
      return {
        ok: false,
        toolName: name,
        code: "permission_denied",
        message: "Literature operation is unavailable",
      };
    try {
      let data: unknown;
      if (signal?.aborted) throw new Error("Cancelled");
      if (name === "literature_search")
        data = await this.service.search(
          this.taskId,
          { ...args, query: String(args.query ?? "") } as LiteratureSearch,
          signal,
        );
      else if (name === "literature_list")
        data = await this.service.list(this.taskId, args);
      else if (name === "literature_get")
        data = await this.service.getWithAbstract(
          this.taskId,
          String(args.id),
          signal,
        );
      else if (name === "literature_update_candidates")
        data = await this.service.updateCandidates(
          this.taskId,
          Number(args.candidateRevision),
          args.changes as Array<{
            id: string;
            selected: boolean;
            reason?: string;
          }>,
          "agent",
        );
      else {
        const preview = await this.service.requestConfirmation(this.taskId);
        context?.executionScope?.pause?.();
        try {
          await this.service.waitForConfirmation(
            this.taskId,
            preview.candidateRevision,
            signal,
            context?.runId,
          );
          if (args.waitForFulltext === true)
            await this.service.waitForFulltext(
              this.taskId,
              context?.runId,
              signal,
            );
          data = await this.service.acquisitionResult(this.taskId);
        } finally {
          context?.executionScope?.resume?.();
        }
      }
      return { ok: true, toolName: name, data };
    } catch (error) {
      return {
        ok: false,
        toolName: name,
        code: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
