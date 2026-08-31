/**
 * Zotero keys are unique only inside a library. Confucius never addresses an
 * item by key alone.
 */
export interface ItemRef {
  libraryID: number;
  key: string;
}

export interface CollectionRef {
  libraryID: number;
  key: string;
}

export function itemRefKey(ref: ItemRef): string {
  return `${ref.libraryID}:${ref.key}`;
}

export function parseItemRefKey(value: string): ItemRef | null {
  const sep = value.indexOf(":");
  if (sep <= 0 || sep === value.length - 1) {
    return null;
  }
  const libraryID = Number(value.slice(0, sep));
  const key = value.slice(sep + 1);
  if (!Number.isInteger(libraryID) || libraryID < 0 || !key) {
    return null;
  }
  return { libraryID, key };
}
