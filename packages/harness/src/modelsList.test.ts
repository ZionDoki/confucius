import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  listEndpointModels,
  mergeModelChoices,
  modelsListRequest,
  parseModelsList,
} from "./modelsList";

describe("modelsListRequest", () => {
  it("maps OpenAI-compatible roots onto /models", () => {
    assert.deepEqual(modelsListRequest("https://api.openai.com/v1"), {
      url: "https://api.openai.com/v1/models",
      style: "openai",
    });
    assert.equal(
      modelsListRequest("https://api.openai.com/v1/chat/completions").url,
      "https://api.openai.com/v1/models",
    );
  });

  it("maps Ollama /api/chat onto /api/tags", () => {
    assert.deepEqual(modelsListRequest("http://127.0.0.1:11434/api/chat"), {
      url: "http://127.0.0.1:11434/api/tags",
      style: "ollama",
    });
    assert.equal(
      modelsListRequest("http://127.0.0.1:11434/api/chat/").url,
      "http://127.0.0.1:11434/api/tags",
    );
  });
});

describe("parseModelsList", () => {
  it("reads OpenAI data[].id and Ollama models[].name", () => {
    assert.deepEqual(
      parseModelsList("openai", {
        data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
      }),
      ["gpt-4o-mini", "gpt-4o"],
    );
    assert.deepEqual(
      parseModelsList("ollama", {
        models: [{ name: "qwen3.8-27b:latest" }, { model: "llama3.1" }],
      }),
      ["qwen3.8-27b:latest", "llama3.1"],
    );
  });
});

describe("mergeModelChoices", () => {
  it("keeps the saved model first and dedupes the catalog", () => {
    assert.deepEqual(
      mergeModelChoices("gpt-4o-mini", ["gpt-4o", "gpt-4o-mini", "gpt-4o"]),
      ["gpt-4o-mini", "gpt-4o"],
    );
  });
});

describe("listEndpointModels", () => {
  it("includes the saved model when the catalog omits it", async () => {
    const result = await listEndpointModels(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "k",
        model: "mine",
      },
      (async () =>
        new Response(JSON.stringify({ data: [{ id: "theirs" }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    assert.deepEqual(result.models, ["mine", "theirs"]);
    assert.equal(result.error, undefined);
  });

  it("returns the saved model and an error on HTTP failure", async () => {
    const result = await listEndpointModels(
      {
        baseUrl: "https://api.example.test/v1",
        model: "kept",
      },
      (async () =>
        new Response("nope", { status: 401 })) as unknown as typeof fetch,
    );
    assert.deepEqual(result.models, ["kept"]);
    assert.match(result.error || "", /HTTP 401/);
  });
});
