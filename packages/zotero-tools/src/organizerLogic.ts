/**
 * organizerLogic — pure outline and annotation assignment logic for Flex Annotations Organizer.
 * Unit-testable in Node with zero external/Zotero dependencies.
 */

export const OUTLINE_TAG = "★outline";
export const HEADING_PREFIX = "§";
export const COLLECTION_TAG_PREFIX = "#flexannotate-outline-";
export const SENTINEL = "LATTICE-OUTLINE-V1";

export interface OutlineNode {
  id: string;
  title: string;
  children: OutlineNode[];
}

export interface FlatHeading {
  id: string;
  title: string;
  num: string;
  path: string;
  depth: number;
  tag: string;
}

/** Prefix that turns a heading title into its backing Zotero tag. */
export function headingTag(title: string): string {
  const trimmed = title.trim();
  if (trimmed.startsWith(HEADING_PREFIX)) {
    return trimmed;
  }
  return `${HEADING_PREFIX}${trimmed}`;
}

/** Extract the heading title from a tag, or null if it does not have the § prefix. */
export function headingTitleFromTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (trimmed.startsWith(HEADING_PREFIX)) {
    return trimmed.slice(HEADING_PREFIX.length).trim();
  }
  return null;
}

/** Build the collection marker tag identifying an outline note for a collection. */
export function outlineCollectionTag(collectionKey: string): string {
  return `${COLLECTION_TAG_PREFIX}${collectionKey}`;
}

/** Check if a tag is a collection outline marker. */
export function isOutlineCollectionTag(tag: string): boolean {
  return tag.startsWith(COLLECTION_TAG_PREFIX);
}

/** Extract the collection key from a marker tag, or null. */
export function collectionKeyFromTag(tag: string): string | null {
  return tag.startsWith(COLLECTION_TAG_PREFIX)
    ? tag.slice(COLLECTION_TAG_PREFIX.length)
    : null;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // &amp; last
}

function sanitizeTree(nodes: unknown): OutlineNode[] {
  if (!Array.isArray(nodes)) return [];
  const out: OutlineNode[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const item = n as Record<string, unknown>;
    if (typeof item.title !== "string" || !item.title.trim()) continue;
    out.push({
      id:
        typeof item.id === "string" && item.id
          ? item.id
          : String(out.length + 1),
      title: item.title.trim(),
      children: sanitizeTree(item.children),
    });
  }
  return out;
}

/** Helper to normalize a heading string for lookup keys. */
export function normalizeHeadingKey(text: string): string {
  return (text || "")
    .trim()
    .toLowerCase()
    .replace(/^§\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract outline numbering badge and stripped title from a heading string. */
export function cleanHeadingTitle(title: string): {
  num?: string;
  title: string;
} {
  const s = (title || "")
    .trim()
    .replace(/^§\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  // 1. Decimal numbering: "1", "1.1", "1.1.2", "1.", "1.1."
  const decMatch = s.match(/^([0-9]+(?:\.[0-9]+)*)\.?\s+(.+)$/);
  if (decMatch) {
    return { num: decMatch[1], title: decMatch[2].trim() };
  }
  // 2. Letter or Roman numeral with delimiter: "A.", "B)", "I.", "IV."
  const letterDelimMatch = s.match(/^([A-Za-z]|[IVXLCDMivxlcdm]+)[.)]\s+(.+)$/);
  if (letterDelimMatch) {
    return { num: letterDelimMatch[1], title: letterDelimMatch[2].trim() };
  }
  // 3. Multi-character Roman numerals: "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII"
  const romanMatch = s.match(/^(X{0,3}(?:IX|IV|V?I{2,3})|V|X{1,3})\s+(.+)$/i);
  if (romanMatch) {
    return { num: romanMatch[1], title: romanMatch[2].trim() };
  }
  return { title: s };
}

/** Parse the tree back out of a stored outline note's HTML. */
export function parseOutline(noteHtml: string): OutlineNode[] {
  if (!noteHtml) return [];
  let rawJson = "";
  const codePreMatch = noteHtml.match(
    /LATTICE-OUTLINE-V1\s*([\s\S]*?)<\/(?:code|pre)>/i,
  );
  if (codePreMatch) {
    let raw = codePreMatch[1].trim();
    if (raw.includes("<pre>") || raw.includes("<code>")) {
      raw = raw.replace(/^[\s\S]*?<(?:pre|code)[^>]*>/i, "");
    }
    rawJson = raw.trim();
  } else {
    const rawMatch = noteHtml.match(/LATTICE-OUTLINE-V1\s*(\{[\s\S]*\})/i);
    if (rawMatch) {
      rawJson = rawMatch[1].trim();
    }
  }
  if (!rawJson) return [];
  try {
    const json = unescapeHtml(rawJson);
    const parsed = JSON.parse(json);
    return sanitizeTree(parsed?.roots);
  } catch {
    return [];
  }
}

/** Decimal outline numbers ("1", "1.1", "1.2.3"), computed from the tree. */
export function numbering(roots: OutlineNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (nodes: OutlineNode[], prefix: string) => {
    (nodes || []).forEach((n, i) => {
      const num = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      if (n.id) {
        out.set(n.id, num);
      }
      walk(n.children || [], num);
    });
  };
  walk(roots, "");
  return out;
}

/** Flatten outline tree nodes depth-first into an array with path, depth, and decimal number. */
export function flattenOutline(roots: OutlineNode[]): FlatHeading[] {
  const out: FlatHeading[] = [];
  const walk = (
    nodes: OutlineNode[],
    depth: number,
    parentPath: string,
    prefix: string,
  ) => {
    for (let i = 0; i < (nodes || []).length; i++) {
      const node = nodes[i];
      const currentPath = parentPath
        ? `${parentPath} > ${node.title}`
        : node.title;
      const computedNum = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      out.push({
        id: node.id || computedNum,
        title: node.title,
        num: computedNum,
        path: currentPath,
        depth,
        tag: headingTag(node.title),
      });
      walk(node.children || [], depth + 1, currentPath, computedNum);
    }
  };
  walk(roots, 0, "", "");
  return out;
}

/** Build a lookup map of lower-cased title/path -> canonical heading information. */
export function buildHeadingLookup(
  rootsOrFlat: OutlineNode[] | FlatHeading[],
): Map<string, FlatHeading> {
  const flat =
    rootsOrFlat.length > 0 && "path" in rootsOrFlat[0]
      ? (rootsOrFlat as FlatHeading[])
      : flattenOutline(rootsOrFlat as OutlineNode[]);
  const map = new Map<string, FlatHeading>();

  const register = (key: string, item: FlatHeading) => {
    const k = normalizeHeadingKey(key);
    if (k) {
      map.set(k, item);
      map.set(`${HEADING_PREFIX}${k}`, item);
    }
  };

  for (const item of flat) {
    const title = item.title.trim();
    let num = (item.num || "").trim();
    const path = item.path.trim();

    register(title, item);
    register(path, item);

    // If the title itself starts with a decimal number / letter prefix (e.g. "1.1 Funktionen ...")
    const cleaned = cleanHeadingTitle(title);
    if (cleaned.num && cleaned.title !== title) {
      if (!num) num = cleaned.num;
      const cleanTitle = cleaned.title;
      register(cleanTitle, item);
      register(`${cleaned.num} ${cleanTitle}`, item);
      register(`${cleaned.num}. ${cleanTitle}`, item);
    }

    if (num) {
      register(num, item);
      register(`${num}.`, item);
      register(`${num} ${title}`, item);
      register(`${num}. ${title}`, item);
      register(`${num} - ${title}`, item);
      if (cleaned.num && cleaned.title !== title) {
        const cleanTitle = cleaned.title;
        register(`${num} ${cleanTitle}`, item);
        register(`${num}. ${cleanTitle}`, item);
        register(`${num} - ${cleanTitle}`, item);
      }
    }

    // Path without numbering if path contains numbers
    const cleanPath = path
      .split(" > ")
      .map((segment) => cleanHeadingTitle(segment).title)
      .join(" > ")
      .trim();
    if (cleanPath && cleanPath !== path) {
      register(cleanPath, item);
    }
  }
  return map;
}

/**
 * Extract surrounding full-text context for an annotation quote.
 * Centered around the quote with up to windowChars total surrounding text.
 */
export function extractSurroundingContext(
  fulltext: string,
  quote: string,
  windowChars = 1000,
): { context: string; index: number } | null {
  if (!fulltext || !quote) return null;
  const cleanQuote = quote.trim();
  if (!cleanQuote) return null;

  let index = fulltext.indexOf(cleanQuote);
  if (index === -1) {
    // Try case-insensitive
    index = fulltext.toLowerCase().indexOf(cleanQuote.toLowerCase());
  }
  if (index === -1) {
    // Try whitespace-normalized match
    const normQuote = cleanQuote.replace(/\s+/g, " ");
    const normFull = fulltext.replace(/\s+/g, " ");
    const normIdx = normFull.indexOf(normQuote);
    if (normIdx !== -1) {
      const start = Math.max(0, normIdx - Math.floor(windowChars / 2));
      const end = Math.min(
        normFull.length,
        normIdx + normQuote.length + Math.floor(windowChars / 2),
      );
      return { context: normFull.slice(start, end).trim(), index: normIdx };
    }
    return null;
  }

  const halfWindow = Math.floor(windowChars / 2);
  const start = Math.max(0, index - halfWindow);
  const end = Math.min(fulltext.length, index + cleanQuote.length + halfWindow);
  return { context: fulltext.slice(start, end).trim(), index };
}

export interface AssignmentItem {
  key: string;
  headings: string[];
  reason?: string;
}

export interface ItemStateForAssignment {
  key: string;
  tags: string[];
  editable?: boolean;
  inScope?: boolean;
}

export interface PlanAssignmentsResult {
  assigned: Array<{
    key: string;
    added: string[];
    headings: string[];
    headingDetails?: Array<{
      title: string;
      num: string;
      path: string;
      tag: string;
    }>;
  }>;
  skipped: Array<{
    key: string;
    reason: string;
  }>;
  unknownHeadings: string[];
}

/** Pure assignment planning validating against the outline and item rules. */
export function planAssignments(
  roots: OutlineNode[],
  assignments: AssignmentItem[],
  itemStates: Map<string, ItemStateForAssignment>,
): PlanAssignmentsResult {
  const headingLookup = buildHeadingLookup(roots);
  const assigned: PlanAssignmentsResult["assigned"] = [];
  const skipped: PlanAssignmentsResult["skipped"] = [];
  const unknownHeadings: string[] = [];

  for (const entry of assignments) {
    if (!entry.headings || !entry.headings.length) {
      skipped.push({ key: entry.key, reason: "no heading" });
      continue;
    }

    const item = itemStates.get(entry.key);
    if (!item) {
      skipped.push({ key: entry.key, reason: "annotation not found" });
      continue;
    }

    if (item.editable === false) {
      skipped.push({ key: entry.key, reason: "item not editable" });
      continue;
    }

    if (item.inScope === false) {
      skipped.push({ key: entry.key, reason: "work not in collection" });
      continue;
    }

    const validTags: string[] = [];
    const validTitles: string[] = [];
    const validMatches: FlatHeading[] = [];
    for (const h of entry.headings) {
      const match = headingLookup.get(h.trim().toLowerCase());
      if (match) {
        if (!validTags.includes(match.tag)) {
          validTags.push(match.tag);
          validTitles.push(match.title);
          validMatches.push(match);
        }
      } else {
        if (!unknownHeadings.includes(h)) {
          unknownHeadings.push(h);
        }
      }
    }

    if (!validTags.length) {
      skipped.push({ key: entry.key, reason: "no valid heading" });
      continue;
    }

    const currentTags = new Set(item.tags);
    const tagsToAdd = validTags.filter((t) => !currentTags.has(t));

    if (!tagsToAdd.length) {
      skipped.push({ key: entry.key, reason: "already assigned" });
      continue;
    }

    assigned.push({
      key: entry.key,
      added: tagsToAdd,
      headings: validTitles,
      headingDetails: validMatches.map((m) => ({
        title: m.title,
        num: m.num,
        path: m.path,
        tag: m.tag,
      })),
    });
  }

  return { assigned, skipped, unknownHeadings };
}
