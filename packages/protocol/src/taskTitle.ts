export const MAX_TASK_TITLE_LENGTH = 48;

export type TaskTitleState = "pending" | "generated" | "fallback" | "fixed";

const PLACEHOLDERS = new Set([
  "",
  "untitled",
  "untitled research task",
  "research task",
  "未命名研究任务",
]);

export function isTaskTitleState(value: unknown): value is TaskTitleState {
  return (
    value === "pending" ||
    value === "generated" ||
    value === "fallback" ||
    value === "fixed"
  );
}

export function isPlaceholderTaskTitle(value: unknown): boolean {
  return PLACEHOLDERS.has(
    String(value ?? "")
      .trim()
      .toLocaleLowerCase(),
  );
}

/** Build the immediate, deterministic title shown as soon as the first turn starts. */
export function temporaryTaskTitle(
  userText: string,
  fallback = "Research task",
): string {
  const cleaned = cleanTaskTitleSource(userText);
  return clipTitle(
    cleaned || cleanTaskTitleSource(fallback) || "Research task",
  );
}

/** Deterministic recovery when title analysis is unavailable or invalid. */
export function fallbackTaskTitle(
  userText: string,
  assistantText = "",
  fallback = "Research task",
): string {
  const fromUser = cleanTaskTitleSource(userText);
  const fromAssistant = cleanTaskTitleSource(assistantText);
  return clipTitle(fromUser || fromAssistant || cleanTaskTitleSource(fallback));
}

/**
 * Accept a model-produced title only when it is a single, plain-text line in
 * the same broad script as the request. The caller falls back locally when
 * this returns null.
 */
export function sanitizeGeneratedTaskTitle(
  value: unknown,
  userText: string,
): string | null {
  if (typeof value !== "string") return null;
  let raw = value.trim();
  if (!raw || /[\r\n\u0000-\u001f\u007f]/.test(raw)) return null;
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("“") && raw.endsWith("”")) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  const cleaned = cleanTaskTitleSource(raw);
  if (!cleaned || isPlaceholderTaskTitle(cleaned)) return null;
  if (Array.from(cleaned).length > MAX_TASK_TITLE_LENGTH) return null;
  const userUsesCjk = /[\u3400-\u9fff]/u.test(userText);
  if (userUsesCjk && !/[\u3400-\u9fff]/u.test(cleaned)) return null;
  const userUsesLatin = /\p{Script=Latin}/u.test(userText);
  if (!userUsesCjk && userUsesLatin && !/\p{Script=Latin}/u.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function cleanTaskTitleSource(value: string): string {
  return String(value ?? "")
    .replace(/^\s*\/[\p{L}\p{N}_-]+\s*/u, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/gi, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_~#>|]/g, " ")
    .replace(/^\s*[-+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。！？.!?].*$/u, "")
    .trim();
}

function clipTitle(value: string): string {
  const chars = Array.from(value.trim());
  return chars.length <= MAX_TASK_TITLE_LENGTH
    ? chars.join("")
    : `${chars.slice(0, MAX_TASK_TITLE_LENGTH - 1).join("")}…`;
}
