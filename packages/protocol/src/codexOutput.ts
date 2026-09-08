import type { ConfuciusEvent } from "./events";

type Output = Extract<
  ConfuciusEvent,
  { type: "text_delta" | "reasoning_delta" }
>;
type Phase = "commentary" | "final_answer";
type Emit = (type: Output["type"], payload: Output["payload"]) => void;
const phaseOf = (value: unknown): Phase | undefined =>
  value === "commentary" || value === "final_answer" ? value : undefined;

/** Cumulative completed items fill missing deltas; item IDs prevent replay duplicates. */
export class CodexOutputTracker {
  private items = new Map<
    string,
    { text: string; phase?: Phase; complete: boolean }
  >();
  constructor(private emit: Emit) {}
  discardIncomplete(): void {
    for (const [key, item] of this.items)
      if (!item.complete) this.items.delete(key);
  }

  observe(method: string, params: Record<string, unknown>): void {
    if (method === "item/started" || method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      if (!item || typeof item.id !== "string") return;
      if (item.type === "agentMessage") {
        const key = `text:${item.id}`;
        const previous = this.items.get(key);
        const phase = phaseOf(item.phase) ?? previous?.phase;
        if (method === "item/started") {
          if (!previous)
            this.items.set(key, { text: "", phase, complete: false });
          else previous.phase = phase;
        } else {
          this.append(key, item.id, String(item.text ?? ""), true, phase);
          // A completed item can be the first place older servers report phase.
          if (phase === "commentary" && previous?.phase !== phase)
            this.emit("text_delta", { text: "", phase, itemId: item.id });
        }
      } else if (item.type === "reasoning" && method === "item/completed") {
        for (const source of ["summary", "content"] as const) {
          if (!Array.isArray(item[source])) continue;
          (item[source] as unknown[]).forEach((text, index) => {
            if (typeof text === "string")
              this.append(
                `${source}:${item.id}:${index}`,
                item.id as string,
                text,
                true,
                undefined,
                source,
                index,
              );
          });
        }
      }
      return;
    }
    const itemId = typeof params.itemId === "string" ? params.itemId : "legacy";
    if (method === "item/agentMessage/delta") {
      const key = `text:${itemId}`;
      this.append(
        key,
        itemId,
        String(params.delta ?? ""),
        false,
        this.items.get(key)?.phase,
      );
    } else if (
      method === "item/reasoning/summaryTextDelta" ||
      method === "item/reasoning/textDelta"
    ) {
      const source =
        method === "item/reasoning/summaryTextDelta" ? "summary" : "content";
      const index = Number(params.summaryIndex ?? params.contentIndex ?? 0);
      this.append(
        `${source}:${itemId}:${index}`,
        itemId,
        String(params.delta ?? ""),
        false,
        undefined,
        source,
        index,
      );
    }
  }

  private append(
    key: string,
    itemId: string,
    value: string,
    completed: boolean,
    phase?: Phase,
    source?: "summary" | "content",
    index = 0,
  ): void {
    const previous = this.items.get(key);
    if (previous?.complete) return;
    const seen = previous?.text ?? "";
    // The server's completed text is cumulative. Never append a conflicting
    // snapshot onto an already streamed prefix and manufacture a new sentence.
    const delta = completed
      ? value.startsWith(seen)
        ? value.slice(seen.length)
        : ""
      : value;
    this.items.set(key, {
      text: completed ? value : seen + value,
      phase,
      complete: completed,
    });
    if (!delta) return;
    if (source)
      this.emit("reasoning_delta", {
        text: (!seen && index > 0 ? "\n\n" : "") + delta,
        itemId,
        source,
      });
    else
      this.emit("text_delta", {
        text: delta,
        itemId,
        ...(phase ? { phase } : {}),
      });
  }
}
