import {
  coalesceTimeline,
  type ConfuciusEvent,
  type TimelineBlock,
} from "@confucius/protocol";

/** Keys are local to a durable turn, so new text and earlier tool results do not replace unrelated turns. */
export function keyedTimeline(
  events: ConfuciusEvent[],
): Array<{ key: string; block: TimelineBlock }> {
  const groups: Array<{ id: string; events: ConfuciusEvent[] }> = [];
  for (const event of events) {
    const last = groups.at(-1);
    const id = event.turnId ?? last?.id ?? event.id;
    if (last?.id === id) last.events.push(event);
    else groups.push({ id, events: [event] });
  }
  return groups.flatMap((group) => {
    const counts = new Map<string, number>();
    return coalesceTimeline(group.events).map((block) => {
      const count = counts.get(block.kind) ?? 0;
      counts.set(block.kind, count + 1);
      const id =
        block.kind === "artifact"
          ? `${block.artifact.id}:${block.artifact.revision}`
          : block.kind === "tools"
            ? block.calls[0]?.callId
            : block.kind === "command"
              ? block.callId
              : count;
      return { key: `${group.id}:${block.kind}:${id}`, block };
    });
  });
}

/** Keep unchanged DOM, open details, selection, and focused controls while the stream grows. */
export function reconcileActivity(
  current: HTMLElement,
  next: HTMLElement,
): void {
  const old = new Map(
    Array.from(current.children).map((node) => [
      (node as HTMLElement).dataset.entryId,
      node as HTMLElement,
    ]),
  );
  let cursor: Node | null = current.firstChild;
  for (const fresh of Array.from(next.children) as HTMLElement[]) {
    const previous = fresh.dataset.entryId
      ? old.get(fresh.dataset.entryId)
      : undefined;
    let chosen = fresh;
    if (previous) {
      // Generated signatures exclude transient state such as an opened details element.
      const signature = String(fresh.outerHTML);
      if (
        previous.dataset.renderSignature === signature ||
        previous.contains(current.ownerDocument?.activeElement ?? null)
      ) {
        chosen = previous;
      } else {
        const details = previous.querySelectorAll("details");
        fresh
          .querySelectorAll("details")
          .forEach((detail: HTMLDetailsElement, index: number) => {
            detail.open =
              (details[index] as HTMLDetailsElement | undefined)?.open ??
              detail.open;
          });
        fresh.dataset.renderSignature = signature;
      }
    } else fresh.dataset.renderSignature = String(fresh.outerHTML);
    if (chosen !== cursor) current.insertBefore(chosen, cursor);
    cursor = chosen.nextSibling;
  }
  while (cursor) {
    const nextNode = cursor.nextSibling;
    current.removeChild(cursor);
    cursor = nextNode;
  }
}
