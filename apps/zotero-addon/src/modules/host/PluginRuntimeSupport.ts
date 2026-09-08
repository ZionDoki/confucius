import type {
  ApprovalRequest,
  ApprovalResolution,
  ConfuciusEvent,
  RuntimeTurnLease,
} from "@confucius/protocol";
import type { PluginRuntimeEventSink } from "./PluginRuntimeTypes";
import { createAbortController } from "../../utils/webPlatform";

interface EventWaiter {
  afterId?: string;
  resolve(value: PluginRuntimeEventPage): void;
  timer: number;
  signal?: AbortSignal;
  abort?: () => void;
}

export interface PluginRuntimeEventPage {
  events: ConfuciusEvent[];
  cursorFound: boolean;
}

export class PluginRuntimeEventBuffer {
  private readonly byTask = new Map<string, ConfuciusEvent[]>();
  private readonly waiters = new Map<string, Set<EventWaiter>>();
  private sequence = 0;

  sink(
    taskId: string,
    onEmit?: (type: ConfuciusEvent["type"], turnId?: string) => void,
    accepts?: () => boolean,
  ): PluginRuntimeEventSink {
    return {
      emit: (type, payload, turnId) => {
        if (accepts && !accepts()) return;
        this.append({
          id: `runtime_${Date.now().toString(36)}_${(++this.sequence).toString(36)}`,
          sessionId: taskId,
          turnId,
          type,
          ts: Date.now(),
          payload,
        } as ConfuciusEvent);
        onEmit?.(type, turnId);
      },
    };
  }

  append(event: ConfuciusEvent): void {
    const list = this.byTask.get(event.sessionId) ?? [];
    list.push(event);
    if (list.length > 1_000) list.splice(0, list.length - 1_000);
    this.byTask.set(event.sessionId, list);
    const waiting = this.waiters.get(event.sessionId);
    if (!waiting) return;
    for (const waiter of [...waiting]) {
      const page = this.page(event.sessionId, waiter.afterId);
      if (!page.events.length) continue;
      this.finishWaiter(event.sessionId, waiter, page);
    }
  }

  page(taskId: string, afterId?: string): PluginRuntimeEventPage {
    const events = this.byTask.get(taskId) ?? [];
    if (!afterId) return { events: [...events], cursorFound: true };
    const index = events.findIndex((event) => event.id === afterId);
    return {
      events: index >= 0 ? events.slice(index + 1) : [...events],
      cursorFound: index >= 0,
    };
  }

  wait(
    taskId: string,
    afterId?: string,
    waitMs = 25_000,
    signal?: AbortSignal,
  ): Promise<PluginRuntimeEventPage> {
    const immediate = this.page(taskId, afterId);
    if (immediate.events.length || waitMs <= 0 || signal?.aborted) {
      return Promise.resolve(immediate);
    }
    return new Promise<PluginRuntimeEventPage>((resolve) => {
      const waiter = {} as EventWaiter;
      waiter.afterId = afterId;
      waiter.resolve = resolve;
      waiter.signal = signal;
      waiter.timer = setTimeout(
        () => {
          this.finishWaiter(taskId, waiter, this.page(taskId, afterId));
        },
        Math.min(Math.max(waitMs, 0), 30_000),
      ) as unknown as number;
      if (signal) {
        waiter.abort = () => {
          this.finishWaiter(taskId, waiter, this.page(taskId, afterId));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      const set = this.waiters.get(taskId) ?? new Set<EventWaiter>();
      set.add(waiter);
      this.waiters.set(taskId, set);
    });
  }

  clear(taskId: string): void {
    this.byTask.delete(taskId);
    const waiters = this.waiters.get(taskId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      this.finishWaiter(taskId, waiter, { events: [], cursorFound: false });
    }
  }

  shutdown(): void {
    for (const [taskId, waiters] of this.waiters) {
      for (const waiter of [...waiters]) {
        this.finishWaiter(taskId, waiter, this.page(taskId, waiter.afterId));
      }
    }
    this.waiters.clear();
  }

  private finishWaiter(
    taskId: string,
    waiter: EventWaiter,
    page: PluginRuntimeEventPage,
  ): void {
    const set = this.waiters.get(taskId);
    if (!set?.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
    if (!set.size) this.waiters.delete(taskId);
    waiter.resolve(page);
  }
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve(resolution: ApprovalResolution): void;
}

export class PluginApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  request(request: ApprovalRequest): Promise<ApprovalResolution> {
    return new Promise<ApprovalResolution>((resolve) => {
      this.pending.set(request.id, { request, resolve });
    });
  }

  resolve(resolution: ApprovalResolution): boolean {
    const pending = this.pending.get(resolution.id);
    if (!pending) return false;
    this.pending.delete(resolution.id);
    pending.resolve(resolution);
    return true;
  }

  rejectTask(taskId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.sessionId !== taskId) continue;
      this.pending.delete(id);
      pending.resolve({ id, verdict: "deny", scope: "once" });
    }
  }
}

interface RuntimeCapability extends RuntimeTurnLease {
  token: string;
  expiresAt: number;
}

const CAPABILITY_TTL_MS = 12 * 60 * 60 * 1_000;

export class PluginRuntimeCapabilityStore {
  private readonly capabilities = new Map<string, RuntimeCapability>();
  private readonly byTask = new Map<string, string>();
  private readonly controllers = new Map<string, AbortController>();

  issue(scope: Omit<RuntimeTurnLease, "namespace">): RuntimeCapability {
    const capability = this.reserve(scope);
    this.activate(capability);
    return capability;
  }

  /** Prepared sessions can initialize transport, but cannot dispatch bound tool calls. */
  reserve(scope: Omit<RuntimeTurnLease, "namespace">): RuntimeCapability {
    const token = randomToken();
    const capability = {
      ...scope,
      namespace: randomToken(),
      token,
      expiresAt: Date.now() + CAPABILITY_TTL_MS,
    };
    this.capabilities.set(token, capability);

    this.controllers.set(capability.namespace, createAbortController());
    return { ...capability };
  }

  activate(capability: RuntimeCapability): void {
    if (
      !this.capabilities.has(capability.token) ||
      capability.expiresAt <= Date.now()
    )
      throw new Error("Prepared session lease expired");
    this.revoke(capability.taskId);
    this.byTask.set(capability.taskId, capability.token);
  }
  discard(capability: RuntimeCapability): void {
    if (this.byTask.get(capability.taskId) === capability.token)
      this.revoke(capability.taskId);
    this.controllers.get(capability.namespace)?.abort();
    this.controllers.delete(capability.namespace);
    this.capabilities.delete(capability.token);
  }

  isCurrent(lease: RuntimeTurnLease): boolean {
    const token = this.byTask.get(lease.taskId);
    const current = token ? this.resolve(token) : null;
    return (
      !!current &&
      ["taskId", "turnId", "runId", "generation", "namespace"].every(
        (key) =>
          current[key as keyof RuntimeTurnLease] ===
          lease[key as keyof RuntimeTurnLease],
      )
    );
  }

  /** Directory discovery only. Reserved leases still cannot execute tools. */
  isKnown(lease: RuntimeTurnLease): boolean {
    return [...this.capabilities.values()].some(
      (capability) =>
        capability.expiresAt > Date.now() &&
        ["taskId", "turnId", "runId", "generation", "namespace"].every(
          (key) =>
            capability[key as keyof RuntimeTurnLease] ===
            lease[key as keyof RuntimeTurnLease],
        ),
    );
  }

  signal(lease: RuntimeTurnLease): AbortSignal | undefined {
    return this.isCurrent(lease)
      ? this.controllers.get(lease.namespace)?.signal
      : undefined;
  }

  resolve(token: string): RuntimeCapability | null {
    const capability = this.capabilities.get(token);
    if (!capability) return null;
    if (capability.expiresAt <= Date.now()) {
      this.discard(capability);
      return null;
    }
    capability.expiresAt = Date.now() + CAPABILITY_TTL_MS;
    return { ...capability };
  }

  revoke(taskId: string): void {
    const token = this.byTask.get(taskId);
    const capability = token ? this.capabilities.get(token) : undefined;
    if (capability) {
      this.controllers.get(capability.namespace)?.abort();
      this.controllers.delete(capability.namespace);
      this.capabilities.delete(token!);
    }
    this.byTask.delete(taskId);
  }

  clear(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.capabilities.clear();
    this.byTask.clear();
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
