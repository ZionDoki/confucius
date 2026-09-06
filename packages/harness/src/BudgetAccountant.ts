import type { ModelUsage } from "./ModelAdapter";

export interface BudgetLimits {
  maxIterations: number;
  maxToolCalls: number;
  maxTokens?: number;
  maxElapsedMs?: number;
}
export interface BudgetSnapshot {
  iterationsUsed: number;
  toolCallsUsed: number;
  modelAttempts: number;
  tokensUsed: number;
  /** Optional on legacy checkpoints; current snapshots include observed usage. */
  promptTokens?: number;
  completionTokens?: number;
  elapsedMs: number;
}
/** One instance is shared by every phase/continuation of a logical run. */
export class BudgetAccountant {
  iterationsUsed = 0;
  toolCallsUsed = 0;
  modelAttempts = 0;
  tokensUsed = 0;
  promptTokens = 0;
  completionTokens = 0;
  private readonly startedAt: number;
  private restoredElapsedMs = 0;
  constructor(
    private readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now,
  ) {
    for (const [name, value] of Object.entries(limits)) {
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) ||
          value < (name === "maxToolCalls" ? 0 : 1))
      )
        throw new Error(
          `${name} must be a positive safe integer${name === "maxToolCalls" ? " or zero" : ""}`,
        );
    }
    this.startedAt = now();
  }
  recordIteration(): void {
    this.iterationsUsed += 1;
  }
  recordModelAttempt(): void {
    this.modelAttempts += 1;
  }
  recordToolCalls(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("Invalid tool count");
    this.toolCallsUsed += count;
  }
  recordUsage(usage?: ModelUsage): void {
    let knownTokens = 0;
    for (const key of ["promptTokens", "completionTokens"] as const) {
      const amount = usage?.[key];
      if (amount !== undefined && Number.isFinite(amount) && amount >= 0) {
        this[key] += amount;
        knownTokens += amount;
      }
    }
    const total = usage?.totalTokens;
    this.tokensUsed +=
      total !== undefined && Number.isFinite(total) && total >= 0
        ? Math.max(total, knownTokens)
        : knownTokens;
  }

  snapshot(): BudgetSnapshot {
    return {
      iterationsUsed: this.iterationsUsed,
      toolCallsUsed: this.toolCallsUsed,
      modelAttempts: this.modelAttempts,
      tokensUsed: this.tokensUsed,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      elapsedMs:
        this.restoredElapsedMs + Math.max(0, this.now() - this.startedAt),
    };
  }
  /** Replaying an older checkpoint must never replenish a live run's budget. */
  restoreMax(snapshot: Partial<BudgetSnapshot>): void {
    for (const key of [
      "iterationsUsed",
      "toolCallsUsed",
      "modelAttempts",
      "tokensUsed",
      "promptTokens",
      "completionTokens",
    ] as const) {
      const value = snapshot[key];
      if (value !== undefined && Number.isFinite(value) && value >= 0)
        this[key] = Math.max(this[key], value);
    }
    if (
      snapshot.elapsedMs !== undefined &&
      Number.isFinite(snapshot.elapsedMs) &&
      snapshot.elapsedMs >= 0
    )
      this.restoredElapsedMs = Math.max(
        this.restoredElapsedMs,
        snapshot.elapsedMs - Math.max(0, this.now() - this.startedAt),
      );
  }
  exhaustedReason():
    "iteration_budget" | "token_budget" | "time_budget" | undefined {
    if (
      this.limits.maxElapsedMs !== undefined &&
      this.snapshot().elapsedMs >= this.limits.maxElapsedMs
    )
      return "time_budget";
    if (
      this.limits.maxTokens !== undefined &&
      this.tokensUsed >= this.limits.maxTokens
    )
      return "token_budget";
    if (this.iterationsUsed >= this.limits.maxIterations)
      return "iteration_budget";
    return undefined;
  }
  remainingElapsedMs(): number | undefined {
    return this.limits.maxElapsedMs === undefined
      ? undefined
      : Math.max(0, this.limits.maxElapsedMs - this.snapshot().elapsedMs);
  }
  canStartIteration(): boolean {
    return this.exhaustedReason() === undefined;
  }
  canRunTools(count: number): boolean {
    return (
      this.toolCallsUsed + count <= this.limits.maxToolCalls &&
      !(
        this.limits.maxTokens !== undefined &&
        this.tokensUsed >= this.limits.maxTokens
      ) &&
      !(
        this.limits.maxElapsedMs !== undefined &&
        this.snapshot().elapsedMs >= this.limits.maxElapsedMs
      )
    );
  }
  remainingToolSlots(): number {
    return Math.max(0, this.limits.maxToolCalls - this.toolCallsUsed);
  }
}
