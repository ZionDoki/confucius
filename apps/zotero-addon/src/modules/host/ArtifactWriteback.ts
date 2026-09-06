import type {
  ArtifactBody,
  ArtifactWriteback,
  CollectionDiffArtifactBody,
} from "@confucius/protocol";

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
  const key =
    data?.attachmentKey ?? data?.key ?? operation?.context.plannedKeys?.item;
  const libraryID = data?.libraryID ?? operation?.args.libraryID;
  const targetRef =
    typeof data?.targetRef === "string"
      ? data.targetRef
      : key && libraryID
        ? `${libraryID}:${key}`
        : previous.targetRef;
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
