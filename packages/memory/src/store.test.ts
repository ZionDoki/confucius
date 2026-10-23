import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryEngine } from "./engine";
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
    const parsed = parseMemoryFile("mem_test01.md", serializeMemory(original));
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

  it("round-trips marker-like bodies and unsafe tags without frontmatter injection", () => {
    const original = record({
      content: "User quoted <!-- history and <!-- confucius:history literally.",
      tags: ["reading", "x\nid: mem_evil", "a,b"],
      researchTasks: ["task_1", "task_2"],
      history: [{ at: 900, content: "Old <!-- confucius:history revision." }],
    });
    const text = serializeMemory(original);
    assert.ok(!/^id: mem_evil$/m.test(text));
    assert.match(text, /^content-encoding: json$/m);
    const parsed = parseMemoryFile("mem_test01.md", text);
    assert.ok(parsed);
    assert.equal(parsed.id, original.id);
    assert.equal(parsed.content, original.content);
    assert.deepEqual(parsed.tags, original.tags);
    assert.deepEqual(parsed.researchTasks, original.researchTasks);
    assert.deepEqual(parsed.history, original.history);
  });

  it("still parses the legacy standalone revision marker", () => {
    const text = [
      "---",
      "id: mem_test01",
      "type: preference",
      "title: Legacy",
      "tags: [reading, papers]",
      "created: 1",
      "updated: 2",
      "confidence: 0.9",
      "---",
      "",
      "Current body.",
      "",
      "<!-- history",
      "900 | Old content.",
      "-->",
    ].join("\n");
    const parsed = parseMemoryFile("mem_test01.md", text);
    assert.ok(parsed);
    assert.equal(parsed.content, "Current body.");
    assert.deepEqual(parsed.tags, ["reading", "papers"]);
    assert.deepEqual(parsed.history, [{ at: 900, content: "Old content." }]);
  });
});

describe("FileMemoryStore", () => {
  it("reconciles deletion receipts and refuses to overwrite an unreadable existing identity", async () => {
    class LostDeleteReceipt extends InMemoryFileSystem {
      override async deleteFile(path: string) {
        await super.deleteFile(path);
        throw new Error("lost deletion receipt");
      }
    }
    const fs = new LostDeleteReceipt();
    const store = new FileMemoryStore(fs, "/mem");
    await store.put(record());
    assert.equal(await store.remove("mem_test01"), true);
    assert.equal(store.get("mem_test01"), undefined);
    assert.equal(await store.remove("mem_test01"), false);
    await fs.writeFile("/mem/memories/mem_broken.md", "garbage");
    await assert.rejects(store.recover("mem_broken"), /Cannot reconcile/);
    assert.equal(await store.recover("mem_missing"), undefined);
  });

  it("never adopts a frontmatter id that disagrees with its filename", async () => {
    const fs = new InMemoryFileSystem();
    const injected = [
      "---",
      "id: mem_test01",
      "type: preference",
      "title: Normal",
      "tags: [x",
      "id: mem_evil",
      "]",
      "created: 1",
      "updated: 2",
      "confidence: 0.9",
      "---",
      "",
      "body",
    ].join("\n");
    await fs.writeFile("/mem/memories/mem_test01.md", injected);
    const warnings: string[] = [];
    const store = new FileMemoryStore(fs, "/mem", {
      onWarn: (message) => warnings.push(message),
    });
    await store.load();
    assert.equal(store.get("mem_evil"), undefined);
    const record = store.get("mem_test01");
    assert.ok(record);
    assert.equal(record.id, "mem_test01");
    assert.deepEqual(record.tags, ["x"]);
    assert.equal(await store.remove("mem_evil"), false);
    assert.ok(fs.snapshot()["/mem/memories/mem_test01.md"]);
    assert.ok(
      warnings.some(
        (message) =>
          message.includes("mem_test01.md") && /does not match/.test(message),
      ),
    );
  });

  it("keeps an undecodable JSON body readable and reports why", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile(
      "/mem/memories/mem_test01.md",
      [
        "---",
        "id: mem_test01",
        "type: preference",
        "title: Hand edited",
        "content-encoding: json",
        "created: 1",
        "updated: 2",
        "confidence: 0.9",
        "---",
        "",
        '{"truncated": ',
      ].join("\n"),
    );
    const warnings: string[] = [];
    const store = new FileMemoryStore(fs, "/mem", {
      onWarn: (message) => warnings.push(message),
    });
    await store.load();
    assert.equal(store.get("mem_test01")?.content, '{"truncated":');
    assert.ok(fs.snapshot()["/mem/memories/mem_test01.md"]);
    assert.ok(
      warnings.some(
        (message) =>
          message.includes("mem_test01.md") &&
          /could not be decoded/.test(message),
      ),
    );
  });

  it("copies researchTasks on read so callers cannot mutate the cache", async () => {
    const fs = new InMemoryFileSystem();
    const engine = new MemoryEngine({ fs, root: "/mem" });
    await engine.save({
      id: "mem_test01",
      content: "research state",
      researchTasks: ["task_1", "task_2"],
    });
    const read = await engine.read("mem_test01");
    assert.deepEqual(read?.researchTasks, ["task_1", "task_2"]);
    read!.researchTasks!.push("task_3");
    assert.deepEqual(engine.get("mem_test01")?.researchTasks, [
      "task_1",
      "task_2",
    ]);
  });

  it("skips invalid identities so maintenance cannot fail on their path", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile(
      "/mem/memories/mem_bad].md",
      "---\nid: mem_bad]\ntype: note\ntitle: bad\n---\n\nbody",
    );
    const warnings: string[] = [];
    const engine = new MemoryEngine({
      fs,
      root: "/mem",
      onWarn: (message) => warnings.push(message),
    });
    await engine.ensureLoaded();
    assert.equal(engine.get("mem_bad]"), undefined);
    assert.deepEqual(await engine.maintain(), []);
    assert.ok(fs.snapshot()["/mem/memories/mem_bad].md"]);
    assert.ok(
      warnings.some(
        (message) =>
          message.includes("mem_bad].md") && /filename/.test(message),
      ),
    );
  });

  it("retries after a transient first-load failure and caches a successful load", async () => {
    class Fs extends InMemoryFileSystem {
      lists = 0;
      failures = 1;
      override async listFiles(dir: string) {
        this.lists++;
        if (this.failures) {
          this.failures--;
          throw new Error("directory busy");
        }
        return super.listFiles(dir);
      }
    }
    const fs = new Fs();
    await fs.writeFile(
      "/mem/memories/mem_good.md",
      serializeMemory(record({ id: "mem_good" })),
    );
    const store = new FileMemoryStore(fs, "/mem");
    await assert.rejects(store.load(), /directory busy/);
    await store.load();
    assert.equal(store.get("mem_good")?.id, "mem_good");
    const lists = fs.lists;
    await store.load();
    assert.equal(fs.lists, lists);
  });

  it("lets MemoryEngine retry after a transient first load", async () => {
    class Fs extends InMemoryFileSystem {
      failures = 1;
      override async makeDirectory() {
        if (this.failures) {
          this.failures--;
          throw new Error("sync folder unavailable");
        }
        return super.makeDirectory();
      }
    }
    const fs = new Fs();
    const engine = new MemoryEngine({ fs, root: "/mem" });
    await assert.rejects(engine.ensureLoaded(), /sync folder unavailable/);
    await engine.ensureLoaded();
    await engine.save({ id: "mem_after_retry", content: "usable memory" });
    assert.equal(engine.get("mem_after_retry")?.content, "usable memory");
  });

  it("persists, reloads, and deletes memory files", async () => {
    const fs = new InMemoryFileSystem();
    let store = new FileMemoryStore(fs, "/mem");
    await store.put(record());
    await store.put(
      record({
        id: "mem_second",
        type: "fact",
        title: "Fact",
        content: "A fact.",
      }),
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
      record({
        id: "mem_fact1",
        type: "fact",
        title: "A fact",
        content: "Fact.",
      }),
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
    assert.ok(
      warnings.some(
        (message) =>
          message.includes("mem_broken.md") && /frontmatter/.test(message),
      ),
    );
  });

  it("refresh preserves pending access and hides unreadable sources without rewriting them", async () => {
    const fs = new InMemoryFileSystem();
    const store = new FileMemoryStore(fs, "/mem");
    await store.load();
    const original = record();
    await store.put(original);
    store.touch(original.id, 9999);
    const path = `/mem/memories/${original.id}.md`;
    const edited = serializeMemory(record({ content: "External revision" }));
    await fs.writeFile(path, edited);
    await store.refresh();
    assert.equal(store.get(original.id)?.content, "External revision");
    assert.equal(store.get(original.id)?.lastUsedAt, 9999);
    assert.equal(store.get(original.id)?.accessCount, 4);
    assert.equal(await fs.readFile(path), edited);
    await fs.writeFile(path, "incomplete source edit");
    await store.refresh();
    assert.equal(store.get(original.id), undefined);
    assert.equal(await fs.readFile(path), "incomplete source edit");
    await fs.writeFile(path, edited);
    await store.refresh();
    assert.equal(store.get(original.id)?.content, "External revision");
    assert.equal(store.get(original.id)?.accessCount, 4);
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
    assert.match(text, /access-count: 3/);
    const reopened = new FileMemoryStore(fs, "/mem");
    await reopened.load();
    assert.equal(reopened.get("mem_test01")?.accessCount, 5);
    assert.equal(reopened.get("mem_test01")?.lastAccessedAt, 9999);
  });
});
