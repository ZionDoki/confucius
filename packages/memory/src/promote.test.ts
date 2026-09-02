import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryEngine } from "./engine";
import { InMemoryFileSystem } from "./fs";
import { KNOWLEDGE_BASE_TAG } from "./knowledge";
import { ConversationLogEngine } from "./logs";
import {
  LOG_PROMOTE_HITS,
  MEMORY_PIN_HITS,
  MemoryPromotion,
  PINNED_TAG,
  PROMOTED_FROM_LOG_TAG,
  durableExcerpt,
  isConversationLogTool,
  isPinned,
  isPromotedFromLog,
  logHitsFromToolData,
} from "./promote";

function makePair() {
  let clock = 1_000;
  const fs = new InMemoryFileSystem();
  const now = () => clock;
  const memory = new MemoryEngine({
    fs,
    root: "/mem",
    now,
    idFactory: (() => {
      let n = 0;
      return () => `mem_p${++n}`;
    })(),
  });
  const logs = new ConversationLogEngine({ fs, root: "/logs", now });
  const promotion = new MemoryPromotion(memory, logs, {
    logPromoteHits: LOG_PROMOTE_HITS,
    memoryPinHits: MEMORY_PIN_HITS,
  });
  return {
    memory,
    logs,
    promotion,
    tick: () => {
      clock += 1_000;
    },
  };
}

describe("MemoryPromotion", () => {
  it("promotes a repeatedly retrieved log excerpt into a durable memory", async () => {
    const { logs, memory, promotion, tick } = makePair();
    await logs.appendTurn({
      sessionId: "ses_promo",
      title: "Preferences",
      turnId: "turn_1",
      userText: "I only want survey papers when entering a new field.",
      assistantText: "I will prefer survey papers for new fields.",
    });
    const hits = await logs.search("survey papers");
    assert.ok(hits[0].excerpt.length >= 48);

    for (let i = 0; i < LOG_PROMOTE_HITS - 1; i++) {
      tick();
      const changes = await promotion.considerLogHits(hits, "survey papers");
      assert.equal(changes.length, 0);
    }
    tick();
    const promoted = await promotion.considerLogHits(hits, "survey papers");
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].op, "add");
    const record = memory.get(promoted[0].id);
    assert.ok(record);
    assert.equal(isPromotedFromLog(record.tags), true);
    assert.ok(record.tags.includes("log:ses_promo"));
    assert.match(record.content, /survey papers/i);
    assert.doesNotMatch(record.content, /\*\*user:\*\*/);

    tick();
    const again = await promotion.considerLogHits(hits, "survey papers");
    assert.equal(
      again.length,
      0,
      "already-promoted excerpts must not duplicate",
    );
  });

  it("pins a memory after repeated retrievals and skips knowledge bases", async () => {
    const { memory, promotion } = makePair();
    const fact = await memory.save({
      content: "User works on retrieval-augmented generation.",
      type: "project",
      tags: ["rag"],
    });
    const kb = await memory.save({
      content: "Visible research topic",
      type: "project",
      tags: [KNOWLEDGE_BASE_TAG],
    });
    for (let i = 0; i < MEMORY_PIN_HITS; i++) {
      await memory.search({ query: "retrieval-augmented", limit: 4 });
    }
    const pinned = await promotion.considerMemoryHits([fact.id, kb.id]);
    assert.deepEqual(pinned, [fact.id]);
    assert.equal(isPinned(memory.get(fact.id)?.tags), true);
    assert.equal(memory.get(kb.id)?.tags.includes(PINNED_TAG), false);
    assert.ok((memory.get(fact.id)?.confidence ?? 0) > 0.9);
  });

  it("folds a log excerpt into an existing near-duplicate instead of adding", async () => {
    const { memory, logs, promotion, tick } = makePair();
    const existing = await memory.save({
      content: "I only want survey papers when entering a new field.",
      type: "preference",
    });
    await logs.appendTurn({
      sessionId: "ses_dup",
      title: "Dup",
      turnId: "turn_1",
      userText: "I only want survey papers when entering a new field.",
      assistantText: "I only want survey papers when entering a new field.",
    });
    const hits = await logs.search("survey papers");
    for (let i = 0; i < LOG_PROMOTE_HITS; i++) {
      tick();
      await promotion.considerLogHits(hits, "survey papers");
    }
    const listed = await memory.list({ tags: [PROMOTED_FROM_LOG_TAG] });
    assert.equal(listed.length, 0);
    assert.ok(existing.id);
  });
});

describe("durableExcerpt", () => {
  it("strips **user:** / **assistant:** / **tool name:** log markup", () => {
    const excerpt = [
      "**user:** I only want survey papers when entering a new field.",
      "**assistant:** I will prefer survey papers for new fields.",
      "**tool search_items:** ok",
    ].join("\n");
    const durable = durableExcerpt(excerpt);
    assert.doesNotMatch(durable, /\*\*user:\*\*/);
    assert.doesNotMatch(durable, /\*\*assistant:\*\*/);
    assert.doesNotMatch(durable, /\*\*tool /);
    assert.match(durable, /survey papers/i);
    assert.match(durable, /tool search_items: ok/);
  });
});

describe("log tool names", () => {
  it("recognizes conversation log tools for the access hook", () => {
    assert.equal(isConversationLogTool("conversation_log_search"), true);
    assert.equal(isConversationLogTool("conversation_log_read"), true);
    assert.equal(isConversationLogTool("conversation_log_foo"), true);
    assert.equal(isConversationLogTool("memory_search"), false);
  });
});

describe("tool result parsers", () => {
  it("reads search hits and log-read payloads without invented ids", async () => {
    const { logs } = makePair();
    await logs.appendTurn({
      sessionId: "ses_parse",
      title: "Parse",
      turnId: "turn_1",
      userText: "Prefer survey papers when entering a new research field.",
      assistantText: "I will prefer survey papers for new fields.",
    });
    const hits = await logs.search("survey papers");
    const fromSearch = logHitsFromToolData({
      results: hits.map((hit) => ({
        sessionId: hit.sessionId,
        title: hit.title,
        excerpt: hit.excerpt,
        score: hit.score,
      })),
    });
    assert.equal(fromSearch[0].sessionId, "ses_parse");
    assert.match(fromSearch[0].excerpt, /survey papers/i);

    const fromRead = logHitsFromToolData({
      log: {
        id: "ses_parse",
        sessionId: "ses_parse",
        excerpt: hits[0].excerpt,
      },
    });
    assert.equal(fromRead[0].sessionId, "ses_parse");
    assert.equal(fromRead[0].excerpt, hits[0].excerpt);
  });
});
