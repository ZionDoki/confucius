import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  modelReasoning,
  normalizeModelEffort,
  modelReasoningBody,
} from "./modelReasoning";
import {
  applyEndpointPatch,
  defaultEndpoint,
  parseEndpointsJson,
  resolveEndpointStore,
} from "./endpoints";

describe("model-specific native reasoning", () => {
  for (const [models, efforts] of [
    [["gpt-6-astra"], ["low", "medium", "high", "xhigh", "max"]],
    [
      ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      ["off", "low", "medium", "high", "xhigh", "max"],
    ],
    [
      ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2"],
      ["off", "low", "medium", "high", "xhigh"],
    ],
    [["gpt-5.1"], ["off", "low", "medium", "high"]],
    [
      ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
      ["minimal", "low", "medium", "high"],
    ],
    [
      ["o1", "o3", "o3-mini", "o4-mini"],
      ["low", "medium", "high"],
    ],
    [
      ["deepseek-v4-pro", "deepseek-v4-flash"],
      ["off", "low", "high", "max"],
    ],
    [
      ["kimi-k2.5", "kimi-k2.6"],
      ["off", "on"],
    ],
    [
      ["kimi-k3", "k3", "k3-256k"],
      ["low", "high", "max"],
    ],
    [
      [
        "kimi-for-coding",
        "kimi-for-coding-highspeed",
        "kimi-k2.7-code",
        "kimi-k2.7-code-highspeed",
      ],
      ["on"],
    ],
  ] as const) {
    it(`offers the documented efforts for ${models.join(", ")}`, () => {
      for (const model of models) {
        assert.deepEqual(modelReasoning(model).efforts, ["auto", ...efforts]);
        assert.deepEqual(modelReasoning(`provider/${model}`).efforts, [
          "auto",
          ...efforts,
        ]);
        assert.deepEqual(modelReasoningBody(model, "", "auto"), {});
        for (const effort of efforts)
          assert.equal(normalizeModelEffort(model, "", effort), effort);
      }
    });
  }

  it("does not offer off or minimal on Astra, or a fictional medium on DeepSeek V4", () => {
    assert.deepEqual(modelReasoning("gpt-6-astra").efforts, [
      "auto",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    assert.deepEqual(modelReasoning("deepseek-v4-pro").efforts, [
      "auto",
      "off",
      "low",
      "high",
      "max",
    ]);
    assert.deepEqual(modelReasoning("kimi-k2.6").efforts, [
      "auto",
      "off",
      "on",
    ]);
    assert.deepEqual(modelReasoning("future-custom-model").efforts, ["auto"]);
    assert.deepEqual(modelReasoning("gpt-5-chat-latest").efforts, ["auto"]);
    assert.deepEqual(modelReasoning("gpt-6-astra-custom").efforts, ["auto"]);
  });

  it("uses an explicit disable parameter, keeping default separate from off", () => {
    assert.deepEqual(modelReasoningBody("gpt-5.5", "", "off"), {
      reasoning_effort: "none",
    });
    assert.deepEqual(modelReasoningBody("gpt-5.5", "", "auto"), {});
    assert.deepEqual(modelReasoningBody("kimi-k2.6", "", "off"), {
      thinking: { type: "disabled" },
    });
    assert.deepEqual(modelReasoningBody("deepseek-v4-flash", "", "max"), {
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    assert.deepEqual(modelReasoningBody("future-custom-model", "", "high"), {});
    assert.deepEqual(modelReasoningBody("kimi-k3", "", "low"), {
      reasoning_effort: "low",
    });
    assert.deepEqual(modelReasoningBody("kimi-k3", "", "off"), {});
    assert.deepEqual(modelReasoningBody("k3-256k", "", "max"), {
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    assert.deepEqual(
      modelReasoningBody("kimi-for-coding-highspeed", "", "on"),
      {
        thinking: { type: "enabled" },
      },
    );
    assert.deepEqual(modelReasoningBody("kimi-for-coding", "", "high"), {});
  });

  it("distinguishes Ollama boolean thinking from GPT-OSS effort levels", () => {
    const url = "http://localhost:11434/api/chat";
    assert.deepEqual(modelReasoning("gpt-oss:20b", url).efforts, [
      "auto",
      "low",
      "medium",
      "high",
    ]);
    assert.deepEqual(modelReasoningBody("gpt-oss:20b", url, "off"), {});
    assert.deepEqual(modelReasoningBody("gpt-oss:20b", url, "low"), {
      think: "low",
    });
    assert.deepEqual(modelReasoningBody("qwen3:8b", url, "on"), {
      think: true,
    });
    assert.deepEqual(modelReasoningBody("deepseek-v3.1:671b", url, "off"), {
      think: false,
    });
  });

  it("resets an incompatible saved effort when switching models", () => {
    assert.equal(normalizeModelEffort("gpt-6-astra", "", "off"), "auto");
    const ep = defaultEndpoint({
      baseUrl: "https://api.example.test/v1",
      apiKey: "test",
      model: "gpt-5.5",
      maxTokens: 0,
      reasoningEffort: "off",
      contextWindowTokens: 32768,
    });
    const result = applyEndpointPatch(
      { endpoints: [ep], activeEndpointId: ep.id },
      { model: "gpt-6-astra" },
    );
    assert.equal(result.ok, true);
    if (result.ok)
      assert.equal(result.store.endpoints[0].reasoningEffort, "auto");
  });
});

describe("custom reasoning settings", () => {
  const legacy = {
    baseUrl: "https://gateway.example.test/v1",
    apiKey: "test",
    model: "private-alias",
    maxTokens: 0,
    reasoningEffort: "auto",
    contextWindowTokens: 32768,
  };
  const reasoning = {
    "private-alias": {
      transport: "openai" as const,
      efforts: ["low", "ultra"],
    },
  };

  it("round-trips provider-specific values, including legacy synchronization", () => {
    const ep = defaultEndpoint(legacy);
    const result = applyEndpointPatch(
      { endpoints: [ep], activeEndpointId: ep.id },
      {
        endpoint: { id: ep.id, reasoning, reasoningEffort: "ultra" },
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const saved = result.store.endpoints[0];
    assert.equal(saved.reasoningEffort, "ultra");
    const json = JSON.stringify(result.store.endpoints);
    assert.deepEqual(parseEndpointsJson(json)[0].reasoning, reasoning);
    assert.deepEqual(
      resolveEndpointStore(json, ep.id, { ...legacy, reasoningEffort: "ultra" })
        .store.endpoints[0],
      saved,
    );
    const legacyEdit = resolveEndpointStore(json, ep.id, {
      ...legacy,
      maxTokens: 100,
    });
    assert.deepEqual(legacyEdit.store.endpoints[0].reasoning, reasoning);
  });

  it("scopes overrides to the exact model and restores built-in behavior when removed", () => {
    const ep = {
      ...defaultEndpoint(legacy),
      reasoning,
      reasoningEffort: "ultra",
    };
    const seed = { endpoints: [ep], activeEndpointId: ep.id };
    const switched = applyEndpointPatch(seed, { model: "another-model" });
    assert.equal(switched.ok, true);
    if (!switched.ok) return;
    assert.equal(switched.store.endpoints[0].reasoningEffort, "auto");
    assert.deepEqual(switched.store.endpoints[0].reasoning, reasoning);
    const back = applyEndpointPatch(switched.store, {
      model: "private-alias",
      reasoningEffort: "ultra",
    });
    assert.equal(back.ok, true);
    if (back.ok) assert.equal(back.store.endpoints[0].reasoningEffort, "ultra");
    const cleared = applyEndpointPatch(seed, {
      endpoint: { id: ep.id, reasoning: {} },
    });
    assert.equal(cleared.ok, true);
    if (cleared.ok)
      assert.equal(cleared.store.endpoints[0].reasoningEffort, "auto");
    assert.equal(ep.reasoningEffort, "ultra");
  });

  it("rejects malformed settings without saving or silently downgrading them", () => {
    const ep = defaultEndpoint(legacy);
    for (const override of [
      { transport: "arbitrary", efforts: ["high"] },
      { transport: "openai", efforts: ["bad value"] },
      { transport: "openai", efforts: ["x".repeat(65)] },
      { transport: "openai", efforts: ["high", "high"] },
      { transport: "thinking", efforts: ["high"], body: { anything: true } },
      {
        transport: "openai",
        efforts: Array.from({ length: 33 }, (_, i) => `level${i}`),
      },
    ]) {
      const result = applyEndpointPatch(
        { endpoints: [ep], activeEndpointId: ep.id },
        {
          endpoint: { id: ep.id, reasoning: { "private-alias": override } },
        },
      );
      assert.equal(result.ok, false);
    }
    assert.equal(
      applyEndpointPatch(
        { endpoints: [ep], activeEndpointId: ep.id },
        {
          endpoint: { id: ep.id, reasoningEffort: "bad value" },
        },
      ).ok,
      false,
    );
  });

  it("uses explicitly configured wire formats without inventing options", () => {
    for (const [transport, effort, expected] of [
      ["openai", "ultra", { reasoning_effort: "ultra" }],
      ["openai", "off", { reasoning_effort: "none" }],
      [
        "thinking",
        "ultra",
        { thinking: { type: "enabled" }, reasoning_effort: "ultra" },
      ],
      ["thinking", "off", { thinking: { type: "disabled" } }],
      ["ollama", "on", { think: true }],
      ["ollama", "off", { think: false }],
      ["ollama", "ultra", { think: "ultra" }],
    ] as const) {
      const config = { transport, efforts: [effort] };
      assert.deepEqual(
        modelReasoningBody("private-alias", legacy.baseUrl, effort, config),
        expected,
      );
      assert.deepEqual(
        modelReasoningBody("private-alias", legacy.baseUrl, "auto", config),
        {},
      );
      assert.deepEqual(
        modelReasoningBody("private-alias", legacy.baseUrl, "medium", config),
        {},
      );
    }
  });
});
