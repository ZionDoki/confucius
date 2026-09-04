import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PluginApprovalBroker,
  PluginRuntimeCapabilityStore,
  PluginRuntimeEventBuffer,
} from "./PluginRuntimeSupport";

describe("in-plugin Runtime support", () => {
  it("isolates and revokes task MCP capabilities", () => {
    const store = new PluginRuntimeCapabilityStore();
    const first = store.issue("task-a");
    const repeated = store.issue("task-a");
    const second = store.issue("task-b");

    assert.equal(repeated.token, first.token);
    assert.notEqual(second.token, first.token);
    assert.equal(store.resolve(first.token)?.taskId, "task-a");
    assert.equal(store.resolve(second.token)?.taskId, "task-b");

    store.revoke("task-a");
    assert.equal(store.resolve(first.token), null);
    assert.equal(store.resolve(second.token)?.taskId, "task-b");
    store.clear();
    assert.equal(store.resolve(second.token), null);
  });

  it("delivers cursor-based events without replaying earlier entries", async () => {
    const buffer = new PluginRuntimeEventBuffer();
    const sink = buffer.sink("task-a");
    sink.emit("text_delta", { text: "first" }, "turn-a");
    const first = buffer.page("task-a");
    assert.equal(first.events.length, 1);

    const waiting = buffer.wait("task-a", first.events[0].id, 1_000);
    sink.emit("text_delta", { text: "second" }, "turn-a");
    const page = await waiting;
    assert.equal(page.cursorFound, true);
    assert.equal(page.events.length, 1);
    assert.deepEqual(page.events[0].payload, { text: "second" });
    buffer.shutdown();
  });

  it("maps approval replies and rejects pending approvals on task stop", async () => {
    const broker = new PluginApprovalBroker();
    const accepted = broker.request({
      id: "approval-a",
      sessionId: "task-a",
      turnId: "turn-a",
      toolName: "runtime.command",
      args: {},
      riskLevel: "command",
      createdAt: Date.now(),
    });
    assert.equal(
      broker.resolve({ id: "approval-a", verdict: "allow", scope: "once" }),
      true,
    );
    assert.equal((await accepted).verdict, "allow");

    const rejected = broker.request({
      id: "approval-b",
      sessionId: "task-b",
      turnId: "turn-b",
      toolName: "runtime.file_change",
      args: {},
      riskLevel: "file_write",
      createdAt: Date.now(),
    });
    broker.rejectTask("task-b");
    assert.equal((await rejected).verdict, "deny");
  });
});
