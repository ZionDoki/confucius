import {
  SUBAGENT_TOOL_NAMES,
  contextTextSlice,
  type LiteratureQuery,
  type LiteratureWork,
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
import { compactWork, LiteratureToolProvider } from "./LiteratureToolProvider";
import { shortlistWorks } from "./LiteratureRanking";
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
          signal,
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
type ChildWork = Omit<LiteratureWork, "decision" | "queryIds" | "reads">;
type ChildQuery = { query: LiteratureQuery; workIds: string[] };
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
        )
        .map((tool) => {
          if (tool.name !== "literature_list") return tool;
          const properties = { ...tool.inputSchema.properties };
          // Parent candidate decisions are deliberately absent from child snapshots.
          delete properties.selected;
          return {
            ...tool,
            description:
              "Read this child's archived papers. Default shortlist returns 10 (at most 12) for its current or requested query. Metadata/status views page only owned snapshots; parent decisions and sibling queries are unavailable.",
            inputSchema: { ...tool.inputSchema, properties },
          };
        }),
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
  private active(signal?: AbortSignal) {
    return (
      !signal?.aborted &&
      !this.run.abort.signal.aborted &&
      this.run.current?.() !== false
    );
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
        if (!this.active()) throw new Error("Child research was cancelled");
        this.run.document.archive[ref] = JSON.stringify({
          ...work,
          decision: undefined,
          queryIds: undefined,
          queryScores: undefined,
          reads: undefined,
        });
      }
    }
    return Object.entries(this.run.document.archive)
      .filter(([key]) => key.startsWith("literature:"))
      .map(([, value]) => JSON.parse(value) as ChildWork);
  }
  private querySnapshot(id: string): ChildQuery | undefined {
    const saved = this.run.document.archive[`literature-query:${id}`];
    return saved ? JSON.parse(saved) : undefined;
  }
  private listSnapshot(rows: ChildWork[], args: Record<string, unknown>) {
    const view = args.view ?? "shortlist";
    const current = this.run.document.archive["literature-current-query"];
    const queryId =
      args.queryId === undefined
        ? view === "shortlist" && current
          ? String(JSON.parse(current))
          : undefined
        : String(args.queryId);
    const snapshot = queryId ? this.querySnapshot(queryId) : undefined;
    if (queryId && !snapshot) return undefined;
    const filter = String(args.filter ?? "").toLocaleLowerCase();
    const filtered = rows.filter(
      (work) =>
        (!snapshot || snapshot.workIds.includes(work.id)) &&
        (!args.status || work.acquisition.status === args.status) &&
        (!filter ||
          [work.title, work.abstract, ...work.authors]
            .join(" ")
            .toLocaleLowerCase()
            .includes(filter)),
    );
    const queryOffset = Number(args.queryOffset ?? 0);
    const queries = Object.entries(this.run.document.archive)
      .filter(([key]) => key.startsWith("literature-query:"))
      .map(([, value]) => (JSON.parse(value) as ChildQuery).query)
      .reverse()
      .slice(queryOffset, queryOffset + 10);
    if (view === "shortlist") {
      const shortlist = shortlistWorks(
        filtered,
        snapshot?.query,
        Number(args.limit ?? 10),
      );
      return {
        items: shortlist.items.map((work) => compactWork(work)),
        total: shortlist.totalCandidates,
        queryId,
        queries,
        nextOffset: null,
        ranking: {
          queryId,
          strategy: snapshot?.query.sort ?? "relevance",
          reranked: shortlist.reranked,
          totalCandidates: shortlist.totalCandidates,
        },
      };
    }
    const offset = Number(args.offset ?? 0);
    const limit = Math.min(25, Number(args.limit ?? 20));
    const items = filtered.slice(offset, offset + limit);
    return {
      items: items.map((work) => compactWork(work, view === "status")),
      total: filtered.length,
      queryId,
      queries,
      nextOffset: offset + limit < filtered.length ? offset + limit : null,
    };
  }
  async recordDelivered(
    result: ToolResult,
    args: Record<string, unknown> = {},
  ) {
    if (!this.active()) return;
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
    if (!this.active(signal))
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
      if (args.queryId && !this.querySnapshot(String(args.queryId)))
        return {
          ok: false,
          toolName: name,
          code: "permission_denied",
          message: "Query outside child source scope",
        };
      const response = await this.discovery.call(name, args, signal, context);
      if (!response.ok) return response;
      const data = response.data as {
        queryId?: string;
        queries: Array<{ id: string }>;
        items: Array<{ id: string; title: string; year?: number }>;
      };
      const queryId = data.queryId ?? data.queries[0]?.id;
      const pool = await this.literature.load(
        this.run.document.record.parentTaskId,
      );
      if (!this.active(signal))
        return {
          ok: false,
          toolName: name,
          code: "unavailable",
          message: "Child research was cancelled",
        };
      const found = pool.works.filter((w) =>
        w.queryIds.includes(String(queryId)),
      );
      const query = pool.queries.find((query) => query.id === queryId);
      if (!query)
        return {
          ok: false,
          toolName: name,
          code: "not_found",
          message: "Search query is unavailable",
        };
      // Freeze sources/acquisition on first observation; only query-specific scores
      // may be added when another child-owned search finds the same paper.
      await this.metadata();
      if (!this.active(signal))
        return {
          ok: false,
          toolName: name,
          code: "unavailable",
          message: "Child research was cancelled",
        };
      for (const work of found) {
        const ref = `literature:${work.id}`;
        const saved = this.run.document.archive[ref];
        const snapshot: ChildWork = saved ? JSON.parse(saved) : work;
        this.run.document.archive[ref] = JSON.stringify({
          ...snapshot,
          decision: undefined,
          queryIds: undefined,
          reads: undefined,
          queryScores: {
            ...(saved ? snapshot.queryScores : {}),
            [query.id]: work.queryScores?.[query.id],
          },
        });
      }
      this.run.document.archive[`literature-query:${query.id}`] =
        JSON.stringify({
          query,
          workIds: found.map((work) => work.id),
        } satisfies ChildQuery);
      this.run.document.archive["literature-current-query"] = JSON.stringify(
        query.id,
      );
      result = {
        ok: true,
        toolName: name,
        data: {
          pool: found.length,
          ...this.listSnapshot(await this.metadata(), {
            ...args,
            queryId: query.id,
          }),
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
          if (!this.active(signal))
            return {
              ok: false,
              toolName: name,
              code: "unavailable",
              message: "Child research was cancelled",
            };
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
        const data = this.listSnapshot(rows, args);
        result = data
          ? { ok: true, toolName: name, data }
          : {
              ok: false,
              toolName: name,
              code: "permission_denied",
              message: "Query outside child source scope",
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
    if (!this.active(signal))
      return {
        ok: false,
        toolName: name,
        code: "unavailable",
        message: "Child research was cancelled",
      };
    this.run.document.archive[
      `tool:${Date.now()}_${Math.random().toString(36).slice(2)}`
    ] = JSON.stringify({ name, args, result }, (key, value) =>
      key === "images" || key === "transient" ? undefined : value,
    );
    await this.run.save();
    return result;
  }
}
