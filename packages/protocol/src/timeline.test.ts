import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConfuciusEvent } from "./events";
import {
  coalesceTimeline,
  nextReasoningFold,
  toolLineStatus,
  toolsSummary,
} from "./timeline";

function event(
  type: ConfuciusEvent["type"],
  payload: unknown,
  extra: Partial<ConfuciusEvent> = {},
): ConfuciusEvent {
  return {
    id: extra.id || type,
    sessionId: "s",
    turnId: "t",
    ts: 1,
    type,
    payload,
  } as ConfuciusEvent;
}

describe("nextReasoningFold", () => {
  it("starts at a 3-line preview, expands, then collapses to one line", () => {
    assert.equal(nextReasoningFold(undefined), "open");
    assert.equal(nextReasoningFold("preview"), "open");
    assert.equal(nextReasoningFold("open"), "compact");
    assert.equal(nextReasoningFold("compact"), "open");
  });
});

describe("coalesceTimeline", () => {
  it("groups consecutive tool calls and keeps text prominent and unfolded", () => {
    const blocks = coalesceTimeline([
      event("turn_started", { userText: "read this" }),
      event("reasoning_delta", { text: "plan " }),
      event("reasoning_delta", { text: "a search" }),
      event("tool_requested", {
        callId: "c1",
        toolName: "search_items",
        args: { q: "x" },
      }),
      event("tool_requested", {
        callId: "c2",
        toolName: "get_item",
        args: { key: "ABC" },
      }),
      event("tool_result", {
        callId: "c1",
        result: { ok: true, toolName: "search_items", data: [1] },
      }),
      event("tool_result", {
        callId: "c2",
        result: { ok: true, toolName: "get_item", data: { title: "T" } },
      }),
      event("text_delta", { text: "Here is " }),
      event("text_delta", { text: "the answer." }),
    ]);
    assert.equal(blocks[0]?.kind, "user");
    assert.equal(blocks[1]?.kind, "reasoning");
    if (blocks[1]?.kind === "reasoning") {
      assert.equal(blocks[1].text, "plan a search");
    }
    assert.equal(blocks[2]?.kind, "tools");
    if (blocks[2]?.kind === "tools") {
      assert.equal(blocks[2].calls.length, 2);
      assert.equal(blocks[2].calls[0]?.result?.ok, true);
      assert.equal(toolsSummary(blocks[2].calls), "search_items · get_item");
      assert.equal(toolLineStatus(blocks[2].calls[0]!), "ok");
    }
    assert.equal(blocks[3]?.kind, "text");
    if (blocks[3]?.kind === "text") {
      assert.equal(blocks[3].text, "Here is the answer.");
    }
  });

  it("keeps mid-turn visible text out of the tool group", () => {
    const blocks = coalesceTimeline([
      event("text_delta", { text: "I will look." }),
      event("tool_requested", {
        callId: "c1",
        toolName: "search_items",
        args: {},
      }),
      event("tool_result", {
        callId: "c1",
        result: { ok: true, toolName: "search_items", data: [] },
      }),
      event("text_delta", { text: "Done." }),
    ]);
    assert.deepEqual(
      blocks.map((block) => block.kind),
      ["text", "tools", "text"],
    );
  });

  it("merges thinking and tools into one group each until a formal answer", () => {
    const blocks = coalesceTimeline([
      event("reasoning_delta", { text: "first think" }),
      event("tool_requested", {
        callId: "c1",
        toolName: "search_items",
        args: {},
      }),
      event("tool_result", {
        callId: "c1",
        result: { ok: true, toolName: "search_items", data: [] },
      }),
      event("reasoning_delta", { text: " then more" }),
      event("tool_requested", {
        callId: "c2",
        toolName: "get_item",
        args: {},
      }),
      event("tool_result", {
        callId: "c2",
        result: { ok: true, toolName: "get_item", data: {} },
      }),
    ]);
    assert.deepEqual(
      blocks.map((block) => block.kind),
      ["reasoning", "tools"],
    );
    if (blocks[0]?.kind === "reasoning") {
      assert.equal(blocks[0].text, "first think then more");
    }
    if (blocks[1]?.kind === "tools") {
      assert.equal(blocks[1].calls.length, 2);
      assert.equal(toolsSummary(blocks[1].calls), "search_items · get_item");
    }
  });
});
