import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emptyLockedContext,
  mergeLockedContexts,
  TASK_TEMPLATES,
  validateTemplateContext,
  type ContextSearchItem,
} from "@confucius/protocol";
import {
  contextForMentionItems,
  libraryMentionTokenAtCaret,
  LibraryMentionSources,
  replaceLibraryMention,
} from "./libraryMention";

describe("library mentions", () => {
  it("finds an @ query at the caret, including a multi-word query", () => {
    assert.deepEqual(libraryMentionTokenAtCaret("Compare @deep learning"), {
      start: 8,
      end: 22,
      query: "deep learning",
    });
  });

  it("accepts punctuation boundaries but ignores email addresses", () => {
    assert.equal(libraryMentionTokenAtCaret("分析：@论文")?.query, "论文");
    assert.equal(libraryMentionTokenAtCaret("分析@论文")?.query, "论文");
    assert.equal(libraryMentionTokenAtCaret("name@example.com"), null);
  });

  it("does not reopen a completed mention", () => {
    assert.equal(libraryMentionTokenAtCaret("@[A paper] continue"), null);
  });

  it("replaces only the active token and preserves text after the caret", () => {
    assert.deepEqual(
      replaceLibraryMention(
        "Compare @map with this",
        { start: 8, end: 12, query: "map" },
        "MapReduce [revisited]",
      ),
      {
        value: "Compare @[MapReduce revisited] with this",
        caret: 31,
      },
    );
  });
});

describe("papers attached through library mentions", () => {
  const paper = (key: string, libraryID = 1): ContextSearchItem => ({
    key,
    libraryID,
    title: `Paper ${key}`,
    itemType: "journalArticle",
    creators: [],
    year: "2026",
  });

  it("counts draft mentions as sources for every template without an open reader", () => {
    const mentions = new LibraryMentionSources(async () => {
      assert.fail("Draft mentions do not need a persisted task");
    });
    assert.equal(mentions.context(), undefined);
    mentions.add(null, paper("A"));
    mentions.add(null, paper("A"));
    const one = mentions.context(emptyLockedContext())!;
    assert.equal(one.items.length, 1);
    assert.equal(one.reader, undefined);
    assert.equal(one.items[0].title, "Paper A");
    assert.notEqual(one.fingerprint, emptyLockedContext().fingerprint);
    mentions.add(null, paper("A", 2));
    const two = mentions.context(emptyLockedContext())!;
    assert.equal(two.items.length, 2);
    for (const template of TASK_TEMPLATES) {
      assert.equal(
        validateTemplateContext(template, one).ok,
        template.source === "single" || template.source === "any",
        template.id,
      );
      assert.equal(
        validateTemplateContext(template, two).ok,
        template.source === "multi" || template.source === "any",
        template.id,
      );
    }
  });

  it("keeps mentions selected during task creation and does not reuse them in the next draft", async () => {
    const mentions = new LibraryMentionSources(async (taskId, incoming) => {
      assert.equal(taskId, "created-task");
      saved = mergeLockedContexts(saved, incoming);
    });
    mentions.add(null, paper("A"));
    let saved = mentions.context(emptyLockedContext())!;
    mentions.add(null, paper("B"));
    mentions.adoptDraft("created-task", saved);
    assert.equal(mentions.context(), undefined);
    await mentions.flush("created-task");
    assert.deepEqual(
      saved.items.map((item) => item.key),
      ["A", "B"],
    );
    assert.equal(mentions.has("created-task", paper("B")), false);
  });

  it("waits for every in-flight paper before a mode change or send can use the sources", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let saved = emptyLockedContext();
    const writes: string[][] = [];
    const mentions = new LibraryMentionSources(async (_taskId, incoming) => {
      writes.push(incoming.items.map((item) => item.key));
      started();
      await gate;
      saved = mergeLockedContexts(saved, incoming);
    });
    mentions.add("task", paper("A"));
    const first = mentions.flush("task");
    await writing;
    mentions.add("task", paper("B"));
    const beforeSend = mentions.flush("task");
    assert.equal(first, beforeSend);
    assert.equal(saved.items.length, 0);
    release();
    await beforeSend;
    assert.deepEqual(writes, [["A"], ["B"]]);
    assert.deepEqual(
      saved.items.map((item) => item.key),
      ["A", "B"],
    );
  });

  it("pins a late explicit mention even when task creation already captured that paper automatically", async () => {
    let saved = contextForMentionItems([paper("A")]);
    saved.items[0].source = "reader";
    const mentions = new LibraryMentionSources(async (_id, incoming) => {
      saved = mergeLockedContexts(saved, incoming);
    });
    mentions.add(null, paper("A"));
    mentions.adoptDraft("created-task", saved);
    await mentions.flush("created-task");
    assert.equal(saved.items[0].source, "library");
  });

  it("retains failed attachments for retry and isolates another task from their failure", async () => {
    let fail = true;
    const writes: string[] = [];
    const mentions = new LibraryMentionSources(async (taskId, incoming) => {
      if (taskId === "first" && fail) throw new Error("Source update failed");
      writes.push(`${taskId}:${incoming.items.map((item) => item.key)}`);
    });
    mentions.add("first", paper("A"));
    await assert.rejects(mentions.flush("first"), /Source update failed/);
    assert.equal(mentions.has("first", paper("A")), true);
    await assert.rejects(mentions.flush("first"), /Source update failed/);
    mentions.add("second", paper("B"));
    await mentions.flush("second");
    assert.deepEqual(writes, ["second:B"]);
    fail = false;
    await mentions.flush("first");
    assert.deepEqual(writes, ["second:B", "first:A"]);
    assert.equal(mentions.has("first", paper("A")), false);
  });
});
