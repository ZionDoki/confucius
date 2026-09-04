/**
 * One-line human summaries for approval cards: the tool plus the object it
 * acts on (a title, query, or name) — never raw JSON or a bare item key.
 * Pure; the caller injects a title resolver backed by Zotero.
 */

export interface SummaryItemLike {
  /** Resolved display title for the referenced item. */
  title: string;
}

export type TitleResolver = (
  libraryID: number,
  key: string,
) => SummaryItemLike | null | undefined;

const MAX_DETAIL = 60;

function clip(text: string, max = MAX_DETAIL): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function quoted(text: string): string {
  return `“${clip(text)}”`;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function itemCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Pick a display quote from a highlights/annotations array entry. */
function firstHighlightText(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }
  const entry = value[0] as {
    quote?: unknown;
    text?: unknown;
    comment?: unknown;
  } | null;
  if (!entry) {
    return "";
  }
  for (const field of [entry.quote, entry.text, entry.comment]) {
    if (typeof field === "string" && field.trim()) {
      return field.trim();
    }
  }
  return "";
}

/** Key-like fields that must never become the displayed object. */
const KEY_FIELDS = new Set([
  "key",
  "parentKey",
  "collectionKey",
  "attachmentKey",
  "annotationKey",
  "relatedKey",
  "knowledgeBaseId",
  "libraryID",
  "id",
]);

function refParts(
  args: Record<string, unknown>,
): { libraryID: number; key: string } | null {
  const key = str(args, "key") || str(args, "parentKey");
  const libraryID = args.libraryID;
  if (key && typeof libraryID === "number") {
    return { libraryID, key };
  }
  return null;
}

export function describeCallForApproval(
  toolName: string,
  args: Record<string, unknown>,
  resolveItem?: TitleResolver,
  language: "en-US" | "zh-CN" = "en-US",
): string | undefined {
  const ref = refParts(args);
  const refTitle =
    ref && resolveItem
      ? (resolveItem(ref.libraryID, ref.key)?.title ?? "")
      : "";

  const highlights = args.highlights ?? args.annotations;
  const highlightText = firstHighlightText(highlights);
  const annotationCount = itemCount(highlights);
  if (annotationCount > 0) {
    const countLabel =
      language === "zh-CN"
        ? `${annotationCount} 条标注`
        : `${annotationCount} annotation${annotationCount === 1 ? "" : "s"}`;
    // For a batch, the first quote is not representative and made summaries
    // such as “3 × ALPHA” look like three duplicate annotations. Keep the
    // quote only when it describes the sole write; full args remain expandable.
    const batch =
      annotationCount === 1 && highlightText
        ? `${countLabel} · ${quoted(highlightText)}`
        : countLabel;
    return refTitle ? `${clip(refTitle)} · ${batch}` : batch;
  }

  if (refTitle) {
    return clip(refTitle);
  }

  const query = str(args, "query");
  if (query) {
    return quoted(query);
  }

  const name = str(args, "name");
  if (name) {
    return clip(name);
  }

  const title = str(args, "title");
  if (title) {
    return clip(title);
  }

  const comment = str(args, "comment");
  if (comment) {
    return quoted(comment);
  }

  // Last resort: the first meaningful string arg (e.g. MCP tool payloads).
  // Key-like fields stay out — an id is not an object description.
  for (const [name, value] of Object.entries(args)) {
    if (KEY_FIELDS.has(name)) {
      continue;
    }
    if (
      typeof value === "string" &&
      value.trim() &&
      value.trim() !== toolName
    ) {
      return quoted(value);
    }
  }
  return undefined;
}
