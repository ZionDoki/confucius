import { canonical } from "./ReliableToolProvider";
import { itemVersion } from "../tools/ZoteroToolHost";
import type { CollectionDiffArtifactBody } from "@confucius/protocol";

export interface WritebackSnapshot {
  items: Array<{ libraryID: number; key: string; version: string }>;
  collection?: { libraryID: number; key: string; version: string };
  scope?: {
    target: "zotero_tags" | "zotero_collection";
    body: CollectionDiffArtifactBody;
  };
}

function collectionVersion(collection: Zotero.Collection): string {
  return canonical({
    data: collection.toJSON(),
    items: collection.getChildItems(true),
  });
}

/** Capture the exact objects the user is approving, before displaying approval. */
export function captureWritebackSnapshot(
  refs: Array<{ libraryID: number; key: string }>,
  collectionRef?: { libraryID: number; key: string },
  scope?: WritebackSnapshot["scope"],
): WritebackSnapshot {
  const items = refs.map((ref) => {
    if ((Zotero.Libraries.get(ref.libraryID) || undefined)?.editable === false)
      throw new Error("Zotero library is read-only");
    const item = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.key);
    if (!item)
      throw new Error(`Item ${ref.libraryID}:${ref.key} was not found`);
    let version = itemVersion(item);
    if (scope?.target === "zotero_tags") {
      const tags = new Set(item.getTags().map((tag) => tag.tag));
      const affected = scope.body.operations
        .filter(
          (entry) =>
            entry.item?.libraryID === ref.libraryID &&
            entry.item.key === ref.key &&
            ["tag_add", "tag_remove"].includes(entry.op),
        )
        .map((entry) => entry.value!)
        .filter(Boolean);
      version = canonical(
        Object.fromEntries(affected.map((tag) => [tag, tags.has(tag)])),
      );
    } else if (scope?.target === "zotero_collection") {
      const target = collectionRef
        ? Zotero.Collections.getByLibraryAndKey(
            collectionRef.libraryID,
            collectionRef.key,
          )
        : null;
      version = canonical({
        member: target ? target.getChildItems(true).includes(item.id) : false,
      });
    }
    return {
      libraryID: ref.libraryID,
      key: ref.key,
      version,
    };
  });
  let collection: WritebackSnapshot["collection"];
  if (collectionRef) {
    if (
      (Zotero.Libraries.get(collectionRef.libraryID) || undefined)?.editable ===
      false
    )
      throw new Error("Zotero library is read-only");
    const value = Zotero.Collections.getByLibraryAndKey(
      collectionRef.libraryID,
      collectionRef.key,
    );
    if (!value) throw new Error("Explicit collection was not found");
    collection = {
      libraryID: collectionRef.libraryID,
      key: collectionRef.key,
      version: scope
        ? canonical({ libraryID: value.libraryID, key: value.key })
        : collectionVersion(value),
    };
  }
  return { items, collection, scope };
}

/** Run under the same resource lock and DB transaction as the approved write. */
export function verifyWritebackSnapshot(snapshot: WritebackSnapshot): void {
  const current = captureWritebackSnapshot(
    snapshot.items,
    snapshot.collection,
    snapshot.scope,
  );
  if (canonical(current) !== canonical(snapshot))
    throw new Error(
      "Zotero contents changed during approval; review the updated changes before saving",
    );
}
