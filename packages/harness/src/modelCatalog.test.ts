import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ModelCatalog,
  MODEL_CATALOG_URL,
  parseModelCatalog,
} from "./modelCatalog";

const fixture = {
  lab: {
    name: "Lab",
    api: "https://ignored.example.test",
    env: ["DO_NOT_USE"],
    models: {
      "model-1": {
        id: "model-1",
        name: "Model One",
        limit: { context: 120000, output: 8000 },
        reasoning_options: [
          { type: "effort", values: ["none", "low", "ultra", null, "default"] },
        ],
        provider: { body: { injected: true } },
      },
      toggle: {
        id: "toggle",
        name: "Toggle",
        reasoning_options: [
          { type: "toggle" },
          { type: "budget_tokens", min: 1024 },
        ],
      },
      unknown: {
        id: "unknown",
        name: "Unknown",
        reasoning: true,
        limit: { context: -1, output: "8000" },
      },
      disabled: { id: "disabled", name: "No reasoning", reasoning_options: [] },
    },
  },
  gateway: {
    name: "Gateway",
    models: {
      "lab/model-1": {
        id: "lab/model-1",
        name: "Model One",
        limit: { context: 64000, output: 4000 },
      },
    },
  },
};

describe("models.dev catalog", () => {
  it("keeps provider IDs and limits distinct, reading only supported metadata", () => {
    const entries = parseModelCatalog(fixture);
    assert.equal(entries.length, 5);
    assert.deepEqual(entries[0], {
      providerId: "lab",
      providerName: "Lab",
      id: "model-1",
      name: "Model One",
      contextWindowTokens: 120000,
      maxOutputTokens: 8000,
      reasoningEfforts: ["off", "low", "ultra"],
    });
    assert.deepEqual(entries[1].reasoningEfforts, ["off", "on"]);
    assert.equal(entries[1].reasoningBudget, true);
    assert.equal(entries[2].reasoningEfforts, undefined);
    assert.equal(entries[2].contextWindowTokens, undefined);
    assert.equal(entries[2].maxOutputTokens, undefined);
    assert.deepEqual(entries[3].reasoningEfforts, []);
    assert.equal(entries[4].contextWindowTokens, 64000);
    assert.deepEqual(parseModelCatalog({ invalid: null }), []);
  });

  it("downloads only the public URL, filters locally and caches for a day", async () => {
    const requests: unknown[] = [];
    let now = 0;
    const controller = new AbortController();
    const catalog = new ModelCatalog(
      async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify(fixture));
      },
      () => now,
    );
    const result = await catalog.search("model-1", controller.signal);
    assert.equal(result.source, MODEL_CATALOG_URL);
    assert.equal(result.models[0].id, "model-1");
    assert.equal(result.total, 2);
    assert.deepEqual(requests, [
      {
        url: MODEL_CATALOG_URL,
        init: { method: "GET", credentials: "omit", signal: controller.signal },
      },
    ]);
    assert.equal((await catalog.search("gateway model-1")).total, 1);
    assert.equal((await catalog.search("private alias")).total, 0);
    assert.equal((await catalog.search("")).total, 5);
    assert.equal(requests.length, 1);
    now += 24 * 60 * 60 * 1000;
    await catalog.search("model-1");
    assert.equal(requests.length, 2);
  });

  it("does not cache failed, malformed or empty responses and permits retry", async () => {
    for (const bad of [
      new Response("failure", { status: 503 }),
      new Response("<html>"),
      new Response("{}"),
    ]) {
      let count = 0;
      const catalog = new ModelCatalog(async () =>
        ++count === 1 ? bad : new Response(JSON.stringify(fixture)),
      );
      await assert.rejects(catalog.search("model-1"));
      assert.equal((await catalog.search("model-1")).total, 2);
    }
    const catalog = new ModelCatalog(async () => {
      throw new Error("offline");
    });
    await assert.rejects(catalog.search("model-1"), /offline/);
    await assert.rejects(catalog.search("x".repeat(257)), /at most 256/);
  });

  it("bounds results and ignores malformed rows", async () => {
    const catalog = new ModelCatalog(
      async () =>
        new Response(
          JSON.stringify({
            p: {
              models: Object.fromEntries(
                Array.from({ length: 100 }, (_, i) => [
                  `model-${i}`,
                  { name: `Model ${i}` },
                ]),
              ),
            },
            broken: { models: { noName: {}, null: null, array: [] } },
          }),
        ),
    );
    const result = await catalog.search("model");
    assert.equal(result.total, 100);
    assert.equal(result.models.length, 60);
  });
});
