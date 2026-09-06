interface QuoteChar {
  u?: string;
  char?: string;
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
}

/** Exact Reader queries for typographic equivalents, never approximate quotes. */
export function layoutQuoteVariants(
  chars: QuoteChar[],
  quote: string,
): string[] {
  const needle = normalized(quote).replace(/\s+/g, " ").trim();
  if (!needle) return [];
  const variants = new Set<string>();
  // A line-final hyphen can be either a word's actual hyphen or a typesetting
  // break. Consider both, but never remove a hyphen in the middle of a line.
  for (const removeBreakHyphen of [false, true]) {
    let raw = "",
      text = "";
    const starts: number[] = [],
      ends: number[] = [];
    const append = (value: string, start: number, end: number) => {
      for (const character of normalized(value)) {
        const part = /\s/.test(character) ? " " : character;
        if (part === " " && text.endsWith(" ")) continue;
        text += part;
        // indexOf uses UTF-16 offsets, including astral characters.
        for (let i = 0; i < part.length; i++) {
          starts.push(start);
          ends.push(end);
        }
      }
    };
    for (const char of chars) {
      const value = String(char.u ?? char.char ?? "");
      const start = raw.length;
      raw += value;
      const end = raw.length;
      const breakHyphen =
        /[-\u00ad]$/.test(value) &&
        char.lineBreakAfter === true &&
        !char.paragraphBreakAfter;
      append(
        removeBreakHyphen && breakHyphen ? value.slice(0, -1) : value,
        start,
        end,
      );
      if (char.spaceAfter || char.lineBreakAfter || char.paragraphBreakAfter) {
        raw += " ";
        if (!breakHyphen) append(" ", end, raw.length);
      }
    }
    for (let from = 0; from < text.length;) {
      const index = text.indexOf(needle, from);
      if (index < 0) break;
      variants.add(
        raw.slice(starts[index], ends[index + needle.length - 1]).trim(),
      );
      from = index + Math.max(needle.length, 1);
    }
  }
  return [...variants];
}
