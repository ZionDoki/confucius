import type { ModelRequestProgress } from "@confucius/protocol";
import { abortError } from "./abort";
import { ModelError, type ModelTurn, type ModelUsage } from "./ModelAdapter";
import {
  scheduleModelTimeout,
  cancelModelTimeout,
  type ModelTimers,
} from "./ModelDeadline";

export function transientModelError(error: unknown): error is ModelError {
  return (
    error instanceof ModelError &&
    error.options.retryable === true &&
    ["transport", "timeout", "rate_limit", "server"].includes(error.code)
  );
}

export async function modelRetryDelay(
  ms: number,
  signal?: AbortSignal,
  timers: ModelTimers = {},
): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cancelModelTimeout(timers, handle);
      reject(abortError());
    };
    const handle = scheduleModelTimeout(
      timers,
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      ms,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One finite policy for a complete response, including failed streaming attempts. */
export async function retryModelRequest(
  work: (progress: ModelRequestProgress) => Promise<ModelTurn>,
  options: ModelTimers & {
    signal?: AbortSignal;
    requestId?: string;
    maxAttempts?: number;
    onProgress?: (progress: ModelRequestProgress) => void | Promise<void>;
  } = {},
): Promise<ModelTurn> {
  const requestId =
    options.requestId ??
    `request_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const usage: ModelUsage = {};
  const addUsage = (value?: ModelUsage) => {
    for (const key of [
      "promptTokens",
      "completionTokens",
      "totalTokens",
    ] as const)
      if (value?.[key] !== undefined)
        usage[key] = (usage[key] ?? 0) + value[key]!;
  };
  const maxAttempts = Math.max(
    1,
    Math.min(3, Math.trunc(options.maxAttempts ?? 3)),
  );
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) throw abortError();
    const progress: ModelRequestProgress = {
      requestId,
      attempt,
      maxAttempts,
      status: "started",
    };
    await options.onProgress?.(progress);
    try {
      const result = await work(progress);
      if (options.signal?.aborted) throw abortError();
      addUsage(result.usage);
      await options.onProgress?.({ ...progress, status: "completed" });
      return { ...result, ...(Object.keys(usage).length ? { usage } : {}) };
    } catch (error) {
      const retryable = !options.signal?.aborted && transientModelError(error);
      if (error instanceof ModelError) addUsage(error.options.partial?.usage);
      const delayMs = Math.min(
        30_000,
        Math.max(
          0,
          error instanceof ModelError &&
            error.options.retryAfterMs !== undefined
            ? error.options.retryAfterMs
            : 1000 * 2 ** (attempt - 1),
        ),
      );
      await options.onProgress?.({
        ...progress,
        status: "failed",
        code: error instanceof ModelError ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
        partial:
          error instanceof ModelError
            ? {
                text: error.options.partial?.text,
                reasoning: error.options.partial?.reasoning,
              }
            : undefined,
        retryable,
        exhausted: retryable && attempt === maxAttempts,
        ...(retryable && attempt < maxAttempts ? { delayMs } : {}),
      });
      if (!retryable) {
        if (error instanceof ModelError) {
          error.options.requestId = requestId;
          error.options.attempts = attempt;
          if (Object.keys(usage).length)
            error.options.partial = { ...error.options.partial, usage };
        }
        throw error;
      }
      if (attempt === maxAttempts) {
        if (error instanceof ModelError)
          throw new ModelError(error.message, error.code, {
            ...error.options,
            requestId,
            attempts: attempt,
            exhausted: retryable,
            ...(Object.keys(usage).length || error.options.partial
              ? { partial: { ...error.options.partial, usage } }
              : {}),
          });
        throw error;
      }
      await modelRetryDelay(delayMs, options.signal, options);
    }
  }
  throw new Error("Model retry policy exited unexpectedly");
}
