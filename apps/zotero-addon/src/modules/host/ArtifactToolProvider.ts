import type {
  AgentBackendKind,
  ArtifactRecord,
  ArtifactUpsertInput,
  JsonSchemaObject,
  ToolDefinition,
  ToolResult,
  ToolRuntimeMeta,
} from "@confucius/protocol";
import { artifactBodyMatchesKind, isArtifactKind } from "@confucius/protocol";
import type { ToolProvider } from "@confucius/harness";
import type { ArtifactStore } from "./ArtifactStore";

export const ARTIFACT_UPSERT_TOOL = "artifact_upsert";

const itemRefSchema = {
  type: "object",
  properties: {
    libraryID: { type: "number" },
    key: { type: "string" },
  },
  required: ["libraryID", "key"],
  additionalProperties: false,
};

const markdownBodySchema = {
  title: "Markdown body (deep_read, report, note_draft)",
  type: "object",
  description:
    'Required when kind is deep_read, report, or note_draft. Use type="markdown", not the artifact kind.',
  properties: {
    type: { type: "string", enum: ["markdown"] },
    markdown: { type: "string" },
  },
  required: ["type", "markdown"],
  additionalProperties: false,
};

const artifactBodySchemas = [
  markdownBodySchema,
  {
    title: "Evidence audit body",
    type: "object",
    properties: {
      type: { type: "string", enum: ["evidence_audit"] },
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            verdict: {
              type: "string",
              enum: ["supported", "mixed", "unsupported", "unclear"],
            },
            rationale: { type: "string" },
            citationIds: { type: "array", items: { type: "string" } },
          },
          required: ["claim", "verdict", "rationale", "citationIds"],
          additionalProperties: false,
        },
      },
    },
    required: ["type", "claims"],
    additionalProperties: false,
  },
  {
    title: "Literature map body",
    type: "object",
    properties: {
      type: { type: "string", enum: ["literature_map"] },
      nodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            summary: { type: "string" },
            item: itemRefSchema,
          },
          required: ["id", "label"],
          additionalProperties: false,
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source: { type: "string" },
            target: { type: "string" },
            relation: { type: "string" },
            citationIds: { type: "array", items: { type: "string" } },
          },
          required: ["source", "target", "relation"],
          additionalProperties: false,
        },
      },
    },
    required: ["type", "nodes", "edges"],
    additionalProperties: false,
  },
  {
    title: "Triage table body",
    type: "object",
    properties: {
      type: { type: "string", enum: ["triage_table"] },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item: itemRefSchema,
            title: { type: "string" },
            decision: {
              type: "string",
              enum: ["keep", "review", "exclude"],
            },
            reason: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["item", "title", "decision", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["type", "rows"],
    additionalProperties: false,
  },
  {
    title: "Annotation set body",
    type: "object",
    properties: {
      type: { type: "string", enum: ["annotation_set"] },
      item: itemRefSchema,
      highlights: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1 },
            quote: { type: "string" },
            comment: { type: "string" },
            color: { type: "string" },
          },
          required: ["page", "quote"],
          additionalProperties: false,
        },
      },
    },
    required: ["type", "item", "highlights"],
    additionalProperties: false,
  },
  {
    title: "Collection diff body",
    type: "object",
    properties: {
      type: { type: "string", enum: ["collection_diff"] },
      collection: itemRefSchema,
      name: { type: "string" },
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["create", "add", "remove", "tag_add", "tag_remove"],
            },
            item: itemRefSchema,
            value: { type: "string" },
          },
          required: ["op"],
          additionalProperties: false,
        },
      },
    },
    required: ["type", "operations"],
    additionalProperties: false,
  },
  {
    title: "Citation list body",
    type: "object",
    properties: {
      type: { type: "string", enum: ["citation_list"] },
      style: { type: "string" },
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            citationId: { type: "string" },
            rendered: { type: "string" },
          },
          required: ["citationId", "rendered"],
          additionalProperties: false,
        },
      },
    },
    required: ["type", "entries"],
    additionalProperties: false,
  },
];

export function artifactBodyShapeHint(kind: unknown): string {
  if (kind === "deep_read" || kind === "report" || kind === "note_draft") {
    return '{"type":"markdown","markdown":"..."}';
  }
  if (isArtifactKind(kind)) {
    return `an object whose type is "${kind}" and whose fields match the advertised ${kind} schema`;
  }
  return "one of the advertised artifact body schemas";
}

/**
 * Some OpenAI-compatible runtimes stringify nested object arguments when a
 * schema uses `oneOf`. Accept that interoperable wire shape at this boundary,
 * but only when it decodes to a JSON object. ArtifactStore still performs the
 * authoritative kind/body validation before anything is persisted.
 */
export function normalizeArtifactBodyArgument(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }
  const text = body.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return body;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : body;
  } catch {
    return body;
  }
}

function artifactBodyDiagnostic(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return `Received ${Array.isArray(body) ? "array" : typeof body}.`;
  }
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(", ") || "none";
  return `Received object keys: ${keys}; type=${JSON.stringify(value.type)}; markdown=${typeof value.markdown}.`;
}

const schema: JsonSchemaObject = {
  type: "object",
  properties: {
    id: { type: "string" },
    taskId: { type: "string" },
    kind: {
      type: "string",
      enum: [
        "deep_read",
        "evidence_audit",
        "literature_map",
        "triage_table",
        "report",
        "note_draft",
        "annotation_set",
        "collection_diff",
        "citation_list",
      ],
      description:
        'The artifact kind. For deep_read, report, and note_draft, body.type must still be "markdown".',
    },
    title: { type: "string" },
    body: {
      description:
        'A typed body. For deep_read/report/note_draft use {"type":"markdown","markdown":"..."}; every other body.type must equal kind.',
      oneOf: artifactBodySchemas,
    },
    status: { type: "string", enum: ["draft", "ready"] },
    citations: {
      type: "array",
      description:
        "Evidence citations. Give an id when a typed body refers to it through citationIds.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          itemLibraryID: { type: "number" },
          itemKey: { type: "string" },
          page: { type: "integer", minimum: 1 },
          section: { type: "string" },
          quote: { type: "string" },
        },
        required: ["itemLibraryID", "itemKey"],
        additionalProperties: false,
      },
    },
    sourceContextIds: { type: "array", items: { type: "string" } },
  },
  required: ["kind", "title", "body"],
  additionalProperties: false,
};

export const ARTIFACT_UPSERT_DEFINITION: ToolDefinition = {
  name: ARTIFACT_UPSERT_TOOL,
  description:
    'Create or revise the task\'s primary structured research artifact before finishing. Critical body rule: deep_read, report, and note_draft use {"type":"markdown","markdown":"..."}; other kinds use a body whose type equals kind and whose required fields follow the schema.',
  inputSchema: schema,
};

export class ArtifactToolProvider implements ToolProvider {
  constructor(
    private readonly store: ArtifactStore,
    private readonly taskId: string,
    private readonly backend: AgentBackendKind,
    private readonly sourceContextIds: string[],
    private readonly onUpsert: (artifact: ArtifactRecord) => void,
  ) {}

  listTools(): ToolDefinition[] {
    return [ARTIFACT_UPSERT_DEFINITION];
  }

  getMeta(name: string): ToolRuntimeMeta | null {
    return name === ARTIFACT_UPSERT_TOOL
      ? {
          name: ARTIFACT_UPSERT_TOOL,
          catalog: "agent",
          concurrency: "serial",
          mutatesState: true,
        }
      : null;
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    return name === ARTIFACT_UPSERT_TOOL ? schema : undefined;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name !== ARTIFACT_UPSERT_TOOL) {
      return {
        ok: false,
        toolName: name,
        code: "not_found",
        message: "Unknown artifact tool",
      };
    }
    const normalizedArgs: Record<string, unknown> = {
      ...args,
      body: normalizeArtifactBodyArgument(args.body),
    };
    if (
      isArtifactKind(normalizedArgs.kind) &&
      !artifactBodyMatchesKind(normalizedArgs.kind, normalizedArgs.body)
    ) {
      return {
        ok: false,
        toolName: name,
        code: "invalid_args",
        message: `Artifact body does not match kind ${normalizedArgs.kind}. Expected ${artifactBodyShapeHint(normalizedArgs.kind)}. ${artifactBodyDiagnostic(normalizedArgs.body)}`,
      };
    }
    try {
      const artifact = await this.store.upsert(
        {
          ...(normalizedArgs as unknown as Omit<ArtifactUpsertInput, "taskId">),
          taskId: this.taskId,
        },
        this.backend,
        this.sourceContextIds,
      );
      this.onUpsert(artifact);
      return { ok: true, toolName: name, data: { artifact } };
    } catch (error) {
      return {
        ok: false,
        toolName: name,
        code: "invalid_args",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
