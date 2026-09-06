import { abortError } from "./abort";
import { ModelError } from "./ModelAdapter";

export interface ModelTimers {
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
}
export function scheduleModelTimeout(
  timers: ModelTimers,
  callback: () => void,
  delayMs: number,
): unknown {
  return timers.scheduleTimeout
    ? timers.scheduleTimeout(callback, delayMs)
    : globalThis.setTimeout(callback, delayMs);
}
export function cancelModelTimeout(timers: ModelTimers, handle: unknown): void {
  if (timers.cancelTimeout) timers.cancelTimeout(handle);
  else globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export interface ModelTimeouts {
  firstByteMs?: number;
  idleMs?: number;
  absoluteMs?: number;
}
export const DEFAULT_MODEL_TIMEOUTS = {
  firstByteMs: 120_000,
  idleMs: 120_000,
  absoluteMs: 600_000,
} as const;

/** A race as well as an AbortSignal: even a non-cooperative fetch cannot hang the run. */
export class ModelDeadline {
  readonly signal: AbortSignal;
  private controller: AbortController;
  private failure: Promise<never>;
  private reject!: (error: Error) => void;
  private timer?: unknown;
  private absolute?: unknown;
  private first = true;
  private terminal?: Error;
  private onAbort: () => void;
  private limits: Required<ModelTimeouts>;
  constructor(
    private parent?: AbortSignal,
    limits: ModelTimeouts = {},
    create: () => AbortController = () => new AbortController(),
    private timers: ModelTimers = {},
  ) {
    this.controller = create();
    this.signal = this.controller.signal;
    this.limits = { ...DEFAULT_MODEL_TIMEOUTS, ...limits };
    for (const [key, value] of Object.entries(this.limits))
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`Invalid model timeout ${key}`);
    this.failure = new Promise((_, reject) => {
      this.reject = reject;
    });
    void this.failure.catch(() => undefined);
    this.onAbort = () => this.fail(abortError());
    parent?.addEventListener("abort", this.onAbort, { once: true });
    if (parent?.aborted) this.onAbort();
    this.arm();
    this.absolute = scheduleModelTimeout(
      this.timers,
      () =>
        this.fail(
          new ModelError("Model absolute deadline exceeded", "timeout", {
            retryable: true,
          }),
        ),
      this.limits.absoluteMs,
    );
  }
  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = error;
    this.reject(error);
    this.controller.abort(error);
  }
  private arm(): void {
    if (this.timer !== undefined) cancelModelTimeout(this.timers, this.timer);
    const first = this.first;
    this.timer = scheduleModelTimeout(
      this.timers,
      () =>
        this.fail(
          new ModelError(
            first
              ? "Model first byte deadline exceeded"
              : "Model stream idle deadline exceeded",
            "timeout",
            { retryable: true },
          ),
        ),
      first ? this.limits.firstByteMs : this.limits.idleMs,
    );
  }
  received(): void {
    this.first = false;
    this.arm();
  }
  async race<T>(promise: Promise<T>): Promise<T> {
    if (this.terminal) throw this.terminal;
    return Promise.race([promise, this.failure]);
  }
  dispose(): void {
    if (this.timer !== undefined) cancelModelTimeout(this.timers, this.timer);
    if (this.absolute !== undefined)
      cancelModelTimeout(this.timers, this.absolute);
    this.parent?.removeEventListener("abort", this.onAbort);
  }
}
