import assert from "node:assert/strict";
import { it } from "node:test";
import { CodexOutputTracker } from "./codexOutput";
import { coalesceTimeline } from "./timeline";
import type { ConfuciusEvent } from "./events";

it("preserves streamed commentary whitespace, fills completed suffixes and deduplicates replay", () => {
  const events: ConfuciusEvent[] = [];
  const output = new CodexOutputTracker((type, payload) =>
    events.push({
      type,
      payload,
      ts: 1,
      id: String(events.length),
      sessionId: "s",
      turnId: "t",
    } as ConfuciusEvent),
  );
  output.observe("item/started", {
    item: { id: "a", type: "agentMessage", phase: "commentary" },
  });
  for (const delta of ["I", " ", "will"])
    output.observe("item/agentMessage/delta", { itemId: "a", delta });
  const item = {
    id: "a",
    type: "agentMessage",
    phase: "commentary",
    text: "I will read.",
  };
  output.observe("item/completed", { item });
  output.observe("item/completed", { item });
  output.observe("item/agentMessage/delta", { itemId: "a", delta: "read." });
  assert.deepEqual(coalesceTimeline(events), [
    { kind: "commentary", text: "I will read." },
  ]);
  output.observe("item/completed", {
    item: {
      id: "f",
      type: "agentMessage",
      text: "Report ready.",
      phase: "final_answer",
    },
  });
  assert.equal(
    events.at(-1)?.payload && (events.at(-1)!.payload as { text: string }).text,
    "Report ready.",
  );
});

it("fills public reasoning parts independently and resets only unfinished items on retry", () => {
  const text: string[] = [];
  const output = new CodexOutputTracker((_type, payload) =>
    text.push(payload.text),
  );
  output.observe("item/reasoning/summaryTextDelta", {
    itemId: "r",
    summaryIndex: 0,
    delta: "First",
  });
  const item = {
    id: "r",
    type: "reasoning",
    summary: ["First summary.", "Second summary."],
    content: [],
  };
  output.observe("item/completed", { item });
  output.observe("item/completed", { item });
  assert.equal(text.join(""), "First summary.\n\nSecond summary.");
  output.observe("item/agentMessage/delta", { itemId: "f", delta: "Failed" });
  output.discardIncomplete();
  output.observe("item/completed", {
    item: {
      id: "f",
      type: "agentMessage",
      text: "Replacement",
      phase: "final_answer",
    },
  });
  assert.equal(text.at(-1), "Replacement");
});
