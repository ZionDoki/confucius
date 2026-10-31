import assert from "node:assert/strict";
import { test } from "node:test";
import { modelApiUrl, resolveModelProtocol } from "./modelProtocol";
import { modelReasoning } from "./modelReasoning";
import {
  applyEndpointPatch,
  blankEndpoint,
  parseEndpointsJson,
  resolveEndpointStore,
} from "./endpoints";

test("native reasoning profiles do not advertise unsupported levels", () => {
  assert.equal(
    modelReasoning(
      "claude-sonnet-4-6",
      "",
      undefined,
      "anthropic",
    ).efforts.includes("xhigh"),
    false,
  );
  assert.equal(
    modelReasoning(
      "claude-opus-4-7",
      "",
      undefined,
      "anthropic",
    ).efforts.includes("xhigh"),
    true,
  );
  assert.deepEqual(
    modelReasoning("gemini-4-argon", "", undefined, "gemini").efforts,
    ["auto", "low", "medium", "high"],
  );
  assert.deepEqual(
    modelReasoning("gemini-3.1-flash-lite-image", "", undefined, "gemini")
      .efforts,
    ["auto", "minimal", "high"],
  );
  assert.deepEqual(
    modelReasoning("gemini-9-unknown", "", undefined, "gemini").efforts,
    ["auto"],
  );
});

test("auto preserves generic gateways and recognizes explicit native URLs", () => {
  for (const [url, protocol] of [
    ["https://proxy.test/cch/v1", "openai"],
    ["https://proxy.test/cch/v1/responses?key=x", "responses"],
    ["https://proxy.test/cch/v1/messages", "anthropic"],
    ["https://api.anthropic.com", "anthropic"],
    ["https://generativelanguage.googleapis.com", "gemini"],
    ["http://localhost:11434/api/chat?x=1", "ollama"],
  ])
    assert.equal(resolveModelProtocol(url), protocol);
  assert.equal(
    resolveModelProtocol("https://api.anthropic.com/v1", "openai"),
    "openai",
  );
});

test("API routes preserve gateway prefixes and query values without duplicating suffixes", () => {
  assert.equal(
    modelApiUrl(
      "https://proxy.test/cch/v1/responses?upstream=https://u/",
      "responses",
      "/responses",
    ),
    "https://proxy.test/cch/v1/responses?upstream=https://u/",
  );
  assert.equal(
    modelApiUrl(
      "https://proxy.test/google/v1beta/models/gemini-a:generateContent",
      "gemini",
      "/models",
    ),
    "https://proxy.test/google/v1beta/models",
  );
  assert.equal(
    modelApiUrl("http://localhost:11434", "ollama", "/api/chat"),
    "http://localhost:11434/api/chat",
  );
  assert.equal(
    modelApiUrl("http://localhost:11434/proxy/api", "ollama", "/api/tags"),
    "http://localhost:11434/proxy/api/tags",
  );
});

test("protocol selection survives endpoint saves, restart migration, and legacy edits", () => {
  const endpoint = {
    ...blankEndpoint("one"),
    baseUrl: "https://proxy.test/v1",
    model: "gpt-6.1-sol",
  };
  const result = applyEndpointPatch(
    { endpoints: [endpoint], activeEndpointId: "one" },
    { endpoint: { id: "one", protocol: "responses", reasoningEffort: "max" } },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.store.endpoints[0].reasoningEffort, "max");
  const saved = JSON.stringify(result.store.endpoints);
  assert.equal(parseEndpointsJson(saved)[0].protocol, "responses");
  const legacy = { ...endpoint, model: "gpt-6.1-terra" };
  assert.equal(
    resolveEndpointStore(saved, "one", legacy).store.endpoints[0].protocol,
    "responses",
  );
  assert.equal(
    applyEndpointPatch(result.store, {
      endpoint: { id: "one", protocol: "invalid" },
    }).ok,
    false,
  );
  assert.equal(
    parseEndpointsJson(JSON.stringify([endpoint]))[0].protocol,
    undefined,
  );
});
