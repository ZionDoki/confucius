export interface BudgetLimits {
  maxIterations: number;
  maxToolCalls: number;
}

export class BudgetAccountant {
  iterationsUsed = 0;
  toolCallsUsed = 0;

  constructor(private readonly limits: BudgetLimits) {
    if (limits.maxIterations < 1) {
      throw new Error("maxIterations must be >= 1");
    }
    if (limits.maxToolCalls < 0) {
      throw new Error("maxToolCalls must be >= 0");
    }
  }

  recordIteration(): void {
    this.iterationsUsed += 1;
  }

  recordToolCalls(count: number): void {
    this.toolCallsUsed += count;
  }

  canStartIteration(): boolean {
    return this.iterationsUsed < this.limits.maxIterations;
  }

  canRunTools(count: number): boolean {
    return this.toolCallsUsed + count <= this.limits.maxToolCalls;
  }

  remainingToolSlots(): number {
    return Math.max(0, this.limits.maxToolCalls - this.toolCallsUsed);
  }
}
