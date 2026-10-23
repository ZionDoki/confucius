import type { ToolExecutionContext } from "@confucius/protocol";
export function schedule(
  callback: () => void,
  milliseconds: number,
): () => void {
  const win =
    typeof Zotero !== "undefined" ? Zotero.getMainWindow?.() : undefined;
  if (win) {
    const id = win.setTimeout(callback, milliseconds);
    return () => win.clearTimeout(id);
  }
  const id = setTimeout(callback, milliseconds);
  return () => clearTimeout(id);
}
export class ToolTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolTimeout";
  }
}
/**
 * A deadline that can be frozen while the host waits for a user decision.
 * Paused time is excluded; resume re-arms the timer with the remaining budget.
 */
export interface PausableDeadline<T> extends Promise<T> {
  pause(): void;
  resume(): void;
}
export function deadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
): PausableDeadline<T> {
  let pause = () => {};
  let resume = () => {};
  const bounded = new Promise<T>((resolve, reject) => {
    let done = false;
    let pausedAt: number | undefined;
    let deadlineAt = Date.now() + milliseconds;
    let cancelTimer = () => {};
    const finish = (work: () => void) => {
      if (done) return;
      done = true;
      cancelTimer();
      signal?.removeEventListener("abort", abort);
      work();
    };
    const arm = () => {
      const remaining = Math.max(0, deadlineAt - Date.now());
      cancelTimer = schedule(
        () =>
          finish(() =>
            reject(
              new ToolTimeout(`Tool stage timed out after ${milliseconds} ms`),
            ),
          ),
        remaining,
      );
    };
    const abort = () => finish(() => reject(new ToolTimeout("Tool cancelled")));
    pause = () => {
      if (done || pausedAt !== undefined) return;
      pausedAt = Date.now();
      cancelTimer();
      cancelTimer = () => {};
    };
    resume = () => {
      if (done || pausedAt === undefined) return;
      deadlineAt += Date.now() - pausedAt;
      pausedAt = undefined;
      arm();
    };
    arm();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
  (bounded as PausableDeadline<T>).pause = () => pause();
  (bounded as PausableDeadline<T>).resume = () => resume();
  return bounded as PausableDeadline<T>;
}
export class ToolProgress {
  private started = Date.now();
  private deadlineAt: number;
  private stage = "starting";
  private closed = false;
  private stopTimer = () => {};
  constructor(
    private context: ToolExecutionContext,
    private signal?: AbortSignal,
    totalMs = 60_000,
  ) {
    this.signal = context.executionScope?.signal ?? signal;
    this.deadlineAt = Math.min(
      this.started + totalMs,
      context.executionScope?.deadlineAt ?? Infinity,
    );
    this.tick();
  }
  private tick() {
    this.report();
    this.stopTimer = schedule(() => this.tick(), 2000);
  }
  private report() {
    if (this.closed) return;
    try {
      this.context.onProgress?.({
        stage: this.stage,
        elapsedMs: Date.now() - this.started,
      });
    } catch {
      /* Progress consumers must not alter execution semantics. */
    }
  }
  setStage(stage: string) {
    this.stage = stage;
    this.report();
  }
  get active(): boolean {
    return (
      !this.closed && !this.signal?.aborted && Date.now() < this.deadlineAt
    );
  }
  async run<T>(
    stage: string,
    limitMs: number,
    work: () => Promise<T>,
  ): Promise<T> {
    this.setStage(stage);
    if (this.signal?.aborted) throw new ToolTimeout("Tool cancelled");
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) throw new ToolTimeout("Tool total deadline exceeded");
    return deadline(work(), Math.min(limitMs, remaining), this.signal);
  }
  close() {
    this.closed = true;
    this.stopTimer();
  }
}
