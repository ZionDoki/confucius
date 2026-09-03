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
      operations: body.operations.filter(
        (operation) =>
          operation.op === "tag_add" || operation.op === "tag_remove",
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
