export interface TurnCheckpoint {
  turnId: string;
  iteration: number;
  savedAt: number;
  messages: unknown[];
  toolExecutions: ToolExecutionCheckpoint[];
}

export interface ToolExecutionCheckpoint {
  callId: string;
  modelCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "started" | "completed" | "failed";
  result?: unknown;
}

export class MemoryCheckpointStore {
  private readonly byTurn = new Map<string, TurnCheckpoint[]>();

  save(checkpoint: TurnCheckpoint): void {
    const list = this.byTurn.get(checkpoint.turnId) ?? [];
    list.push(checkpoint);
    this.byTurn.set(checkpoint.turnId, list);
  }

  latest(turnId: string): TurnCheckpoint | undefined {
    const list = this.byTurn.get(turnId);
    return list?.[list.length - 1];
  }

  count(turnId: string): number {
    return this.byTurn.get(turnId)?.length ?? 0;
  }
}
