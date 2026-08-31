const SECTION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "abstract", pattern: /^abstract\b/i },
  { name: "introduction", pattern: /^(?:\d+\.?\s*)?(introduction|background)\b/i },
  { name: "related_work", pattern: /^(?:\d+\.?\s*)?(related\s+work|literature\s+review)\b/i },
  { name: "methodology", pattern: /^(?:\d+\.?\s*)?(method|methodology|approach)\b/i },
  { name: "experiments", pattern: /^(?:\d+\.?\s*)?(experiment|evaluation)\b/i },
  { name: "results", pattern: /^(?:\d+\.?\s*)?(result|finding)\b/i },
  { name: "discussion", pattern: /^(?:\d+\.?\s*)?(discussion|analysis)\b/i },
  { name: "conclusion", pattern: /^(?:\d+\.?\s*)?(conclusion|summary|future\s+work)\b/i },
  { name: "references", pattern: /^(references|bibliography)\b/i },
];

export interface PaperSection {
  name: string;
  normalizedName: string;
  content: string;
}

export interface PaperPages {
  pageCount: number;
  pages: Array<{ page: number; text: string }>;
}

export function splitPages(text: string, charsPerPage = 3000): PaperPages {
  const byFormFeed = text.split("\f").filter((part) => part.trim());
  if (byFormFeed.length > 1) {
    return {
      pageCount: byFormFeed.length,
      pages: byFormFeed.map((pageText, index) => ({
        page: index + 1,
        text: pageText.trim(),
      })),
    };
  }
  const pages: Array<{ page: number; text: string }> = [];
  for (let i = 0; i < text.length; i += charsPerPage) {
    pages.push({
      page: pages.length + 1,
      text: text.slice(i, i + charsPerPage),
    });
  }
  return { pageCount: Math.max(pages.length, 1), pages };
}

export function parseSections(text: string): PaperSection[] {
  const lines = text.split("\n");
  const sections: PaperSection[] = [];
  let current: PaperSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = SECTION_PATTERNS.find((entry) => entry.pattern.test(trimmed));
    if (match) {
      if (current) {
        current.content = current.content.trim();
        sections.push(current);
      }
      current = { name: trimmed, normalizedName: match.name, content: "" };
    } else if (current) {
      current.content += `${line}\n`;
    }
  }
  if (current) {
    current.content = current.content.trim();
    sections.push(current);
  }
  if (sections.length === 0) {
    sections.push({
      name: "Full Text",
      normalizedName: "full_text",
      content: text,
    });
  }
  return sections;
}

export function findSection(sections: PaperSection[], requested: string): PaperSection | null {
  const needle = requested.toLowerCase().replace(/\s+/g, "_");
  return (
    sections.find((section) => section.normalizedName === needle) ||
    sections.find((section) =>
      section.name.toLowerCase().includes(requested.toLowerCase()),
    ) ||
    null
  );
}

export function requireItemRef(args: Record<string, unknown>): {
  ok: true;
  libraryID: number;
  key: string;
} | { ok: false; message: string } {
  const libraryID = Number(args.libraryID);
  const key = String(args.key ?? args.itemKey ?? "");
  if (!Number.isInteger(libraryID) || libraryID < 0 || !key) {
    return {
      ok: false,
      message: "libraryID (integer) and key (string) are required",
    };
  }
  return { ok: true, libraryID, key };
}
