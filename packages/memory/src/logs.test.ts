import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryFileSystem } from "./fs";
import { ConversationLogEngine, bestExcerpt, excerptKey } from "./logs";

function makeEngine() {
  let clock = 1_000;
  const fs = new InMemoryFileSystem();
  const engine = new ConversationLogEngine({
    fs,
    root: "/logs",
    now: () => clock,
  });
  return {
    engine,
    fs,
    tick: (ms = 500) => {
      clock += ms;
    },
  };
}

describe("ConversationLogEngine", () => {
  it("appends turns as searchable markdown files and keeps them after many writes", async () => {
    const { engine, fs } = makeEngine();
    await engine.appendTurn({
      sessionId: "ses_a",
      title: "Survey reading",
      turnId: "turn_1",
      userText: "Find transformer survey papers",
      assistantText: "I searched the library for transformer surveys.",
      tools: [{ name: "search_items", ok: true }],
    });
    const files = Object.keys(fs.snapshot());
    assert.ok(files.some((path) => path.endsWith("sessions/ses_a.md")));
    assert.ok(files.some((path) => path.endsWith("LOGS.md")));

    const hits = await engine.search("transformer survey");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, "ses_a");
    assert.match(hits[0].excerpt, /transformer/i);

    const listed = await engine.list();
    assert.equal(listed[0].turnCount, 1);
  });

  it("records excerpt hits once per call and promotes identity via hash", async () => {
    const { engine, tick } = makeEngine();
    await engine.appendTurn({
      sessionId: "ses_b",
      title: "RAG notes",
      turnId: "turn_1",
      userText: "Remember that the user prefers dense retrieval for RAG.",
      assistantText: "Noted the dense retrieval preference.",
    });
    const hits = await engine.search("dense retrieval");
    const first = await engine.recordHits(hits, "dense retrieval");
    tick();
    const second = await engine.recordHits(hits, "dense retrieval again");
    assert.equal(first[0].count, 1);
    assert.equal(second[0].count, 2);
    assert.equal(first[0].hash, second[0].hash);
    assert.equal(excerptKey("ses_b", hits[0].excerpt), first[0].hash);

    await engine.markPromoted(first[0].hash, "mem_promoted");
    assert.equal(engine.getExcerpt(first[0].hash)?.promotedId, "mem_promoted");
  });

  it("reads a session and returns a query excerpt without wiping the file", async () => {
    const { engine } = makeEngine();
    await engine.appendTurn({
      sessionId: "ses_c",
      title: "Long chat",
      turnId: "turn_1",
      userText: "alpha",
      assistantText: "beta",
    });
    await engine.appendTurn({
      sessionId: "ses_c",
      title: "Long chat",
      turnId: "turn_2",
      userText: "talk about citation graphs",
      assistantText: "Citation graphs connect related papers.",
    });
    const read = await engine.read("ses_c", { query: "citation graphs" });
    assert.ok(read);
    assert.match(read.content, /alpha/);
    assert.match(read.excerpt, /citation graphs/i);
    assert.equal(read.turnCount, 2);

    const whole = await engine.read("ses_c");
    assert.ok(whole);
    assert.ok(whole.excerpt.length > 0);
    assert.match(whole.content, /citation graphs/i);
  });
});

describe("bestExcerpt", () => {
  it("picks the turn section that overlaps the query", () => {
    const body = [
      "## t1 turn_1",
      "",
      "**user:** hello",
      "",
      "## t2 turn_2",
      "",
      "**user:** discuss BM25 ranking",
    ].join("\n");
    const excerpt = bestExcerpt(body, "BM25 ranking", 80);
    assert.match(excerpt, /BM25/);
    assert.doesNotMatch(excerpt, /hello/);
  });
});
