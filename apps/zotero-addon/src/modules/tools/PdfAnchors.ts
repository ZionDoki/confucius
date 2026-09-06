/** Native Reader character offsets, never offsets into reflowed/extracted text. */
export interface PdfPageChar {
  u?: string;
  char?: string;
  rect?: number[];
  inlineRect?: number[];
  rotation?: number;
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
}

export interface PdfPassage {
  anchor?: string;
  legacyAnchor?: string;
  start: number;
  end: number; // Inclusive, as in Zotero Reader selections.
  text: string;
}

export function charText(char: PdfPageChar): string {
  return `${char.u ?? char.char ?? ""}${char.paragraphBreakAfter ? "\n\n" : char.lineBreakAfter ? "\n" : char.spaceAfter ? " " : ""}`;
}

function hasGeometry(char: PdfPageChar): boolean {
  return Boolean(
    char.rect?.length === 4 &&
    char.rect.every(Number.isFinite) &&
    char.rect[2] > char.rect[0] &&
    char.rect[3] > char.rect[1],
  );
}

/** Sentence spans keep original ligatures, line breaks and offsets. Native
 * paragraph flags can occur mid-sentence at a font/column change; they are
 * preserved as whitespace, not treated as a complete evidence boundary. */
export async function pdfPassages(
  chars: PdfPageChar[],
  page: number,
  fingerprint: string,
  digest: (value: string) => Promise<string>,
): Promise<PdfPassage[]> {
  const signature = (
    await digest(
      JSON.stringify([
        "pdf-anchor-v1",
        fingerprint,
        page,
        chars.map((c) => [
          c.u ?? c.char ?? "",
          c.rect,
          c.inlineRect,
          c.rotation,
          !!c.spaceAfter,
          !!c.lineBreakAfter,
          !!c.paragraphBreakAfter,
        ]),
      ]),
    )
  ).slice(0, 16);
  const passages: PdfPassage[] = [];
  let start = 0,
    text = "";
  const flush = (end: number) => {
    let first = start,
      last = end;
    while (
      first <= last &&
      !String(chars[first].u ?? chars[first].char ?? "").trim()
    )
      first++;
    while (
      last >= first &&
      !String(chars[last].u ?? chars[last].char ?? "").trim()
    )
      last--;
    if (first <= last && text.trim()) {
      // A lowercase continuation at the top, or unfinished sentence at the
      // bottom, cannot stand alone as evidence. Keep it readable without an ID.
      const pageFragment =
        (passages.length === 0 && /^\p{Ll}/u.test(text.trim())) ||
        (end === chars.length - 1 && !/[.!?。！？][”’"')\]]*\s*$/.test(text));
      const positioned =
        !pageFragment &&
        text.trim().length >= 12 &&
        /\p{L}/u.test(text) &&
        chars
          .slice(first, last + 1)
          .every((c) => !String(c.u ?? c.char ?? "").trim() || hasGeometry(c));
      passages.push({
        legacyAnchor: positioned
          ? `p${page}:${first.toString(36)}-${last.toString(36)}:${signature}`
          : undefined,
        start: first,
        end: last,
        text: text.trim(),
      });
    }
    start = end + 1;
    text = "";
  };
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    text += charText(char);
    const separated =
      char.spaceAfter ||
      char.lineBreakAfter ||
      /\s/.test(String(chars[index + 1]?.u ?? chars[index + 1]?.char ?? ""));
    const sentence =
      /[。！？][”’"')\]]*\s*$/.test(text) ||
      (separated &&
        /[.!?][”’"')\]]*\s*$/.test(text) &&
        !/\b(?:[A-Z]|Dr|Mr|Ms|Prof|Fig|Figs|Eq|Sec|No|vs|al|e\.g|i\.e)\.\s*$/i.test(
          text,
        ));
    if (
      sentence ||
      (text.length >= 700 && char.lineBreakAfter) ||
      (text.length >= 1000 && separated) ||
      index === chars.length - 1
    )
      flush(index);
  }
  // One opaque token avoids asking the model to understand/reassemble page,
  // offsets and checksum fields. Keep all source validation inside the tool.
  await Promise.all(
    passages.map(async (passage) => {
      if (!passage.legacyAnchor || page > 46_655) return;
      const hash = (await digest(passage.legacyAnchor)).slice(0, 12);
      passage.anchor = `a${page.toString(36).padStart(3, "0")}${hash}`;
    }),
  );
  return passages;
}

export function anchorPage(anchor: string): number {
  anchor = normalizeAnchor(anchor);
  const opaque = /^a([0-9a-z]{3})[0-9a-f]{12}$/.exec(anchor);
  if (opaque && parseInt(opaque[1], 36) > 0) return parseInt(opaque[1], 36);
  const match = /^p([1-9]\d*):[0-9a-z]+-[0-9a-z]+:[0-9a-f]{16}$/.exec(anchor);
  const page = Number(match?.[1]);
  if (!Number.isSafeInteger(page) || page < 1)
    throw new Error("Invalid annotation anchor; copy an anchor from get_pages");
  return page;
}

export function normalizeAnchor(anchor: string): string {
  // Harmless copy formatting is recoverable without guessing a location.
  return anchor
    .trim()
    .replace(/^\[anchor:([^\]]+)\]$/i, "$1")
    .trim()
    .toLowerCase();
}

export function renderPdfPassages(passages: PdfPassage[], maxChars: number) {
  let text = "";
  for (const passage of passages) {
    const block = `${passage.anchor ? `[anchor:${passage.anchor}]` : "[unanchored]"} ${passage.text}`;
    const next = `${text ? "\n\n" : ""}${block}`;
    if (text.length + next.length > maxChars) {
      // Never show an ID alongside only part of the passage it will select.
      return { text: text || passage.text.slice(0, maxChars), truncated: true };
    }
    text += next;
  }
  return { text, truncated: false };
}

export function resolvePassage(
  passages: PdfPassage[],
  anchor: string,
): PdfPassage {
  anchor = normalizeAnchor(anchor);
  const passage = passages.find(
    (candidate) =>
      candidate.anchor === anchor || candidate.legacyAnchor === anchor,
  );
  if (!passage)
    throw new Error(
      "Annotation anchor does not match this PDF's current text and positions; reread its page with get_pages",
    );
  return passage;
}
