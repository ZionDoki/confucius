/** One external executor dispatch, including continuations within a host turn. */
export interface RuntimeTurnLease {
  taskId: string;
  turnId: string;
  runId: string;
  generation: number;
  namespace: string;
}
