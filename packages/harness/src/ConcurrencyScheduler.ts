import type { ToolRuntimeMeta } from "@confucius/protocol";

export interface ScheduledCall {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export function assertParallelSafeInvariant(meta: ToolRuntimeMeta): void {
  if (meta.concurrency === "parallel_safe" && meta.mutatesState) {
    throw new Error(
      `Tool "${meta.name}" is parallel_safe but mutatesState=true`,
    );
  }
}

export function splitBatches(
  calls: ScheduledCall[],
  getMeta: (name: string) => ToolRuntimeMeta | null,
): ScheduledCall[][] {
  const batches: ScheduledCall[][] = [];
  let parallel: ScheduledCall[] = [];

  const flushParallel = () => {
    if (parallel.length > 0) {
      batches.push(parallel);
      parallel = [];
    }
  };

  for (const call of calls) {
    const meta = getMeta(call.toolName);
    if (meta) {
      assertParallelSafeInvariant(meta);
    }
    const parallelSafe =
      meta?.concurrency === "parallel_safe" && meta.mutatesState === false;
    if (parallelSafe) {
      parallel.push(call);
    } else {
      flushParallel();
      batches.push([call]);
    }
  }
  flushParallel();
  return batches;
}
