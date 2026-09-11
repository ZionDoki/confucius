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
    "For a Markdown research report, start with a one-minute overview INSIDE the report: the research question, central method, main evidence-backed takeaway, and the most important limit or applicability condition. Then explain the method, decisive evidence with page citations, and material limitations. Keep the overview consistent with the detailed evidence when revising. Prefer a compact evidence table for exact results, denominators and baselines; do not repeat the same statistics throughout the report. Scale length and the number of limitations to available evidence. Do not expand broad source terms into unsupported implementation details or treat an unreported detail as an author mistake. Respect the user's requested format, length and configured response language.",
    'Use inline [cite:e1] markers in prose, including the opening overview, linked to citations:[{"id":"e1","itemLibraryID":1,"itemKey":"SOURCE_KEY","attachmentKey":"PDF_KEY","page":3,"quote":"verbatim evidence"}]. Copy source keys and physical pages from tools; include title when known and annotationKey only for an actual saved mark. The reader renders these as clickable source components. Bare [page 3] text cannot locate a source. Every marker must resolve to exactly one citation. For sources available only as abstracts, identify that limit and link the library item without inventing PDF pages.',
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
  if (template?.id === "deep-read") {
    lines.push(
      'Save a readable deep_read with status="ready"; draft is for unfinished content. Consult source evidence and actual saved comments as needed, reusing retrieved material. There is no post-draft reading prerequisite or quality verdict to obtain. The host may make one direct improvement pass with the current model and remaining budget; do not grade, re-review or loop until approval. ready means deliverable, not certified correct.',
      'Deliver ONE deep_read artifact. Include the annotation explanations and source links in an appendix of this report, distinguishing saved, skipped, denied and unresolved marks from actual receipts; do not create a separate annotation_set or summary artifact unless the user explicitly requests a separate file. Each saved annotation listed in the appendix needs its own inline [cite:a1] marker and matching citation with the actual attachmentKey, physical page and annotationKey. A raw URI or an annotation ID in backticks is not a clickable component. Keep tool receipts and identifiers out of the prose. End the same report with a short "导读 Map" / "Reading map": problem → method → evidence → limits. In two to four plain-language sentences, say "This paper tries to solve … [cite:problem]; it does so by … [cite:method]" in the configured language, explaining the method as concrete steps understandable without specialist knowledge, then give the supported takeaway and main boundary with citations. Avoid repeating the statistics table. This is a reading guide, not an invented mathematical formula.',
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
