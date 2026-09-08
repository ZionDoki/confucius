import assert from "node:assert/strict";
import { it } from "node:test";
import {
  ConversationLogEngine,
  InMemoryFileSystem,
  MemoryEngine,
  type LogReadResult,
} from "@confucius/memory";
import { ConfuciusMemoryToolProvider } from "./MemoryTools";

it("retains hidden conversation-log aliases for existing calls", async () => {
  const fs = new InMemoryFileSystem();
  const memory = new MemoryEngine({ fs, root: "/memory" });
  const logs = new ConversationLogEngine({ fs, root: "/logs" });
  await logs.appendTurn({
    sessionId: "research-task",
    title: "Grounded survey",
    turnId: "turn-1",
    userText: "Find evidence on retrieval reliability",
    assistantText: "The retrieval experiment needs a held-out evaluation.",
  });
  const provider = new ConfuciusMemoryToolProvider(memory, logs);
  const names = provider.listTools().map((tool) => tool.name);
  for (const name of ["conversation_log_search", "conversation_log_read"]) {
    assert.equal(names.filter((candidate) => candidate === name).length, 0);
    assert.equal(provider.getMeta(name)?.mutatesState, false);
    assert.equal(provider.getMeta(name)?.catalog, "memory.read");
    assert.equal(provider.getSchema(name)?.type, "object");
  }
  const searchArgs = { query: "retrieval reliability", limit: 5 };
  assert.equal(
    await provider.prepare("conversation_log_search", searchArgs),
    null,
  );
  const search = await provider.call("conversation_log_search", searchArgs);
  assert.equal(search.ok, true);
  const hits = search.ok
    ? (
        search.data as {
          results: Array<{ sessionId: string; excerpt: string }>;
        }
      ).results
    : [];
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, "research-task");
  assert.match(hits[0].excerpt, /retrieval/i);

  const readArgs = { sessionId: hits[0].sessionId, maxChars: 4000 };
  assert.equal(await provider.prepare("conversation_log_read", readArgs), null);
  const read = await provider.call("conversation_log_read", readArgs);
  assert.equal(read.ok, true);
  const log = read.ok
    ? (read.data as { log: LogReadResult & { sessionId: string } }).log
    : undefined;
  assert.equal(log?.sessionId, "research-task");
  assert.match(log?.content ?? "", /held-out evaluation/);
});
