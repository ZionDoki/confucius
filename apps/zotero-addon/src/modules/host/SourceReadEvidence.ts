import type {
  ArtifactRecord,
  ConfuciusEvent,
  SourceReadEvidence,
  ToolResult,
} from "@confucius/protocol";

/** Accept structured content only. An archive reference is not a source read. */
export function sourceReadEvidence(
  result: ToolResult,
  args: Record<string, unknown> = {},
): SourceReadEvidence | undefined {
  if (!result.ok || !result.data || typeof result.data !== "object") return;
  const data = result.data as Record<string, unknown>;
  if (data.archivedRef) return;
  const libraryID = data.libraryID;
  const keys = [data.itemKey, data.key, data.attachmentKey].filter(
    (key): key is string => typeof key === "string" && !!key,
  );
  if (!Number.isSafeInteger(libraryID) || !keys.length) return;
  const source = {
    libraryID: libraryID as number,
    keys: [...new Set(keys)],
    attachmentKey:
      typeof data.attachmentKey === "string" ? data.attachmentKey : undefined,
  };
  if (result.toolName === "get_pages") {
    if (
      !Array.isArray(data.pages) ||
      !data.pages.some(
        (page) => typeof page?.text === "string" && page.text.trim(),
      )
    )
      return;
    return { ...source, toolName: result.toolName, sourceContent: true };
  }
  if (result.toolName === "inspect_pdf_page") {
    // A visualAvailable flag alone is not proof that an image reached the model.
    if (
      !(Array.isArray(data.lineAnchors) && data.lineAnchors.length) &&
      !result.transientMedia?.length
    )
      return;
    return { ...source, toolName: result.toolName, sourceContent: true };
  }
  if (
    result.toolName !== "get_annotations" ||
    data.truncated === true ||
    !Array.isArray(data.annotations)
  )
    return;
  const offset = Number(data.offset ?? args.offset ?? 0);
  const count = data.annotations.length;
  const total = Number(data.totalAnnotations ?? count);
  const nextOffset = data.nextOffset ?? null;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(total) ||
    total < offset + count ||
    (nextOffset !== null &&
      (!Number.isSafeInteger(nextOffset) || nextOffset !== offset + count))
  )
    return;
  return {
    ...source,
    toolName: "get_annotations",
    annotations: {
      offset,
      count,
      total,
      nextOffset: nextOffset as number | null,
      snapshot: typeof data.snapshot === "string" ? data.snapshot : undefined,
      filtered: data.filtered === true || Array.isArray(args.batchIds),
    },
  };
}

export function savedArtifactIndex(
  artifact: Pick<ArtifactRecord, "id" | "revision">,
  events: readonly ConfuciusEvent[],
): number {
  return events.findLastIndex((event) => {
    const saved =
      event.type === "artifact_upserted"
        ? event.payload.artifact
        : event.type === "tool_result" &&
            event.payload.result.ok &&
            ["artifact_upsert", "artifact_patch"].includes(
              event.payload.result.toolName,
            )
          ? (
              event.payload.result.data as {
                artifact?: { id: string; revision: number };
              }
            )?.artifact
          : undefined;
    return saved?.id === artifact.id && saved.revision === artifact.revision;
  });
}

/** Bind delivery to the revision preceding the original call, not a later replay. */
export function sourceReviewBinding(
  artifact: ArtifactRecord | undefined,
  callId: string,
  events: readonly ConfuciusEvent[],
): { artifactId: string; revision: number } | undefined {
  if (!artifact || artifact.status !== "draft") return;
  const savedIndex = savedArtifactIndex(artifact, events);
  if (savedIndex < 0) return;
  const requestedIndex = events.findIndex(
    (event) =>
      event.type === "tool_requested" && event.payload.callId === callId,
  );
  const resultIndex = events.findIndex(
    (event) =>
      event.type === "tool_result" &&
      event.payload.callId === callId &&
      event.payload.result.ok,
  );
  if (requestedIndex <= savedIndex || resultIndex <= savedIndex) return;
  return { artifactId: artifact.id, revision: artifact.revision };
}
