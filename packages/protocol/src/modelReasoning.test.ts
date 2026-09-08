import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  modelReasoning,
  normalizeModelEffort,
  modelReasoningBody,
} from "./modelReasoning";
import { applyEndpointPatch, defaultEndpoint } from "./endpoints";

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
