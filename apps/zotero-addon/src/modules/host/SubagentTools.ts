import {
  SUBAGENT_TOOL_NAMES,
  contextTextSlice,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
  type ToolRuntimeMeta,
} from "@confucius/protocol";
import { validateArgs, type ToolProvider } from "@confucius/harness";
import {
  type SubagentRun,
  type SubagentSpawn,
  SubagentManager,
} from "./SubagentManager";
import type { LiteratureService } from "./LiteratureService";
import { LiteratureToolProvider } from "./LiteratureToolProvider";
import { sourceReadEvidence } from "./SourceReadEvidence";

const def = (
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
const string = { type: "string" },
  strings = { type: "array", items: string, maxItems: 100 };
const definitions = [
  def(
    "subagent_spawn",
    "Delegate a bounded research question to an isolated read-only child. Inherits this request's engine, model, reasoning and shared budget. Max three run concurrently; additional children queue. Explicit sourceIds are pool IDs or libraryID:itemKey from the current source scope; no recursive delegation.",
    { title: string, goal: string, sourceIds: strings, background: string },
    ["goal", "sourceIds"],
  ),
  def(
    "subagent_list",
    "List this task's child research statuses. Use wait to await work, not repeated polling.",
    {},
  ),
  def(
    "subagent_read",
    "Read a child's conclusion, evidence provenance and a bounded page of public activity. archiveRefs identify retained tool/source evidence; archiveRef with archiveOffset pages an exact receipt. archiveIndexOffset pages the receipt index. Internal reasoning is unavailable.",
    {
      id: string,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 25 },
      archiveRef: string,
      archiveOffset: { type: "integer", minimum: 0 },
      archiveIndexOffset: { type: "integer", minimum: 0 },
    },
    ["id"],
  ),
  def(
    "subagent_wait",
    "Wait on host completion events for the selected children (or all). No model polling is needed. Then read completed results before synthesizing.",
    { ids: strings },
  ),
  def("subagent_cancel", "Cancel one child of this task.", { id: string }, [
    "id",
  ]),
];
export class SubagentToolProvider implements ToolProvider {
  constructor(
    private readonly manager: SubagentManager,
    private readonly parent: string,
  ) {}
  listTools() {
    return definitions;
  }
  getSchema(name: string) {
    return definitions.find((d) => d.name === name)?.inputSchema;
  }
  getMeta(name: string): ToolRuntimeMeta | null {
    return SUBAGENT_TOOL_NAMES.has(name)
      ? { name, catalog: "agent", concurrency: "serial", mutatesState: false }
      : null;
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const invalid = validateArgs(name, this.getSchema(name), args);
    if (invalid) return invalid;
    try {
      let data: unknown;
      if (signal?.aborted) throw new Error("Cancelled");
      if (name === "subagent_spawn")
        data = await this.manager.spawn(
          this.parent,
          args as unknown as SubagentSpawn,
        );
      else if (name === "subagent_list")
        data = await this.manager.list(this.parent);
      else if (name === "subagent_read")
        data = await this.manager.read(
          this.parent,
          String(args.id),
          Number(args.offset ?? 0),
          Number(args.limit ?? 20),
          {
            ref: args.archiveRef as string | undefined,
            offset: Number(args.archiveOffset ?? 0),
            indexOffset: Number(args.archiveIndexOffset ?? 0),
          },
        );
      else if (name === "subagent_cancel")
        data = await this.manager.cancel(this.parent, String(args.id));
      else if (name === "subagent_wait") {
        context?.executionScope?.pause?.();
        try {
          data = await this.manager.wait(
            this.parent,
            args.ids as string[] | undefined,
            signal,
          );
        } finally {
          context?.executionScope?.resume?.();
        }
      } else throw new Error("Unknown subagent tool");
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
const reads = new Set([
  "get_item",
  "get_item_metadata",
  "get_paper_metadata",
  "get_outline",
  "list_sections",
  "get_paper_section",
  "get_pages",
  "get_page_count",
  "search_paper_content",
  "search_with_regex",
  "get_annotations",
  "inspect_pdf_page",
]);
/** Hard permission boundary, independent of backend instructions or parent grants. */
export class SubagentResearchTools implements ToolProvider {
  private readonly discovery: LiteratureToolProvider;
  constructor(
    private readonly run: SubagentRun,
    private readonly library: ToolProvider,
    private readonly literature: LiteratureService,
  ) {
    this.discovery = new LiteratureToolProvider(
      literature,
      run.document.record.parentTaskId,
      true,
    );
    run.delivered = (result, args) => this.recordDelivered(result, args);
  }
  listTools() {
    return [
      ...this.library
        .listTools()
        .filter(
          (t) =>
            reads.has(t.name) &&
            this.library.getMeta(t.name)?.mutatesState === false,
        ),
      ...this.discovery
        .listTools()
        .filter(
          (t) =>
            t.name !== "literature_search" ||
            this.run.document.record.allowSearch,
        ),
      def(
        "context_search",
        "Search this child's own archived passages. Parent and sibling histories are unavailable.",
        { query: string },
      ),
      def(
        "context_read",
        "Page an exact reference returned by this child's context_search.",
        { ref: string, offset: { type: "integer", minimum: 0 } },
        ["ref"],
      ),
    ];
  }
  getSchema(name: string) {
    return this.listTools().find((t) => t.name === name)?.inputSchema;
  }
  getMeta(name: string): ToolRuntimeMeta | null {
    return this.getSchema(name)
      ? { name, catalog: "agent", concurrency: "serial", mutatesState: false }
      : null;
  }
  private async metadata() {
    for (const id of this.run.document.record.sourceIds.filter((id) =>
      /^W\d+$/.test(id),
    )) {
      const ref = `literature:${id}`;
      if (!this.run.document.archive[ref]) {
        const work = await this.literature.get(
          this.run.document.record.parentTaskId,
          id,
        );
        this.run.document.archive[ref] = JSON.stringify({
          ...work,
          decision: undefined,
          queryIds: undefined,
          reads: undefined,
        });
      }
    }
    return Object.entries(this.run.document.archive)
      .filter(([key]) => key.startsWith("literature:"))
      .map(([, value]) => JSON.parse(value));
  }
  async recordDelivered(
    result: ToolResult,
    args: Record<string, unknown> = {},
  ) {
    if (this.run.abort.signal.aborted) return;
    const receipt = sourceReadEvidence(result, args);
    if (!receipt) return;
    this.run.document.record.evidence.push({
      reader: this.run.task.id,
      sourceVersion: receipt.contentVersion ?? "unknown",
      receipt,
      at: Date.now(),
    });
    await this.literature.recordRead?.(
      this.run.document.record.parentTaskId,
      receipt,
      this.run.task.id,
      receipt.contentVersion ?? "unknown",
      receipt.pages,
    );
    await this.run.save();
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (!this.getMeta(name))
      return {
        ok: false,
        toolName: name,
        code: "permission_denied",
        message:
          "Child research tools are read-only and scoped; recursive delegation is unavailable",
      };
    const invalid = validateArgs(name, this.getSchema(name), args);
    if (invalid) return invalid;
    if (signal?.aborted || this.run.abort.signal.aborted)
      return {
        ok: false,
        toolName: name,
        code: "unavailable",
        message: "Cancelled",
      };
    let result: ToolResult;
    if (name.startsWith("context_")) {
      const archive = this.run.document.archive;
      if (name === "context_read") {
        const value = archive[String(args.ref)];
        result =
          value === undefined
            ? {
                ok: false,
                toolName: name,
                code: "not_found",
                message: "Reference is outside this child archive",
              }
            : {
                ok: true,
                toolName: name,
                data: contextTextSlice(value, 2000, Number(args.offset ?? 0)),
              };
      } else {
        const query = String(args.query ?? "").toLowerCase();
        result = {
          ok: true,
          toolName: name,
          data: Object.entries(archive)
            .filter(([, v]) => v.toLowerCase().includes(query))
            .slice(0, 20)
            .map(([ref, value]) => ({
              ref,
              excerpt: contextTextSlice(value, 150).content,
            })),
        };
      }
    } else if (name === "literature_search") {
      const response = await this.discovery.call(name, args, signal, context);
      if (!response.ok) return response;
      const data = response.data as { queries: Array<{ id: string }> };
      const queryId = args.queryId ?? data.queries[0]?.id;
      const pool = await this.literature.load(
        this.run.document.record.parentTaskId,
      );
      const found = pool.works.filter((w) =>
        w.queryIds.includes(String(queryId)),
      );
      for (const work of found)
        this.run.document.archive[`literature:${work.id}`] = JSON.stringify({
          ...work,
          decision: undefined,
          queryIds: undefined,
          reads: undefined,
        });
      result = {
        ok: true,
        toolName: name,
        data: {
          pool: found.length,
          queryId,
          items: found
            .slice(0, 10)
            .map((w) => ({ id: w.id, title: w.title, year: w.year })),
          nextOffset: found.length > 10 ? 10 : null,
        },
      };
    } else if (name === "literature_list" || name === "literature_get") {
      const rows = await this.metadata();
      if (name === "literature_get") {
        const work = rows.find((w) => w.id === args.id);
        if (
          work &&
          !work.abstract?.trim() &&
          this.run.document.record.allowSearch
        ) {
          const enriched = await this.literature.getWithAbstract(
            this.run.document.record.parentTaskId,
            work.id,
            signal ?? this.run.abort.signal,
          );
          // Only fill abstract metadata; the child's source/acquisition snapshot stays fixed.
          work.abstract = enriched.abstract;
          work.abstractLookup = enriched.abstractLookup;
          this.run.document.archive[`literature:${work.id}`] =
            JSON.stringify(work);
        }
        result = work
          ? { ok: true, toolName: name, data: work }
          : {
              ok: false,
              toolName: name,
              code: "permission_denied",
              message: "Paper outside child source scope",
            };
      } else {
        const filtered = rows.filter((w) =>
            JSON.stringify(w)
              .toLowerCase()
              .includes(String(args.filter ?? "").toLowerCase()),
          ),
          offset = Math.max(0, Number(args.offset ?? 0)),
          limit = Math.min(25, Number(args.limit ?? 20));
        result = {
          ok: true,
          toolName: name,
          data: {
            items: filtered.slice(offset, offset + limit),
            total: filtered.length,
            nextOffset:
              offset + limit < filtered.length ? offset + limit : null,
          },
        };
      }
    } else {
      const sources = this.run.task.lockedContext.items;
      const allowed = sources.some(
        (s) =>
          s.libraryID === Number(args.libraryID) &&
          (s.key === args.key || s.attachmentKey === args.key),
      );
      if (!allowed)
        return {
          ok: false,
          toolName: name,
          code: "permission_denied",
          message: "Paper outside the explicitly delegated source scope",
        };
      result = await this.library.call(name, args, signal, context);
    }
    this.run.document.archive[
      `tool:${Date.now()}_${Math.random().toString(36).slice(2)}`
    ] = JSON.stringify({ name, args, result }, (key, value) =>
      key === "images" || key === "transient" ? undefined : value,
    );
    await this.run.save();
    return result;
  }
}
