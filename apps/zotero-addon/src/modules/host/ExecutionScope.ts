import type { ToolExecutionScope } from "@confucius/protocol";
import { createAbortController } from "../../utils/webPlatform";
import {
  deadline,
  ToolTimeout,
  type PausableDeadline,
} from "../tools/Deadline";

export interface OwnedExecutionScope extends ToolExecutionScope {
  abort(): void;
  dispose(): void;
  pause(): void;
  resume(): void;
}

interface ScopeControl {
  paused(): boolean;
  track(timer: PausableDeadline<unknown>): void;
}
const controls = new WeakMap<ToolExecutionScope, ScopeControl>();

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
  // Deadlines armed by runInScope in this scope. A pause must stop the timers
  // too, not merely move the absolute deadline the timers were derived from.
  const timers = new Set<PausableDeadline<unknown>>();
  const scope: OwnedExecutionScope = {
    get deadlineAt() {
      return pausedAt === undefined
        ? deadlineAt
        : deadlineAt + Date.now() - pausedAt;
    },
    signal: controller.signal,
    abort,
    pause() {
      if (pausedAt !== undefined) return;
      pausedAt = Date.now();
      for (const timer of timers) timer.pause();
    },
    resume() {
      if (pausedAt === undefined) return;
      deadlineAt += Date.now() - pausedAt;
      pausedAt = undefined;
      for (const timer of timers) timer.resume();
    },
    dispose: () => options.signal?.removeEventListener("abort", abort),
  };
  controls.set(scope, {
    paused: () => pausedAt !== undefined,
    track(timer) {
      timers.add(timer);
      if (pausedAt !== undefined) timer.pause();
      const done = () => timers.delete(timer);
      void timer.then(done, done);
    },
  });
  return scope;
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
  const timer = deadline(
    Promise.resolve().then(() => {
      throwIfScopeExpired(scope);
      return work();
    }),
    remainingMs(scope),
    scope.signal,
  );
  controls.get(scope)?.track(timer as PausableDeadline<unknown>);
  return timer;
}
