import type { MemoryRecord } from "./types";
import { contextTextHead } from "@confucius/protocol";
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
 *
 * The revision marker is only honored as a standalone block at the very end of
 * the file. A body that contains the marker is JSON-encoded so it round-trips.
 */

const HISTORY_OPEN = "<!-- history";
const HISTORY_CLOSE = "-->";
const SAFE_TAG = /^[^,"[\]\\\r\n]+$/;

export function serializeMemory(record: MemoryRecord): string {
  const lines: string[] = ["---"];
  const content = record.content.trim();
  // A body can legitimately contain the revision marker. Encode it as escaped
  // JSON so the split remains reversible instead of truncating the body.
  const encoded = content.includes(HISTORY_OPEN)
    ? JSON.stringify(content).replace(/</g, "\\u003c")
    : undefined;
  lines.push(`id: ${record.id}`);
  lines.push(`type: ${record.type}`);
  lines.push(`title: ${escapeScalar(record.title)}`);
  lines.push(`tags: ${serializeTags(record.tags)}`);
  lines.push(`created: ${record.createdAt}`);
  lines.push(`updated: ${record.updatedAt}`);
  lines.push(`last-accessed: ${record.lastAccessedAt}`);
  lines.push(`access-count: ${record.accessCount}`);
  if (record.retentionVersion === 1) {
    lines.push("retention-version: 1");
    if (record.lastUsedAt !== undefined)
      lines.push(`last-used: ${record.lastUsedAt}`);
    lines.push(
      `retention-started: ${record.retentionStartedAt ?? record.createdAt}`,
    );
    lines.push(`protection: ${record.protection ?? "user"}`);
    lines.push(`source-refs: ${JSON.stringify(record.sourceRefs ?? [])}`);
  }
  if (record.researchTasks?.length)
    lines.push(`research-tasks: ${JSON.stringify(record.researchTasks)}`);
  lines.push(`confidence: ${round2(record.confidence)}`);
  if (record.sourceSessionId) {
    lines.push(`source-session: ${record.sourceSessionId}`);
  }
  if (record.supersedes) {
    lines.push(`supersedes: ${record.supersedes}`);
  }
  if (encoded !== undefined) lines.push("content-encoding: json");
  lines.push("---");
  lines.push("");
  lines.push(encoded ?? content);
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
  onWarn?: (message: string) => void,
): MemoryRecord | null {
  const warn = (message: string) => onWarn?.(message);
  if (!text.startsWith("---")) {
    warn("missing frontmatter; skipped");
    return null;
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) {
    warn("missing closing frontmatter; skipped");
    return null;
  }
  const frontmatter = text.slice(4, end);
  const map = parseFrontmatter(frontmatter);
  const filenameId = filename.replace(/\.md$/, "");
  if (!/^[\w-]+$/.test(filenameId)) {
    warn("invalid memory filename; skipped");
    return null;
  }
  // The filename is the identity used by remove/recover. A frontmatter id that
  // disagrees with it (including one injected through a multi-line tag) must
  // not redirect reads or writes; keep the file readable under its real path.
  const declaredId = map.get("id");
  if (declaredId !== undefined && declaredId !== filenameId)
    warn(
      `frontmatter id ${JSON.stringify(declaredId)} does not match the filename; using ${filenameId}`,
    );
  const id = filenameId;
  const type = map.get("type");
  if (!isMemoryType(type)) {
    warn(`invalid memory type ${JSON.stringify(type ?? "")}; skipped`);
    return null;
  }
  const split = splitHistory(text.slice(end + 4).trim());
  let content = split.body;
  if (map.get("content-encoding") === "json") {
    try {
      const decoded: unknown = JSON.parse(content);
      if (typeof decoded === "string") content = decoded;
      else warn("JSON-encoded body is not a string; keeping raw text");
    } catch {
      // Keep a hand-edited or truncated file readable instead of dropping it.
      warn("JSON-encoded body could not be decoded; keeping raw text");
    }
  }
  const researchTasks = parseStringArray(map.get("research-tasks"), (message) =>
    warn(`${message}; ignored`),
  );
  const title =
    map.get("title") ?? contextTextHead(content.split("\n")[0] ?? id, 80);
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
    ...(map.get("retention-version") === "1"
      ? {
          retentionVersion: 1 as const,
          lastUsedAt:
            map.has("last-used") &&
            Number.isFinite(Number(map.get("last-used")))
              ? Number(map.get("last-used"))
              : undefined,
          retentionStartedAt:
            map.has("retention-started") &&
            Number.isFinite(Number(map.get("retention-started")))
              ? Number(map.get("retention-started"))
              : now,
          protection:
            map.get("protection") === "none"
              ? ("none" as const)
              : ("user" as const),
          sourceRefs: parseSourceRefs(map.get("source-refs")),
        }
      : {}),
    ...(researchTasks ? { researchTasks } : {}),
    confidence: clamp01(Number(map.get("confidence"))),
    supersedes: map.get("supersedes") || undefined,
    history: split.history,
  };
}

function parseSourceRefs(raw?: string): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value)
      ? value
          .filter((ref): ref is string => typeof ref === "string")
          .slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function parseStringArray(
  raw?: string,
  onWarn?: (message: string) => void,
): string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value))
      return value.filter(
        (entry): entry is string => typeof entry === "string",
      );
  } catch {
    /* Reported below. */
  }
  onWarn?.("invalid research-tasks field");
  return undefined;
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

/** Keep the familiar comma form for ordinary tags and JSON-escape the rest,
 *  so a newline or delimiter in a tag cannot inject another frontmatter key. */
function serializeTags(tags: string[]): string {
  const values = tags.map((tag) => tag.trim()).filter(Boolean);
  return values.every((tag) => SAFE_TAG.test(tag))
    ? `[${values.join(", ")}]`
    : JSON.stringify(values);
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  if (raw.trim().startsWith("[")) {
    try {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value) && value.every((tag) => typeof tag === "string"))
        return (value as string[]).map((tag) => tag.trim()).filter(Boolean);
    } catch {
      /* Legacy comma-separated lists are not valid JSON. */
    }
  }
  return raw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** Only a standalone, self-closing marker at the very end of the file is a
 *  revision block. This keeps a body that merely mentions the marker intact. */
function splitHistory(body: string): {
  body: string;
  history: MemoryRecord["history"];
} {
  let open = body.lastIndexOf(HISTORY_OPEN);
  while (open >= 0) {
    const atLineStart = open === 0 || body[open - 1] === "\n";
    const lineEnd = body.indexOf("\n", open + HISTORY_OPEN.length);
    const close = body.lastIndexOf(HISTORY_CLOSE);
    if (
      atLineStart &&
      lineEnd >= 0 &&
      !body.slice(open + HISTORY_OPEN.length, lineEnd).trim() &&
      close > lineEnd &&
      !body.slice(close + HISTORY_CLOSE.length).trim()
    ) {
      const history = parseHistory(body.slice(lineEnd + 1, close));
      if (history) return { body: body.slice(0, open).trim(), history };
    }
    open = open > 0 ? body.lastIndexOf(HISTORY_OPEN, open - 1) : -1;
  }
  return { body: body.trim(), history: [] };
}

function parseHistory(payload: string): MemoryRecord["history"] | undefined {
  const history: MemoryRecord["history"] = [];
  for (const line of payload.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf("|");
    if (separator <= 0) return undefined; // Not a revision block.
    const at = Number(line.slice(0, separator).trim());
    const content = line.slice(separator + 1).trim();
    // An update from an empty body records an empty revision
    // ("<ts> | "). It is still a serialized revision and must round-trip;
    // rejecting it would leave the marker inside the body.
    if (!Number.isFinite(at)) {
      return undefined;
    }
    history.push({ at, content });
  }
  // A serialized block always contains at least one revision.
  return history.length ? history : undefined;
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
