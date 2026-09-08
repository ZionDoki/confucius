const SECTION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "abstract", pattern: /^abstract\b/i },
  {
    name: "introduction",
    pattern: /^(?:\d+\.?\s*)?(introduction|background)\b/i,
  },
  {
    name: "related_work",
    pattern: /^(?:\d+\.?\s*)?(related\s+work|literature\s+review)\b/i,
  },
  {
    name: "methodology",
    pattern: /^(?:\d+\.?\s*)?(method|methodology|approach)\b/i,
  },
  { name: "experiments", pattern: /^(?:\d+\.?\s*)?(experiment|evaluation)\b/i },
  { name: "results", pattern: /^(?:\d+\.?\s*)?(result|finding)\b/i },
  { name: "discussion", pattern: /^(?:\d+\.?\s*)?(discussion|analysis)\b/i },
  {
    name: "conclusion",
    pattern: /^(?:\d+\.?\s*)?(conclusion|summary|future\s+work)\b/i,
  },
  { name: "references", pattern: /^(references|bibliography)\b/i },
];

export interface PaperSection {
  name: string;
  normalizedName: string;
  content: string;
}

function sectionHeading(text: string): { name: string } | undefined {
  if (
    !text ||
    text.length > 100 ||
    /[.!?;。！？]$/.test(text) ||
    text.split(/\s+/).length > 12
  )
    return;
  // Keep subsection text in its parent, so reading Methodology includes 3.1 etc.
  if (/^\d+\.\d+\s/.test(text)) return;
  const numbered = /^\d{1,2}\.?\s+(\p{L}.*)$/u.exec(text);
  const title = numbered?.[1] ?? text;
  const known = SECTION_PATTERNS.find((entry) => entry.pattern.test(title));
  if (known)
    return { name: /^background\b/i.test(title) ? "background" : known.name };
  if (!numbered) return;
  if (
    /\b(method(?:ology)?|methods|approach|workflow|architecture)\b/i.test(title)
  )
    return { name: "methodology" };
  return {
    name: title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/_$/, ""),
  };
}

export interface PaperPages {
  pageCount: number | null;
  pagination: "form_feed" | "unpaged";
  pages: Array<{ page: number | null; text: string }>;
}

/** Only explicit page separators can establish page numbers in indexed text. */
export function splitPages(text: string): PaperPages {
  if (!text.includes("\f")) {
    return {
      pageCount: null,
      pagination: "unpaged",
      pages: [{ page: null, text }],
    };
  }
  const pages = text.split("\f");
  return {
    pageCount: pages.length,
    pagination: "form_feed",
    pages: pages.map((pageText, index) => ({
      page: index + 1,
      text: pageText.trim(),
    })),
  };
}

export function parseSections(text: string): PaperSection[] {
  const lines = text.split("\n");
  const sections: PaperSection[] = [];
  let current: PaperSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = sectionHeading(trimmed);
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

export function findSection(
  sections: PaperSection[],
  requested: string,
): PaperSection | null {
  const needle = requested.toLowerCase().replace(/\s+/g, "_");
  return (
    sections.find((section) => section.normalizedName === needle) ||
    sections.find((section) =>
      section.name.toLowerCase().includes(requested.toLowerCase()),
    ) ||
    null
  );
}

export function requireItemRef(args: Record<string, unknown>):
  | {
      ok: true;
      libraryID: number;
      key: string;
    }
  | { ok: false; message: string } {
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
