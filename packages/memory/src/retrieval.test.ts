import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryRetriever } from "./retrieval";
import { jaccard, tokenize } from "./tokenize";
import type { MemoryRecord } from "./types";

function memory(
  id: string,
  content: string,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id,
    type: "fact",
    title: content.slice(0, 20),
    content,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
    confidence: 0.5,
    history: [],
    ...overrides,
  };
}

describe("tokenize", () => {
  it("splits ASCII words and lowercases", () => {
    assert.deepEqual(tokenize("Transformer Models!"), [
      "transformer",
      "models",
    ]);
  });

  it("produces CJK bigrams", () => {
    const tokens = tokenize("多模态检索");
    assert.ok(tokens.includes("多模"));
    assert.ok(tokens.includes("模态"));
    assert.ok(tokens.includes("检索"));
  });

  it("jaccard is 1 for identical and 0 for disjoint text", () => {
    assert.equal(jaccard("alpha beta", "alpha beta"), 1);
    assert.equal(jaccard("alpha beta", "gamma delta"), 0);
  });
});

describe("MemoryRetriever", () => {
  const NOW = 10 * 86_400_000;

  it("ranks lexical matches above non-matches", () => {
    const retriever = new MemoryRetriever();
    retriever.index([
      memory("mem_a", "The user studies transformer architectures."),
      memory("mem_b", "The user plays chess on weekends."),
    ]);
    const results = retriever.search({ query: "transformer" }, NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].record.id, "mem_a");
    assert.ok(results[0].score > 0);
  });

  it("matches Chinese queries against Chinese memories", () => {
    const retriever = new MemoryRetriever();
    retriever.index([
      memory("mem_cjk", "用户正在研究多模态检索增强生成。"),
      memory("mem_en", "User studies biology."),
    ]);
    const results = retriever.search({ query: "多模态检索" }, NOW);
    assert.equal(results[0].record.id, "mem_cjk");
  });

  it("filters by type and requires tag overlap when tags given", () => {
    const retriever = new MemoryRetriever();
    retriever.index([
      memory("mem_pref", "Likes surveys", { type: "preference", tags: ["reading"] }),
      memory("mem_fact", "Surveys are review articles", { type: "fact" }),
    ]);
    const typed = retriever.search(
      { query: "surveys", type: "preference" },
      NOW,
    );
    assert.equal(typed.every((r) => r.record.type === "preference"), true);

    const tagged = retriever.search({ query: "surveys", tags: ["reading"] }, NOW);
    assert.ok(tagged.some((r) => r.record.id === "mem_pref"));

    const missing = retriever.search({ query: "surveys", tags: ["nope"] }, NOW);
    assert.equal(missing.length, 0);
  });

  it("boosts recent and frequently accessed memories on equal text", () => {
    const retriever = new MemoryRetriever();
    retriever.index([
      memory("mem_old", "pipeline for data processing", {
        lastAccessedAt: 0,
        accessCount: 0,
      }),
      memory("mem_hot", "pipeline for data processing", {
        lastAccessedAt: NOW,
        accessCount: 10,
        confidence: 0.95,
      }),
    ]);
    const results = retriever.search({ query: "data processing" }, NOW);
    assert.equal(results[0].record.id, "mem_hot");
  });

  it("returns nothing for an empty corpus", () => {
    const retriever = new MemoryRetriever();
    assert.equal(
      retriever.search({ query: "anything" }, NOW).length,
      0,
    );
  });
});
