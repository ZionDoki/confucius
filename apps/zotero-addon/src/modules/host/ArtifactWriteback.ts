import type {
  ArtifactBody,
  ArtifactWriteback,
  ArtifactRecord,
  CollectionDiffArtifactBody,
} from "@confucius/protocol";

export function writebackAssociationKey(writeback: ArtifactWriteback): string {
  return writeback.target === "knowledge_base"
    ? `${writeback.target}:${writeback.targetRef?.split(":")[0] ?? ""}`
    : writeback.target;
}

export function artifactWritebackFor(
  artifact: ArtifactRecord,
  target: ArtifactWriteback["target"],
  knowledgeBaseId?: string,
): ArtifactWriteback | undefined {
  return [
    artifact.writeback,
    ...(artifact.writebacks ?? []).slice().reverse(),
  ].find(
    (entry) =>
      entry?.target === target &&
      (!knowledgeBaseId ||
        target !== "knowledge_base" ||
        entry.targetRef?.split(":")[0] === knowledgeBaseId),
  );
}
import {
  buildOpenPdfUri,
  buildSelectUri,
  mapMarkdownCitations,
  type Citation,
} from "@confucius/protocol";

/** Preserve report source links when exporting to Zotero notes or the knowledge base. */
export function markdownWithCitationLinks(
  markdown: string,
  citations: readonly Citation[],
  groupForLibrary: (libraryID: number) => number | undefined,
): string {
  return mapMarkdownCitations(markdown, (id, marker) => {
    const matches = citations.filter((citation) => citation.id === id);
    if (matches.length !== 1) return marker;
    const citation = matches[0];
    const groupID = groupForLibrary(citation.itemLibraryID);
    const href = citation.attachmentKey
      ? buildOpenPdfUri(citation.attachmentKey, {
          groupID,
          page: citation.page,
          annotationKey: citation.annotationKey,
        })
      : buildSelectUri(citation.itemKey, groupID);
    const label = (
      citation.title ||
      citation.section ||
      citation.itemKey
    ).replace(/[[\]\\]/g, " ");
    return `[${label}${citation.page ? `, p. ${citation.page}` : ""}](${href})`;
  });
}

export interface TagChange {
  libraryID: number;
  key: string;
  add: string[];
  remove: string[];
}

/** Aggregate tag edits per item; if a draft conflicts, its final operation wins. */
export function collectTagChanges(
  body: CollectionDiffArtifactBody,
): TagChange[] {
  const byItem = new Map<
    string,
    {
      libraryID: number;
      key: string;
      tags: Map<string, "add" | "remove">;
    }
  >();
  for (const operation of body.operations) {
    if (
      !operation.item ||
      !operation.value ||
      (operation.op !== "tag_add" && operation.op !== "tag_remove")
    ) {
      continue;
    }
    const id = `${operation.item.libraryID}:${operation.item.key}`;
    const change = byItem.get(id) ?? {
      ...operation.item,
      tags: new Map<string, "add" | "remove">(),
    };
    change.tags.set(
      operation.value,
      operation.op === "tag_add" ? "add" : "remove",
    );
    byItem.set(id, change);
  }
  return [...byItem.values()].map(({ libraryID, key, tags }) => ({
    libraryID,
    key,
    add: [...tags].filter(([, action]) => action === "add").map(([tag]) => tag),
    remove: [...tags]
      .filter(([, action]) => action === "remove")
      .map(([tag]) => tag),
  }));
}

/** Keep a before/after preview scoped to the target that will actually run. */
export function writebackBodyForTarget(
  body: ArtifactBody,
  target: ArtifactWriteback["target"],
): ArtifactBody {
  if (body.type !== "collection_diff") return body;
  if (target === "zotero_tags") {
    return {
      ...body,
      operations: collectTagChanges(body).flatMap(
        ({ libraryID, key, add, remove }) => [
          ...add.map((value) => ({
            op: "tag_add" as const,
            item: { libraryID, key },
            value,
          })),
          ...remove.map((value) => ({
            op: "tag_remove" as const,
            item: { libraryID, key },
            value,
          })),
        ],
      ),
    };
  }
  if (target === "zotero_collection") {
    return {
      ...body,
      operations: body.operations.filter(
        (operation) =>
          operation.op === "create" ||
          operation.op === "add" ||
          operation.op === "remove",
      ),
    };
  }
  return body;
}

/** Recover a UI approval interrupted before its writeback status was saved. */
export function recoverPendingWriteback(
  previous: ArtifactWriteback,
  operation: import("./ReliableToolProvider").OperationRecord | null,
): ArtifactWriteback {
  const result = operation?.result;
  const data = (result?.ok ? result.data : result?.details) as
    Record<string, unknown> | undefined;
  const state: ArtifactWriteback["state"] =
    result?.effect === "partial"
      ? "partial"
      : result?.effect === "unknown" ||
          (operation && !result) ||
          !previous.operationId
        ? "unknown"
        : result?.ok
          ? "committed"
          : result
            ? "failed"
            : "none";
  // A planned key is only a real note after Zotero confirmed the write. An
  // unknown outcome may still report ok, so require effect !== "unknown" to
  // match AgentHost's committed check.
  const created = result?.ok === true && result.effect !== "unknown";
  const plannedKey = operation?.context.plannedKeys?.item;
  const key =
    data?.attachmentKey ?? data?.key ?? (created ? plannedKey : undefined);
  const libraryID = data?.libraryID ?? operation?.args.libraryID;
  const plannedTargetRef =
    plannedKey && libraryID ? `${libraryID}:${plannedKey}` : undefined;
  const generatedTargetRef =
    typeof data?.targetRef === "string"
      ? data.targetRef
      : key && libraryID
        ? `${libraryID}:${key}`
        : undefined;
  // Only a committed write may promote its planned key to an existing target.
  // After a confirmed failure, drop a targetRef that only the old planned-key
  // fallback could have produced so the next preview creates the note again.
  const previousTargetRef =
    (state === "failed" || state === "none") &&
    previous.targetRef !== undefined &&
    previous.targetRef === plannedTargetRef
      ? undefined
      : previous.targetRef;
  const targetRef = generatedTargetRef ?? previousTargetRef;
  const legacyReceipts = (
    previous as ArtifactWriteback & {
      receipts?: Array<{ operationId?: string }>;
    }
  ).receipts;
  const operationIds = [
    ...new Set(
      [
        ...(previous.operationIds ?? []),
        ...(legacyReceipts ?? []).map((receipt) => receipt.operationId),
        previous.operationId,
        operation?.id,
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const recovered: ArtifactWriteback = {
    ...previous,
    state,
    targetRef,
    operationIds,
    error:
      state === "unknown"
        ? "Write outcome requires verification in Zotero; the old approval was not replayed"
        : state === "none"
          ? "Approval was interrupted before execution; review the preview again"
          : result && !result.ok
            ? result.message
            : undefined,
  };
  // Native outcomes live in OperationStore. The artifact keeps references,
  // while callers can project the current receipt when rendering details.
  delete (recovered as unknown as Record<string, unknown>).receipts;
  delete recovered.entries;
  return recovered;
}
