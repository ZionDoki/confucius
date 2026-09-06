import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolProvider } from "@confucius/harness";
import type { ToolExecutionContext, ToolResult } from "@confucius/protocol";
import { ToolExecutionService, canonical } from "./ReliableToolProvider";
import { memoryJsonStorage, type JsonStorage } from "./RuntimeStorage";
import { OperationStore } from "./OperationStore";
import { registerHostOperationDomains } from "./HostOperationDomains";
import type { ArtifactRecord } from "@confucius/protocol";
import {
  createHarness,
  session,
} from "../../../../../packages/harness/src/test-kit";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          2000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function provider(
  call: ToolProvider["call"],
  prepare?: ToolProvider["prepare"],
): ToolProvider {
  const definition = {
    name: "write",
    description: "test",
    inputSchema: {
      type: "object" as const,
      properties: {
        libraryID: { type: "integer" },
        key: { type: "string" },
        value: { type: "string" },
      },
      required: ["key"],
    },
  };
  return {
    listTools: () => [definition],
    getMeta: (name) => ({
      name,
      catalog: "agent",
      concurrency: "serial",
      mutatesState: name !== "read",
    }),
    getSchema: () => definition.inputSchema,
    call,
    prepare,
  };
}
const applied: ToolResult = {
  ok: true,
  toolName: "write",
  data: { key: "NOTE" },
  effect: "applied",
};

describe("shared tool execution journal", () => {
  it("rejects non-object arguments at the shared boundary before entering a domain", async () => {
    let prepares = 0,
      writes = 0;
    const service = new ToolExecutionService(memoryJsonStorage());
    const inner = provider(
      async () => {
        writes++;
        return applied;
      },
      async () => {
        prepares++;
        return null;
      },
    );
    const result = await service
      .wrap(inner)
      .call("write", null as unknown as Record<string, unknown>);
    assert.equal(!result.ok && result.code, "invalid_args");
    assert.equal(result.effect, "none");
    assert.equal(prepares, 0);
    assert.equal(writes, 0);
  });
  it("records an explicit denial without executing or losing its run and proposal identity", async () => {
    const storage = memoryJsonStorage();
    const service = new ToolExecutionService(storage);
    let writes = 0;
    const wrapped = service.wrap(
      provider(
        async () => {
          writes++;
          return applied;
        },
        async (name, args, context = {}) => {
          context.preparedOperation = {
            schemaVersion: 1,
            domain: "annotation",
            name,
            args: { ...args },
            resources: ["pdf:1"],
            recovery: { proposalId: "proposal" },
          };
          return null;
        },
      ),
    );
    const context: ToolExecutionContext = {
      taskId: "task",
      runId: "run",
      intentRevision: 3,
      operationId: "denied",
    };
    const args = { key: "NOTE" };
    assert.equal(await wrapped.prepare!("write", args, context), null);
    await wrapped.recordDenied!("write", args, context);
    const recovered = await new ToolExecutionService(storage).getOperation(
      "denied",
    );
    assert.equal(recovered?.intent?.recovery.proposalId, "proposal");
    assert.equal(recovered?.context.runId, "run");
    assert.equal(recovered?.context.intentRevision, 3);
    assert.equal(recovered?.result?.effect, "none");
    assert.equal(
      recovered?.result?.ok === false && recovered.result.code,
      "permission_denied",
    );
    assert.equal(
      (await wrapped.call("write", args, undefined, context)).ok,
      false,
    );
    assert.equal(writes, 0);
  });
  it("persists an immutable domain intent and dispatches the reviewed arguments", async () => {
    const service = new ToolExecutionService(memoryJsonStorage());
    let nativeArgs: Record<string, unknown> | undefined;
    const inner = provider(
      async (_name, args) => {
        nativeArgs = args;
        args.value = "provider mutated its own argument";
        return applied;
      },
      async (name, args, context = {}) => {
        context.preparedOperation = {
          schemaVersion: 1,
          domain: "native-test",
          name,
          args: { ...args },
          resources: [`item:${args.key}`],
          recovery: { expectedValue: args.value },
        };
        return null;
      },
    );
    const context: ToolExecutionContext = { operationId: "immutable" };
    const wrapped = service.wrap(inner);
    const args = { key: "NOTE", value: "reviewed" };
    assert.equal(await wrapped.prepare!("write", args, context), null);
    assert.equal(Object.isFrozen(context.preparedOperation?.args), true);
    assert.equal(
      (await wrapped.call("write", args, undefined, context)).effect,
      "applied",
    );
    assert.equal(nativeArgs?.value, "provider mutated its own argument");
    const operation = await service.getOperation("immutable");
    assert.equal(operation?.intent?.args.value, "reviewed");
    assert.deepEqual(operation?.resources, ["item:NOTE"]);
  });

  it("bounds preparation and isolates mutations arriving after its deadline", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    let finish!: () => void,
      writes = 0;
    let entered!: () => void;
    const preparationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const preparationSettled = deferred<void>();
    const inner = provider(
      async () => {
        writes++;
        return applied;
      },
      async (_name, args) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
          entered();
        });
        args.value = "late preparation";
        preparationSettled.resolve();
        return null;
      },
    );
    const args = { key: "NOTE", value: "original" };
    const service = new ToolExecutionService(memoryJsonStorage(), undefined, {
      timeoutMs: 10,
    });
    const calling = service.wrap(inner).call("write", args);
    await preparationEntered;
    t.mock.timers.tick(11);
    const result = await calling;
    try {
      assert.equal(result.ok, false);
      assert.equal(result.effect, "none");
      assert.equal(!result.ok && result.code, "timeout");
    } finally {
      finish();
    }
    await preparationSettled.promise;
    assert.equal(args.value, "original");
    assert.equal(writes, 0);
  });

  it("excludes human approval time while preserving one active preparation/execution budget", async (t) => {
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    const service = new ToolExecutionService(memoryJsonStorage(), undefined, {
      timeoutMs: 100,
    });
    let prepares = 0,
      writes = 0;
    const wrapped = service.wrap(
      provider(
        async () => {
          writes++;
          now += 30;
          return applied;
        },
        async () => {
          prepares++;
          now += 20;
          return null;
        },
      ),
    );
    const context: ToolExecutionContext = {
      operationId: "approved-after-wait",
    };
    const args = { key: "NOTE" };
    assert.equal(await wrapped.prepare!("write", args, context), null);
    context.executionScope!.pause!();
    now += 10000;
    context.executionScope!.resume!();
    assert.equal(context.executionScope!.deadlineAt - now, 80);
    assert.equal(
      (await wrapped.call("write", args, undefined, context)).effect,
      "applied",
    );
    assert.equal(prepares, 1);
    assert.equal(writes, 1);
    assert.equal(context.executionScope!.deadlineAt - now, 50);
  });

  it("keeps cancellation effective while approval time is paused", async () => {
    const controller = new AbortController();
    let writes = 0;
    const service = new ToolExecutionService(memoryJsonStorage());
    const wrapped = service.wrap(
      provider(async () => {
        writes++;
        return applied;
      }),
    );
    const context: ToolExecutionContext = {
      operationId: "cancelled-approval",
      signal: controller.signal,
    };
    const args = { key: "NOTE" };
    assert.equal(await wrapped.prepare!("write", args, context), null);
    context.executionScope!.pause!();
    controller.abort();
    assert.equal(context.executionScope!.signal.aborted, true);
    context.executionScope!.resume!();
    assert.equal(
      (await wrapped.call("write", args, undefined, context)).effect,
      "none",
    );
    assert.equal(writes, 0);
  });

  it("reconciles with the owning domain without requiring a model read call", async () => {
    const service = new ToolExecutionService(memoryJsonStorage());
    await service.importLegacyOperation({
      id: "reconcile",
      name: "write",
      args: { key: "NOTE" },
      context: { taskId: "task" },
      resources: ["item:NOTE"],
      startedAt: 1,
      intent: {
        schemaVersion: 1,
        domain: "test",
        name: "write",
        args: { key: "NOTE" },
        resources: ["item:NOTE"],
        recovery: { plannedKey: "NOTE" },
      },
    });
    let reconciled = 0;
    service.registerDomain("test", {
      async reconcile(intent, _operation, scope) {
        assert.equal(intent.recovery.plannedKey, "NOTE");
        assert.ok(scope.deadlineAt > Date.now());
        reconciled++;
        return applied;
      },
    });
    assert.deepEqual(await service.unresolvedForTask("task"), []);
    assert.equal(reconciled, 1);
    assert.equal(
      (await service.getOperation("reconcile"))?.result?.effect,
      "applied",
    );
  });

  it("scopes run blockers without weakening conflict protection for old unknown writes", async () => {
    const service = new ToolExecutionService(memoryJsonStorage());
    for (const [id, runId] of [
      ["old", "old-run"],
      ["new", "new-run"],
      ["legacy", undefined],
    ] as const)
      await service.importLegacyOperation({
        id,
        name: "write",
        args: { key: id },
        resources: [`native:${id}`],
        context: { taskId: "task", runId },
        startedAt: 1,
      });
    assert.deepEqual(
      await service.unresolvedForTask("task", { runId: "new-run" }),
      ["new"],
    );
    assert.deepEqual(
      await service.unresolvedForTask("task", {
        runId: "new-run",
        includeLegacy: true,
      }),
      ["new", "legacy"],
    );
    assert.deepEqual(
      await service.unresolvedForTask("task", {
        runId: "new-run",
        operationIds: ["old"],
      }),
      ["old", "new"],
    );
    assert.deepEqual(await service.unresolvedForTask("task"), [
      "old",
      "new",
      "legacy",
    ]);
    let writes = 0;
    const inner = provider(
      async () => {
        writes++;
        return applied;
      },
      async (name, args, context = {}) => {
        context.preparedOperation = {
          schemaVersion: 1,
          domain: "test",
          name,
          args: { ...args },
          resources: ["native:old"],
          recovery: {},
        };
        return null;
      },
    );
    const result = await service
      .wrap(inner)
      .call("write", { key: "old" }, undefined, {
        taskId: "task",
        runId: "new-run",
        operationId: "new-conflicting-write",
      });
    assert.equal(result.effect, "none");
    assert.equal(
      !result.ok &&
        (result.details as { blockedByOperationId: string })
          .blockedByOperationId,
      "old",
    );
    assert.equal(writes, 0);
  });

  it("uses domain resource identities instead of guessing from tool argument names", async () => {
    const gate = deferred<void>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const starts: string[] = [];
    const inner = provider(
      async (_name, args) => {
        starts.push(String(args.value));
        if (args.value === "first") {
          firstStarted.resolve();
          await gate.promise;
        } else secondStarted.resolve();
        return applied;
      },
      async (name, args, context = {}) => {
        context.preparedOperation = {
          schemaVersion: 1,
          domain: "test",
          name,
          args: { ...args },
          resources: [`domain:${args.value}`],
          recovery: {},
        };
        return null;
      },
    );
    const service = new ToolExecutionService(memoryJsonStorage(), undefined, {
      timeoutMs: 2000,
    });
    const first = service
      .wrap(inner)
      .call("write", { key: "SAME", value: "first" });
    let second: Promise<ToolResult> | undefined;
    try {
      await bounded(firstStarted.promise, "the first domain execution");
      second = service
        .wrap(inner)
        .call("write", { key: "SAME", value: "second" });
      await bounded(secondStarted.promise, "the independent domain execution");
      assert.deepEqual(starts, ["first", "second"]);
    } finally {
      gate.resolve();
      await bounded(
        Promise.allSettled([first, ...(second ? [second] : [])]),
        "domain execution cleanup",
      );
    }
  });
  it("gives Native and ACP the same normalized approval and partial outcome contract", async () => {
    for (const backend of ["native", "acp"] as const) {
      const seen: unknown[] = [];
      const inner = provider(async (_name, args) => {
        seen.push(args);
        return {
          ...applied,
          effect: "partial",
          data: { committed: ["one"], skipped: ["two"] },
        };
      });
      const tools = new ToolExecutionService(memoryJsonStorage()).wrap(inner);
      const approvals: unknown[] = [];
      const args = { libraryID: "1", itemKey: "NOTE", value: "test" };
      let result: ToolResult | undefined;
      if (backend === "native") {
        const { loop, events } = createHarness({
          toolProvider: tools,
          script: [
            { toolCalls: [{ id: "one", name: "write", args }] },
            { text: "One saved; one skipped" },
          ],
          modeFor: () => "ask",
          resolve: (request) => {
            approvals.push(request.args);
            return Promise.resolve({
              id: request.id,
              verdict: "allow",
              scope: "once",
            });
          },
        });
        await loop.run({
          session: session(),
          turnId: "native",
          userText: "Save reviewed marks",
        });
        const event = events.events.find(
          (event) => event.type === "tool_result",
        );
        if (event?.type === "tool_result") result = event.payload.result;
      } else {
        const context = { taskId: "acp", operationId: "acp:one" };
        assert.equal(await tools.prepare!("write", args, context), null);
        approvals.push(args);
        result = await tools.call("write", args, undefined, context);
      }
      assert.deepEqual(approvals, [
        { libraryID: 1, key: "NOTE", value: "test" },
      ]);
      assert.deepEqual(seen, approvals);
      assert.equal(result?.ok, true);
      assert.equal(result?.effect, "partial");
      assert.ok(result?.operationId);
    }
  });
  it("uses stable canonical objects", () =>
    assert.equal(canonical({ b: 2, a: 1, c: undefined }), '{"a":1,"b":2}'));
  it("replays a persisted receipt after restart even if its target was edited or deleted", async () => {
    const storage = memoryJsonStorage();
    let writes = 0;
    let targetExists = true;
    const inner = provider(
      async () => {
        writes++;
        return applied;
      },
      async (_name, args, context = {}) => {
        if (!targetExists) throw new Error("deleted target");
        args.libraryID ??= 1;
        context.expected = { "1:NOTE": "before" };
        return null;
      },
    );
    const original = await new ToolExecutionService(storage)
      .wrap(inner)
      .call("write", { itemKey: "NOTE", libraryID: "1" }, undefined, {
        operationId: "one",
      });
    targetExists = false;
    const replay = await new ToolExecutionService(storage)
      .wrap(inner)
      .call("write", { key: "NOTE", libraryID: 1 }, undefined, {
        operationId: "one",
      });
    assert.deepEqual(replay, original);
    assert.equal(writes, 1);
    const conflict = await new ToolExecutionService(storage)
      .wrap(inner)
      .call("write", { key: "NOTE", value: "changed" }, undefined, {
        operationId: "one",
      });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.effect, "none");
    assert.match(!conflict.ok ? conflict.message : "", /different arguments/);
  });
  it("serializes conflicting resources across separate task providers", async () => {
    const service = new ToolExecutionService(memoryJsonStorage(), undefined, {
      timeoutMs: 2000,
    });
    const gate = deferred<void>();
    const firstStarted = deferred<void>();
    const secondPrepared = deferred<void>();
    let firstActive = false;
    const starts: string[] = [];
    const inner = provider(
      async (_name, args) => {
        starts.push(String(args.value));
        if (args.value === "a") {
          firstActive = true;
          firstStarted.resolve();
          try {
            await gate.promise;
          } finally {
            firstActive = false;
          }
        } else
          assert.equal(
            firstActive,
            false,
            "a conflicting domain must finish first",
          );
        return applied;
      },
      async (_name, args) => {
        if (args.value === "b") secondPrepared.resolve();
        return null;
      },
    );
    const a = service
      .wrap(inner, { taskId: "a" })
      .call("write", { key: "NOTE", value: "a" });
    let b: Promise<ToolResult> | undefined;
    try {
      await bounded(firstStarted.promise, "the first conflicting execution");
      b = service
        .wrap(inner, { taskId: "b" })
        .call("write", { key: "NOTE", value: "b" });
      await bounded(secondPrepared.promise, "the second prepared operation");
      assert.deepEqual(starts, ["a"]);
    } finally {
      gate.resolve();
      const results = await bounded(
        Promise.all([a, ...(b ? [b] : [])]),
        "serialized execution cleanup",
      );
      assert.ok(
        results.every((result) => result.ok),
        JSON.stringify(results),
      );
    }
    assert.deepEqual(starts, ["a", "b"]);
  });
  it("blocks writes when an intent cannot be saved and recovers without a permanent latch", async () => {
    const memory = memoryJsonStorage();
    let fail = true,
      writes = 0;
    const storage: JsonStorage = {
      read: memory.read,
      keys: memory.keys,
      write: async (key, value) => {
        if (fail) throw new Error("ENOSPC");
        await memory.write(key, value);
      },
    };
    const service = new ToolExecutionService(storage);
    const inner = provider(async () => {
      writes++;
      return applied;
    });
    const first = await service
      .wrap(inner)
      .call("write", { key: "NOTE" }, undefined, { operationId: "first" });
    assert.equal(first.effect, "none");
    assert.equal(writes, 0);
    fail = false;
    const second = await service
      .wrap(inner)
      .call("write", { key: "NOTE" }, undefined, { operationId: "second" });
    assert.equal(second.effect, "applied");
    assert.equal(writes, 1);
  });
  it("retains a known effect when receipt persistence fails and repairs the journal", async () => {
    const memory = memoryJsonStorage();
    let saves = 0,
      writes = 0;
    const storage: JsonStorage = {
      read: memory.read,
      keys: memory.keys,
      write: async (key, value) => {
        if (++saves === 2) throw new Error("index locked");
        await memory.write(key, value);
      },
    };
    const service = new ToolExecutionService(storage);
    const inner = provider(async () => {
      writes++;
      return applied;
    });
    const result = await service
      .wrap(inner)
      .call("write", { key: "NOTE" }, undefined, { operationId: "receipt" });
    assert.equal(result.effect, "applied");
    assert.match(result.warnings?.join(" ") ?? "", /receipt/);
    await service.recoverStorage();
    await new ToolExecutionService(storage)
      .wrap(inner)
      .call("write", { key: "NOTE" }, undefined, { operationId: "receipt" });
    assert.equal(writes, 1);
  });
  it("aborts timed-out work, blocks a new write, and records an unabortable late success", async () => {
    const storage = memoryJsonStorage();
    let release!: (result: ToolResult) => void;
    let actualSignal: AbortSignal | undefined;
    let writes = 0;
    const inner = provider(async (_name, _args, signal) => {
      writes++;
      actualSignal = signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const service = new ToolExecutionService(
      storage,
      () => Promise.resolve(applied),
      { timeoutMs: 15 },
    );
    const first = await service
      .wrap(inner)
      .call("write", { key: "NOTE" }, undefined, { operationId: "late" });
    assert.equal(first.effect, "unknown");
    assert.equal(actualSignal?.aborted, true);
    const blocked = await service
      .wrap(inner)
      .call("write", { key: "NOTE" }, undefined, { operationId: "new" });
    assert.equal(blocked.effect, "none");
    assert.equal(
      !blocked.ok &&
        (blocked.details as { blockedByOperationId: string })
          .blockedByOperationId,
      "late",
    );
    assert.equal(writes, 1);
    release(applied);
    // Wait for the actual receipt, not an assumed number of event-loop turns;
    // native IO and crypto completion can be delayed under the full test suite.
    const expiresAt = Date.now() + 2000;
    while (
      (await service.getOperation("late"))?.result?.effect !== "applied" &&
      Date.now() < expiresAt
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      (await service.getOperation("late"))?.result?.effect,
      "applied",
    );
    await service.recoverStorage();
    const replay = await new ToolExecutionService(storage)
      .wrap(inner)
      .call("write", { key: "NOTE" }, undefined, { operationId: "late" });
    assert.equal(replay.effect, "applied");
    assert.equal(writes, 1);
  });
  it("allows read-only verification with broken storage and preserves approval versions", async () => {
    const storage: JsonStorage = {
      read: async () => {
        throw new Error("damaged journal");
      },
      write: async () => {
        throw new Error("ENOSPC");
      },
    };
    const reader = new ToolExecutionService(storage).wrap(
      provider(async () => ({ ...applied, toolName: "read" })),
    );
    assert.equal((await reader.call("read", { key: "NOTE" })).ok, true);
    let received: ToolExecutionContext | undefined;
    const write = new ToolExecutionService(memoryJsonStorage()).wrap(
      provider(
        async (_name, _args, _signal, context) => {
          received = context;
          return applied;
        },
        async (_name, _args, context = {}) => {
          context.expected ??= { version: "reviewed" };
          return null;
        },
      ),
    );
    const context = { operationId: "approval" };
    await write.prepare!("write", { key: "NOTE", value: "a" }, context);
    await write.call("write", { key: "NOTE", value: "b" }, undefined, context);
    assert.equal(received?.expected?.version, "reviewed");
  });
});

describe("per-operation persistence", () => {
  it("keeps native artifact recovery independent from a failed task-view callback", async () => {
    const service = new ToolExecutionService(memoryJsonStorage());
    const body = { type: "markdown", markdown: "saved" };
    const artifact = {
      id: "art",
      taskId: "task",
      revision: 1,
      revisions: [{ revision: 1, body }],
    } as unknown as ArtifactRecord;
    registerHostOperationDomains(service, {
      artifacts: { get: async () => artifact },
      history: {
        listNotes: async () => [],
        readNote: async () => {
          throw new Error("unused");
        },
      },
      tools: { reconcile: async () => null },
      onArtifactRecovered: () => {
        throw new Error("UI unavailable");
      },
    });
    await service.importLegacyOperation({
      id: "artifact-op",
      name: "artifact_upsert",
      args: { id: "art", body },
      resources: ["artifact:art"],
      context: { taskId: "task" },
      startedAt: 1,
      intent: {
        schemaVersion: 1,
        domain: "artifact",
        name: "artifact_upsert",
        args: { id: "art", body },
        resources: ["artifact:art"],
        recovery: { expectedRevision: 0, artifactRevision: 1 },
      },
    });
    assert.deepEqual(await service.unresolvedForTask("task"), []);
    const result = (await service.getOperation("artifact-op"))?.result;
    assert.equal(result?.effect, "applied");
    assert.match(result?.warnings?.[0] ?? "", /task view/);
  });
  it("migrates the old global journal without losing unknown or changing operation IDs", async () => {
    const storage = memoryJsonStorage();
    const original = {
      id: "old:operation",
      name: "write",
      args: { key: "NOTE" },
      context: { taskId: "task" },
      resources: ["item:NOTE"],
      startedAt: 1,
      result: {
        ok: false as const,
        toolName: "write",
        code: "timeout" as const,
        message: "lost response",
        effect: "unknown" as const,
      },
    };
    await storage.write("operations", {
      version: 1,
      operations: { [original.id]: original },
    });
    const migrated = new OperationStore(storage);
    assert.deepEqual(await migrated.getOperation(original.id), original);
    assert.equal((await storage.keys!("op_")).length, 1);
    await migrated.save({ ...original, result: applied });
    const restarted = new OperationStore(storage);
    assert.equal(
      (await restarted.getOperation(original.id))?.result?.effect,
      "applied",
    );
    assert.deepEqual(await storage.read("operations"), {
      version: 1,
      operations: { [original.id]: original },
    });
  });

  it("rebuilds operation discovery from files independently of task/UI indexes", async () => {
    const storage = memoryJsonStorage();
    const service = new ToolExecutionService(storage);
    await service
      .wrap(provider(async () => applied))
      .call("write", { key: "NOTE" }, undefined, {
        operationId: "listed",
        taskId: "task",
      });
    assert.equal((await storage.keys!("op_")).length, 1);
    assert.equal(await storage.read("operation-index"), null);
    const restarted = new ToolExecutionService(storage);
    assert.equal(
      (await restarted.listOperations({ taskId: "task" }))[0].id,
      "listed",
    );
  });
});
