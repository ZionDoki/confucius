import type { ArtifactKind } from "./research";
import { taskTemplate } from "./templates";

export interface ArtifactPromptRef {
  id: string;
  kind: ArtifactKind | string;
  title: string;
  revision?: number;
}

export interface ArtifactUpsertGuidanceInput {
  templateId?: string;
  artifacts?: readonly ArtifactPromptRef[];
}

export const MCP_TASK_GATEWAY_INSTRUCTIONS =
  "Use Zotero sources as evidence. Call artifact_upsert only to save a cited research file, not for ordinary replies. Zotero writes require user approval.";

/**
 * Artifacts are explicit research products, not a receipt for every turn.
 * Native, Codex/Kimi, and MCP hosts should share this wording.
 */
export function artifactUpsertGuidance(
  input: ArtifactUpsertGuidanceInput = {},
): string {
  const lines = [
    "Call artifact_upsert only to save a cited research file (deep_read, evidence_audit, literature_map, triage_table, note_draft, annotation_set, collection_diff, citation_list, or a cited report).",
    "Leave clarifications, status updates, short answers, and tool-only turns in the conversation. Do not save an ordinary reply as an artifact.",
    "For a new artifact, omit id and taskId; the host assigns them. To revise an artifact, copy its returned id from this task. Artifact saves do not require Zotero write approval; an invalid id must be corrected, not reapproved.",
    "Use artifact_patch with expectedRevision for focused corrections to a saved Markdown report; send only changed passages and fields. Omitted citations and sources are preserved. Use artifact_read when the current text or revision is missing or stale; do not read a report already supplied in review inputs. Batch linked corrections, including the opening overview and its evidence, into one atomic patch. Use artifact_upsert for a new artifact or a complete replacement.",
    "For a Markdown research report, start with a one-minute overview INSIDE the report: the research question, central method, main evidence-backed takeaway, and the most important limit or applicability condition. Then explain the method, decisive evidence with page citations, and material limitations. Keep the overview consistent with the detailed evidence when revising. Prefer a compact evidence table for exact results, denominators and baselines; do not repeat the same statistics throughout the report. Respect the user's requested format, length and configured response language.",
  ];

  const template = taskTemplate(input.templateId);
  if (template && template.id !== "freeform") {
    const products = [
      template.artifactKind,
      ...(template.additionalArtifactKinds ?? []),
    ];
    lines.push(
      `This task uses the "${template.title}" template. For that output, call artifact_upsert for ${products.map((kind) => `kind ${kind}`).join(" and ")}. Follow-ups and clarifications do not need an artifact.`,
    );
  }

  const artifacts = input.artifacts ?? [];
  if (artifacts.length > 0) {
    lines.push("Saved files in this task:");
    for (const artifact of artifacts) {
      const revision =
        typeof artifact.revision === "number" ? `r${artifact.revision}` : "r1";
      lines.push(
        `- ${artifact.id} (${artifact.kind}, ${revision}): ${artifact.title}`,
      );
    }
    lines.push(
      "To revise a file, use artifact_patch with its id and current revision; call artifact_upsert with its id only for a complete replacement. Create a new artifact only when the user asks for a separate file.",
    );
  }

  lines.push(
    "After creating or revising an artifact, state what changed briefly and point to the saved report. Put the overview and full content in the artifact, without duplicating the report in chat.",
  );
  return lines.join("\n");
}
