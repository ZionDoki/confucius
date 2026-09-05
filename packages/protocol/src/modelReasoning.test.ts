import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  modelReasoning,
  normalizeModelEffort,
  modelReasoningBody,
} from "./modelReasoning";
import { applyEndpointPatch, defaultEndpoint } from "./endpoints";

describe("model-specific native reasoning", () => {
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
