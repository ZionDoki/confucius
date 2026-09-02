/**
 * History budget derived from the model's context window.
 *
 * The working transcript is a scarce resource: system prompt, tool schemas,
 * memory injection, and the model's own output all share the same window.
 * Compaction should fire against that real budget — not a fixed character
 * cap — so a 8k local model and a 128k hosted model behave differently.
 */

export const CHARS_PER_TOKEN = 3.5;
export const SYSTEM_AND_TOOLS_RESERVE_TOKENS = 6_000;
export const SAFETY_RESERVE_TOKENS = 1_000;
export const COMPACT_RATIO = 0.7;
export const MIN_HISTORY_TOKENS = 2_000;
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 4_096;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;

export interface HistoryBudgetInput {
  contextWindowTokens: number;
  /** 0 / omitted means "server default"; we still reserve a conservative output slice. */
  maxOutputTokens?: number;
}

/**
 * Character budget for persisted conversation history (system prompt excluded).
 * Compact when `estimateChars(messages)` exceeds this value.
 */
export function historyBudgetChars(input: HistoryBudgetInput): number {
  const window = Math.max(
    1,
    Math.floor(input.contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS),
  );
  const output =
    Number.isFinite(input.maxOutputTokens) && (input.maxOutputTokens ?? 0) > 0
      ? Math.floor(input.maxOutputTokens as number)
      : DEFAULT_OUTPUT_RESERVE_TOKENS;
  const reserved =
    SYSTEM_AND_TOOLS_RESERVE_TOKENS + output + SAFETY_RESERVE_TOKENS;
  const usable = Math.max(MIN_HISTORY_TOKENS, window - reserved);
  return Math.max(1_000, Math.floor(usable * COMPACT_RATIO * CHARS_PER_TOKEN));
}

export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) {
    return 0;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
