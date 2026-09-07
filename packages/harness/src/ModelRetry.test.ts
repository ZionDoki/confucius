import assert from "node:assert/strict";
import { test } from "node:test";
import { retryModelRequest } from "./ModelRetry";
import { ModelError } from "./ModelAdapter";
import { OpenAICompatibleAdapter } from "./OpenAICompatibleAdapter";
import {
  visibleModelEvents,
  type ConfuciusEvent,
  type ModelRequestProgress,
} from "@confucius/protocol";

const fast = {
  scheduleTimeout: (callback: () => void) => setTimeout(callback, 0),
  cancelTimeout: (id: unknown) =>
    clearTimeout(id as ReturnType<typeof setTimeout>),
};
test("each logical request gets three attempts, isolated IDs, backoff and cumulative usage", async () => {
  const progress: ModelRequestProgress[] = [];
  for (let request = 0; request < 2; request++) {
    let calls = 0;
    const result = await retryModelRequest(
      async () => {
        calls++;
        if (calls < 3)
          throw new ModelError("lost stream", "timeout", {
            retryable: true,
            partial: { text: "incomplete", usage: { totalTokens: 2 } },
          });
        return { text: "complete", usage: { totalTokens: 5 } };
      },
      {
        ...fast,
        onProgress: (p) => {
          progress.push(p);
        },
      },
    );
    assert.equal(calls, 3);
    assert.equal(result.text, "complete");
    assert.equal(result.usage?.totalTokens, 9);
  }
  assert.equal(new Set(progress.map((p) => p.requestId)).size, 2);
  assert.deepEqual(
    progress.filter((p) => p.status === "failed").map((p) => p.delayMs),
    [1000, 2000, 1000, 2000],
  );
});
test("exhaustion is explicit, permanent errors preserve identity, cancellation interrupts backoff", async () => {
  await assert.rejects(
    retryModelRequest(async () => {
      throw new ModelError("timeout", "timeout", { retryable: true });
    }, fast),
    (error: ModelError) =>
      error.options.exhausted === true && error.options.attempts === 3,
  );
  const permanent = new ModelError("denied", "auth");
  await assert.rejects(
    retryModelRequest(async () => {
      throw permanent;
    }, fast),
    (error) => error === permanent,
  );
  const controller = new AbortController();
  let calls = 0;
  const pending = retryModelRequest(
    async () => {
      calls++;
      throw new ModelError("offline", "transport", { retryable: true });
    },
    {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.status === "failed") controller.abort();
      },
    },
  );
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
});
test("a failed stream is replaced and its incomplete tools never become a result", async () => {
  let calls = 0;
  const events: ConfuciusEvent[] = [];
  const add = (type: string, payload: unknown) =>
    events.push({
      id: String(events.length),
      sessionId: "task",
      ts: 0,
      type,
      payload,
    } as ConfuciusEvent);
  const adapter = new OpenAICompatibleAdapter({
    apiKey: "",
    baseUrl: "https://example.test/v1",
    model: "test",
    stream: true,
    scheduleTimeout: (cb, ms) =>
      setTimeout(cb, ms === 1000 || ms === 2000 ? 0 : ms),
    cancelTimeout: fast.cancelTimeout,
    onTextDelta: (text, p) =>
      add("text_delta", { text, requestId: p?.requestId, attempt: p?.attempt }),
    onRequestProgress: (p) => {
      add("model_request_progress", p);
    },
    fetchImpl: async () => {
      calls++;
      const data =
        calls === 1
          ? 'data: {"choices":[{"delta":{"content":"discard me"}}]}\n\n'
          : 'data: {"choices":[{"delta":{"content":"saved answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new Response(data, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const result = await adapter.complete({
    messages: [{ role: "user", content: "go" }],
  });
  assert.equal(calls, 2);
  assert.equal(result.text, "saved answer");
  assert.equal(result.toolCalls?.length ?? 0, 0);
  assert.equal(
    visibleModelEvents(events)
      .filter((e) => e.type === "text_delta")
      .map((e) => e.payload.text)
      .join(""),
    "saved answer",
  );
  assert.ok(
    events.some(
      (e) => e.type === "text_delta" && e.payload.text === "discard me",
    ),
  );
});
test("HTTP 408 is transient and Retry-After is honored without nested HTTP retries", async () => {
  let calls = 0;
  const delays: number[] = [];
  const adapter = new OpenAICompatibleAdapter({
    apiKey: "",
    baseUrl: "https://example.test",
    model: "test",
    stream: false,
    scheduleTimeout: (cb, ms) => {
      if (ms === 7000) delays.push(ms);
      return setTimeout(cb, ms === 7000 ? 0 : ms);
    },
    cancelTimeout: fast.cancelTimeout,
    fetchImpl: async () =>
      ++calls < 3
        ? new Response("wait", { status: 408, headers: { "retry-after": "7" } })
        : Response.json({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
  });
  assert.equal((await adapter.complete({ messages: [] })).text, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [7000, 7000]);
});
