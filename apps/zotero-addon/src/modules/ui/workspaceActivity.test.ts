import assert from "node:assert/strict";
import { it } from "node:test";
import type { ConfuciusEvent } from "@confucius/protocol";
import {
  contextActivity,
  retryActivity,
  turnAwaitingReply,
} from "./workspaceActivity";

it("shows context search, post-reply distillation retries and cleanup in loading", () => {
  const events: ConfuciusEvent[] = [];
  const add = (type: string, payload: unknown) =>
    events.push({
      id: String(events.length),
      sessionId: "s",
      turnId: "t",
      ts: 1000,
      type,
      payload,
    } as ConfuciusEvent);
  add("turn_started", { userText: "read" });
  add("tool_requested", {
    callId: "search",
    toolName: "context_search",
    args: {},
  });
  assert.match(contextActivity(events, false, 2000)!, /检索/);
  add("tool_result", {
    callId: "search",
    result: { ok: true, toolName: "context_search", data: {} },
  });
  assert.equal(contextActivity(events, false), undefined);
  add("turn_completed", { phase: "done" });
  add("context_progress", { stage: "distilling", status: "started" });
  add("model_request_progress", {
    requestId: "maintenance",
    purpose: "memory",
    status: "failed",
    retryable: true,
    attempt: 1,
    maxAttempts: 2,
    delayMs: 2000,
  });
  assert.equal(turnAwaitingReply(events), false);
  assert.match(
    contextActivity(events, false, 1500)!,
    /提炼.*重试.*1\/2.*2 秒后/,
  );
  add("context_progress", { stage: "distilling", status: "completed" });
  add("context_progress", { stage: "clearing", status: "started" });
  assert.match(contextActivity(events, true)!, /Clearing/);
  add("context_progress", {
    stage: "clearing",
    status: "failed",
    message: "disk unavailable",
  });
  assert.equal(contextActivity(events, true), undefined);
});

it("keeps loading visible through reasoning, retries and recovery and clears it on completion", () => {
  const events: ConfuciusEvent[] = [];
  const add = (type: string, payload: unknown, turnId = "t") =>
    events.push({
      id: String(events.length),
      sessionId: "s",
      turnId,
      type,
      payload,
      ts: 1000,
    } as ConfuciusEvent);
  add("turn_started", { userText: "read" });
  add("reasoning_delta", { text: "Public summary" });
  assert.equal(turnAwaitingReply(events), true);
  add("model_request_progress", {
    requestId: "r",
    attempt: 1,
    maxAttempts: 5,
    status: "failed",
    retryable: true,
    delayMs: 2000,
  });
  assert.match(retryActivity(events, false, 1500)!, /连接中断.*1\/5.*2 秒后/);
  add("model_request_progress", {
    requestId: "aux",
    purpose: "title",
    status: "failed",
  });
  assert.match(
    retryActivity(events, true, 1500)!,
    /Connection interrupted.*1\/5/,
  );
  add("model_request_progress", {
    requestId: "r",
    attempt: 2,
    status: "started",
    stage: "recovering",
  });
  assert.match(retryActivity(events, false)!, /正在恢复连接/);
  add("tool_requested", { callId: "p", toolName: "get_pages", args: {} });
  assert.equal(retryActivity(events, false), undefined);
  add("model_request_progress", {
    requestId: "r",
    attempt: 3,
    status: "failed",
    retryable: true,
    exhausted: true,
  });
  assert.match(retryActivity(events, false)!, /重试失败/);
  add("turn_aborted", { reason: "retries exhausted" });
  assert.equal(turnAwaitingReply(events), false);
  assert.equal(retryActivity(events, false), undefined);
  add("turn_started", { userText: "continue" }, "next");
  assert.equal(retryActivity(events, false), undefined);
});
