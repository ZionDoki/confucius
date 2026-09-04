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
