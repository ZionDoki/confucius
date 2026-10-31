/** Ranges in the plain-text draft; reference identities never depend on titles. */
export interface ComposerMention {
  id: string;
  label: string;
  start: number;
  end: number;
}

export function composerMentionText(label: string): string {
  return `@[${label.replace(/[[\]\r\n]/g, "").trim() || "Untitled"}]`;
}

export function composerMentions(
  text: string,
  value: unknown,
): ComposerMention[] {
  if (!Array.isArray(value)) return [];
  let end = 0;
  const result: ComposerMention[] = [];
  for (const row of value.slice(0, 200)) {
    if (!row || typeof row !== "object") continue;
    const { id, label, start, end: stop } = row;
    if (
      typeof id !== "string" ||
      !/^(item|task):[\w:-]+$/.test(id) ||
      typeof label !== "string" ||
      label.length > 2000 ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(stop) ||
      start < end ||
      stop <= start ||
      stop > text.length ||
      text.slice(start, stop) !== composerMentionText(label)
    )
      continue;
    result.push({ id, label, start, end: stop });
    end = stop;
  }
  return result;
}
