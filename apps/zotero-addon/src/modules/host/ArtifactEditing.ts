import { contextTextSlice, markdownForDisplay } from "@confucius/protocol";
import type {
  ArtifactBody,
  ArtifactRecord,
  ArtifactUpsertInput,
  Citation,
  JsonSchemaObject,
  ToolDefinition,
} from "@confucius/protocol";

export const ARTIFACT_READ_TOOL = "artifact_read";
export const ARTIFACT_PATCH_TOOL = "artifact_patch";

const id = { type: "string", pattern: "^[a-zA-Z0-9_-]+$" };
const revision = { type: "integer", minimum: 1 };

export const ARTIFACT_CITATIONS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      itemLibraryID: { type: "number" },
      itemKey: { type: "string" },
      attachmentKey: { type: "string", minLength: 1 },
      annotationKey: { type: "string", minLength: 1 },
      title: { type: "string" },
      page: { type: "integer", minimum: 1 },
      section: { type: "string" },
      quote: { type: "string" },
    },
    required: ["itemLibraryID", "itemKey"],
    additionalProperties: false,
  },
};

export const ARTIFACT_READ_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    id,
    part: {
      type: "string",
      enum: ["body", "citations"],
      description:
        "Defaults to body. Markdown is returned verbatim; other bodies and citations are JSON text.",
    },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 12000 },
    expectedRevision: {
      ...revision,
      description:
        "For subsequent chunks, use the first chunk's revision to avoid mixing versions.",
    },
  },
  required: ["id"],
  additionalProperties: false,
};

export const ARTIFACT_PATCH_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    id,
    expectedRevision: {
      ...revision,
      description:
        "Revision returned by the latest save or artifact_read. A stale version is rejected without changing the report.",
    },
    edits: {
      type: "array",
      maxItems: 30,
      description:
        "Markdown replacements checked against the original revision, then applied together. Each oldText must match exactly once; use enough surrounding text. All edits succeed or none do.",
      items: {
        type: "object",
        properties: {
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
        },
        required: ["oldText", "newText"],
        additionalProperties: false,
      },
    },
    title: { type: "string", minLength: 1, pattern: "\\S" },
    status: {
      type: "string",
      enum: ["draft", "ready"],
      description:
        "After evidence review, send all corrections with status=ready in one call. If no correction is needed, send only id, expectedRevision and status=ready.",
    },
    citations: {
      ...ARTIFACT_CITATIONS_SCHEMA,
      description:
        "Optional replacement of the complete citation list. Omit to preserve existing citations; [] explicitly clears it.",
    },
  },
  required: ["id", "expectedRevision"],
  additionalProperties: false,
};

export const ARTIFACT_EDIT_DEFINITIONS: ToolDefinition[] = [
  {
    name: ARTIFACT_READ_TOOL,
    description:
      "Read a saved artifact in this task, including its current revision. Use when the current report text is absent or stale; do not reread a draft already present in review inputs. Returns up to 8000 characters by default; follow nextOffset with expectedRevision for more. Read part=citations only when editing citations. This is saved draft content, not source evidence.",
    inputSchema: ARTIFACT_READ_SCHEMA,
  },
  {
    name: ARTIFACT_PATCH_TOOL,
    description:
      "Revise the same saved research report without resending its whole body. Supply id, expectedRevision and only changed text/fields. Markdown edits are atomic; body, citations and sources are otherwise preserved. Correct the opening summary and detailed evidence together when a conclusion changes. Review source evidence before status=ready; saved-artifact reads do not count as evidence. No Zotero write approval is needed. Use artifact_upsert for a complete replacement or a new artifact.",
    inputSchema: ARTIFACT_PATCH_SCHEMA,
  },
];

export interface ArtifactPatchArgs {
  id: string;
  expectedRevision: number;
  edits?: Array<{ oldText: string; newText: string }>;
  title?: string;
  status?: "draft" | "ready";
  citations?: Citation[];
}

/** Match all spans in the same snapshot: replacement text is never another edit's target. */
export function patchArtifactInput(
  artifact: ArtifactRecord,
  args: ArtifactPatchArgs,
): ArtifactUpsertInput {
  if (
    !args.edits?.length &&
    args.title === undefined &&
    args.status === undefined &&
    args.citations === undefined
  )
    throw new Error(
      "Supply edits, title, status or citations. To finalize an unchanged reviewed draft, supply status=ready.",
    );
  let body: ArtifactBody = artifact.body;
  if (args.edits?.length) {
    if (body.type !== "markdown")
      throw new Error(
        "Text edits require a Markdown report. Use artifact_upsert to replace a structured body under the same id.",
      );
    const text =
      body.type === "markdown"
        ? markdownForDisplay(body, artifact.citations)
        : "";
    const spans = args.edits
      .map((edit, index) => {
        const start = text.indexOf(edit.oldText);
        if (start < 0 || text.indexOf(edit.oldText, start + 1) >= 0)
          throw new Error(
            `Edit ${index + 1}: oldText must match exactly once in revision ${artifact.revision}. Copy a unique span from artifact_read; no edits were saved.`,
          );
        return { start, end: start + edit.oldText.length, text: edit.newText };
      })
      .sort((a, b) => a.start - b.start);
    if (
      spans.some(
        (span, index) => index > 0 && spans[index - 1].end > span.start,
      )
    )
      throw new Error(
        "Edits overlap. Combine them into one replacement of the overlapping passage; no edits were saved.",
      );
    let markdown = text;
    for (const span of spans.reverse())
      markdown =
        markdown.slice(0, span.start) + span.text + markdown.slice(span.end);
    body = { ...body, markdown };
  }
  return {
    id: artifact.id,
    taskId: artifact.taskId,
    kind: artifact.kind,
    title: args.title ?? artifact.title,
    body,
    status:
      args.status ??
      (artifact.status === "committed" ? "ready" : artifact.status),
    citations: args.citations ?? artifact.citations,
    sourceContextIds: artifact.sourceContextIds,
  };
}

export function readArtifactPart(
  artifact: ArtifactRecord,
  args: Record<string, unknown>,
  outputBudgetTokens?: number,
) {
  const part = args.part === "citations" ? "citations" : "body";
  const text =
    part === "citations"
      ? JSON.stringify(artifact.citations, null, 2)
      : artifact.body.type === "markdown"
        ? markdownForDisplay(artifact.body, artifact.citations)
        : JSON.stringify(artifact.body, null, 2);
  const offset = Number(args.offset ?? 0);
  if (offset > text.length)
    throw new Error(
      `offset exceeds the current ${part} length (${text.length}); read from offset=0.`,
    );
  const end = Math.min(text.length, offset + Number(args.limit ?? 8000));
  const safeEnd = /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") ? end - 1 : end;
  const slice = contextTextSlice(
    text.slice(0, safeEnd),
    outputBudgetTokens ?? Infinity,
    offset,
  );
  const next = slice.nextOffset ?? safeEnd;
  return {
    artifact: {
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      status: artifact.status,
      revision: artifact.revision,
    },
    part,
    format:
      part === "body" && artifact.body.type === "markdown"
        ? "markdown"
        : "json",
    content: slice.content,
    offset,
    totalChars: text.length,
    nextOffset: next < text.length ? next : null,
    citationCount: artifact.citations.length,
  };
}

export function artifactPatchReceipt(
  artifact: ArtifactRecord,
  args: Record<string, unknown>,
) {
  return {
    artifact: {
      id: artifact.id,
      taskId: artifact.taskId,
      kind: artifact.kind,
      title: artifact.title,
      status: artifact.status,
      revision: artifact.revision,
    },
    citationCount: artifact.citations.length,
    contentStored: true,
    appliedEditCount: Array.isArray(args.edits) ? args.edits.length : 0,
  };
}
