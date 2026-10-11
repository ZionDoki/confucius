import type { ConfuciusEvent } from "@confucius/protocol";

/** Initial polls can contain history that was never mounted in this document. */
export function reviewArrivals(
  incoming: readonly ConfuciusEvent[],
  known: ReadonlySet<string>,
  openedAt: number,
  eventKey: (event: ConfuciusEvent) => string,
  afterSequence = 0,
) {
  const batchIds: string[] = [],
    workIds: string[] = [];
  for (const event of incoming) {
    if (known.has(eventKey(event))) continue;
    if (afterSequence && event.sequence !== undefined) {
      if (event.sequence <= afterSequence) continue;
    } else if (event.ts < openedAt) continue;
    if (event.type === "annotation_review_changed" && event.payload.batchId)
      batchIds.push(event.payload.batchId);
    if (event.type === "literature_updated")
      workIds.push(...(event.payload.workIds ?? []));
  }
  return { batchIds, workIds };
}
