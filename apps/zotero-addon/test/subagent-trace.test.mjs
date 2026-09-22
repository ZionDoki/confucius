import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ordinaryTimelineCalls,
  subagentTraceGroups,
  subagentWaitProgress,
} from "../src/modules/ui/subagentTrace.ts";

const event = (id, type, payload) => ({
  id,
  type,
  payload,
  sessionId: "child",
  turnId: "turn",
  ts: 1000,
});

test("subagent trace groups interleaved tool inputs, progress and results without dropping events", () => {
  const events = [
    event("a", "tool_requested", {
      callId: "a",
      toolName: "get_pages",
      args: { page: 1 },
    }),
    event("b", "tool_requested", {
      callId: "b",
      toolName: "get_outline",
      args: {},
    }),
    event("c", "tool_progress", { callId: "a", message: "Reading" }),
    event("d", "tool_result", {
      callId: "b",
      result: {
        ok: true,
        toolName: "get_outline",
        data: { headings: ["Methods"] },
      },
    }),
    event("e", "tool_result", {
      callId: "a",
      result: {
        ok: false,
        toolName: "get_pages",
        message: "PDF missing",
        code: "not_found",
      },
    }),
    event("f", "tool_progress", { callId: "a", message: "Late progress" }),
    event("g", "turn_failed", { message: "Failed to read" }),
  ];
  const groups = subagentTraceGroups(events);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups[0].events.map((e) => e.id),
    ["a", "c", "e", "f"],
  );
  assert.equal(groups[0].state, "failed");
  assert.equal(groups[0].text, "PDF missing");
  assert.equal(groups[1].label, "get_outline");
  assert.equal(groups[1].state, "completed");
  assert.equal(groups[2].text, "Failed to read");
  assert.deepEqual(
    groups.flatMap((g) => g.events.map((e) => e.id)).sort(),
    events.map((e) => e.id).sort(),
  );
});

test("long streamed output is preserved across pages and model retries remain distinct", () => {
  const chunks = Array.from({ length: 120 }, (_, i) =>
    event(`chunk-${i}`, "text_delta", {
      text: `Part ${i}. `,
      phase: "commentary",
    }),
  );
  const events = [
    event("m1", "model_request_progress", {
      requestId: "request",
      attempt: 1,
      status: "started",
    }),
    event("m2", "model_request_progress", {
      requestId: "request",
      attempt: 1,
      status: "failed",
      message: "Retryable",
    }),
    event("m3", "model_request_progress", {
      requestId: "request",
      attempt: 2,
      status: "started",
    }),
    ...chunks,
    event("m4", "model_request_progress", {
      requestId: "request",
      attempt: 2,
      status: "completed",
    }),
    event("done", "text_delta", {
      text: "Final conclusion",
      phase: "final_answer",
    }),
  ];
  const groups = subagentTraceGroups(events);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].state, "failed");
  assert.equal(groups[1].state, "completed");
  assert.equal(groups[2].text, chunks.map((e) => e.payload.text).join(""));
  assert.equal(groups[2].events.length, 120);
  assert.equal(groups[3].label, "final_answer");
  assert.equal(
    groups.reduce((n, g) => n + g.events.length, 0),
    events.length,
  );
});

test("independent subagent entries hide routine delegate calls but preserve failures and ordinary tools", () => {
  const calls = [
    { toolName: "subagent_spawn", result: { ok: true } },
    { toolName: "subagent_wait" },
    { toolName: "subagent_read", result: { ok: true } },
    {
      toolName: "subagent_spawn",
      result: { ok: false, message: "Budget exhausted" },
    },
    { toolName: "get_pages", result: { ok: true } },
  ];
  assert.deepEqual(ordinaryTimelineCalls(calls), calls.slice(3));
});

test("waiting progress uses each child's latest state and respects selected child IDs", () => {
  const update = (id, child, status) =>
    event(id, "subagent_updated", { subagent: { id: child, status } });
  const events = [
    update("1", "a", "running"),
    update("2", "b", "queued"),
    update("3", "a", "completed"),
    update("4", "c", "failed"),
  ];
  assert.deepEqual(subagentWaitProgress(events), { total: 3, settled: 2 });
  assert.deepEqual(subagentWaitProgress(events, ["b"]), {
    total: 1,
    settled: 0,
  });
});

test("retrying a child keeps reused provider call IDs in separate executions", () => {
  const events = [
    event("start1", "turn_started", {}),
    event("call1", "tool_requested", {
      callId: "call_0",
      toolName: "get_pages",
      args: { page: 1 },
    }),
    event("start2", "turn_started", {}),
    event("call2", "tool_requested", {
      callId: "call_0",
      toolName: "get_pages",
      args: { page: 2 },
    }),
    event("result2", "tool_result", {
      callId: "call_0",
      result: { ok: true, toolName: "get_pages", data: "Second attempt" },
    }),
  ];
  const groups = subagentTraceGroups(events).filter((g) => g.kind === "tool");
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].key, groups[1].key);
  assert.equal(groups[0].events.length, 1);
  assert.equal(groups[0].state, "interrupted");
  assert.equal(groups[1].events.length, 2);
});
