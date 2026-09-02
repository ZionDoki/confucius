import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HookedToolProvider,
  compactHistory,
  estimateChars,
  historyBudgetChars,
  needsCompaction,
  ScriptedModel,
  type ToolProvider,
} from "@confucius/harness";
import { callMemoryCatalogTool } from "./catalogTools";
import { MemoryEngine } from "./engine";
import { InMemoryFileSystem } from "./fs";
import { ConversationLogEngine } from "./logs";
import {
  LOG_PROMOTE_HITS,
  MEMORY_PIN_HITS,
  MemoryPromotion,
  PINNED_TAG,
  PROMOTED_FROM_LOG_TAG,
  applyToolAccessHook,
  isPinned,
  isPromotedFromLog,
  logHitsFromToolData,
  memoryIdsFromToolData,
} from "./promote";

function makeStack() {
  let clock = 1_000;
  const fs = new InMemoryFileSystem();
  const now = () => clock;
  const memory = new MemoryEngine({
    fs,
    root: "/mem",
    now,
    idFactory: (() => {
      let n = 0;
      return () => `mem_h${++n}`;
    })(),
  });
  const logs = new ConversationLogEngine({ fs, root: "/logs", now });
  const promotion = new MemoryPromotion(memory, logs);
  const inner: ToolProvider = {
    listTools: () => [],
    getMeta: () => null,
    getSchema: () => undefined,
    call: (name, args) => callMemoryCatalogTool(memory, logs, name, args),
  };
  const hooked = new HookedToolProvider(inner, async (info) => {
    await applyToolAccessHook(promotion, logs, info);
  });
  return {
    fs,
    memory,
    logs,
    hooked,
    tick: (ms = 1_000) => {
      clock += ms;
    },
  };
}

describe("historyBudgetChars + compactHistory + searchable logs", () => {
  it("sizes the working transcript from the model window, not a fixed cap", () => {
    const small = historyBudgetChars({ contextWindowTokens: 8_192 });
    const large = historyBudgetChars({ contextWindowTokens: 131_072 });
    assert.ok(small < large);
    assert.ok(large > 80_000);
    assert.notEqual(small, large);
  });

  it("compacts an over-budget transcript while log files stay searchable", async () => {
    const { logs, fs } = makeStack();
    const messages = [];
    for (let i = 0; i < 24; i++) {
      const user = `question about dense retrieval for RAG ${i} `.repeat(30);
      const assistant = `answer about dense retrieval ranking ${i} `.repeat(30);
      messages.push({ role: "user" as const, content: user });
      messages.push({ role: "assistant" as const, content: assistant });
      await logs.appendTurn({
        sessionId: "ses_compact",
        title: "RAG notes",
        turnId: `turn_${i}`,
        userText: user,
        assistantText: assistant,
      });
    }
    const budget = historyBudgetChars({
      contextWindowTokens: 8_192,
      maxOutputTokens: 1_024,
    });
    assert.equal(needsCompaction(messages, budget), true);
    const beforeChars = estimateChars(messages);
    const result = await compactHistory(
      new ScriptedModel([{ text: "SUMMARY of dense retrieval for RAG." }]),
      messages,
      budget,
    );
    assert.equal(result.compacted, true);
    assert.ok(estimateChars(result.messages) < beforeChars);
    assert.ok(result.messages[0].content.includes("SUMMARY"));
    assert.equal(needsCompaction(result.messages, budget), false);

    const files = Object.keys(fs.snapshot());
    assert.ok(files.some((path) => path.endsWith("sessions/ses_compact.md")));
    assert.ok(files.some((path) => path.endsWith("LOGS.md")));
    const hits = await logs.search("dense retrieval");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].sessionId, "ses_compact");
    assert.match(hits[0].excerpt, /dense retrieval/i);
    const listed = await logs.list();
    assert.equal(listed[0].turnCount, 24);
  });
});

describe("tool access hook promotion", () => {
  it("routes conversation_log_* and memory reads through the hook and promotes", async () => {
    const { hooked, memory, logs, tick } = makeStack();
    await logs.appendTurn({
      sessionId: "ses_hook",
      title: "Survey preference",
      turnId: "turn_1",
      userText:
        "I only want survey papers when entering a new field, not primary studies.",
      assistantText:
        "I will prefer survey papers for new fields instead of primary studies.",
    });

    let lastSearch;
    for (let i = 0; i < LOG_PROMOTE_HITS; i++) {
      tick();
      lastSearch = await hooked.call("conversation_log_search", {
        query: "survey papers",
        limit: 6,
      });
    }
    assert.equal(lastSearch?.ok, true);
    const parsedHits = logHitsFromToolData(
      lastSearch && lastSearch.ok ? lastSearch.data : null,
    );
    assert.ok(parsedHits.length >= 1);
    assert.equal(parsedHits[0].sessionId, "ses_hook");

    const read = await hooked.call("conversation_log_read", {
      sessionId: "ses_hook",
      query: "survey papers",
    });
    assert.equal(read.ok, true);
    assert.ok(read.ok && read.data && typeof read.data === "object");
    const log = (
      read as { data: { log: { sessionId: string; excerpt: string } } }
    ).data.log;
    assert.equal(log.sessionId, "ses_hook");
    assert.match(log.excerpt, /survey papers/i);

    const promoted = await memory.list({ tags: [PROMOTED_FROM_LOG_TAG] });
    assert.equal(promoted.length, 1);
    assert.equal(isPromotedFromLog(promoted[0].tags), true);
    assert.match(promoted[0].content, /survey papers/i);

    const query = promoted[0].content.slice(0, 40);
    let lastMemory;
    for (let i = 0; i < MEMORY_PIN_HITS; i++) {
      tick();
      lastMemory = await hooked.call("memory_search", {
        query,
        limit: 6,
      });
    }
    assert.equal(lastMemory?.ok, true);
    const ids = memoryIdsFromToolData(
      lastMemory && lastMemory.ok ? lastMemory.data : null,
    );
    assert.ok(ids.includes(promoted[0].id));
    const listed = await hooked.call("memory_list", { limit: 20 });
    assert.equal(listed.ok, true);
    const listedIds = memoryIdsFromToolData(listed.ok ? listed.data : null);
    assert.ok(listedIds.includes(promoted[0].id));
    assert.equal(isPinned(memory.get(promoted[0].id)?.tags), true);
    assert.ok(memory.get(promoted[0].id)?.tags.includes(PINNED_TAG));
  });

  it("does not fail the tool when the access hook throws", async () => {
    const { memory, logs } = makeStack();
    const inner: ToolProvider = {
      listTools: () => [],
      getMeta: () => null,
      getSchema: () => undefined,
      call: (name, args) => callMemoryCatalogTool(memory, logs, name, args),
    };
    const hooked = new HookedToolProvider(inner, () => {
      throw new Error("hook exploded");
    });
    await logs.appendTurn({
      sessionId: "ses_safe",
      title: "Safe",
      turnId: "turn_1",
      userText:
        "hello from the log that must remain readable after a hook error",
      assistantText: "noted",
    });
    const result = await hooked.call("conversation_log_search", {
      query: "remain readable",
    });
    assert.equal(result.ok, true);
  });
});
