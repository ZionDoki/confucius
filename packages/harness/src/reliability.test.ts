import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OpenAICompatibleAdapter,
  type OpenAICompatibleConfig,
} from "./OpenAICompatibleAdapter";
import { ModelError, type ModelRequest, type ModelTurn } from "./ModelAdapter";
import { BudgetAccountant } from "./BudgetAccountant";
import { createHarness, session } from "./test-kit";
import { validateArgs, validateValue } from "./SchemaValidate";
import { latestReplayGroup } from "./WindowContext";

const request: ModelRequest = {
  messages: [{ role: "user", content: "fixture" }],
};
const runInput = {
  session: session(),
  turnId: "reliability",
  userText: "fixture",
};
function stream(
  chunks: Array<string | Error>,
  contentType = "text/event-stream",
  hang = false,
): Response {
  let index = 0;
  return {
    ok: true,
    headers: { get: () => contentType },
    body: {
      getReader: () => ({
        async read() {
          const chunk = chunks[index++];
          if (chunk instanceof Error) throw chunk;
          if (chunk !== undefined)
            return { done: false, value: new TextEncoder().encode(chunk) };
          if (hang) return new Promise<never>(() => {});
          return { done: true };
        },
        async cancel() {},
      }),
    },
  } as unknown as Response;
}
function adapter(
  fetchImpl: OpenAICompatibleConfig["fetchImpl"],
  config: Partial<OpenAICompatibleConfig> = {},
) {
  return new OpenAICompatibleAdapter({
    apiKey: "test",
    baseUrl: "https://example.invalid/v1",
    model: "fixture",
    fetchImpl,
    ...config,
  });
}
const delta = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const textDelta = (text: string) =>
  delta({ choices: [{ delta: { content: text } }] });
const json = (message: object, finish_reason = "stop") =>
  new Response(JSON.stringify({ choices: [{ message, finish_reason }] }));

describe("transport outcome contract", () => {
  for (const tail of [
    [],
    [new Error("connection reset")],
    ["data: {broken}\n\n"],
  ])
    it(`never accepts partial SSE as a completed turn (${String(tail)})`, async () => {
      const model = adapter(async () =>
        stream([textDelta("partial"), ...tail]),
      );
      await assert.rejects(
        model.complete(request),
        (error: unknown) =>
          error instanceof ModelError &&
          error.options.partial?.text === "partial" &&
          error.options.partial?.end === "incomplete",
      );
    });
  it("does not execute a fully parsed tool proposal without a terminal model response", async () => {
    let calls = 0;
    const model = adapter(async () =>
      stream([
        delta({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "c",
                    function: {
                      name: "create_collection",
                      arguments: '{"name":"X"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        new Error("reset"),
      ]),
    );
    const h = createHarness({
      model,
      maxModelRecoveries: 0,
      modeFor: () => "auto_allow",
    });
    h.tools.call = async () => {
      calls++;
      return { ok: true, toolName: "create_collection", data: {} };
    };
    const result = await h.loop.run(runInput);
    assert.equal(result.stopReason, "model_retries_exhausted");
    assert.equal(calls, 0);
  });
  it("accepts a finish frame without DONE but rejects an unknown finish reason", async () => {
    const model = adapter(async () =>
      stream([
        textDelta("ok"),
        delta({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      ]),
    );
    assert.equal((await model.complete(request)).end, "stop");
    assert.equal(
      (
        await adapter(async () => json({ content: "x" }, "unexpected"), {
          stream: false,
        }).complete(request)
      ).end,
      "incomplete",
    );
  });
  it("preserves explicit truncated/refusal outcomes and never dispatches their tool calls", async () => {
    for (const end of ["length", "content_filter"] as const) {
      const h = createHarness({
        script: [
          {
            text: "partial",
            end,
            toolCalls: [
              { id: "c", name: "search_items", args: { query: "x" } },
            ],
          },
        ],
        maxLengthContinuations: 0,
      });
      const result = await h.loop.run(runInput);
      assert.equal(result.phase, "failed");
      assert.equal(result.stopReason, end);
      assert.equal(h.events.types().includes("tool_requested"), false);
    }
  });
  it("reconstructs the same tool call for every byte boundary, including UTF-8", async () => {
    const body =
      textDelta("文献") +
      delta({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "c",
                  function: {
                    name: "search_items",
                    arguments: '{"query":"中文"}',
                  },
                },
              ],
            },
          },
        ],
      }) +
      "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(body);
    for (let cut = 1; cut < bytes.length; cut++) {
      let index = 0;
      const response = {
        ok: true,
        headers: { get: () => "text/event-stream" },
        body: {
          getReader: () => ({
            async read() {
              return index < 2
                ? {
                    done: false,
                    value:
                      index++ === 0 ? bytes.slice(0, cut) : bytes.slice(cut),
                  }
                : { done: true };
            },
            async cancel() {},
          }),
        },
      } as unknown as Response;
      const result = await adapter(async () => response).complete(request);
      assert.equal(result.text, "文献");
      assert.deepEqual(result.toolCalls?.[0].args, { query: "中文" });
      assert.equal(result.end, "tool_calls");
    }
  });
  it("merges separate Ollama calls and makes snapshot behavior an explicit profile", async () => {
    const a = { function: { name: "search_items", arguments: { query: "a" } } };
    const b = { function: { name: "search_items", arguments: { query: "b" } } };
    const chunks = [
      { message: { tool_calls: [a] }, done: false },
      { message: { tool_calls: [b] }, done: false },
      { done: true },
    ].map((value) => JSON.stringify(value) + "\n");
    const result = await adapter(
      async () => stream(chunks, "application/x-ndjson"),
      { baseUrl: "https://example.invalid/api/chat" },
    ).complete(request);
    assert.deepEqual(
      result.toolCalls?.map((call) => call.args),
      [{ query: "a" }, { query: "b" }],
    );
    assert.equal(new Set(result.toolCalls?.map((call) => call.id)).size, 2);
    const snapshot = await adapter(
      async () => stream(chunks, "application/x-ndjson"),
      {
        baseUrl: "https://example.invalid/api/chat",
        profile: { ollamaToolCalls: "snapshot" },
      },
    ).complete(request);
    assert.deepEqual(
      snapshot.toolCalls?.map((call) => call.args),
      [{ query: "b" }],
    );
  });
});

describe("deadlines and cancellation", () => {
  it("bounds a fetch that never settles", async () => {
    const model = adapter(async () => new Promise<Response>(() => {}), {
      timeouts: { firstByteMs: 15, idleMs: 100, absoluteMs: 500 },
    });
    await assert.rejects(
      model.complete(request),
      (error: unknown) =>
        error instanceof ModelError &&
        error.code === "timeout" &&
        /first byte/.test(error.message),
    );
  });
  it("bounds a reader that stalls after a byte", async () => {
    const model = adapter(
      async () => stream([textDelta("partial")], "text/event-stream", true),
      { timeouts: { firstByteMs: 100, idleMs: 15, absoluteMs: 500 } },
    );
    await assert.rejects(
      model.complete(request),
      (error: unknown) =>
        error instanceof ModelError &&
        /idle/.test(error.message) &&
        error.options.partial?.text === "partial",
    );
  });
  it("enforces absolute deadline even while bytes keep arriving", async () => {
    const response = {
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: {
        getReader: () => ({
          async read() {
            await new Promise((resolve) => setTimeout(resolve, 3));
            return {
              done: false,
              value: new TextEncoder().encode(textDelta("x")),
            };
          },
          async cancel() {},
        }),
      },
    } as unknown as Response;
    await assert.rejects(
      adapter(async () => response, {
        timeouts: { firstByteMs: 100, idleMs: 100, absoluteMs: 20 },
      }).complete(request),
      /absolute deadline/,
    );
  });
  it("does not swallow cancellation after partial data and cleans up its reader", async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const response = {
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: {
        getReader: () => ({
          async read() {
            controller.abort();
            return {
              done: false,
              value: new TextEncoder().encode(textDelta("stale")),
            };
          },
          async cancel() {
            cancelled++;
          },
        }),
      },
    } as unknown as Response;
    await assert.rejects(
      adapter(async () => response).complete(request, controller.signal),
      { name: "AbortError" },
    );
    assert.ok(cancelled > 0);
  });
});

describe("run accounting and guarded progress", () => {
  it("charges every HTTP retry before dispatch, with a shared run ceiling", async () => {
    let requests = 0;
    const model = adapter(async () => {
      requests++;
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    });
    const h = createHarness({ model, maxIterations: 1 });
    const result = await h.loop.run(runInput);
    assert.equal(result.stopReason, "iteration_budget");
    assert.equal(requests, 1);
    assert.equal(h.budget.snapshot().modelAttempts, 1);
    assert.equal(
      h.checkpoints.latest(runInput.turnId)?.budget?.modelAttempts,
      1,
    );
  });
  it("never replenishes a run when an older checkpoint or a new phase uses it", async () => {
    const budget = new BudgetAccountant({ maxIterations: 2, maxToolCalls: 5 });
    const first = createHarness({ budget, script: [{ text: "phase 1" }] });
    await first.loop.run(runInput);
    const checkpoint = first.checkpoints.latest(runInput.turnId)!;
    const second = createHarness({ budget, script: [{ text: "phase 2" }] });
    await second.loop.run({ ...runInput, turnId: "phase2" });
    const third = createHarness({
      budget,
      script: [{ text: "must not happen" }],
    });
    assert.equal(
      (
        await third.loop.run({
          ...runInput,
          turnId: "phase3",
          resume: checkpoint,
        })
      ).stopReason,
      "iteration_budget",
    );
    assert.equal(budget.iterationsUsed, 2);
  });
  it("reports token and elapsed exhaustion before executing tool side effects", async () => {
    for (const kind of ["tokens", "elapsed"]) {
      let now = 0;
      const budget = new BudgetAccountant(
        {
          maxIterations: 5,
          maxToolCalls: 5,
          ...(kind === "tokens" ? { maxTokens: 10 } : { maxElapsedMs: 10 }),
        },
        () => now,
      );
      const h = createHarness({
        budget,
        model: {
          async complete() {
            now = 20;
            return {
              toolCalls: [
                { id: "c", name: "search_items", args: { query: "x" } },
              ],
              usage: { totalTokens: 20 },
            };
          },
        },
      });
      assert.equal(
        (await h.loop.run(runInput)).stopReason,
        kind === "tokens" ? "token_budget" : "time_budget",
      );
      assert.equal(h.events.types().includes("tool_requested"), false);
    }
  });
  it("bounds identical actions with unchanged results, regardless of model ids", async () => {
    const script: ModelTurn[] = Array.from({ length: 8 }, (_, index) => ({
      toolCalls: [
        { id: `c${index}`, name: "search_items", args: { query: "unchanged" } },
      ],
    }));
    const h = createHarness({ script });
    const result = await h.loop.run(runInput);
    assert.equal(result.stopReason, "stalled");
    assert.equal(h.budget.iterationsUsed, 4);
  });
  it("rejects non-object arguments before provider prepare", async () => {
    const h = createHarness({
      script: [
        { toolCalls: [{ id: "c", name: "search_items", args: null as never }] },
        { text: "fixed" },
      ],
    });
    const provider = h.tools as typeof h.tools & { prepare(): Promise<null> };
    let prepares = 0;
    provider.prepare = async () => {
      prepares++;
      throw new Error("must not reach prepare");
    };
    assert.equal((await h.loop.run(runInput)).stopReason, "completed");
    assert.equal(prepares, 0);
  });
});

it("round-trips provider reasoning with its tool group but never leaks it to another route", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const model = adapter(
    async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? json(
            {
              content: "",
              reasoning_content: "retain me",
              tool_calls: [
                {
                  id: "c",
                  function: {
                    name: "search_items",
                    arguments: '{"query":"x"}',
                  },
                },
              ],
            },
            "tool_calls",
          )
        : json({ content: "done" });
    },
    { model: "deepseek-fixture", stream: false },
  );
  const h = createHarness({ model });
  const result = await h.loop.run(runInput);
  const sent = requests[1].messages as Array<Record<string, unknown>>;
  assert.equal(
    sent.find((message) => message.role === "assistant")?.reasoning_content,
    "retain me",
  );
  const group = latestReplayGroup(result.messages);
  assert.equal(group[0].replayState?.data.reasoning, "retain me");
  assert.equal(group[1].role, "tool");
  let other: Record<string, unknown> = {};
  await adapter(
    async (_url, init) => {
      other = JSON.parse(String(init?.body));
      return json({ content: "ok" });
    },
    {
      stream: false,
      model: "another",
      profile: { reasoningReplay: "reasoning_content" },
    },
  ).complete({ messages: result.messages });
  assert.equal(JSON.stringify(other).includes("retain me"), false);
});

it("uses real JSON Schema semantics with explicit, lossless normalization", () => {
  assert.deepEqual(
    validateValue({ const: { a: 1, b: 2 } }, { b: 2, a: 1 }).issues,
    [],
  );
  assert.deepEqual(
    validateValue({ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 }).issues,
    [],
  );
  assert.ok(validateValue({ allOf: [{ type: "string" }] }, 42).issues.length);
  assert.ok(
    validateValue(
      { $ref: "#/$defs/id", $defs: { id: { type: "integer", minimum: 2 } } },
      1,
    ).issues.length,
  );
  assert.ok(validateValue({ madeUpValidation: true }, 1).issues.length);
  assert.ok(validateValue({ type: "string", pattern: "[" }, "x").issues.length);
  assert.ok(
    validateValue({ type: "number" }, "0.100000000000000005").issues.length,
  );
  assert.ok(
    validateValue({ type: "integer" }, "9007199254740993").issues.length,
  );
  assert.equal(validateValue({ type: ["number", "string"] }, "7").value, "7");
  assert.equal(validateValue({ type: "number" }, "0.2500").value, 0.25);
  assert.equal(
    validateArgs(
      "x",
      {
        type: "object",
        properties: { x: { type: "string" } },
        required: ["x"],
      },
      { x: null },
    )?.code,
    "invalid_args",
  );
});

it("records denial against the prepared operation before allowing the model to continue", async () => {
  for (const mode of ["deny", "ask"] as const) {
    const h = createHarness({
      modeFor: () => mode,
      resolve: async (request) => ({
        id: request.id,
        verdict: "deny",
        scope: "once",
      }),
      script: [
        {
          toolCalls: [
            { id: "c", name: "create_collection", args: { name: "no" } },
          ],
        },
        { text: "denied" },
      ],
    });
    const provider = h.tools as typeof h.tools & {
      prepare(
        name: string,
        args: unknown,
        context?: import("@confucius/protocol").ToolExecutionContext,
      ): Promise<null>;
      recordDenied(
        name: string,
        args: unknown,
        context?: import("@confucius/protocol").ToolExecutionContext,
      ): Promise<void>;
    };
    let operation: string | undefined;
    let denied = 0;
    let calls = 0;
    provider.prepare = async (_name, _args, context) => {
      operation = context?.operationId;
      return null;
    };
    provider.recordDenied = async (_name, _args, context) => {
      assert.equal(context?.operationId, operation);
      assert.ok(operation);
      denied++;
    };
    provider.call = async () => {
      calls++;
      throw new Error("no execution allowed");
    };
    assert.equal((await h.loop.run(runInput)).stopReason, "completed");
    assert.equal(denied, 1);
    assert.equal(calls, 0);
  }
});

it("normalizes referenced union branches in their original schema scope", () => {
  const schema = {
    type: "object",
    $defs: {
      id: { type: "integer", minimum: 2 },
      label: { type: "string", pattern: "^label:" },
    },
    properties: {
      value: { oneOf: [{ $ref: "#/$defs/id" }, { $ref: "#/$defs/label" }] },
    },
  };
  assert.deepEqual(validateValue(schema, { value: "3" }), {
    value: { value: 3 },
    issues: [],
  });
  assert.deepEqual(validateValue(schema, { value: "label:a" }).issues, []);
  assert.ok(validateValue(schema, { value: "1" }).issues.length);
});

it("does not modify an argument object's prototype during normalized copyback", () => {
  const args = JSON.parse('{"__proto__":{"polluted":true},"id":"3"}');
  assert.equal(
    validateArgs(
      "x",
      { type: "object", properties: { id: { type: "integer" } } },
      args,
    ),
    null,
  );
  assert.equal(Object.getPrototypeOf(args), Object.prototype);
  assert.equal(args.polluted, undefined);
  assert.deepEqual(args.__proto__, { polluted: true });
});

it("keeps tool result pairs on cancellation without pretending an unresolved write completed", async () => {
  const controller = new AbortController();
  const h = createHarness({
    script: [
      {
        toolCalls: [
          { id: "pending", name: "create_collection", args: { name: "x" } },
        ],
      },
    ],
    modeFor: () => "ask",
    resolve: async (request) => {
      controller.abort();
      return { id: request.id, verdict: "allow", scope: "once" };
    },
  });
  const result = await h.loop.run({ ...runInput, signal: controller.signal });
  assert.equal(result.stopReason, "aborted");
  const paired = result.messages.find(
    (message) => message.role === "tool" && message.toolCallId === "pending",
  );
  assert.ok(paired);
  assert.equal(JSON.parse(paired.content).effect, "none");
});

it("pins native Ollama context size and keeps reasoning isolated across endpoints with one profile id", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const config = {
    profile: { id: "common", reasoningReplay: "thinking" as const },
    contextWindowTokens: 65536,
    maxTokens: 8192,
    stream: false,
  };
  const first = adapter(
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          message: { content: "ok", thinking: "private" },
          done: true,
        }),
      );
    },
    { ...config, baseUrl: "https://first.invalid/api/chat" },
  );
  const turn = await first.complete(request);
  assert.deepEqual(sent[0].options, { num_predict: 8192, num_ctx: 65536 });
  await adapter(
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ message: { content: "ok" }, done: true }),
      );
    },
    { ...config, baseUrl: "https://second.invalid/api/chat" },
  ).complete({
    messages: [
      { role: "assistant", content: "ok", replayState: turn.replayState },
    ],
  });
  assert.equal(JSON.stringify(sent[1]).includes("private"), false);
});

it("keeps native Ollama null/primitive and malformed JSON arguments out of prepare", async () => {
  for (const value of [null, 7, [], "{broken"]) {
    let requests = 0;
    const model = adapter(
      async () =>
        new Response(
          JSON.stringify(
            ++requests === 1
              ? {
                  message: {
                    tool_calls: [
                      { function: { name: "search_items", arguments: value } },
                    ],
                  },
                  done: true,
                }
              : { message: { content: "fixed" }, done: true },
          ),
        ),
      { baseUrl: "https://example.invalid/api/chat", stream: false },
    );
    let prepares = 0;
    const h = createHarness({ model });
    (h.tools as typeof h.tools & { prepare(): Promise<null> }).prepare =
      async () => {
        prepares++;
        return null;
      };
    const result = await h.loop.run(runInput);
    assert.equal(result.stopReason, "completed");
    assert.equal(prepares, 0);
    const tool = result.messages.find((message) => message.role === "tool");
    assert.equal(JSON.parse(tool!.content).code, "invalid_args");
  }
});

it("rechecks elapsed budget after approval before executing even a completion tool", async () => {
  let now = 0;
  const budget = new BudgetAccountant(
    { maxIterations: 5, maxToolCalls: 0, maxElapsedMs: 10 },
    () => now,
  );
  const h = createHarness({
    budget,
    completionToolNames: new Set(["create_collection"]),
    modeFor: () => "ask",
    resolve: async (request) => {
      now = 20;
      return { id: request.id, verdict: "allow", scope: "once" };
    },
    script: [
      {
        toolCalls: [
          { id: "c", name: "create_collection", args: { name: "x" } },
        ],
      },
    ],
  });
  let called = false;
  h.tools.call = async () => {
    called = true;
    throw new Error("must not execute");
  };
  assert.equal((await h.loop.run(runInput)).stopReason, "time_budget");
  assert.equal(called, false);
});

it("retains original conversation when a compaction model returns a truncated summary", async () => {
  const { compactHistory } = await import("./ConversationMemory");
  const history = Array.from({ length: 20 }, () => ({
    role: "user" as const,
    content: "source ".repeat(100),
  }));
  const original = structuredClone(history);
  await assert.rejects(
    compactHistory(
      {
        async complete() {
          return { text: "partial", end: "length" };
        },
      },
      history,
      1000,
    ),
    /summary did not complete/,
  );
  assert.deepEqual(history, original);
});

it("pauses only the permission wait and resumes the execution deadline on every outcome", async () => {
  for (const failDecision of [false, true]) {
    let paused = false;
    const boundaries: string[] = [];
    const scope = {
      deadlineAt: 1000,
      signal: new AbortController().signal,
      pause() {
        paused = true;
        boundaries.push("pause");
      },
      resume() {
        paused = false;
        boundaries.push("resume");
      },
    };
    const h = createHarness({
      modeFor: () => "ask",
      resolve: async (request) => {
        assert.equal(paused, true);
        if (failDecision) throw new Error("decision failed");
        return { id: request.id, verdict: "allow", scope: "once" };
      },
      script: [
        {
          toolCalls: [
            { id: "c", name: "create_collection", args: { name: "x" } },
          ],
        },
        { text: "done" },
      ],
    });
    const provider = h.tools as typeof h.tools & {
      prepare(
        name: string,
        args: unknown,
        context?: import("@confucius/protocol").ToolExecutionContext,
      ): Promise<null>;
    };
    provider.prepare = async (_name, _args, context) => {
      assert.equal(paused, false);
      if (context) context.executionScope = scope;
      return null;
    };
    provider.call = async () => {
      assert.equal(paused, false);
      return { ok: true, toolName: "create_collection", data: {} };
    };
    assert.equal(
      (await h.loop.run(runInput)).phase,
      failDecision ? "failed" : "done",
    );
    assert.deepEqual(boundaries, ["pause", "resume"]);
  }
});

it("retains separate input/output usage and elapsed time across resumed runs", () => {
  let now = 0;
  const budget = new BudgetAccountant(
    { maxIterations: 10, maxToolCalls: 10 },
    () => now,
  );
  budget.recordUsage({
    promptTokens: 16,
    completionTokens: 4,
    totalTokens: 20,
  });
  now = 40;
  const checkpoint = budget.snapshot();
  const resumed = new BudgetAccountant(
    { maxIterations: 10, maxToolCalls: 10 },
    () => now,
  );
  resumed.restoreMax(checkpoint);
  resumed.recordUsage({ promptTokens: 8, completionTokens: 2 });
  now = 50;
  resumed.restoreMax(checkpoint);
  resumed.restoreMax({ tokensUsed: 1, elapsedMs: 1 });
  assert.equal(resumed.snapshot().promptTokens, 24);
  assert.equal(resumed.snapshot().completionTokens, 6);
  assert.equal(resumed.snapshot().tokensUsed, 30);
  assert.equal(resumed.snapshot().elapsedMs, 50);
  resumed.recordUsage({
    promptTokens: NaN,
    completionTokens: -1,
    totalTokens: Infinity,
  });
  assert.equal(resumed.snapshot().promptTokens, 24);
  assert.equal(resumed.snapshot().completionTokens, 6);
  assert.equal(resumed.snapshot().tokensUsed, 30);
});

it("does not use an old success to close a cancelled proposal that reused a model call id", async () => {
  const controller = new AbortController();
  let decisions = 0;
  const h = createHarness({
    script: [
      {
        toolCalls: [
          { id: "reused", name: "create_collection", args: { name: "x" } },
        ],
      },
      {
        toolCalls: [
          { id: "reused", name: "create_collection", args: { name: "x" } },
        ],
      },
    ],
    modeFor: () => "ask",
    resolve: async (request) => {
      if (++decisions === 2) controller.abort();
      return { id: request.id, verdict: "allow", scope: "once" };
    },
  });
  const result = await h.loop.run({ ...runInput, signal: controller.signal });
  const responses = result.messages
    .filter((message) => message.role === "tool")
    .map((message) => JSON.parse(message.content));
  assert.equal(result.stopReason, "aborted");
  assert.equal(responses[0].ok, true);
  assert.equal(responses[1].ok, false);
});
