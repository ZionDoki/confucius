import type { ConfuciusEvent, ContextWindowState } from "@confucius/protocol";
import type { HistoryAppend } from "@confucius/memory";

export interface TraceBatch {
  taskId: string;
  window: ContextWindowState;
  items: HistoryAppend[];
}

/** Diagnostic projection into the existing history; never owns execution state. */
export class TaskTraceBuffer {
  private batches = new Map<
    string,
    { window: ContextWindowState; events: ConfuciusEvent[] }
  >();
  record(event: ConfuciusEvent, window: ContextWindowState): void {
    const key = `${event.sessionId}:${window.id}`;
    let batch = this.batches.get(key);
    if (!batch)
      this.batches.set(key, (batch = { window: { ...window }, events: [] }));
    batch.events.push(JSON.parse(JSON.stringify(event)) as ConfuciusEvent);
  }
  snapshot(taskId?: string): TraceBatch[] {
    return [...this.batches.values()]
      .filter((b) => !taskId || b.events[0].sessionId === taskId)
      .map((b) => {
        const first = b.events[0];
        return {
          taskId: first.sessionId,
          window: { ...b.window },
          items: [
            {
              taskId: first.sessionId,
              windowId: b.window.id,
              itemId: `trace_${first.turnId ?? "host"}_${first.id}`.replace(
                /[^\w-]/g,
                "_",
              ),
              turnId: first.turnId,
              role: "event",
              purpose: "diagnostic",
              createdAt: first.ts,
              sourceIds: [],
              content: JSON.stringify({
                kind: "confucius-trace-events",
                version: 1,
                events: b.events,
              }),
            },
          ],
        };
      });
  }
  clear(taskId: string): void {
    for (const [key, batch] of this.batches)
      if (batch.events[0]?.sessionId === taskId) this.batches.delete(key);
  }
  drain(): TraceBatch[] {
    const batches = this.snapshot();
    this.batches.clear();
    return batches;
  }
}
