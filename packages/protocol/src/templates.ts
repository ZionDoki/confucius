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
    title: "Paper review",
    description: "Set annotation colors, note style, or a focus in the prompt.",
    artifactKind: "deep_read",
    additionalArtifactKinds: ["annotation_set"],
    skillSlug: "paper-deep-reading",
    source: "single",
    prompt:
      "Review the paper attached to this task. Cover its question, method, evidence, assumptions, and limitations. Use the default annotation settings unless I specify changes here.",
  },
  {
    id: "evidence-audit",
    title: "Evidence audit",
    description:
      "Set a scope, evidence threshold, counterexample priority, or output format in the prompt.",
    artifactKind: "evidence_audit",
    source: "single",
    prompt:
      "Check the main claims in the task paper against its evidence. Use the full paper unless I specify a scope or output format here.",
  },
  {
    id: "related-work",
    title: "Related work",
    description: "Place one paper in its closest scholarly neighborhood.",
    artifactKind: "report",
    source: "single",
    prompt:
      "Find closely related work in this Zotero library for the task paper.",
  },
  {
    id: "paper-note",
    title: "Paper note",
    description: "Draft a cited Zotero reading note.",
    artifactKind: "note_draft",
    source: "single",
    prompt: "Draft a cited reading note for the task paper.",
  },
  {
    id: "compare",
    title: "Compare",
    description: "Compare questions, methods, evidence, and conclusions.",
    artifactKind: "report",
    source: "multi",
    prompt:
      "Compare the task sources by question, method, evidence, and conclusion.",
  },
  {
    id: "triage",
    title: "Triage",
    description: "Keep, review, or exclude each source with a reason.",
    artifactKind: "triage_table",
    skillSlug: "library-triage",
    source: "multi",
    prompt:
      "Classify each task source as keep, review, or exclude, and give a reason.",
  },
  {
    id: "synthesis",
    title: "Synthesis",
    description:
      "Set the question, source scope, treatment of disagreements, or output format in the prompt.",
    artifactKind: "report",
    source: "multi",
    prompt:
      "Write a cited report that synthesizes the task sources. Use the full source set unless I specify a question, scope, treatment of disagreements, or format here.",
  },
  {
    id: "literature-map",
    title: "Literature map",
    description: "Map conceptual and evidential relationships.",
    artifactKind: "literature_map",
    source: "multi",
    prompt: "Build a literature map from the task sources.",
  },
  {
    id: "explain-selection",
    title: "Explain",
    description: "Explain the selected passage in its paper context.",
    artifactKind: "report",
    source: "selection",
    prompt:
      "Explain the selected passage in its paper context. Define terms when needed.",
  },
  {
    id: "verify-claim",
    title: "Verify claim",
    description:
      "Check whether the passage is supported by the cited evidence.",
    artifactKind: "evidence_audit",
    source: "selection",
    prompt:
      "Check the selected claim against evidence in the paper and Zotero library.",
  },
  {
    id: "save-insight",
    title: "Save insight",
    description: "Turn the passage into a reusable research insight.",
    artifactKind: "report",
    source: "selection",
    prompt: "Turn the selected passage into a cited research insight.",
  },
  {
    id: "selection-note",
    title: "Selection note",
    description: "Draft a note anchored to the selected passage.",
    artifactKind: "note_draft",
    source: "selection",
    prompt: "Draft a Zotero note based on the selected passage.",
  },
  {
    id: "freeform",
    title: "Research task",
    description: "Use the task sources with your own instruction.",
    artifactKind: "report",
    source: "any",
    prompt:
      "Research my request using the Zotero sources attached to this task.",
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

export type TemplateContextFailureReason =
  "selection_required" | "single_required" | "multi_required";

export type TemplateContextValidation =
  | { ok: true }
  | {
      ok: false;
      /** Stable code for hosts that localize the user-facing validation. */
      reason: TemplateContextFailureReason;
      /** English compatibility text for callers that do not localize yet. */
      message: string;
    };

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
          reason: "selection_required",
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
          reason: "single_required",
          message:
            "This task needs exactly one paper. The draft was kept so you can update the task context and send again.",
        };
  }
  return itemKeys.size >= 2 ||
    Boolean(context.collection || context.savedSearch)
    ? { ok: true }
    : {
        ok: false,
        reason: "multi_required",
        message:
          "This task needs multiple papers, a collection, or a saved search. The draft was kept so you can add sources and send again.",
      };
}
