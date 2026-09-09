import type { ArtifactBody, Citation } from "./research";
import { mapMarkdownCitations } from "./markdown";

export type ReadingView = "guide" | "report";
export interface ReadingCheckpoint {
  id: string;
  kind: "signpost" | "checkpoint";
  section?: string;
  title: string;
  before: string;
  after: string;
  citationIds: string[];
  /** Markdown explanations; quotations live in the shared citations. */
  reading?: string;
  writing?: string;
  further?: string;
  question?: string;
  hint?: string;
}

export interface ReadingGuide {
  version: 1;
  overview: string;
  checkpoints: ReadingCheckpoint[];
  /** Actual saved comments, source links, and unresolved annotation outcomes. */
  annotationsMarkdown?: string;
}

export interface ReadingState {
  view: ReadingView;
  checkpointId?: string;
  checkpointOffset?: number;
  discussionCheckpointId?: string;
  quote?: { checkpointId: string; text: string } | null;
  lens: "reading" | "writing";
  expanded: Record<string, boolean>;
  drafts: Record<string, string>;
}

const text = { type: "string", minLength: 1, pattern: "\\S" };
export const READING_GUIDE_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "integer", const: 1 },
    overview: text,
    checkpoints: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { ...text, pattern: "^[a-zA-Z0-9_-]+$" },
          kind: { type: "string", enum: ["signpost", "checkpoint"] },
          section: { type: "string" },
          title: text,
          before: text,
          after: text,
          citationIds: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: text,
          },
          reading: text,
          writing: text,
          further: text,
          question: text,
          hint: text,
        },
        required: ["id", "kind", "title", "before", "after", "citationIds"],
        additionalProperties: false,
      },
    },
    annotationsMarkdown: { type: "string" },
  },
  required: ["version", "overview", "checkpoints"],
  additionalProperties: false,
};

export function isReadingGuide(value: unknown): value is ReadingGuide {
  if (!value || typeof value !== "object") return false;
  const guide = value as ReadingGuide;
  const nonempty = (v: unknown): v is string =>
    typeof v === "string" && !!v.trim();
  return (
    guide.version === 1 &&
    nonempty(guide.overview) &&
    (guide.annotationsMarkdown === undefined ||
      typeof guide.annotationsMarkdown === "string") &&
    Array.isArray(guide.checkpoints) &&
    guide.checkpoints.length > 0 &&
    new Set(guide.checkpoints.map((cp) => cp?.id)).size ===
      guide.checkpoints.length &&
    guide.checkpoints.every(
      (cp) =>
        cp &&
        nonempty(cp.id) &&
        /^[\w-]+$/.test(cp.id) &&
        ["signpost", "checkpoint"].includes(cp.kind) &&
        [cp.title, cp.before, cp.after].every(nonempty) &&
        (cp.section === undefined || typeof cp.section === "string") &&
        [cp.reading, cp.writing, cp.further, cp.question, cp.hint].every(
          (v) => v === undefined || nonempty(v),
        ) &&
        (cp.kind !== "checkpoint" ||
          (nonempty(cp.reading) && nonempty(cp.writing))) &&
        Array.isArray(cp.citationIds) &&
        cp.citationIds.length > 0 &&
        cp.citationIds.every(nonempty) &&
        new Set(cp.citationIds).size === cp.citationIds.length,
    )
  );
}

export function guideFromBody(body: ArtifactBody): ReadingGuide | undefined {
  return body.type === "markdown" ? body.readingGuide : undefined;
}

/** Validate all references, including prose inside an expanded checkpoint. */
export function readingCitationErrors(
  body: ArtifactBody,
  citations: readonly Citation[],
): string[] {
  if (body.type !== "markdown") return [];
  const errors = new Set<string>();
  const check = (id: string) => {
    if (citations.filter((c) => c.id === id).length !== 1) errors.add(id);
  };
  const prose = [body.markdown];
  if (body.readingGuide) {
    prose.push(
      body.readingGuide.overview,
      body.readingGuide.annotationsMarkdown ?? "",
    );
    for (const cp of body.readingGuide.checkpoints) {
      cp.citationIds.forEach(check);
      for (const id of cp.citationIds) {
        const source = citations.find((c) => c.id === id);
        if (source && (!source.attachmentKey || !source.page))
          errors.add(id + " (PDF source required)");
      }
      prose.push(
        cp.title,
        cp.before,
        cp.after,
        cp.reading ?? "",
        cp.writing ?? "",
        cp.further ?? "",
        cp.question ?? "",
        cp.hint ?? "",
      );
    }
  }
  for (const markdown of prose)
    mapMarkdownCitations(markdown, (id, marker) => {
      check(id);
      return marker;
    });
  return [...errors];
}

/** A static export of the guide, never a projection of private discussions. */
export function readingGuideMarkdown(
  guide: ReadingGuide,
  citations: readonly Citation[],
  english = false,
): string {
  const lines = [guide.overview];
  for (const cp of guide.checkpoints) {
    lines.push(
      `## ${cp.section ? cp.section + " · " : ""}${cp.title}`,
      cp.before,
    );
    for (const id of cp.citationIds) {
      const source = citations.find((c) => c.id === id);
      if (source?.quote)
        lines.push(
          source.quote
            .split("\n")
            .map((line) => "> " + line)
            .join("\n"),
        );
      lines.push(`[cite:${id}]`);
    }
    if (cp.reading)
      lines.push(
        `### ${english ? "Understand this passage" : "读懂这段"}`,
        cp.reading,
      );
    if (cp.writing)
      lines.push(
        `### ${english ? "How the argument is written" : "看作者怎么写"}`,
        cp.writing,
      );
    if (cp.further) lines.push(cp.further);
    if (cp.question) lines.push(cp.question, cp.hint ?? "");
    lines.push(cp.after);
  }
  if (guide.annotationsMarkdown)
    lines.push(
      `## ${english ? "Saved annotations" : "原文批注"}`,
      guide.annotationsMarkdown,
    );
  return lines.filter(Boolean).join("\n\n");
}

export function readingBodyForView(
  body: ArtifactBody,
  citations: readonly Citation[],
  view?: ReadingView,
  english = false,
): ArtifactBody {
  if (body.type !== "markdown") return body;
  if (
    (view === "guide" || (!view && !body.markdown.trim())) &&
    body.readingGuide
  )
    return {
      type: "markdown",
      markdown: readingGuideMarkdown(body.readingGuide, citations, english),
    };
  return { type: "markdown", markdown: body.markdown };
}
