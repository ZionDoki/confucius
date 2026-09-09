import assert from "node:assert/strict";
import { it } from "node:test";
import type { ConfuciusEvent } from "@confucius/protocol";
import {
  contextActivity,
  retryActivity,
  turnAwaitingReply,
  waitingTextParts,
  sendErrorInTimeline,
} from "./workspaceActivity";

it("distinguishes gateway, service, throttling and transport failures and clears retry status on success", () => {
  for (const [code, message, chinese, english] of [
    ["server", "Model HTTP 504: nginx", "网关超时", "Gateway timeout"],
    ["server", "Model HTTP 503", "模型服务异常", "Model service error"],
    ["rate_limit", "Model HTTP 429", "请求受到限流", "Rate limited"],
    ["timeout", "deadline", "请求超时", "Request timed out"],
    ["transport", "fetch failed", "连接中断", "Connection interrupted"],
    ["auth", "Model HTTP 401", "身份验证失败", "Authentication failed"],
    [
      "invalid_request",
      "Model HTTP 400",
      "模型请求无效",
      "Invalid model request",
    ],
  ]) {
    const failure: ConfuciusEvent = {
      id: "failed",
      sessionId: "s",
      turnId: "t",
      ts: 1000,
      type: "model_request_progress",
      payload: {
        requestId: "r",
        attempt: 1,
        maxAttempts: 3,
        status: "failed",
        retryable: !["auth", "invalid_request"].includes(code),
        code,
        message,
        delayMs: 1000,
      },
    };
    const started: ConfuciusEvent = {
      ...failure,
      id: "started",
      type: "turn_started",
      payload: { userText: "Read" },
    };
    assert.ok(
      retryActivity([started, failure], false, 1500)!.includes(chinese),
    );
    assert.ok(retryActivity([started, failure], true, 1500)!.includes(english));
    assert.match(
      retryActivity([started, failure], false, 1500)!,
      /1\/3.*1 秒后.*00:00/,
    );
    assert.equal(
      retryActivity(
        [
          started,
          failure,
          {
            ...failure,
            id: "completed",
            ts: 3000,
            payload: { requestId: "r", attempt: 2, status: "completed" },
          },
        ],
        false,
        3100,
      ),
      undefined,
    );
  }
});

it("shows a failed submission once after its durable error arrives, without hiding older or unrelated errors", () => {
  const failure = (id: string, message: string): ConfuciusEvent => ({
    id,
    sessionId: "s",
    turnId: id,
    ts: 1000,
    type: "turn_failed",
    payload: { message },
  });
  const message =
    "Multiple PDF attachments are available. Choose the file to use.";
  const events = [failure("old", message)];
  assert.equal(sendErrorInTimeline(message, events, "old"), false);
  assert.equal(sendErrorInTimeline(message, events, undefined), false);
  events.push(failure("current", message));
  assert.equal(sendErrorInTimeline(message, events, "old"), true);
  assert.equal(
    sendErrorInTimeline("Network unavailable", events, "old"),
    false,
  );
  assert.equal(sendErrorInTimeline(message, events, "missing-cursor"), false);
  assert.equal(
    sendErrorInTimeline(message, [failure("first", message)], null),
    true,
  );
  assert.equal(sendErrorInTimeline(message, [], null), false);
  assert.equal(
    sendErrorInTimeline(
      message,
      [
        {
          id: "reply",
          sessionId: "s",
          turnId: "new",
          ts: 1000,
          type: "text_delta",
          payload: { text: message },
        },
      ],
      null,
    ),
    false,
  );
});

it("separates the elapsed clock without losing workflow, tool, or retry details", () => {
  for (const [message, elapsed] of [
    ["正在核对证据", "00:18"],
    ["精读论文 · 正在调用工具 · get_pages", "02:07"],
    ["连接中断 · 正在重试 · 2/5 · 3 秒后", "00:04"],
    ["Reading context · Retrying request · 2/5 · in 3s", "100:09"],
    ["检查片段 00:12\n继续核对 · 方法与实验", "01:20"],
  ]) {
    assert.deepEqual(waitingTextParts(`${message} · ${elapsed}`), {
      message,
      elapsed,
    });
  }
  for (const message of ["等待模型响应", "读取片段 00:12", "Working · 00:60"])
    assert.deepEqual(waitingTextParts(message), { message, elapsed: "" });
});

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
    code: "transport",
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
  assert.match(retryActivity(events, false)!, /正在恢复任务/);
  add("tool_requested", { callId: "p", toolName: "get_pages", args: {} });
  assert.equal(retryActivity(events, false), undefined);
  add("model_request_progress", {
    requestId: "r",
    attempt: 3,
    status: "failed",
    retryable: true,
    exhausted: true,
  });
  assert.match(retryActivity(events, false)!, /请求失败/);
  add("turn_aborted", { reason: "retries exhausted" });
  assert.equal(turnAwaitingReply(events), false);
  assert.equal(retryActivity(events, false), undefined);
  add("turn_started", { userText: "continue" }, "next");
  assert.equal(retryActivity(events, false), undefined);
});
