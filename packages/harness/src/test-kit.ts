import type { PermissionMode, SessionRecord, ToolRiskLevel } from "@confucius/protocol";
import { BudgetAccountant } from "./BudgetAccountant";
import { MemoryCheckpointStore } from "./CheckpointStore";
import { MemoryEventLog } from "./EventLog";
import { createClock, createIdFactory } from "./ids";
import { MemoryToolProvider, jsonObjectSchema } from "./MemoryToolProvider";
import { ScriptedModel, type ModelTurn } from "./ModelAdapter";
import { PermissionGate } from "./PermissionGate";
import { TurnLoop } from "./TurnLoop";

export function session(id = "sess_1"): SessionRecord {
  return {
    id,
    title: "Test",
    createdAt: 1,
    updatedAt: 1,
    mode: "agent",
    context: {},
    permissionMode: "ask",
  };
}

export function createHarness(options: {
  script: ModelTurn[];
  maxIterations?: number;
  maxToolCalls?: number;
  modeFor?: (toolName: string) => PermissionMode;
  resolve?: ConstructorParameters<typeof PermissionGate>[0]["resolve"];
}) {
  const ids = createIdFactory("id");
  const now = createClock(1000);
  const events = new MemoryEventLog();
  const checkpoints = new MemoryCheckpointStore();
  const tools = new MemoryToolProvider();
  const model = new ScriptedModel(options.script);
  const budget = new BudgetAccountant({
    maxIterations: options.maxIterations ?? 8,
    maxToolCalls: options.maxToolCalls ?? 20,
  });
  const permissions = new PermissionGate({
    ids,
    now,
    modeFor:
      options.modeFor ??
      ((name) => (name.startsWith("create_") ? "ask" : "auto_allow")),
    riskFor: (name): ToolRiskLevel =>
      name.startsWith("create_") ? "write" : "read",
    resolve: options.resolve,
  });

  tools.register(
    {
      name: "search_items",
      description: "Search the library",
      inputSchema: jsonObjectSchema(
        { query: { type: "string" } },
        ["query"],
      ),
    },
    {
      name: "search_items",
      catalog: "library.read",
      concurrency: "parallel_safe",
      mutatesState: false,
    },
    (args) => ({ items: [{ title: `hit:${String(args.query)}` }] }),
  );

  tools.register(
    {
      name: "get_item",
      description: "Get one item",
      inputSchema: jsonObjectSchema(
        { libraryID: { type: "number" }, key: { type: "string" } },
        ["libraryID", "key"],
      ),
    },
    {
      name: "get_item",
      catalog: "library.read",
      concurrency: "parallel_safe",
      mutatesState: false,
    },
    (args) => ({ libraryID: args.libraryID, key: args.key, title: "Paper" }),
  );

  tools.register(
    {
      name: "create_collection",
      description: "Create a collection",
      inputSchema: jsonObjectSchema({ name: { type: "string" } }, ["name"]),
    },
    {
      name: "create_collection",
      catalog: "library.write",
      concurrency: "serial",
      mutatesState: true,
    },
    (args) => ({ created: true, name: args.name }),
  );

  const loop = new TurnLoop({
    model,
    tools,
    permissions,
    budget,
    events,
    checkpoints,
    ids,
    now,
  });

  return { loop, events, checkpoints, budget, tools, ids, now };
}
