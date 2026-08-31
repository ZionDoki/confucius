import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MemoryEventLog,
  MemoryCheckpointStore,
  MemoryToolProvider,
  PermissionGate,
  BudgetAccountant,
  ScriptedModel,
  TurnLoop,
  createClock,
  createIdFactory,
  type ModelTurn,
} from "@confucius/harness";
import { MemoryEngine } from "./engine";
import { InMemoryFileSystem } from "./fs";
import { buildExtractionMessages, parseExtractionResponse } from "./extract";

/**
 * End-to-end pipeline mirror of AgentHost: a session runs a turn, the turn is
 * consolidated into memory, and the next turn both recalls the memory and
 * replays the conversation history.
 */
describe("memory + agent loop pipeline", () => {
  it("remembers across turns and recalls it in the next prompt", async () => {
    const fs = new InMemoryFileSystem();
    let clock = 1_000;
    const engine = new MemoryEngine({
      fs,
      root: "/mem",
      now: () => clock,
      idFactory: (() => {
        let n = 0;
        return () => `mem_pipe${++n}`;
      })(),
    });

    const registerMemoryTools = (provider: MemoryToolProvider) => {
      provider.register(
        {
          name: "memory_search",
          description: "Search memory",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
        {
          name: "memory_search",
          catalog: "memory.read",
          concurrency: "parallel_safe",
          mutatesState: false,
        },
        (args) => engine.search({ query: String(args.query ?? "") }),
      );
    };

    const makeLoop = (script: ModelTurn[], systemPrompt: string) => {
      const tools = new MemoryToolProvider();
      registerMemoryTools(tools);
      return new TurnLoop({
        model: new ScriptedModel(script),
        tools,
        permissions: new PermissionGate({
          ids: createIdFactory("id"),
          now: createClock(1),
          modeFor: () => "auto_allow",
          riskFor: () => "read",
        }),
        budget: new BudgetAccountant({ maxIterations: 4, maxToolCalls: 4 }),
        events: new MemoryEventLog(),
        checkpoints: new MemoryCheckpointStore(),
        ids: createIdFactory("id"),
        now: createClock(1),
        systemPrompt,
      });
    };

    // Turn 1: the user states a durable preference.
    const turn1 = makeLoop(
      [{ text: "Noted — I will focus on retrieval-augmented generation papers." }],
      "You are Confucius.",
    );
    const result1 = await turn1.run({
      session: {
        id: "ses_pipe",
        title: "t",
        createdAt: 1,
        updatedAt: 1,
        mode: "agent",
        context: {},
        permissionMode: "ask",
      },
      turnId: "t1",
      userText: "From now on I am working on retrieval-augmented generation.",
    });
    assert.equal(result1.phase, "done");

    // Post-turn consolidation, as AgentHost.afterTurn does.
    const extraction = new ScriptedModel([
      {
        text: '[{"op":"add","type":"project","title":"RAG focus","content":"User works on retrieval-augmented generation.","tags":["rag"]}]',
      },
    ]);
    const existing = await engine.search({ query: "retrieval", limit: 5 });
    const extractionMessages = buildExtractionMessages({
      userText: "From now on I am working on retrieval-augmented generation.",
      assistantText: result1.text,
      existing: existing.map((hit) => hit.record),
    });
    const extractionTurn = await extraction.complete({
      messages: extractionMessages,
    });
    const ops = parseExtractionResponse(extractionTurn.text ?? "");
    const changes = await engine.applyOps(ops, "ses_pipe");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].op, "add");

    // Turn 2: memory recall finds it, and history replays.
    const recall = await engine.search({ query: "RAG retrieval augmented" });
    assert.equal(recall.length >= 1, true);
    assert.match(recall[0].record.content, /retrieval-augmented generation/);

    const turn2 = makeLoop(
      [{ text: "Continuing your RAG project from before." }],
      "You are Confucius.\nRelevant long-term memory:\n- [project] User works on retrieval-augmented generation.",
    );
    const result2 = await turn2.run({
      session: {
        id: "ses_pipe",
        title: "t",
        createdAt: 1,
        updatedAt: 2,
        mode: "agent",
        context: {},
        permissionMode: "ask",
      },
      turnId: "t2",
      userText: "What was I working on?",
      history: result1.messages,
    });
    assert.equal(result2.phase, "done");
    // The persisted conversation now spans both turns.
    const roles = result2.messages.map((message) => message.role);
    assert.deepEqual(roles, [
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    assert.match(result2.messages[0].content, /retrieval-augmented/);

    // The memory file landed on disk as markdown.
    const files = Object.keys(fs.snapshot());
    assert.ok(
      files.some((path) => path.startsWith("/mem/memories/mem_pipe") && path.endsWith(".md")),
    );
    assert.ok(files.includes("/mem/MEMORY.md"));
    const index = await fs.readFile("/mem/MEMORY.md");
    assert.match(index, /RAG focus/);
  });
});
