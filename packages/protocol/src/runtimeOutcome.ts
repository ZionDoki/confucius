export interface RuntimeOutcome {
  phase: "done" | "failed" | "aborted";
  status: "completed" | "failed" | "interrupted";
  stopReason:
    | "completed"
    | "aborted"
    | "length"
    | "iteration_budget"
    | "content_filter"
    | "incomplete"
    | "error";
}

/** A transport response is final only when the provider explicitly says so. */
export function runtimeOutcome(
  backend: "codex" | "kimi",
  value: unknown,
): RuntimeOutcome {
  if (value === (backend === "codex" ? "completed" : "end_turn"))
    return { phase: "done", status: "completed", stopReason: "completed" };
  if (value === "refusal")
    return { phase: "failed", status: "failed", stopReason: "content_filter" };
  if (value === "failed")
    return { phase: "failed", status: "failed", stopReason: "error" };
  const stopReason =
    value === "cancelled" || value === "interrupted"
      ? "aborted"
      : value === "max_tokens"
        ? "length"
        : value === "max_turn_requests"
          ? "iteration_budget"
          : "incomplete";
  return { phase: "aborted", status: "interrupted", stopReason };
}

export interface RuntimeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Deduplicate provider cumulative counts without charging restored history. */
export class RuntimeUsageCounter {
  private previous?: RuntimeTokenUsage;
  constructor(private readonly freshSession = true) {}

  observe(value: unknown): RuntimeTokenUsage | undefined {
    if (!value || typeof value !== "object") return undefined;
    const usage = value as RuntimeTokenUsage;
    if (
      ![usage.inputTokens, usage.outputTokens, usage.totalTokens].every(
        (count) => Number.isSafeInteger(count) && count >= 0,
      )
    )
      return undefined;
    const previous = this.previous;
    this.previous = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    };
    if (!previous && !this.freshSession) return undefined;
    if (
      previous &&
      (usage.inputTokens < previous.inputTokens ||
        usage.outputTokens < previous.outputTokens ||
        usage.totalTokens < previous.totalTokens)
    )
      return undefined;
    const delta = {
      inputTokens: usage.inputTokens - (previous?.inputTokens ?? 0),
      outputTokens: usage.outputTokens - (previous?.outputTokens ?? 0),
      totalTokens: usage.totalTokens - (previous?.totalTokens ?? 0),
    };
    return delta.inputTokens || delta.outputTokens || delta.totalTokens
      ? delta
      : undefined;
  }
}
