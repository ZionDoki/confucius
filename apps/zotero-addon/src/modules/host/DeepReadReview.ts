import type {
  ArtifactRecord,
  ConfuciusEvent,
  ExecutionBinding,
} from "@confucius/protocol";

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
      ? "Call get_annotations for this paper's PDF attachment to review its saved comments. Updating a comment does not replace this read."
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
} {
  if (
    !artifact ||
    !execution ||
    artifact.execution?.runId !== execution.runId ||
    artifact.execution.intentRevision !== execution.intentRevision ||
    artifact.execution.sourceFingerprint !== execution.sourceFingerprint
  )
    return { state: "draft_required", missingReads: [] };
  // A completed report may be edited without restarting its evidence pass.
  if (artifact.status !== "draft")
    return { state: "reviewed", missingReads: [] };
  // Runtime tool events and host artifact events can use different clocks.
  // Their durable arrival order, not timestamp subtraction, establishes reads
  // after the exact saved revision (and survives checkpoint restoration).
  const savedIndex = events.findLastIndex((event) => {
    const saved =
      event.type === "artifact_upserted"
        ? event.payload.artifact
        : event.type === "tool_result" &&
            event.payload.result.ok &&
            ["artifact_upsert", "artifact_patch"].includes(
              event.payload.result.toolName,
            )
          ? (
              event.payload.result.data as
                { artifact?: { id: string; revision: number } } | undefined
            )?.artifact
          : undefined;
    return saved?.id === artifact.id && saved.revision === artifact.revision;
  });
  if (savedIndex < 0)
    return {
      state: "evidence_required",
      missingReads: ["get_pages", "get_annotations"],
    };
  // Tools accept either a bibliographic item or its PDF attachment key. Learn
  // that relationship from actual tool results, not from model-authored text.
  const sourceRefs = new Set(artifact.sourceContextIds);
  for (const citation of artifact.citations)
    sourceRefs.add(`item:${citation.itemLibraryID}:${citation.itemKey}`);
  for (const event of events) {
    if (
      event.type !== "tool_result" ||
      !event.payload.result.ok ||
      !["get_pages", "inspect_pdf_page", "get_annotations"].includes(
        event.payload.result.toolName,
      )
    )
      continue;
    const data = event.payload.result.data as
      Record<string, unknown> | undefined;
    if (!data) continue;
    const refs = [data.itemKey, data.key, data.attachmentKey]
      .filter((key) => typeof key === "string")
      .map((key) => `item:${Number(data.libraryID)}:${key}`);
    if (refs.some((ref) => sourceRefs.has(ref)))
      for (const ref of refs) sourceRefs.add(ref);
  }
  let sourceRead = false;
  let annotationsRead = false;
  for (const event of events.slice(savedIndex + 1)) {
    if (event.type !== "tool_result") continue;
    const result = event.payload.result;
    if (!result.ok || !result.data || typeof result.data !== "object") continue;
    const data = result.data as Record<string, unknown>;
    const libraryID = Number(data.libraryID);
    const keys = [data.itemKey, data.key, data.attachmentKey].filter(
      (x) => typeof x === "string",
    );
    const sameSource = keys.some((key) =>
      sourceRefs.has(`item:${libraryID}:${key}`),
    );
    if (!sameSource) continue;
    if (result.toolName === "get_annotations") annotationsRead = true;
    if (
      result.toolName === "get_pages" &&
      Array.isArray(data.pages) &&
      data.pages.some(
        (page) =>
          page &&
          typeof page === "object" &&
          typeof page.text === "string" &&
          page.text.trim(),
      )
    )
      sourceRead = true;
    if (
      result.toolName === "inspect_pdf_page" &&
      (data.visualAvailable === true ||
        (Array.isArray(data.lineAnchors) && data.lineAnchors.length > 0))
    )
      sourceRead = true;
  }
  const missingReads: ("get_pages" | "get_annotations")[] = [];
  if (!sourceRead) missingReads.push("get_pages");
  if (!annotationsRead) missingReads.push("get_annotations");
  return {
    state: missingReads.length ? "evidence_required" : "reviewed",
    missingReads,
  };
}
