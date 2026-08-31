import type { MemoryRecord } from "./types";
import { isMemoryType, MEMORY_TYPES, type MemoryType } from "./types";

/**
 * One memory per markdown file. Frontmatter carries the indexable metadata,
 * the body is the memory text, and revisions are kept in an HTML comment so
 * every file stays valid, readable markdown for a human with any editor.
 *
 *     ---
 *     id: mem_ab12cd34
 *     type: preference
 *     title: Prefers survey papers
 *     tags: [reading, papers]
 *     created: 1725000000000
 *     updated: 1725000000000
 *     last-accessed: 1725000000000
 *     access-count: 3
 *     confidence: 0.9
 *     source-session: ses_ab21
 *     supersedes: mem_old
 *     ---
 *
 *     Prefers survey papers when entering a new field.
 *
 *     <!-- history
 *     1724000000000 | Previous content.
 *     -->
 */

const HISTORY_OPEN = "<!-- history";
const HISTORY_CLOSE = "-->";

export function serializeMemory(record: MemoryRecord): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${record.id}`);
  lines.push(`type: ${record.type}`);
  lines.push(`title: ${escapeScalar(record.title)}`);
  lines.push(`tags: [${record.tags.map((tag) => tag.trim()).join(", ")}]`);
  lines.push(`created: ${record.createdAt}`);
  lines.push(`updated: ${record.updatedAt}`);
  lines.push(`last-accessed: ${record.lastAccessedAt}`);
  lines.push(`access-count: ${record.accessCount}`);
  lines.push(`confidence: ${round2(record.confidence)}`);
  if (record.sourceSessionId) {
    lines.push(`source-session: ${record.sourceSessionId}`);
  }
  if (record.supersedes) {
    lines.push(`supersedes: ${record.supersedes}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(record.content.trim());
  if (record.history.length > 0) {
    lines.push("");
    lines.push(HISTORY_OPEN);
    for (const entry of record.history) {
      lines.push(`${entry.at} | ${entry.content.replace(/\n/g, " ")}`);
    }
    lines.push(HISTORY_CLOSE);
  }
  return lines.join("\n") + "\n";
}

export function parseMemoryFile(
  filename: string,
  text: string,
): MemoryRecord | null {
  if (!text.startsWith("---")) {
    return null;
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) {
    return null;
  }
  const frontmatter = text.slice(4, end);
  const body = text.slice(end + 4).trim();
  const map = parseFrontmatter(frontmatter);
  const id = map.get("id") ?? filename.replace(/\.md$/, "");
  const type = map.get("type");
  if (!isMemoryType(type)) {
    return null;
  }
  const { body: content, history } = splitHistory(body);
  const title = map.get("title") ?? content.split("\n")[0]?.slice(0, 80) ?? id;
  const now = Number(map.get("updated")) || 0;
  return {
    id,
    type,
    title,
    content,
    tags: parseTags(map.get("tags")),
    sourceSessionId: map.get("source-session") || undefined,
    createdAt: Number(map.get("created")) || now,
    updatedAt: now,
    lastAccessedAt: Number(map.get("last-accessed")) || now,
    accessCount: Number(map.get("access-count")) || 0,
    confidence: clamp01(Number(map.get("confidence"))),
    supersedes: map.get("supersedes") || undefined,
    history,
  };
}

function parseFrontmatter(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    map.set(key, value);
  }
  return map;
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function splitHistory(body: string): {
  body: string;
  history: MemoryRecord["history"];
} {
  const open = body.lastIndexOf(HISTORY_OPEN);
  if (open < 0) {
    return { body: body.trim(), history: [] };
  }
  const close = body.indexOf(HISTORY_CLOSE, open);
  if (close < 0) {
    return { body: body.slice(0, open).trim(), history: [] };
  }
  const history: MemoryRecord["history"] = [];
  for (const line of body.slice(open + HISTORY_OPEN.length, close).split("\n")) {
    const separator = line.indexOf("|");
    if (separator <= 0) {
      continue;
    }
    const at = Number(line.slice(0, separator).trim());
    const content = line.slice(separator + 1).trim();
    if (Number.isFinite(at) && content) {
      history.push({ at, content });
    }
  }
  return { body: body.slice(0, open).trim(), history };
}

function escapeScalar(value: string): string {
  return value.replace(/\n/g, " ").trim();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

export function memoryTypeName(type: MemoryType): string {
  const index = MEMORY_TYPES.indexOf(type);
  return index >= 0 ? MEMORY_TYPES[index] : "fact";
}
