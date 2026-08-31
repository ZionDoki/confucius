import type { ModelMessage } from "@confucius/harness";
import type { MemoryOp, MemoryRecord } from "./types";
import { isMemoryType } from "./types";

/**
 * Mem0-style consolidation: after each turn an extraction prompt sees the
 * transcript plus the most similar existing memories, and answers with a
 * strict JSON array of add/update/delete operations. Unlike Mem0 the host
 * runs the model call, so this module stays deterministic and testable.
 */

const SYSTEM_PROMPT = [
  "You maintain the long-term memory of Confucius, a research assistant.",
  "Extract durable facts worth remembering across sessions from the exchange below:",
  "user preferences and habits, ongoing research projects, opinions or assessments",
  "of specific papers, established facts about the user's field, and reusable procedures.",
  "Ignore one-off questions, transient context, and anything already covered by an",
  "existing memory unless it contradicts or refines it.",
  "",
  "Known memory types: preference, fact, project, paper, procedure, insight.",
  "",
  "Rules:",
  "- When the user explicitly asks you to remember something, ALWAYS emit an add op",
  "  (or update if an existing memory covers it). Never reply [] in that case.",
  "- One op per distinct fact; keep content to one or two sentences.",
  "- Reply with ONLY a JSON array (no prose, no code fence).",
  "",
  "Each element is one of:",
  '- {"op":"add","type":"preference","title":"short label","content":"one or two sentences","tags":["optional"],"confidence":0.0-1.0}',
  '- {"op":"update","id":"mem_x","content":"revised text","title":"optional new title","tags":["optional"]}',
  '- {"op":"delete","id":"mem_x"}',
  "",
  "Use update when a listed existing memory is contradicted or should be refined;",
  "never invent ids. Otherwise, when in doubt, reply [].",
].join("\n");

export function buildExtractionMessages(input: {
  userText: string;
  assistantText: string;
  existing: MemoryRecord[];
}): ModelMessage[] {
  const lines: string[] = [];
  lines.push(`User: ${input.userText}`);
  lines.push(`Assistant: ${input.assistantText}`);
  if (input.existing.length > 0) {
    lines.push("");
    lines.push("Existing related memories:");
    for (const record of input.existing) {
      lines.push(`- ${record.id} [${record.type}] ${record.content}`);
    }
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n") },
  ];
}

export function parseExtractionResponse(text: string): MemoryOp[] {
  const json = extractJsonArray(text);
  if (!json) {
    return [];
  }
  const ops: MemoryOp[] = [];
  for (const entry of json) {
    const op = coerceOp(entry);
    if (op) {
      ops.push(op);
    }
  }
  return ops;
}

function extractJsonArray(text: string): unknown[] | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function coerceOp(entry: unknown): MemoryOp | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const kind = String(record.op ?? "");
  if (kind === "add") {
    const content = String(record.content ?? "").trim();
    if (!content) {
      return null;
    }
    const type = isMemoryType(record.type) ? record.type : "fact";
    const title = String(record.title ?? "").trim() || content.slice(0, 64);
    return {
      op: "add",
      type,
      title,
      content,
      tags: toStringArray(record.tags),
      confidence: clamp01(record.confidence),
    };
  }
  if (kind === "update") {
    const id = String(record.id ?? "").trim();
    const content = String(record.content ?? "").trim();
    if (!id.startsWith("mem_") || !content) {
      return null;
    }
    return {
      op: "update",
      id,
      content,
      title: String(record.title ?? "").trim() || undefined,
      tags: toStringArray(record.tags),
      confidence: clamp01(record.confidence),
    };
  }
  if (kind === "delete") {
    const id = String(record.id ?? "").trim();
    if (!id.startsWith("mem_")) {
      return null;
    }
    return { op: "delete", id };
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 8);
}

function clamp01(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0.6;
  }
  return Math.min(1, Math.max(0, num));
}
