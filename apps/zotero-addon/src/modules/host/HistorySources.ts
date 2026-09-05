import type { LockedContextSnapshot } from "@confucius/protocol";

/** Preserve identifiers actually present in a result, including recalled provenance.
 * An uncited answer is not evidence for a paper merely because that paper was selected.
 */
export function historySourceRefs(
  context?: LockedContextSnapshot,
  evidence?: unknown,
): string[] {
  const refs = new Set<string>();
  const add = (libraryID: unknown, key: unknown) => {
    if (
      Number.isInteger(libraryID) &&
      Number(libraryID) >= 0 &&
      typeof key === "string" &&
      /^[\w-]+$/.test(key)
    )
      refs.add(`${libraryID}:${key}`);
  };
  for (const item of context?.items ?? []) {
    add(item.libraryID, item.key);
    add(item.libraryID, item.attachmentKey);
  }
  if (context?.reader) {
    add(context.reader.libraryID, context.reader.parentKey);
    add(context.reader.libraryID, context.reader.attachmentKey);
  }
  const seen = new WeakSet<object>();
  function visit(value: unknown): void {
    if (typeof value === "string") {
      // Zotero item keys contain eight uppercase letters/digits. Requiring the
      // key length avoids interpreting timestamps and ratios as citations.
      for (const match of value.matchAll(/\b(\d+):([A-Z0-9]{8})\b/g))
        add(Number(match[1]), match[2]);
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          visit(JSON.parse(trimmed));
        } catch {
          /* Ordinary text. */
        }
      }
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["key", "itemKey", "attachmentKey", "parentKey"])
      add(record.libraryID, record[key]);
    // Host provenance can also contain shorter fixture or legacy identifiers.
    if (Array.isArray(record.sourceIds))
      for (const source of record.sourceIds) {
        const match =
          typeof source === "string" ? source.match(/^(\d+):([\w-]+)$/) : null;
        if (match) add(Number(match[1]), match[2]);
      }
    Object.values(record).forEach(visit);
  }
  visit(evidence);
  return [...refs];
}
