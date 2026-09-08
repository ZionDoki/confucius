/** Shared limits for storage, retrieval, maintenance and model input admission. */
export const CONTEXT_POLICY = Object.freeze({
  recentTasks: 10,
  recentDays: 30,
  recentBytes: 50 * 1024 * 1024,
  memoryEntries: 200,
  memoryTokens: 16_000,
  memoryIdleDays: 90,
  searchResults: 8,
  searchTokens: 1_500,
  readTokens: 4_000,
  maintenanceInputTokens: 8_000,
  maintenanceOutputTokens: 1_000,
  maintenanceAttempts: 2,
  handoffAttempts: 1,
  handoffTokens: 2_000,
  archiveDays: 90,
  archiveBytes: 500 * 1024 * 1024,
  parallelReads: 4,
  freshWindowRatio: 0.6,
  indexCacheWindows: 16,
  indexCacheBytes: 16 * 1024 * 1024,
});

/** Conservative mixed-language estimate; actual provider usage remains separate. */
export function contextTextTokens(text: string): number {
  let weight = 0;
  for (const char of text) weight += char.charCodeAt(0) < 128 ? 1 / 3.5 : 1.5;
  return Math.ceil(weight);
}

/** Bound a label in UTF-16 characters without leaving half an emoji for UTF-8 IO. */
export function contextTextHead(text: string, maxCharacters: number): string {
  const prefix = text.slice(0, Math.max(0, maxCharacters));
  return prefix.replace(/[\uD800-\uDBFF]$/, "");
}

/** Never split a surrogate pair; offsets are stable UTF-16 character positions. */
export function contextTextSlice(text: string, maxTokens: number, offset = 0) {
  let start = Math.max(
    0,
    Math.min(text.length, Number.isFinite(offset) ? Math.trunc(offset) : 0),
  );
  if (
    start > 0 &&
    /[\uDC00-\uDFFF]/.test(text[start] ?? "") &&
    /[\uD800-\uDBFF]/.test(text[start - 1])
  )
    start--;
  let end = start;
  let weight = 0;
  for (const char of text.slice(start)) {
    const next = char.charCodeAt(0) < 128 ? 1 / 3.5 : 1.5;
    if (weight + next > Math.max(0, maxTokens)) break;
    weight += next;
    end += char.length;
  }
  return {
    content: text.slice(start, end),
    tokens: Math.ceil(weight),
    nextOffset: end < text.length ? end : null,
  };
}

/** One admission calculation for direct requests and host-visible CLI input. */
export function contextInputLimit(capacity: number, output = 4096): number {
  return Math.max(
    0,
    capacity - output - Math.max(1000, Math.ceil(capacity * 0.1)),
  );
}
export function contextReadBudget(
  capacity: number,
  used: number,
  parallel = 1,
  output = 4096,
): number {
  const remaining =
    contextInputLimit(capacity, output) - Math.max(0, used) - 256;
  return Math.max(
    128,
    Math.min(
      CONTEXT_POLICY.readTokens,
      Math.floor(remaining / Math.max(1, parallel)),
    ),
  );
}
