import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConfuciusEvent } from "@confucius/protocol";
import { compactTaskEvents } from "./TaskEventHistory";

function event(
  id: string,
  type: ConfuciusEvent["type"],
  payload: ConfuciusEvent["payload"],
  turnId = "turn-1",
): ConfuciusEvent {
  return {
    id,
    sessionId: "task-1",
    turnId,
    type,
    ts: Number(id.replace(/\D/g, "")) || 0,
    payload,
  } as ConfuciusEvent;
}

describe("compactTaskEvents", () => {
  it("preserves commentary boundaries and never merges progress into the answer", () => {
    const events = [
      event("delta-1", "text_delta", {
        text: "Reading the PDF.",
        phase: "commentary",
      }),
      event("delta-2", "text_delta", {
        text: "Checking the annotations.",
        phase: "commentary",
      }),
      event("delta-3", "text_delta", { text: "Saved ", phase: "final_answer" }),
      event("delta-4", "text_delta", {
        text: "the report.",
        phase: "final_answer",
      }),
    ];
    const compacted = compactTaskEvents(events, 400);
    assert.deepEqual(
      compacted.map((event) => event.payload),
      [
        {
          text: "Reading the PDF.\n\nChecking the annotations.",
          phase: "commentary",
        },
        { text: "Saved the report.", phase: "final_answer" },
      ],
    );
    assert.deepEqual(compactTaskEvents(compacted, 400), compacted);
  });

  it("keeps long streamed replies as one durable event with the latest cursor", () => {
    const chunks = Array.from({ length: 600 }, (_, index) =>
      event(`delta-${index}`, "text_delta", { text: "x" }),
    );
    const completed = event("terminal-1", "turn_completed", { phase: "done" });

    const result = compactTaskEvents([...chunks, completed], 400);

    assert.equal(result.length, 2);
    assert.equal(result[0].id, "delta-599");
    assert.equal(result[0].type, "text_delta");
    if (result[0].type === "text_delta") {
      assert.equal(result[0].payload.text.length, 600);
    }
    assert.equal(result[1].id, "terminal-1");
  });

  it("does not merge text across tool activity and applies the final cap", () => {
    const result = compactTaskEvents(
      [
        event("delta-1", "text_delta", { text: "before" }),
        event("tool-1", "tool_requested", {
          callId: "call-1",
          toolName: "search_items",
          args: {},
        }),
        event("delta-2", "text_delta", { text: "after" }),
      ],
      2,
    );

    assert.deepEqual(
      result.map((item) => item.id),
      ["tool-1", "delta-2"],
    );
  });
});
