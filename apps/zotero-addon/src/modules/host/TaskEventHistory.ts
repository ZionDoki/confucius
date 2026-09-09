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
      event.type === previous.type &&
      (event.type !== "text_delta" ||
        previous.type !== "text_delta" ||
        event.payload.phase === previous.payload.phase)
    ) {
      compacted[compacted.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          text:
            previous.payload.text +
            (event.type === "text_delta" && event.payload.phase === "commentary"
              ? "\n\n"
              : "") +
            event.payload.text,
        },
      } as ConfuciusEvent;
      continue;
    }
    compacted.push(event);
  }
  if (limit <= 0 || compacted.length <= limit) return compacted;
  // A pending evidence pass must retain its saved-revision boundary through a
  // stop/restart. Losing that marker would make even fresh reads unreviewable.
  const latestArtifacts = new Map<string, ConfuciusEvent>();
  for (const event of compacted)
    if (event.type === "artifact_upserted")
      latestArtifacts.set(event.payload.artifact.id, event);
  const markers =
    limit > 1
      ? compacted
          .filter(
            (event) =>
              event.type === "artifact_upserted" &&
              event.payload.artifact.status === "draft" &&
              latestArtifacts.get(event.payload.artifact.id) === event,
          )
          .slice(1 - limit)
      : [];
  const retained = new Set(markers);
  const tail = compacted
    .filter((event) => !retained.has(event))
    .slice(-(limit - markers.length));
  for (const event of tail) retained.add(event);
  return compacted.filter((event) => retained.has(event));
}
