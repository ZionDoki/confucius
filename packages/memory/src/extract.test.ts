import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildExtractionMessages,
  parseExtractionResponse,
} from "./extract";
import { MemoryEngine } from "./engine";
import { InMemoryFileSystem } from "./fs";
import { serializeMemory } from "./markdown";
import type { MemoryRecord } from "./types";

describe("extraction prompt and parsing", () => {
  it("builds a prompt with existing memories listed", () => {
    const messages = buildExtractionMessages({
      userText: "I mainly work on RAG now.",
      assistantText: "Noted, I will focus retrieval-augmented work.",
      existing: [
        {
          id: "mem_old",
          type: "project",
          title: "Old project",
          content: "User worked on summarization.",
          tags: [],
          createdAt: 0,
          updatedAt: 0,
          lastAccessedAt: 0,
          accessCount: 0,
          confidence: 0.5,
          history: [],
        },
      ],
    });
    assert.equal(messages[0].role, "system");
    assert.match(messages[1].content, /RAG/);
    assert.match(messages[1].content, /mem_old/);
  });

  it("parses clean, fenced, and padded JSON responses", () => {
    const ops = parseExtractionResponse(
      '```json\n[{"op":"add","type":"project","content":"Works on RAG."}]\n```',
    );
    assert.equal(ops.length, 1);
    assert.deepEqual(ops[0], {
      op: "add",
      type: "project",
      title: "Works on RAG.",
      content: "Works on RAG.",
      tags: [],
      confidence: 0.6,
    });

    const padded = parseExtractionResponse(
      'Sure! Here is the plan:\n[{"op":"delete","id":"mem_dead"}]\nDone.',
    );
    assert.deepEqual(padded, [{ op: "delete", id: "mem_dead" }]);
  });

  it("returns [] for unparseable or empty output", () => {
    assert.deepEqual(parseExtractionResponse("I cannot help with that."), []);
    assert.deepEqual(parseExtractionResponse(""), []);
    assert.deepEqual(parseExtractionResponse("[]"), []);
  });

  it("drops ops with invented ids or missing content", () => {
    const ops = parseExtractionResponse(
      JSON.stringify([
        { op: "update", id: "not-a-mem-id", content: "x" },
        { op: "add", type: "fact" },
        { op: "delete", id: "mem_ok" },
      ]),
    );
    assert.deepEqual(ops, [{ op: "delete", id: "mem_ok" }]);
  });
});

describe("MemoryEngine", () => {
  function makeEngine(seed: MemoryRecord[] = []) {
    const fs = new InMemoryFileSystem();
    for (const record of seed) {
      fs.writeFile(`/mem/memories/${record.id}.md`, serializeMemory(record));
    }
    let clock = 1_000;
    let counter = 0;
    const engine = new MemoryEngine({
      fs,
      root: "/mem",
      now: () => clock,
      idFactory: () => `mem_gen${++counter}`,
    });
    return { engine, fs, tick: () => (clock += 500) };
  }

  const seedRecord: MemoryRecord = {
    id: "mem_seed",
    type: "preference",
    title: "Likes surveys",
    content: "User prefers survey papers when entering a new field.",
    tags: ["reading"],
    createdAt: 500,
    updatedAt: 900,
    lastAccessedAt: 900,
    accessCount: 0,
    confidence: 0.9,
    history: [],
  };

  it("saves, searches, and reinforces access", async () => {
    const { engine } = makeEngine([seedRecord]);
    const saved = await engine.save({
      content: "User works on retrieval-augmented generation.",
      type: "project",
      tags: ["rag"],
    });
    assert.equal(saved.id, "mem_gen1");

    const hits = await engine.search({ query: "retrieval augmented" });
    assert.ok(hits.some((hit) => hit.record.id === saved.id));
    const after = engine.get(saved.id);
    assert.equal(after?.accessCount, 1);
  });

  it("applies add/update/delete ops and keeps revision history", async () => {
    const { engine } = makeEngine([seedRecord]);
    const changes = await engine.applyOps(
      [
        {
          op: "add",
          type: "fact",
          title: "Field",
          content: "User's field is machine learning.",
        },
        {
          op: "update",
          id: "mem_seed",
          content: "User now prefers primary sources over surveys.",
        },
        { op: "delete", id: "mem_gen1" },
        { op: "update", id: "mem_missing", content: "nope" },
      ],
      "ses_1",
    );
    assert.deepEqual(
      changes.map((change) => change.op),
      ["add", "update", "delete"],
    );

    const updated = engine.get("mem_seed");
    assert.equal(
      updated?.content,
      "User now prefers primary sources over surveys.",
    );
    assert.equal(updated?.history.length, 1);
    assert.deepEqual(updated?.tags, ["reading"]);
    assert.match(updated?.history[0].content ?? "", /survey papers/);

    // Deleted in the same batch; unknown id still a no-op.
    assert.equal(engine.get("mem_gen1"), undefined);
    assert.equal(engine.get("mem_missing"), undefined);
  });

  it("folds near-duplicate adds into the existing memory", async () => {
    const { engine, tick } = makeEngine([seedRecord]);
    tick();
    const changes = await engine.applyOps([
      {
        op: "add",
        type: "preference",
        title: "Surveys",
        content:
          "User prefers survey papers when entering a new field, especially ML.",
      },
    ]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].op, "update");
    assert.equal(changes[0].id, "mem_seed");
    assert.equal(engine.stats().total, 1);
  });

  it("updates and deletes directly", async () => {
    const { engine, tick } = makeEngine([seedRecord]);
    tick();
    const updated = await engine.update({
      id: "mem_seed",
      content: "Updated content.",
    });
    assert.equal(updated?.content, "Updated content.");
    assert.equal(await engine.delete("mem_seed"), true);
    assert.equal(await engine.delete("mem_seed"), false);
    assert.equal(engine.stats().total, 0);
  });

  it("finds near duplicates lexically", async () => {
    const { engine } = makeEngine([seedRecord]);
    const dupes = await engine.findNearDuplicates(
      "User prefers survey papers when entering a new field!",
    );
    assert.equal(dupes.length, 1);
    const none = await engine.findNearDuplicates("Completely unrelated text.");
    assert.equal(none.length, 0);
  });

  it("lists by type and regenerates the index after writes", async () => {
    const { engine, fs } = makeEngine([seedRecord]);
    await engine.applyOps([
      { op: "add", type: "fact", title: "F", content: "A fact." },
    ]);
    const index = await fs.readFile("/mem/MEMORY.md");
    assert.match(index, /## fact/);
    const facts = await engine.list({ type: "fact" });
    assert.equal(facts.length, 1);
  });
});
