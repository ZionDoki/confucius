import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ENDPOINTS,
  applyEndpointPatch,
  defaultEndpoint,
  endpointIsConfigured,
  parseEndpointsJson,
  resolveEndpointStore,
} from "./endpoints";

const legacy = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
  maxTokens: 0,
  reasoningEffort: "auto",
  contextWindowTokens: 32768,
};

describe("resolveEndpointStore", () => {
  it("migrates a single legacy pref row into a store", () => {
    const { store, dirty } = resolveEndpointStore("[]", "", legacy);
    assert.equal(dirty, true);
    assert.equal(store.endpoints.length, 1);
    assert.equal(store.endpoints[0]?.model, "gpt-4o-mini");
    assert.equal(store.endpoints[0]?.id, store.activeEndpointId);
    assert.equal(endpointIsConfigured(store.endpoints[0]), true);
  });

  it("keeps a persisted list and repairs a missing active id", () => {
    const json = JSON.stringify([
      {
        id: "ep_a",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434/api/chat",
        apiKey: "ollama",
        model: "qwen3.8-27b",
        maxTokens: 0,
        reasoningEffort: "low",
        contextWindowTokens: 32768,
      },
    ]);
    const { store, dirty } = resolveEndpointStore(json, "missing", {
      ...legacy,
      baseUrl: "http://127.0.0.1:11434/api/chat",
      apiKey: "ollama",
      model: "qwen3.8-27b",
      reasoningEffort: "low",
    });
    assert.equal(store.activeEndpointId, "ep_a");
    assert.equal(dirty, true);
    assert.equal(store.endpoints[0]?.name, "Ollama");
  });
});

describe("applyEndpointPatch", () => {
  const seed = resolveEndpointStore("[]", "", legacy).store;

  it("adds a second endpoint and makes it active", () => {
    const result = applyEndpointPatch(seed, {
      endpoint: {
        name: "Local",
        baseUrl: "http://127.0.0.1:11434/api/chat",
        apiKey: "ollama",
        model: "qwen3.8-27b",
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.store.endpoints.length, 2);
    const active = result.store.endpoints.find(
      (entry) => entry.id === result.store.activeEndpointId,
    );
    assert.equal(active?.model, "qwen3.8-27b");
    assert.equal(active?.name, "Local");
  });

  it("updates the active endpoint through legacy fields", () => {
    const result = applyEndpointPatch(seed, {
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.store.endpoints[0]?.reasoningEffort, "high");
    assert.equal(result.store.endpoints[0]?.model, "gpt-5.5");
  });

  it("switches the active endpoint", () => {
    const added = applyEndpointPatch(seed, {
      endpoint: {
        name: "B",
        baseUrl: "https://api.example.test/v1",
        apiKey: "k",
        model: "demo",
      },
    });
    assert.equal(added.ok, true);
    if (!added.ok) {
      return;
    }
    const originalId = seed.activeEndpointId;
    const switched = applyEndpointPatch(added.store, {
      activeEndpointId: originalId,
    });
    assert.equal(switched.ok, true);
    if (!switched.ok) {
      return;
    }
    assert.equal(switched.store.activeEndpointId, originalId);
  });

  it("switches endpoint and sets that endpoint's model in one patch", () => {
    const added = applyEndpointPatch(seed, {
      endpoint: {
        name: "B",
        baseUrl: "https://api.example.test/v1",
        apiKey: "k",
        model: "demo",
      },
    });
    assert.equal(added.ok, true);
    if (!added.ok) {
      return;
    }
    const targetId = seed.activeEndpointId;
    const result = applyEndpointPatch(added.store, {
      activeEndpointId: targetId,
      model: "gpt-4o",
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.store.activeEndpointId, targetId);
    const active = result.store.endpoints.find(
      (entry) => entry.id === targetId,
    );
    assert.equal(active?.model, "gpt-4o");
  });

  it("refuses to delete the last endpoint", () => {
    const result = applyEndpointPatch(seed, {
      deleteEndpointId: seed.activeEndpointId,
    });
    assert.equal(result.ok, false);
  });

  it("deletes a non-active endpoint", () => {
    const added = applyEndpointPatch(seed, {
      endpoint: {
        name: "Extra",
        baseUrl: "https://api.example.test/v1",
        apiKey: "k",
        model: "demo",
      },
    });
    assert.equal(added.ok, true);
    if (!added.ok) {
      return;
    }
    const extraId = added.store.activeEndpointId;
    const deleted = applyEndpointPatch(added.store, {
      deleteEndpointId: extraId,
    });
    assert.equal(deleted.ok, true);
    if (!deleted.ok) {
      return;
    }
    assert.equal(deleted.store.endpoints.length, 1);
    assert.equal(deleted.store.activeEndpointId, seed.activeEndpointId);
  });

  it("rejects an endpoint without a model", () => {
    const result = applyEndpointPatch(seed, {
      endpoint: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "k",
        model: "",
      },
    });
    assert.equal(result.ok, false);
  });
});

describe("parseEndpointsJson", () => {
  it("drops malformed rows and caps the list", () => {
    const rows = Array.from({ length: MAX_ENDPOINTS + 5 }, (_, index) => ({
      id: `ep_${index}`,
      name: "x",
      baseUrl: "https://api.example.test/v1",
      apiKey: "",
      model: "m",
      maxTokens: 0,
      reasoningEffort: "auto",
      contextWindowTokens: 32768,
    }));
    rows.push({ id: "" } as never);
    const parsed = parseEndpointsJson(JSON.stringify(rows));
    assert.equal(parsed.length, MAX_ENDPOINTS);
  });

  it("returns empty on invalid JSON", () => {
    assert.deepEqual(parseEndpointsJson("not-json"), []);
    assert.deepEqual(parseEndpointsJson("{}"), []);
  });
});

describe("defaultEndpoint", () => {
  it("names the row after the model", () => {
    const ep = defaultEndpoint(legacy);
    assert.equal(ep.name, "gpt-4o-mini");
  });
});
