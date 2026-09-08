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
    Reflect.set(globalThis, "Zotero", {
      Prefs: { get: () => undefined },
      Server: { port: 55831 },
    });
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
      assert.equal(
        executions[0].input.mcp.url,
        "http://127.0.0.1:55831/confucius/v1/mcp",
      );
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

describe("recoverable runtime session handoff", () => {
  for (const backend of ["codex", "kimi"] as const)
    it(`${backend} prepares without inference or replacing the old lease, then activates and releases it`, async () => {
      const previous = Reflect.get(globalThis, "Zotero");
      Reflect.set(globalThis, "Zotero", {
        Prefs: { get: () => undefined },
        Server: { port: 55831 },
      });
      const host = new PluginRuntimeHost();
      const internals = host as unknown as {
        adapters: Map<string, unknown>;
        resolveCwd(): Promise<string>;
      };
      internals.resolveCwd = async () => "/tmp";
      const calls: PluginRuntimeTurnInput[] = [],
        disposed: string[] = [];
      internals.adapters.set(backend, {
        startTurn: async (input: PluginRuntimeTurnInput) => {
          calls.push(input);
          return {
            externalSessionId: input.sessionKey ? "candidate" : "old",
            externalTurnId: input.prepareOnly ? undefined : "inference",
          };
        },
        dispose: async (id: string) => {
          disposed.push(id);
        },
        interrupt: async () => {},
      });
      const params = {
        backend,
        taskId: "task",
        runId: "run",
        turnId: "turn",
        generation: 1,
      };
      try {
        await host.rpc("task/startTurn", params);
        const old = host.resolveCapability(calls[0].mcp.token)!;
        const prepared = await host.rpc<{ externalSessionId: string }>(
          "task/prepareSession",
          { ...params, generation: 2, transactionId: "switch" },
        );
        assert.equal(prepared.externalSessionId, "candidate");
        assert.equal(calls[1].prepareOnly, true);
        assert.equal(host.isCurrentLease(old), true);
        assert.equal(
          host.isCurrentLease(host.resolveCapability(calls[1].mcp.token)!),
          false,
        );
        assert.deepEqual(disposed, []);
        await host.rpc("task/activateSession", {
          ...params,
          generation: 2,
          transactionId: "switch",
          externalSessionId: "candidate",
          prompt: "continue",
        });
        assert.equal(
          calls.length,
          3,
          "prepared session is reused without another preparation",
        );
        assert.equal(calls[2].prepareOnly, undefined);
        assert.equal(calls[2].sessionKey, calls[1].sessionKey);
        assert.equal(host.isCurrentLease(old), false);
        assert.deepEqual(disposed, ["task"]);
      } finally {
        await host.shutdown();
        Reflect.set(globalThis, "Zotero", previous);
      }
    });

  it("preparation failure leaves the old lease current, while restart activation resumes the persisted candidate identity", async () => {
    const previous = Reflect.get(globalThis, "Zotero");
    Reflect.set(globalThis, "Zotero", {
      Prefs: { get: () => undefined },
      Server: { port: 55831 },
    });
    const host = new PluginRuntimeHost();
    const internals = host as unknown as {
      adapters: Map<string, unknown>;
      resolveCwd(): Promise<string>;
    };
    internals.resolveCwd = async () => "/tmp";
    const inputs: PluginRuntimeTurnInput[] = [];
    let fail = false;
    internals.adapters.set("codex", {
      startTurn: async (input: PluginRuntimeTurnInput) => {
        inputs.push(input);
        if (fail) throw new Error("startup offline");
        return { externalSessionId: input.externalSessionId ?? "old" };
      },
      dispose: async () => {},
      interrupt: async () => {},
    });
    const params = {
      backend: "codex",
      taskId: "task",
      runId: "run",
      turnId: "turn",
      generation: 1,
    };
    try {
      await host.rpc("task/startTurn", params);
      const old = host.resolveCapability(inputs[0].mcp.token)!;
      fail = true;
      await assert.rejects(
        host.rpc("task/prepareSession", {
          ...params,
          transactionId: "failed",
          generation: 2,
        }),
        /startup offline/,
      );
      assert.equal(host.isCurrentLease(old), true);
      fail = false;
      await host.rpc("task/activateSession", {
        ...params,
        transactionId: "restored",
        generation: 3,
        externalSessionId: "persisted-candidate",
      });
      assert.equal(inputs.at(-2)?.prepareOnly, true);
      assert.equal(inputs.at(-2)?.externalSessionId, "persisted-candidate");
      assert.equal(inputs.at(-1)?.externalSessionId, "persisted-candidate");
    } finally {
      await host.shutdown();
      Reflect.set(globalThis, "Zotero", previous);
    }
  });
});
