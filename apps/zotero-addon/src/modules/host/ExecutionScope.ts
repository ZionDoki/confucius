import type { ToolExecutionScope } from "@confucius/protocol";
import { createAbortController } from "../../utils/webPlatform";
import { deadline, ToolTimeout } from "../tools/Deadline";

export interface OwnedExecutionScope extends ToolExecutionScope {
  abort(): void;
  dispose(): void;
  pause(): void;
  resume(): void;
}

/** A child inherits its parent's absolute limit; stages cannot reset it. */
export function createExecutionScope(
  options: {
    signal?: AbortSignal;
    deadlineAt?: number;
    timeoutMs?: number;
  } = {},
): OwnedExecutionScope {
  const controller = createAbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let deadlineAt = Math.min(
    options.deadlineAt ?? Infinity,
    Date.now() + (options.timeoutMs ?? 120_000),
  );
  let pausedAt: number | undefined;
  return {
    get deadlineAt() {
      return pausedAt === undefined
        ? deadlineAt
        : deadlineAt + Date.now() - pausedAt;
    },
    signal: controller.signal,
    abort,
    pause() {
      pausedAt ??= Date.now();
    },
    resume() {
      if (pausedAt === undefined) return;
      deadlineAt += Date.now() - pausedAt;
      pausedAt = undefined;
    },
    dispose: () => options.signal?.removeEventListener("abort", abort),
  };
}

export function remainingMs(scope: ToolExecutionScope): number {
  return Math.max(0, scope.deadlineAt - Date.now());
}

export function throwIfScopeExpired(scope: ToolExecutionScope): void {
  if (scope.signal.aborted) throw new ToolTimeout("Tool cancelled");
  if (remainingMs(scope) <= 0)
    throw new ToolTimeout("Tool total deadline exceeded");
}

/** Bounds waiting without pretending that an unabortable native call stopped. */
export function runInScope<T>(
  scope: ToolExecutionScope,
  work: () => Promise<T>,
): Promise<T> {
  throwIfScopeExpired(scope);
  return deadline(
    Promise.resolve().then(() => {
      throwIfScopeExpired(scope);
      return work();
    }),
    remainingMs(scope),
    scope.signal,
  );
}
