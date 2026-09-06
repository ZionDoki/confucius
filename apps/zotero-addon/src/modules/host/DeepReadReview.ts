import type {
  ArtifactRecord,
  ConfuciusEvent,
  ExecutionBinding,
} from "@confucius/protocol";

export const DEEP_READ_REVIEW_INSTRUCTION = [
  "The deep_read report is saved as a draft. Review its evidence before setting status=ready under the same artifact id.",
  "Reread the source pages for the decisive empirical claims with get_pages or inspect_pdf_page, and read get_annotations to audit the saved comments. These reads must occur AFTER saving the draft; a notes/history summary is not source evidence.",
  "Check each reported number with its exact metric, denominator, experiment population, interval, baseline and scope. An observed maximum is not a configured limit. Separate author-stated results from your deductions; remove unsupported claims and redundant numbers.",
  "Use the page image or spatial text to resolve table headers. If extraction is uncertain, keep only unambiguous prose aggregates and state the uncertainty; do not infer an author error.",
  "Correct saved comments with update_annotation_comment, preserve their keys, then save the corrected report as ready. Keep all user-facing prose in the configured response language.",
].join("\n");

/** A durable source-read prerequisite, not an assertion of factual correctness. */
export function deepReadReviewState(
  artifact: ArtifactRecord | null,
  execution: ExecutionBinding | undefined,
  events: readonly ConfuciusEvent[],
): "draft_required" | "evidence_required" | "reviewed" {
  if (
    !artifact ||
    !execution ||
    artifact.execution?.runId !== execution.runId ||
    artifact.execution.intentRevision !== execution.intentRevision ||
    artifact.execution.sourceFingerprint !== execution.sourceFingerprint
  )
    return "draft_required";
  // A completed report may be edited without restarting its evidence pass.
  if (artifact.status !== "draft") return "reviewed";
  // Runtime tool events and host artifact events can use different clocks.
  // Their durable arrival order, not timestamp subtraction, establishes reads
  // after the exact saved revision (and survives checkpoint restoration).
  const savedIndex = events.findLastIndex((event) => {
    const saved =
      event.type === "artifact_upserted"
        ? event.payload.artifact
        : event.type === "tool_result" &&
            event.payload.result.ok &&
            event.payload.result.toolName === "artifact_upsert"
          ? (
              event.payload.result.data as
                { artifact?: { id: string; revision: number } } | undefined
            )?.artifact
          : undefined;
    return saved?.id === artifact.id && saved.revision === artifact.revision;
  });
  if (savedIndex < 0) return "evidence_required";
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
  return sourceRead && annotationsRead ? "reviewed" : "evidence_required";
}
