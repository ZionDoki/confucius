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
export function deadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    let cancelTimer = () => {};
    const finish = (work: () => void) => {
      if (done) return;
      done = true;
      cancelTimer();
      signal?.removeEventListener("abort", abort);
      work();
    };
    const abort = () => finish(() => reject(new ToolTimeout("Tool cancelled")));
    cancelTimer = schedule(
      () =>
        finish(() =>
          reject(
            new ToolTimeout(`Tool stage timed out after ${milliseconds} ms`),
          ),
        ),
      milliseconds,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
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
