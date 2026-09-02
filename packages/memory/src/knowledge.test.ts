import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryEngine } from "./engine";
import { InMemoryFileSystem } from "./fs";
import {
  KNOWLEDGE_BASE_TAG,
  KnowledgeBaseService,
  knowledgeBaseTag,
} from "./knowledge";

function makeService() {
  let counter = 0;
  let clock = 1_000;
  const fs = new InMemoryFileSystem();
  const engine = new MemoryEngine({
    fs,
    root: "/memory",
    now: () => ++clock,
    idFactory: () => `mem_kb${++counter}`,
  });
  return { engine, fs, service: new KnowledgeBaseService(engine) };
}

describe("KnowledgeBaseService", () => {
  it("creates visible research topics backed by project memories", async () => {
    const { engine, service } = makeService();
    const base = await service.create({
      title: "可解释检索",
      description: "追踪检索增强生成中的可解释性。",
      tags: ["RAG"],
    });
    assert.equal(base.title, "可解释检索");
    assert.deepEqual(base.tags, ["RAG"]);

    const record = engine.get(base.id);
    assert.equal(record?.type, "project");
    assert.ok(record?.tags.includes(KNOWLEDGE_BASE_TAG));
    assert.ok(record?.tags.includes(knowledgeBaseTag(base.id)));
    assert.equal((await service.list()).length, 1);
  });

  it("organizes, searches, updates, and deletes typed entries", async () => {
    const { service } = makeService();
    const base = await service.create({ title: "Agent memory" });
    const map = await service.saveEntry({
      knowledgeBaseId: base.id,
      kind: "mindmap",
      title: "论文结构",
      content: "# Agent memory\n- retrieval\n  - episodic memory",
      tags: ["outline"],
    });
    const paper = await service.saveEntry({
      knowledgeBaseId: base.id,
      kind: "paper",
      title: "MemoryBank",
      content: "A paper about long-term memory for language models.",
      source: { libraryID: 1, key: "ABCD1234" },
    });
    assert.ok(map && paper);

    const detail = await service.get(base.id);
    assert.equal(detail?.entryCount, 2);
    assert.equal(detail?.counts.mindmap, 1);
    assert.equal(detail?.counts.paper, 1);
    assert.deepEqual(
      detail?.entries.find((entry) => entry.id === paper?.id)?.source,
      { libraryID: 1, key: "ABCD1234" },
    );

    const hits = await service.search({
      knowledgeBaseId: base.id,
      query: "episodic",
    });
    assert.deepEqual(
      hits.map((hit) => hit.entry.id),
      [map?.id],
    );

    const updated = await service.saveEntry({
      id: map?.id,
      knowledgeBaseId: base.id,
      kind: "insight",
      title: "论文结构 v2",
      content: "# Agent memory\n- retrieval\n- consolidation",
      tags: [],
    });
    assert.equal(updated?.title, "论文结构 v2");
    assert.equal(updated?.kind, "insight");
    assert.deepEqual(updated?.tags, []);
    assert.equal(
      (await service.get(base.id, { kind: "mindmap" }))?.entryCount,
      0,
    );
    assert.deepEqual(
      (await service.get(base.id, { kind: "insight" }))?.entries.map(
        (candidate) => candidate.id,
      ),
      [map?.id],
    );

    const clearedPaper = await service.saveEntry({
      id: paper?.id,
      knowledgeBaseId: base.id,
      kind: "note",
      title: "MemoryBank notes",
      content: "The paper source is intentionally detached.",
      clearSource: true,
    });
    assert.equal(clearedPaper?.kind, "note");
    assert.equal(clearedPaper?.source, undefined);

    assert.equal(await service.deleteEntry(base.id, paper?.id ?? ""), true);
    assert.equal((await service.get(base.id))?.entryCount, 1);
  });

  it("keeps bases isolated and cascades deletion", async () => {
    const { engine, service } = makeService();
    const first = await service.create({ title: "First" });
    const second = await service.create({ title: "Second" });
    const entry = await service.saveEntry({
      knowledgeBaseId: first.id,
      kind: "insight",
      title: "Finding",
      content: "Only belongs to the first topic.",
    });
    assert.ok(entry);
    assert.equal(
      await service.saveEntry({
        id: entry?.id,
        knowledgeBaseId: second.id,
        kind: "insight",
        title: "Moved illicitly",
        content: "Must not cross topic boundaries.",
      }),
      null,
    );

    const removed = await service.delete(first.id);
    assert.deepEqual(removed, { removed: true, entriesRemoved: 1 });
    assert.equal(engine.get(first.id), undefined);
    assert.equal(engine.get(entry?.id ?? ""), undefined);
    assert.ok(await service.get(second.id));
  });
});
