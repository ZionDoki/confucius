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
  templateVersion?: number;
  reportArtifactId?: string;
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
    "Use artifact_patch with expectedRevision for focused corrections to a saved Markdown report; send only changed passages and fields. Omitted citations, sources, readingGuide and report markdown are preserved. readingGuide replaces the structured guide; reportMarkdown initializes/replaces the report; edits modify only report text. Use artifact_read(part=guide) to read only the companion guide. Use artifact_read when the current text or revision is missing or stale; do not read a report already supplied in review inputs. Batch linked corrections, including the opening overview and its evidence, into one atomic patch. Use artifact_upsert for a new artifact or a complete replacement.",
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
  if (
    template?.id === "deep-read" &&
    !input.reportArtifactId &&
    (input.templateVersion ?? 3) >= 3
  ) {
    lines.push(
      'Deliver ONE deep_read artifact. For new deep_read, deliver a reading companion FIRST: body:{type:"markdown",markdown:"",readingGuide:{version:1,overview,checkpoints:[...],annotationsMarkdown}}. Do not generate a research report until requested. Save status=draft, reread decisive source pages and actual annotations AFTER that save, then revise the SAME artifact atomically with status=ready. A reviewed guide is the complete initial deliverable.',
      "Follow the article order: brief signposts explain what ordinary paragraph groups do; demanding checkpoints use question titles. Every route entry has a stable id, kind (signpost/checkpoint), title, before (short reading cue), after (short transition), citationIds referencing the shared citations. A checkpoint also requires reading (concepts, steps, evidence) and writing (actual sentence/paragraph roles, transitions and argument organization). Include both lenses initially. Optional section, further (intermediate steps, small examples, prerequisites), question and hint support deeper understanding. Use the original language for verbatim citation quotes and the configured language for explanations. Size and density follow content difficulty, not page counts or quotas.",
      "The companion is a continuous article, following the paper's layout. Keep overview to two or three plain sentences. Each signpost/before cue uses one or two short sentences to say what this part does, like 'This part introduces ...', without retelling it. Checkpoints pair a short, continuous original excerpt with a focused explanation; explain only what the reader needs here, usually one to three short paragraphs. Put lengthy derivations in optional further, and writing analysis in a concise optional note. Avoid a mini report at every checkpoint, repeated summaries, dense bullet lists, navigation instructions and interface terminology. Let whitespace separate ideas; do not manufacture checkpoints or optional questions to fill a template.",
      "Keep author statements, established evidence and explanatory inference distinct. Do not fabricate proof steps, derivations, experiments or limitations. Put actual saved annotations and incomplete outcomes in readingGuide.annotationsMarkdown, using a citation marker for each saved mark with its real annotationKey and physical page. Detailed explanations belong in the guide, brief comments on the PDF. Both views share one citations array; preserve all guide and report references when revising. Stable checkpoint IDs survive edits. Never include private checkpoint discussions in artifacts or task memory.",
    );
  } else if (input.reportArtifactId) {
    lines.push(
      `Explicit report request for artifact ${input.reportArtifactId}: use artifact_patch with reportMarkdown and status=draft, read decisive source pages and saved annotations AFTER saving, then correct and mark the same artifact ready. Preserve readingGuide. Include a one-minute overview, method, key evidence table and material boundaries, avoiding duplicated paragraph-by-paragraph explanations. Do not create another artifact or annotations. Private reading discussions are unavailable and must not enter this report.`,
    );
  } else if (template?.id === "deep-read") {
    lines.push(
      'Save the first deep_read with status="draft". Then retrieve the decisive source pages and saved comments once, AFTER that save; reads made before saving the draft do not meet this prerequisite. Use the supplied post-save review inputs directly, correct concrete issues, and send one artifact_patch with status="ready". Do not request ready first and wait for the host to reject it.',
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
