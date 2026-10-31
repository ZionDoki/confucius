import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeModelAdapter, ModelSseParser } from "./NativeModelAdapter";
import {
  ModelError,
  type ModelMessage,
  type ModelRequest,
} from "./ModelAdapter";
import type { NativeWireProtocol } from "./NativeWireCodec";
import { createHarness, session } from "./test-kit";
import { listEndpointModels } from "./modelsList";

const tool = {
  name: "lookup",
  description: "Look up a paper",
  inputSchema: {
    type: "object" as const,
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};
const request: ModelRequest = {
  messages: [
    { role: "system", content: "Be precise." },
    { role: "user", content: "Find this paper." },
  ],
  tools: [tool],
  maxAttempts: 1,
};
const message = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Found.", annotations: [] }],
};
const outputs = {
  responses: {
    status: "completed",
    output: [message],
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  },
  anthropic: {
    type: "message",
    content: [{ type: "text", text: "Found." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 4 },
  },
  gemini: {
    candidates: [
      {
        content: { role: "model", parts: [{ text: "Found." }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 4,
      totalTokenCount: 14,
    },
  },
};

test("protocol factory preserves Chat Completions and Ollama routes including query values", async () => {
  for (const protocol of ["openai", "ollama"] as const) {
    let url = "";
    const model = createNativeModelAdapter({
      protocol,
      baseUrl: "https://example.test/proxy?upstream=https://upstream/",
      apiKey: "",
      model: "fixture",
      stream: false,
      fetchImpl: async (input) => {
        url = String(input);
        return Response.json(
          protocol === "openai"
            ? {
                choices: [
                  { message: { content: "ok" }, finish_reason: "stop" },
                ],
              }
            : { message: { content: "ok" }, done: true, done_reason: "stop" },
        );
      },
    });
    assert.equal(
      (await model.complete({ messages: [{ role: "user", content: "test" }] }))
        .text,
      "ok",
    );
    assert.equal(
      new URL(url).searchParams.get("upstream"),
      "https://upstream/",
    );
    assert.equal(
      new URL(url).pathname,
      protocol === "openai" ? "/proxy/chat/completions" : "/proxy/api/chat",
    );
  }
});

function events(protocol: NativeWireProtocol, text = "Found."): object[] {
  if (protocol === "responses")
    return [
      { type: "response.output_text.delta", delta: text },
      {
        type: "response.completed",
        response: {
          ...outputs.responses,
          output: [
            {
              ...message,
              content: [{ type: "output_text", text, annotations: [] }],
            },
          ],
        },
      },
    ];
  if (protocol === "anthropic")
    return [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ];
  return [
    {
      ...outputs.gemini,
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    },
  ];
}
function sse(events: object[], buffered = false): Response {
  const text = events
    .map((event) => `event: ignored\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");
  if (buffered)
    return {
      ok: true,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: null,
      text: async () => text,
    } as unknown as Response;
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, ++offset));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

for (const protocol of ["responses", "anthropic", "gemini"] as const) {
  for (const mode of ["json", "stream", "buffered"] as const)
    test(`${protocol}: ${mode} authenticates, preserves prefixes, and reads a completed response`, async () => {
      let sent: any,
        url = "",
        headers: Headers | undefined;
      const deltas: string[] = [];
      const model = createNativeModelAdapter({
        protocol,
        baseUrl: "https://example.test/proxy/v1?version=one",
        apiKey: "fixture-secret",
        model: "fixture-model",
        stream: mode !== "json",
        maxTokens: 1000,
        onTextDelta: (text) => deltas.push(text),
        fetchImpl: async (input, init) => {
          url = String(input);
          headers = new Headers(init?.headers);
          sent = JSON.parse(String(init?.body));
          return mode === "json"
            ? Response.json(outputs[protocol])
            : sse(events(protocol, "中文🙂"), mode === "buffered");
        },
      });
      const result = await model.complete(request);
      assert.equal(result.end, "stop");
      assert.equal(result.text, mode === "json" ? "Found." : "中文🙂");
      assert.equal(deltas.join(""), mode === "json" ? "" : "中文🙂");
      assert.equal(result.usage?.totalTokens, 14);
      assert.equal(new URL(url).searchParams.get("version"), "one");
      assert.match(new URL(url).pathname, /^\/proxy\/v1\//);
      if (protocol === "responses") {
        assert.equal(headers!.get("authorization"), "Bearer fixture-secret");
        assert.equal(sent.max_output_tokens, 1000);
        assert.equal(sent.store, false);
        assert.equal(sent.tools[0].strict, false);
      }
      if (protocol === "anthropic") {
        assert.equal(headers!.get("x-api-key"), "fixture-secret");
        assert.ok(headers!.get("anthropic-version"));
        assert.equal(sent.system, "Be precise.");
        assert.equal(sent.max_tokens, 1000);
      }
      if (protocol === "gemini") {
        assert.equal(headers!.get("x-goog-api-key"), "fixture-secret");
        assert.equal(sent.generationConfig.maxOutputTokens, 1000);
        assert.equal(sent.systemInstruction.parts[0].text, "Be precise.");
        assert.deepEqual(
          sent.tools[0].functionDeclarations[0].parametersJsonSchema,
          tool.inputSchema,
        );
      }
    });

  test(`${protocol}: a truncated stream cannot execute tools`, async () => {
    const proposal =
      protocol === "responses"
        ? [
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "function_call",
                id: "item",
                call_id: "c1",
                name: "lookup",
                arguments: '{"query":"x"}',
              },
            },
          ]
        : protocol === "anthropic"
          ? [
              {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: "c1",
                  name: "lookup",
                  input: { query: "x" },
                },
              },
            ]
          : [
              {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: "lookup",
                            args: { query: "x" },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ];
    const model = createNativeModelAdapter({
      protocol,
      baseUrl: "https://example.test/v1",
      apiKey: "",
      model: "fixture",
      scheduleTimeout: (cb, ms) =>
        setTimeout(cb, ms === 1000 || ms === 2000 ? 0 : ms),
      cancelTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      fetchImpl: async () => sse(proposal),
    });
    let calls = 0;
    const h = createHarness({ model, modeFor: () => "auto_allow" });
    h.tools.call = async () => {
      calls++;
      throw new Error("must not execute");
    };
    const result = await h.loop.run({
      session: session(),
      turnId: "truncated",
      userText: "go",
    });
    assert.equal(result.stopReason, "model_retries_exhausted");
    assert.equal(calls, 0);
  });

  test(`${protocol}: cancellation aborts a pending request without retries`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const model = createNativeModelAdapter({
      protocol,
      baseUrl: "https://example.test/v1",
      apiKey: "",
      model: "fixture",
      fetchImpl: async (_url, init) => {
        calls++;
        controller.abort();
        assert.equal(init?.signal?.aborted, true);
        return new Promise<Response>(() => {});
      },
    });
    await assert.rejects(model.complete(request, controller.signal), {
      name: "AbortError",
    });
    assert.equal(calls, 1);
  });
}

test("Responses replays encrypted reasoning and tool call IDs through the next request", async () => {
  const items = [
    { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "lookup",
      arguments: '{"query":"x"}',
    },
  ];
  const bodies: any[] = [];
  const model = createNativeModelAdapter({
    protocol: "responses",
    baseUrl: "https://example.test/cch/v1/responses",
    apiKey: "",
    model: "gpt-6.1-sol",
    maxTokens: 128000,
    reasoningEffort: "max",
    stream: false,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(
        bodies.length === 1
          ? { status: "completed", output: items }
          : outputs.responses,
      );
    },
  });
  const first = await model.complete(request);
  assert.equal(first.end, "tool_calls");
  assert.equal(first.toolCalls?.[0].id, "call_1");
  const messages: ModelMessage[] = [
    ...request.messages,
    {
      role: "assistant",
      content: "",
      toolCalls: first.toolCalls,
      replayState: first.replayState,
    },
    { role: "tool", content: '{"found":true}', toolCallId: "call_1" },
  ];
  assert.equal((await model.complete({ ...request, messages })).text, "Found.");
  assert.deepEqual(bodies[1].input.slice(-3, -1), items);
  assert.deepEqual(bodies[1].input.at(-1), {
    type: "function_call_output",
    call_id: "call_1",
    output: '{"found":true}',
  });
  assert.deepEqual(bodies[0].reasoning, { effort: "max" });
  assert.equal(bodies[0].max_output_tokens, 128000);
  const elsewhere = createNativeModelAdapter({
    protocol: "responses",
    baseUrl: "https://other.test/v1",
    apiKey: "",
    model: "gpt-6.1-sol",
    stream: false,
    fetchImpl: async (_url, init) => {
      assert.doesNotMatch(String(init?.body), /opaque/);
      return Response.json(outputs.responses);
    },
  });
  await elsewhere.complete({ ...request, messages });
});

test("Anthropic streams thinking signatures and JSON arguments, then groups tool results", async () => {
  const bodies: any[] = [];
  const frames = [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "summary" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "SIGNED" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "t1", name: "lookup", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"query":' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"paper"}' },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ];
  const model = createNativeModelAdapter({
    protocol: "anthropic",
    baseUrl: "https://example.test/v1",
    apiKey: "",
    model: "claude-sonnet-4-6",
    reasoningEffort: "high",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? sse(frames) : sse(events("anthropic"));
    },
  });
  const first = await model.complete(request);
  assert.deepEqual(first.toolCalls?.[0].args, { query: "paper" });
  await model.complete({
    ...request,
    messages: [
      ...request.messages,
      {
        role: "assistant",
        content: "",
        toolCalls: first.toolCalls,
        replayState: first.replayState,
      },
      { role: "tool", content: "result", toolCallId: "t1" },
    ],
  });
  assert.equal(bodies[1].messages.at(-2).content[0].signature, "SIGNED");
  assert.equal(bodies[1].messages.at(-1).content[0].tool_use_id, "t1");
  assert.deepEqual(bodies[0].output_config, { effort: "high" });
});

for (const withIds of [true, false])
  test(`Gemini retains thought signatures and parallel tool results ${withIds ? "with" : "without"} wire IDs`, async () => {
    const parts = [
      {
        functionCall: {
          ...(withIds ? { id: "g1" } : {}),
          name: "lookup",
          args: { query: "a" },
        },
        thoughtSignature: "SIGNED",
      },
      {
        functionCall: {
          ...(withIds ? { id: "g2" } : {}),
          name: "lookup",
          args: { query: "b" },
        },
      },
      { thoughtSignature: "SIGNATURE_ONLY" },
    ];
    const bodies: any[] = [];
    const model = createNativeModelAdapter({
      protocol: "gemini",
      baseUrl: "https://example.test/proxy/v1beta",
      apiKey: "",
      model: "gemini-3-pro-preview",
      stream: false,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(
          bodies.length === 1
            ? { candidates: [{ content: { parts }, finishReason: "STOP" }] }
            : outputs.gemini,
        );
      },
    });
    const first = await model.complete(request);
    await model.complete({
      ...request,
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: "",
          toolCalls: first.toolCalls,
          replayState: first.replayState,
        },
        ...first.toolCalls!.map((call) => ({
          role: "tool" as const,
          content: "ok",
          toolCallId: call.id,
        })),
      ],
    });
    assert.deepEqual(bodies[1].contents.at(-2).parts, parts);
    assert.equal(bodies[1].contents.at(-1).parts.length, 2);
    assert.equal(
      bodies[1].contents.at(-1).parts[0].functionResponse.id,
      withIds ? "g1" : undefined,
    );
  });

test("native protocols encode transient page images without losing MIME types", async () => {
  for (const protocol of ["responses", "anthropic", "gemini"] as const) {
    let body: any;
    const model = createNativeModelAdapter({
      protocol,
      baseUrl: "https://example.test/v1",
      apiKey: "",
      model: "fixture",
      stream: false,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json(outputs[protocol]);
      },
    });
    await model.complete({
      messages: [
        {
          role: "user",
          content: "Read this page",
          images: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
        },
      ],
    });
    if (protocol === "responses")
      assert.equal(
        body.input[0].content[1].image_url,
        "data:image/png;base64,aW1hZ2U=",
      );
    if (protocol === "anthropic")
      assert.deepEqual(body.messages[0].content[1].source, {
        type: "base64",
        media_type: "image/png",
        data: "aW1hZ2U=",
      });
    if (protocol === "gemini")
      assert.deepEqual(body.contents[0].parts[1].inlineData, {
        mimeType: "image/png",
        data: "aW1hZ2U=",
      });
  }
});

test("Responses recovers tools from completed output items and marks invalid JSON non-executable", async () => {
  const output = [
    {
      type: "function_call",
      id: "fc",
      call_id: "c",
      name: "lookup",
      arguments: "{",
    },
  ];
  const model = createNativeModelAdapter({
    protocol: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "",
    model: "fixture",
    fetchImpl: async () =>
      sse([
        { type: "response.output_item.done", output_index: 0, item: output[0] },
        { type: "response.completed", response: { status: "completed" } },
      ]),
  });
  assert.ok((await model.complete(request)).toolCalls?.[0].argumentsError);
});

test("MCP tool names survive wire normalization without changing host dispatch", async () => {
  let name = "";
  const model = createNativeModelAdapter({
    protocol: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "",
    model: "fixture",
    stream: false,
    fetchImpl: async (_url, init) => {
      name = JSON.parse(String(init?.body)).tools[0].name;
      return Response.json({
        status: "completed",
        output: [
          { type: "function_call", call_id: "c", name, arguments: "{}" },
        ],
      });
    },
  });
  const result = await model.complete({
    ...request,
    tools: [{ ...tool, name: "mcp.library.search" }],
  });
  assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(result.toolCalls?.[0].name, "mcp.library.search");
});

test("non-2xx structured quota errors fail once and Retry-After is not shortened", async () => {
  let calls = 0;
  const quota = createNativeModelAdapter({
    protocol: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "",
    model: "fixture",
    fetchImpl: async () => {
      calls++;
      return Response.json(
        { error: { code: "insufficient_quota", message: "Quota exhausted" } },
        { status: 429 },
      );
    },
  });
  await assert.rejects(
    quota.complete({ ...request, maxAttempts: 3 }),
    (error: ModelError) => error.options.retryable === false,
  );
  assert.equal(calls, 1);
  const delays: number[] = [];
  const retry = createNativeModelAdapter({
    protocol: "responses",
    baseUrl: "https://example.test/v1",
    apiKey: "",
    model: "fixture",
    scheduleTimeout: (cb, ms) => {
      if (ms === 60000) delays.push(ms);
      return setTimeout(cb, ms === 60000 ? 0 : ms);
    },
    cancelTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    fetchImpl: async () =>
      ++calls === 2
        ? new Response("busy", {
            status: 503,
            headers: { "retry-after": "60" },
          })
        : Response.json(outputs.responses),
  });
  await retry.complete({ ...request, maxAttempts: 3 });
  assert.deepEqual(delays, [60000]);
});

test("provider catalogs use their native authentication and model ID shape", async () => {
  for (const protocol of [
    "anthropic",
    "gemini",
    "responses",
    "ollama",
  ] as const) {
    const listed = await listEndpointModels(
      { baseUrl: "https://example.test/gateway", protocol, apiKey: "key" },
      async (url, init) => {
        const headers = new Headers(init?.headers);
        if (protocol === "anthropic")
          assert.equal(headers.get("x-api-key"), "key");
        if (protocol === "gemini") {
          assert.equal(headers.get("x-goog-api-key"), "key");
          assert.match(String(url), /\/gateway\/models/);
          return Response.json({
            models: [
              {
                name: "models/gemini-test",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/embedding",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
          });
        }
        if (protocol === "ollama")
          return Response.json({ models: [{ name: "local" }] });
        return Response.json({ data: [{ id: "remote" }] });
      },
    );
    assert.deepEqual(listed.models, [
      protocol === "gemini"
        ? "gemini-test"
        : protocol === "ollama"
          ? "local"
          : "remote",
    ]);
  }
});

test("SSE parser handles multiline JSON and ignores keepalives", () => {
  const values: unknown[] = [];
  const parser = new ModelSseParser((value) => values.push(JSON.parse(value)));
  for (const char of ': ping\r\ndata: {\r\ndata: "ok": true}\r\n\r\ndata: [DONE]\n\n')
    parser.push(char);
  parser.finish();
  assert.deepEqual(values, [{ ok: true }]);
});
