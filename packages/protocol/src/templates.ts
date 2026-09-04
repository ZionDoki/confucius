import type { ArtifactKind, LockedContextSnapshot } from "./research";

export type TaskTemplateId =
  | "deep-read"
  | "evidence-audit"
  | "related-work"
  | "paper-note"
  | "compare"
  | "triage"
  | "synthesis"
  | "literature-map"
  | "explain-selection"
  | "verify-claim"
  | "save-insight"
  | "selection-note"
  | "freeform";

export interface TaskTemplate {
  id: TaskTemplateId;
  title: string;
  description: string;
  artifactKind: ArtifactKind;
  additionalArtifactKinds?: ArtifactKind[];
  skillSlug?: string;
  source: "single" | "multi" | "selection" | "any";
  prompt: string;
}

export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    id: "deep-read",
    title: "Deep read",
    description:
      "Trace the question, method, evidence, limits, and implications.",
    artifactKind: "deep_read",
    additionalArtifactKinds: ["annotation_set"],
    skillSlug: "paper-deep-reading",
    source: "single",
    prompt:
      "Deep-read the locked paper. Plan the delivery details I want, then produce both a cited deep-reading report and a detailed annotation set. Use the default annotation legend unless I override its colors, meanings, method-section summary style, note voice, or focus.",
  },
  {
    id: "evidence-audit",
    title: "Evidence audit",
    description: "Separate claims from the evidence that supports them.",
    artifactKind: "evidence_audit",
    source: "single",
    prompt: "Audit the major claims in the locked paper against its evidence.",
  },
  {
    id: "related-work",
    title: "Related work",
    description: "Place one paper in its closest scholarly neighborhood.",
    artifactKind: "report",
    source: "single",
    prompt:
      "Map the locked paper to closely related work in this Zotero library.",
  },
  {
    id: "paper-note",
    title: "Paper note",
    description: "Draft a durable Zotero reading note.",
    artifactKind: "note_draft",
    source: "single",
    prompt: "Create a concise, cited reading-note draft for the locked paper.",
  },
  {
    id: "compare",
    title: "Compare",
    description: "Compare questions, methods, evidence, and conclusions.",
    artifactKind: "report",
    source: "multi",
    prompt:
      "Compare the locked sources across question, method, evidence, and conclusions.",
  },
  {
    id: "triage",
    title: "Triage",
    description: "Keep, review, or exclude each source with a reason.",
    artifactKind: "triage_table",
    skillSlug: "library-triage",
    source: "multi",
    prompt: "Triage every locked source and produce a decision table.",
  },
  {
    id: "synthesis",
    title: "Synthesis",
    description: "Synthesize consensus, disagreement, and open questions.",
    artifactKind: "report",
    source: "multi",
    prompt: "Synthesize the locked sources into a cited research report.",
  },
  {
    id: "literature-map",
    title: "Literature map",
    description: "Map conceptual and evidential relationships.",
    artifactKind: "literature_map",
    source: "multi",
    prompt: "Build a literature map from the locked sources.",
  },
  {
    id: "explain-selection",
    title: "Explain",
    description: "Explain the selected passage in its paper context.",
    artifactKind: "report",
    source: "selection",
    prompt:
      "Explain the locked passage in context, including any necessary definitions.",
  },
  {
    id: "verify-claim",
    title: "Verify claim",
    description:
      "Check whether the passage is supported by the cited evidence.",
    artifactKind: "evidence_audit",
    source: "selection",
    prompt:
      "Verify the claim in the locked passage against the paper and library evidence.",
  },
  {
    id: "save-insight",
    title: "Save insight",
    description: "Turn the passage into a reusable research insight.",
    artifactKind: "report",
    source: "selection",
    prompt: "Turn the locked passage into a concise, cited research insight.",
  },
  {
    id: "selection-note",
    title: "Selection note",
    description: "Draft a note anchored to the selected passage.",
    artifactKind: "note_draft",
    source: "selection",
    prompt: "Draft a Zotero note grounded in the locked passage.",
  },
  {
    id: "freeform",
    title: "Research task",
    description: "Start from the locked context with your own instruction.",
    artifactKind: "report",
    source: "any",
    prompt:
      "Research the user's request using only the locked Zotero context as the starting scope.",
  },
] as const;

/**
 * The three representative workflows shown in the workspace and slash menu.
 * Keep TASK_TEMPLATES complete so persisted tasks and legacy entry points can
 * continue resolving every historical template id.
 */
export const FEATURED_TASK_TEMPLATES: readonly TaskTemplate[] = [
  taskTemplateFromList("deep-read"),
  taskTemplateFromList("evidence-audit"),
  taskTemplateFromList("synthesis"),
];

function taskTemplateFromList(id: TaskTemplateId): TaskTemplate {
  const template = TASK_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) {
    throw new Error(`Missing task template: ${id}`);
  }
  return template;
}

export function templatesForContext(
  context: LockedContextSnapshot,
): TaskTemplate[] {
  const source = context.selection
    ? "selection"
    : context.items.length > 1 || context.collection || context.savedSearch
      ? "multi"
      : context.items.length === 1 || context.reader
        ? "single"
        : "any";
  return TASK_TEMPLATES.filter(
    (template) => template.source === source || template.source === "any",
  );
}

export function taskTemplate(id: unknown): TaskTemplate | undefined {
  return TASK_TEMPLATES.find((template) => template.id === id);
}

export interface TemplateContextValidation {
  ok: boolean;
  message?: string;
}

/** Validate a staged template at send time, after mention/context updates land. */
export function validateTemplateContext(
  template: TaskTemplate,
  context: LockedContextSnapshot,
): TemplateContextValidation {
  if (template.source === "any") return { ok: true };
  if (template.source === "selection") {
    return context.selection?.text.trim()
      ? { ok: true }
      : {
          ok: false,
          message:
            "This task needs a PDF text selection. The draft was kept so you can select text or update the task context and send again.",
        };
  }
  const itemKeys = new Set(
    context.items.map((item) => `${item.libraryID}:${item.key}`),
  );
  if (context.reader?.parentKey) {
    itemKeys.add(`${context.reader.libraryID}:${context.reader.parentKey}`);
  } else if (context.reader?.attachmentKey) {
    itemKeys.add(
      `${context.reader.libraryID}:attachment:${context.reader.attachmentKey}`,
    );
  }
  if (template.source === "single") {
    return itemKeys.size === 1
      ? { ok: true }
      : {
          ok: false,
          message:
            "This task needs exactly one paper. The draft was kept so you can update the task context and send again.",
        };
  }
  return itemKeys.size >= 2 ||
    Boolean(context.collection || context.savedSearch)
    ? { ok: true }
    : {
        ok: false,
        message:
          "This task needs multiple papers, a collection, or a saved search. The draft was kept so you can add sources and send again.",
      };
}
