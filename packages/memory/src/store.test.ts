import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryFileSystem } from "./fs";
import { parseMemoryFile, serializeMemory } from "./markdown";
import { FileMemoryStore } from "./store";
import type { MemoryRecord } from "./types";

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_test01",
    type: "preference",
    title: "Prefers surveys",
    content: "User prefers survey papers for new fields.",
    tags: ["reading"],
    createdAt: 1_000,
    updatedAt: 1_500,
    lastAccessedAt: 1_200,
    accessCount: 3,
    confidence: 0.9,
    history: [{ at: 900, content: "Old content." }],
    ...overrides,
  };
}

describe("markdown round-trip", () => {
  it("serializes and parses back losslessly", () => {
    const original = record();
    const text = serializeMemory(original);
    const parsed = parseMemoryFile("mem_test01.md", text);
    assert.ok(parsed);
    assert.equal(parsed.id, original.id);
    assert.equal(parsed.type, original.type);
    assert.equal(parsed.title, original.title);
    assert.equal(parsed.content, original.content);
    assert.deepEqual(parsed.tags, original.tags);
    assert.equal(parsed.createdAt, original.createdAt);
    assert.equal(parsed.updatedAt, original.updatedAt);
    assert.equal(parsed.accessCount, original.accessCount);
    assert.equal(parsed.confidence, original.confidence);
    assert.equal(parsed.history.length, 1);
    assert.equal(parsed.history[0].content, "Old content.");
  });

  it("round-trips Chinese content", () => {
    const original = record({
      type: "project",
      title: "用户的论文项目",
      content: "用户正在研究多模态检索增强生成。",
      tags: ["中文", "rag"],
    });
    const parsed = parseMemoryFile(
      "mem_test01.md",
      serializeMemory(original),
    );
    assert.ok(parsed);
    assert.equal(parsed.content, "用户正在研究多模态检索增强生成。");
    assert.deepEqual(parsed.tags, ["中文", "rag"]);
  });

  it("rejects files without valid frontmatter or type", () => {
    assert.equal(parseMemoryFile("x.md", "no frontmatter"), null);
    assert.equal(
      parseMemoryFile("x.md", "---\nid: mem_a\ntype: bogus\n---\n\nx"),
      null,
    );
  });
});

describe("FileMemoryStore", () => {
  it("persists, reloads, and deletes memory files", async () => {
    const fs = new InMemoryFileSystem();
    let store = new FileMemoryStore(fs, "/mem");
    await store.put(record());
    await store.put(
      record({ id: "mem_second", type: "fact", title: "Fact", content: "A fact." }),
    );
    await store.rebuildIndex();

    const files = Object.keys(fs.snapshot());
    assert.ok(files.includes("/mem/memories/mem_test01.md"));
    assert.ok(files.includes("/mem/MEMORY.md"));

    store = new FileMemoryStore(fs, "/mem");
    await store.load();
    assert.equal(store.all().length, 2);
    assert.ok(store.get("mem_test01"));

    const ok = await store.remove("mem_second");
    assert.equal(ok, true);
    assert.equal(store.all().length, 1);
  });

  it("regenerates MEMORY.md grouped by type", async () => {
    const fs = new InMemoryFileSystem();
    const store = new FileMemoryStore(fs, "/mem");
    await store.put(record());
    await store.put(
      record({ id: "mem_fact1", type: "fact", title: "A fact", content: "Fact." }),
    );
    await store.rebuildIndex();
    const index = await fs.readFile("/mem/MEMORY.md");
    assert.match(index, /## preference \(1\)/);
    assert.match(index, /## fact \(1\)/);
    assert.match(index, /mem_test01/);
    assert.match(index, /source of truth/);
  });

  it("survives a corrupt file by skipping it", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("/mem/memories/mem_broken.md", "garbage");
    await fs.writeFile(
      "/mem/memories/mem_good.md",
      serializeMemory(record({ id: "mem_good" })),
    );
    const warnings: string[] = [];
    const store = new FileMemoryStore(fs, "/mem", {
      onWarn: (message) => warnings.push(message),
    });
    await store.load();
    assert.equal(store.all().length, 1);
    assert.equal(store.get("mem_good") !== undefined, true);
  });

  it("defers access counter writes to flushAccess", async () => {
    const fs = new InMemoryFileSystem();
    const store = new FileMemoryStore(fs, "/mem");
    await store.put(record());
    const writesBefore = Object.keys(fs.snapshot()).length;
    store.touch("mem_test01", 9_999);
    store.touch("mem_test01", 9_999);
    assert.equal(Object.keys(fs.snapshot()).length, writesBefore);
    await store.flushAccess();
    const text = await fs.readFile("/mem/memories/mem_test01.md");
    assert.match(text, /access-count: 5/);
    assert.match(text, /last-accessed: 9999/);
  });
});
