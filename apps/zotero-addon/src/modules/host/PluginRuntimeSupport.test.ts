import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PluginApprovalBroker,
  PluginRuntimeCapabilityStore,
  PluginRuntimeEventBuffer,
} from "./PluginRuntimeSupport";
import { PluginRuntimeHost } from "./PluginRuntimeHost";
import type {
  PluginRuntimeEventSink,
  PluginRuntimeTurnInput,
} from "./PluginRuntimeTypes";

describe("in-plugin Runtime support", () => {
  it("rotates continuation leases and drops late output even when the host turn id is unchanged", async () => {
    const previous = Reflect.get(globalThis, "Zotero");
    Reflect.set(globalThis, "Zotero", { Prefs: { get: () => undefined } });
    const host = new PluginRuntimeHost();
    const executions: Array<{
      input: PluginRuntimeTurnInput;
      sink: PluginRuntimeEventSink;
    }> = [];
    const internals = host as unknown as {
      adapters: Map<string, unknown>;
      resolveCwd(): Promise<string>;
    };
    internals.resolveCwd = async () => "/tmp";
    internals.adapters.set("codex", {
      startTurn: async (
        input: PluginRuntimeTurnInput,
        sink: PluginRuntimeEventSink,
      ) => {
        executions.push({ input, sink });
        return { externalSessionId: "provider-session" };
      },
      interrupt: async () => {},
      dispose: async () => {},
    });
    const params = {
      backend: "codex",
      taskId: "task",
      turnId: "turn",
      runId: "run",
      generation: 1,
    };
    try {
      await host.rpc("task/startTurn", params);
      const firstLease = host.resolveCapability(executions[0].input.mcp.token)!;
      const signal = host.leaseSignal(firstLease)!;
      await host.rpc("task/startTurn", params);
      assert.equal(signal.aborted, true);
      assert.equal(host.resolveCapability(executions[0].input.mcp.token), null);
      const currentLease = host.resolveCapability(
        executions[1].input.mcp.token,
      )!;
      assert.notEqual(currentLease.namespace, firstLease.namespace);
      const before = host.eventsBuffer.page("task").events.length;
      executions[0].sink.emit("turn_completed", { phase: "done" }, "turn");
      assert.equal(host.eventsBuffer.page("task").events.length, before);
      assert.equal(host.isCurrentLease(currentLease), true);
      executions[1].sink.emit("turn_completed", { phase: "done" }, "turn");
      assert.equal(host.isCurrentLease(currentLease), false);
      assert.equal(host.eventsBuffer.page("task").events.length, before + 1);
    } finally {
      await host.shutdown();
      Reflect.set(globalThis, "Zotero", previous);
    }
  });

  it("isolates and revokes task MCP capabilities", () => {
    const store = new PluginRuntimeCapabilityStore();
    const scope = {
      taskId: "task-a",
      turnId: "turn-a",
      runId: "run-a",
      generation: 1,
    };
    const first = store.issue(scope);
    const firstSignal = store.signal(first)!;
    const repeated = store.issue(scope);
    const second = store.issue({ ...scope, taskId: "task-b" });

    assert.notEqual(repeated.token, first.token);
    assert.notEqual(repeated.namespace, first.namespace);
    assert.equal(firstSignal.aborted, true);
    assert.notEqual(second.token, first.token);
    assert.equal(store.resolve(first.token), null);
    assert.equal(store.resolve(repeated.token)?.taskId, "task-a");
    assert.equal(store.resolve(second.token)?.taskId, "task-b");
    assert.equal(store.isCurrent({ ...repeated, generation: 2 }), false);
    assert.equal(store.isCurrent({ ...repeated, runId: "other" }), false);
    assert.equal(store.isCurrent({ ...repeated, turnId: "other" }), false);

    store.revoke("task-a");
    assert.equal(store.resolve(repeated.token), null);
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
