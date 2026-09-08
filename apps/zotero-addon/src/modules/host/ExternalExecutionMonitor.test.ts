import assert from "node:assert/strict";
import { it } from "node:test";
import type { ConfuciusEvent } from "@confucius/protocol";
import { ExternalExecutionMonitor } from "./ExternalExecutionMonitor";

it("bounds silent retries, ignores poll metadata, pauses during approval and cleans up on stop", () => {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let id = 0,
    expired = 0;
  const monitor = new ExternalExecutionMonitor(() => expired++, {
    schedule: (callback, ms) => {
      pending.set(++id, { callback, ms });
      return id;
    },
    cancel: (handle) => {
      pending.delete(Number(handle));
    },
  });
  const emit = (type: string, payload: unknown) =>
    monitor.observe({ type, payload } as ConfuciusEvent);
  assert.equal(pending.get(id)?.ms, 300_000);
  emit("context_usage_updated", { inputTokens: 100 });
  assert.equal(id, 1);
  emit("model_request_progress", {
    requestId: "r",
    status: "failed",
    retryable: true,
  });
  assert.equal(pending.get(id)?.ms, 120_000);
  emit("approval_required", { request: { id: "approval" } });
  assert.equal(pending.size, 0);
  emit("tool_progress", { message: "waiting" });
  assert.equal(pending.size, 0);
  emit("approval_resolved", { resolution: { id: "approval" } });
  assert.equal(pending.size, 1);
  pending.get(id)!.callback();
  assert.equal(expired, 1);
  monitor.dispose();
  assert.equal(pending.size, 0);
});
