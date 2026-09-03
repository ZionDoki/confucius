import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventBuffer } from "./eventBuffer";
import { CapabilityStore } from "./capabilities";
import { ApprovalBroker } from "./approvalBroker";

describe("sidecar event and capability isolation", () => {
  it("long-polls from a stable per-task cursor", async () => {
    const buffer = new EventBuffer();
    const sink = buffer.sink("task_a");
    const waiting = buffer.wait("task_a", undefined, 2_000);
    sink.emit("text_delta", { text: "chunk" }, "turn_a");
    const first = await waiting;
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].sessionId, "task_a");
    const cursor = first.events[0].id;
    assert.deepEqual(buffer.page("task_a", cursor).events, []);
    assert.deepEqual(buffer.page("task_b").events, []);
  });

  it("revokes a task capability without affecting another task", () => {
    const store = new CapabilityStore();
    const first = store.issue("task_a");
    const second = store.issue("task_b");
    assert.equal(store.resolve(first.token)?.taskId, "task_a");
    store.revoke("task_a");
    assert.equal(store.resolve(first.token), null);
    assert.equal(store.resolve(second.token)?.taskId, "task_b");
  });

  it("resolves only the matching approval", async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request({
      id: "approval_a",
      sessionId: "task_a",
      turnId: "turn_a",
      toolName: "runtime.command",
      args: {},
      riskLevel: "command",
      createdAt: 1,
    });
    assert.equal(
      broker.resolve({ id: "wrong", verdict: "allow", scope: "once" }),
      false,
    );
    assert.equal(
      broker.resolve({ id: "approval_a", verdict: "deny", scope: "once" }),
      true,
    );
    assert.equal((await pending).verdict, "deny");
  });
});
