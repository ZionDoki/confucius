import type { ConfuciusEvent } from "@confucius/protocol";
import type { RuntimeEventSink } from "./types.js";

interface Waiter {
  afterId?: string;
  resolve: (value: EventPage) => void;
  timer: NodeJS.Timeout;
}

export interface EventPage {
  events: ConfuciusEvent[];
  cursorFound: boolean;
}

export class EventBuffer {
  private readonly byTask = new Map<string, ConfuciusEvent[]>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private sequence = 0;

  sink(taskId: string): RuntimeEventSink {
    return {
      emit: (type, payload, turnId) => {
        this.append({
          id: `sidecar_${Date.now().toString(36)}_${(++this.sequence).toString(36)}`,
          sessionId: taskId,
          turnId,
          type,
          ts: Date.now(),
          payload,
        } as ConfuciusEvent);
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
      clearTimeout(waiter.timer);
      waiting.delete(waiter);
      waiter.resolve(page);
    }
  }

  page(taskId: string, afterId?: string): EventPage {
    const events = this.byTask.get(taskId) ?? [];
    if (!afterId) return { events: [...events], cursorFound: true };
    const index = events.findIndex((event) => event.id === afterId);
    return {
      events: index >= 0 ? events.slice(index + 1) : [...events],
      cursorFound: index >= 0,
    };
  }

  async wait(
    taskId: string,
    afterId?: string,
    waitMs = 25_000,
  ): Promise<EventPage> {
    const immediate = this.page(taskId, afterId);
    if (immediate.events.length || waitMs <= 0) return immediate;
    return new Promise<EventPage>((resolve) => {
      const waiter = {} as Waiter;
      waiter.afterId = afterId;
      waiter.resolve = resolve;
      waiter.timer = setTimeout(
        () => {
          this.waiters.get(taskId)?.delete(waiter);
          resolve(this.page(taskId, afterId));
        },
        Math.min(Math.max(waitMs, 0), 30_000),
      );
      const set = this.waiters.get(taskId) ?? new Set<Waiter>();
      set.add(waiter);
      this.waiters.set(taskId, set);
    });
  }

  clear(taskId: string): void {
    this.byTask.delete(taskId);
  }

  shutdown(): void {
    for (const [taskId, waiters] of this.waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(this.page(taskId, waiter.afterId));
      }
    }
    this.waiters.clear();
  }
}
