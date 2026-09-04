export interface LibraryMentionToken {
  start: number;
  end: number;
  query: string;
}

const EMAIL_LOCAL_CHARACTER = /[A-Za-z0-9._%+-]/;

/** Find the unfinished @ mention that owns the current caret position. */
export function libraryMentionTokenAtCaret(
  value: string,
  caret = value.length,
): LibraryMentionToken | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  const beforeCaret = value.slice(0, safeCaret);
  const start = beforeCaret.lastIndexOf("@");
  if (start < 0) return null;
  if (start > 0 && EMAIL_LOCAL_CHARACTER.test(beforeCaret[start - 1] ?? "")) {
    return null;
  }
  const rawQuery = beforeCaret.slice(start + 1);
  if (
    rawQuery.includes("\n") ||
    rawQuery.includes("@") ||
    rawQuery.length > 120
  ) {
    return null;
  }
  // A selected mention is rendered as @[Title]. Do not reopen the picker
  // while the user continues typing after that closed token.
  if (/^\[[^\]]*\](?:\s|$)/.test(rawQuery)) return null;
  return {
    start,
    end: safeCaret,
    query: rawQuery.trim(),
  };
}

export function replaceLibraryMention(
  value: string,
  token: LibraryMentionToken,
  title: string,
): { value: string; caret: number } {
  const safeTitle =
    title.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || "Untitled";
  const replacement = `@[${safeTitle}] `;
  const suffix = value.slice(token.end).replace(/^[ \t]+/, "");
  const next = `${value.slice(0, token.start)}${replacement}${suffix}`;
  return {
    value: next,
    caret: token.start + replacement.length,
  };
}
