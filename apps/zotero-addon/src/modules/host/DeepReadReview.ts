import type {
  ArtifactRecord,
  ConfuciusEvent,
  ExecutionBinding,
  SourceReadEvidence,
} from "@confucius/protocol";
import { savedArtifactIndex, sourceReadEvidence } from "./SourceReadEvidence";

export const DEEP_READ_REVIEW_INSTRUCTION = [
  "The deep_read report is saved as a draft. Review its evidence before setting status=ready under the same artifact id.",
  "Retrieve only the source pages for decisive empirical claims with get_pages or inspect_pdf_page, and use get_annotations to audit saved comments. These reads must occur AFTER saving the draft; sourcePages/pageInspections already supplied in review inputs count as retrieved evidence and should not be fetched again without a concrete gap. A notes/history summary is not source evidence. Follow nextOffset for unread saved comments.",
  "Check each reported number with its exact metric, denominator, experiment population, interval, baseline and scope. An observed maximum is not a configured limit. Separate author-stated results from your deductions; remove unsupported claims and redundant numbers.",
  "Audit method details and critical comments too. Do not expand a broad source term into specific mechanisms or procedures that were not reported. Missing details in the available material are uncertainty, not evidence that the authors ignored a metric or used a flawed baseline. Do not invent limitations to fill a quota. Preserve the meaning of actual saved comments in the appendix.",
  "Use the page image or spatial text to resolve table headers. If extraction is uncertain, keep only unambiguous prose aggregates and state the uncertainty; do not infer an author error.",
  "Correct saved comments with update_annotation_comment and preserve their keys. Use artifact_patch with the current expectedRevision to correct the report's overview and detailed evidence together, sending only changed passages with status=ready. If the report is already correct, send status=ready without resending its body or citations. Use artifact_read only when the current draft or revision is absent or stale; reading the artifact is not a source-evidence read. Keep all user-facing prose in the configured response language.",
].join("\n");

/** A durable source-read prerequisite, not an assertion of factual correctness. */
export function deepReadReviewState(
  artifact: ArtifactRecord | null,
  execution: ExecutionBinding | undefined,
  events: readonly ConfuciusEvent[],
): "draft_required" | "evidence_required" | "reviewed" {
  return deepReadReviewStatus(artifact, execution, events).state;
}

export function deepReadReviewNextAction(
  artifact: ArtifactRecord | null,
  execution: ExecutionBinding | undefined,
  events: readonly ConfuciusEvent[],
): string {
  const review = deepReadReviewStatus(artifact, execution, events);
  if (review.state !== "evidence_required") return DEEP_READ_REVIEW_INSTRUCTION;
  return [
    `Artifact ${artifact!.id}, draft revision ${artifact!.revision}: missing successful ${review.missingReads.join(" and ")} after this revision was saved.`,
    review.missingReads.includes("get_pages")
      ? "Read the source pages supporting the report with get_pages (or inspect_pdf_page)."
      : "The source-page read is already satisfied for this revision; do not repeat it unless you have an evidence gap.",
    review.missingReads.includes("get_annotations")
      ? `Call get_annotations for this paper's PDF attachment to review its saved comments. ${review.annotationHint ?? "Start at offset=0 without batchIds, and follow nextOffset until all saved comments have been delivered."} Updating a comment does not replace this read. An archivedRef alone is not delivered evidence; use a smaller get_annotations limit so the comments fit in the model input.`
      : "The saved-comment read is already satisfied for this revision.",
    "Keep the current draft. After the missing source reads, use ONE artifact_patch call with this id, expectedRevision and all needed edits plus status=ready. If no correction is needed, omit edits and just set status=ready. Do not resubmit the whole report. Saving another draft creates a new revision that needs another evidence pass.",
  ].join("\n");
}

function deepReadReviewStatus(
  artifact: ArtifactRecord | null,
  execution: ExecutionBinding | undefined,
  events: readonly ConfuciusEvent[],
): {
  state: "draft_required" | "evidence_required" | "reviewed";
  missingReads: ("get_pages" | "get_annotations")[];
  annotationHint?: string;
} {
  if (
    !artifact ||
    !execution ||
    artifact.execution?.runId !== execution.runId ||
    artifact.execution.intentRevision !== execution.intentRevision ||
    artifact.execution.sourceFingerprint !== execution.sourceFingerprint
  )
    return { state: "draft_required", missingReads: [] };
  if (artifact.status !== "draft")
    return { state: "reviewed", missingReads: [] };
  const savedIndex = savedArtifactIndex(artifact, events);
  const reads: SourceReadEvidence[] = [];
  const sourceRefs = new Set(artifact.sourceContextIds);
  for (const citation of artifact.citations)
    sourceRefs.add(`item:${citation.itemLibraryID}:${citation.itemKey}`);
  // Relationship evidence may precede the draft; content evidence may not.
  const relationships: SourceReadEvidence[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type === "source_read_delivered") {
      relationships.push(event.payload.evidence);
      if (
        index > savedIndex &&
        event.payload.review?.artifactId === artifact.id &&
        event.payload.review.revision === artifact.revision
      )
        reads.push(event.payload.evidence);
    } else if (event.type === "tool_result") {
      const request = events.find(
        (candidate) =>
          candidate.type === "tool_requested" &&
          candidate.payload.callId === event.payload.callId,
      );
      const evidence = sourceReadEvidence(
        event.payload.result,
        request?.type === "tool_requested" ? request.payload.args : undefined,
      );
      if (!evidence) continue;
      relationships.push(evidence);
    }
  }
  for (const evidence of relationships) {
    const refs = evidence.keys.map(
      (key) => `item:${evidence.libraryID}:${key}`,
    );
    if (refs.some((ref) => sourceRefs.has(ref)))
      for (const ref of refs) sourceRefs.add(ref);
  }
  let sourceRead = false;
  const comments = new Map<
    string,
    {
      total: number;
      snapshot?: string;
      ranges: Array<[number, number]>;
      terminal: boolean;
    }
  >();
  for (const evidence of reads) {
    if (
      !evidence.keys.some((key) =>
        sourceRefs.has(`item:${evidence.libraryID}:${key}`),
      )
    )
      continue;
    if (evidence.sourceContent) sourceRead = true;
    const page = evidence.annotations;
    if (!page || page.filtered) continue;
    const ref = `${evidence.libraryID}:${evidence.attachmentKey ?? evidence.keys[0]}`;
    let coverage = comments.get(ref);
    if (
      !coverage ||
      coverage.total !== page.total ||
      coverage.snapshot !== page.snapshot
    ) {
      coverage = {
        total: page.total,
        snapshot: page.snapshot,
        ranges: [],
        terminal: false,
      };
      comments.set(ref, coverage);
    }
    coverage.ranges.push([page.offset, page.offset + page.count]);
    coverage.terminal ||=
      page.nextOffset === null && page.offset + page.count === page.total;
  }
  let annotationsRead = false;
  let annotationHint: string | undefined;
  for (const [ref, coverage] of comments) {
    let offset = 0;
    for (const [start, end] of coverage.ranges.sort((a, b) => a[0] - b[0])) {
      if (start > offset) break;
      offset = Math.max(offset, end);
    }
    if (offset === coverage.total && coverage.terminal) annotationsRead = true;
    else
      annotationHint = `Saved comments for ${ref}: ${offset}/${coverage.total} delivered contiguously. Continue with offset=${offset}, without batchIds; follow nextOffset. If the snapshot changed, restart at offset=0.`;
  }
  const missingReads: ("get_pages" | "get_annotations")[] = [];
  if (!sourceRead) missingReads.push("get_pages");
  if (!annotationsRead) missingReads.push("get_annotations");
  return {
    state: missingReads.length ? "evidence_required" : "reviewed",
    missingReads,
    annotationHint,
  };
}
