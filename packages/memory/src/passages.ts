import { termFrequency, tokenize } from "./tokenize";

/** Rebuildable lexical data. Offsets always address the unchanged UTF-16 original. */
export interface Passage {
  start: number;
  end: number;
  page?: number;
  section?: string;
  length: number;
  terms: Record<string, number>;
}
export interface PassageIndex {
  version: 2;
  passages: Passage[];
}

const MAX_CHARS = 1800;

/** JSON records/pages and plain paragraphs are boundaries, never replacement originals. */
export function indexPassages(content: string): PassageIndex {
  const boundaries = new Set([0, content.length]);
  const metadata: Array<{
    start: number;
    end: number;
    page?: number;
    section?: string;
  }> = [];
  if (/^\s*[\[{]/.test(content)) {
    // Lex strings atomically so quoted braces, page labels and escaped text cannot
    // masquerade as structure. A malformed/truncated result still has plain chunks.
    const stack: Array<{ start: number; page?: number; section?: string }> = [];
    let key: string | undefined;
    for (const match of content.matchAll(
      /"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?/g,
    )) {
      const token = match[0],
        at = match.index!;
      if (token === "{") {
        stack.push({ start: at });
        key = undefined;
      } else if (token === "}") {
        const object = stack.pop();
        if (object) {
          boundaries.add(object.start);
          boundaries.add(at + 1);
          if (object.page !== undefined || object.section)
            metadata.push({ ...object, end: at + 1 });
        }
        key = undefined;
      } else if (token.startsWith('"')) {
        let value: string;
        try {
          value = JSON.parse(token);
        } catch {
          continue;
        }
        if (
          /^\s*:/.test(content.slice(at + token.length, at + token.length + 8))
        )
          key = value;
        else {
          if (stack.length && key === "section")
            stack[stack.length - 1].section = value.slice(0, 120);
          key = undefined;
        }
      } else if (/^\d+$/.test(token) && key === "page" && stack.length) {
        const page = Number(token);
        if (Number.isSafeInteger(page) && page > 0)
          stack[stack.length - 1].page = page;
        key = undefined;
      } else if (token === ",") key = undefined;
    }
  } else {
    for (const match of content.matchAll(/\n\s*\n|\n(?=#{1,6}\s)/g))
      boundaries.add(
        match.index! + (match[0].startsWith("\n\n") ? match[0].length : 1),
      );
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const passages: Passage[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const stop = sorted[i + 1];
    for (let start = sorted[i]; start < stop;) {
      let end = Math.min(stop, start + MAX_CHARS);
      if (end < stop) {
        const text = content.slice(start, end);
        const boundary = Math.max(
          text.lastIndexOf("\n"),
          text.lastIndexOf(". "),
          text.lastIndexOf("。"),
          text.lastIndexOf(" "),
        );
        if (boundary > MAX_CHARS / 2) end = start + boundary + 1;
        if (/[\uDC00-\uDFFF]/.test(content[end] ?? "")) end--;
      }
      const text = content.slice(start, end);
      const tokens = tokenize(text);
      if (tokens.length) {
        const meta = metadata
          .filter((m) => m.start <= start && m.end >= end)
          .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
        const heading = !meta && /^#{1,6}\s+([^\n]+)/.exec(text)?.[1];
        passages.push({
          start,
          end,
          page: meta?.page,
          section: meta?.section ?? (heading || undefined),
          length: tokens.length,
          terms: Object.fromEntries(termFrequency(tokens)),
        });
      }
      start = end;
    }
  }
  return { version: 2, passages };
}

/** Only compare these scores within one store and one permission-filtered corpus. */
export function rankPassages<
  T extends {
    passage: Passage;
    background: string;
    preferred?: boolean;
    at: number;
    identity: string;
  },
>(rows: T[], query: string): Array<T & { score: number }> {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const df = new Map<string, number>();
  const docs = rows.map((row) => {
    const background = new Set(tokenize(row.background));
    for (const term of terms)
      if (Object.hasOwn(row.passage.terms, term) || background.has(term))
        df.set(term, (df.get(term) ?? 0) + 1);
    return { row, background };
  });
  const average =
    rows.reduce((sum, row) => sum + row.passage.length, 0) /
      Math.max(1, rows.length) || 1;
  return docs
    .map(({ row, background }) => {
      let lexical = 0;
      for (const term of terms) {
        const frequency =
          (Object.hasOwn(row.passage.terms, term)
            ? row.passage.terms[term]
            : 0) + (background.has(term) ? 0.35 : 0);
        if (!frequency) continue;
        const count = df.get(term) ?? 0;
        const idf = Math.log(1 + (rows.length - count + 0.5) / (count + 0.5));
        lexical +=
          (idf * frequency * 2.5) /
          (frequency + 1.5 * (0.25 + (0.75 * row.passage.length) / average));
      }
      // Relatedness breaks near ties; it cannot swamp a rare, relevant passage.
      return { ...row, score: lexical * (row.preferred ? 1.08 : 1) };
    })
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.at - a.at ||
        a.identity.localeCompare(b.identity),
    );
}

export function passageExcerpt(
  content: string,
  passage: Passage,
  query: string,
) {
  const text = content.slice(passage.start, passage.end),
    lower = text.toLowerCase();
  let hit = lower.indexOf(query.trim().toLowerCase());
  if (hit < 0)
    hit = tokenize(query).reduce((first, term) => {
      const at = lower.indexOf(term);
      return at < 0 ? first : Math.min(first, at);
    }, text.length);
  let offset = passage.start + Math.max(0, Math.min(hit, text.length) - 32);
  if (/[\uDC00-\uDFFF]/.test(content[offset] ?? "")) offset--;
  let endOffset = Math.min(passage.end, offset + 700);
  if (/[\uDC00-\uDFFF]/.test(content[endOffset] ?? "")) endOffset--;
  return {
    offset,
    endOffset,
    excerpt: content.slice(offset, endOffset),
    page: passage.page,
    section: passage.section,
  };
}
