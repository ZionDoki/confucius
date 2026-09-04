import type { ConfuciusEvent } from "@confucius/protocol";

export function isTerminalTaskEventType(type: ConfuciusEvent["type"]): boolean {
  return (
    type === "turn_completed" ||
    type === "turn_failed" ||
    type === "turn_aborted"
  );
}

/**
 * Collapse streamed text/reasoning chunks after a turn finishes. The merged
 * event keeps the newest id so a client that already consumed the stream can
 * continue polling from its last cursor without replaying the whole history.
 */
export function compactTaskEvents(
  events: readonly ConfuciusEvent[],
  limit: number,
): ConfuciusEvent[] {
  const compacted: ConfuciusEvent[] = [];
  for (const event of events) {
    const previous = compacted.at(-1);
    if (
      previous &&
      event.turnId === previous.turnId &&
      (event.type === "text_delta" || event.type === "reasoning_delta") &&
      event.type === previous.type
    ) {
      compacted[compacted.length - 1] = {
        ...event,
        payload: {
          text: previous.payload.text + event.payload.text,
        },
      } as ConfuciusEvent;
      continue;
    }
    compacted.push(event);
  }
  return limit > 0 && compacted.length > limit
    ? compacted.slice(-limit)
    : compacted;
}
