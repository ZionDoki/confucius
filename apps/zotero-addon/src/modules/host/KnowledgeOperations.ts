import {
  InMemoryFileSystem,
  MemoryEngine,
  KnowledgeBaseService,
  callMemoryCatalogTool,
  serializeMemory,
  type MemoryRecord,
} from "@confucius/memory";
import type {
  ToolExecutionContext,
  ToolResult,
  ToolFailure,
} from "@confucius/protocol";
import { canonical, type OperationRecord } from "./ReliableToolProvider";

const writes = new Set([
  "knowledge_base_create",
  "knowledge_base_update",
  "knowledge_base_save_entry",
]);

function contentState(record: MemoryRecord | undefined): unknown {
  if (!record) return null;
  const {
    id,
    type,
    title,
    content,
    tags,
    protection,
    sourceRefs,
    sourceSessionId,
  } = record;
  return {
    id,
    type,
    title,
    content,
    tags,
    protection,
    sourceRefs,
    sourceSessionId,
  };
}

interface KnowledgeRecovery extends Record<string, unknown> {
  knowledgeWrite: true;
  catalogName: string;
  recordId: string;
  creationId?: string;
  before: unknown;
  after: unknown;
}

/** Run the same validation/normalization on an isolated copy before journaling
 * the intended record. No persistent write is made during preparation. */
export async function prepareKnowledgeWrite(
  memory: MemoryEngine,
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  catalogName = name,
): Promise<ToolFailure | null> {
  if (!writes.has(catalogName)) return null;
  const creates =
    catalogName === "knowledge_base_create" ||
    (catalogName === "knowledge_base_save_entry" && !args.id);
  const recordId = creates ? memory.allocateId() : String(args.id ?? "");
  const records = new Map<string, MemoryRecord>();
  for (const id of new Set(
    [recordId, String(args.knowledgeBaseId ?? "")].filter(Boolean),
  )) {
    const record = await memory.reconcile(id);
    if (record) records.set(id, record);
  }
  const before = contentState(records.get(recordId));
  const scratch = new MemoryEngine({
    fs: new InMemoryFileSystem(
      Object.fromEntries(
        [...records].map(([id, record]) => [
          `/preview/memories/${id}.md`,
          serializeMemory(record),
        ]),
      ),
    ),
    root: "/preview",
  });
  const creationId = creates ? recordId : undefined;
  const preview = await callMemoryCatalogTool(
    scratch,
    undefined,
    catalogName,
    args,
    { creationId },
  );
  if (!preview.ok) return { ...preview, toolName: name, effect: "none" };
  const recovery: KnowledgeRecovery = {
    knowledgeWrite: true,
    catalogName,
    recordId,
    creationId,
    before,
    after: contentState(scratch.get(recordId)),
  };
  context.resources = ["memory:index"];
  context.preparedOperation = {
    schemaVersion: 1,
    domain: "memory",
    name,
    args: { ...args },
    resources: context.resources,
    recovery,
  };
  return null;
}

async function receipt(
  memory: MemoryEngine,
  name: string,
  recovery: KnowledgeRecovery,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const knowledge = new KnowledgeBaseService(memory);
  if (recovery.catalogName === "knowledge_base_save_entry") {
    const base = await knowledge.get(String(args.knowledgeBaseId), {
      limit: 10_000,
    });
    const entry = base?.entries.find(
      (candidate) => candidate.id === recovery.recordId,
    );
    return {
      ok: true,
      toolName: name,
      effect: "applied",
      data:
        name === "artifact.knowledge"
          ? { targetRef: `${args.knowledgeBaseId}:${recovery.recordId}` }
          : { entry },
    };
  }
  const knowledgeBase = await knowledge.get(recovery.recordId, {
    limit: 10_000,
  });
  return {
    ok: true,
    toolName: name,
    effect: "applied",
    data: { knowledgeBase },
  };
}

export async function reconcileKnowledgeWrite(
  memory: MemoryEngine,
  operation: OperationRecord,
): Promise<ToolResult | null> {
  const recovery = operation.intent?.recovery as KnowledgeRecovery | undefined;
  if (!recovery?.knowledgeWrite) return null;
  const current = contentState(await memory.reconcile(recovery.recordId));
  if (canonical(current) === canonical(recovery.after))
    return receipt(memory, operation.name, recovery, operation.args);
  if (canonical(current) === canonical(recovery.before))
    return {
      ok: false,
      toolName: operation.name,
      code: "unavailable",
      effect: "none",
      retryable: true,
      message: "Verified that the knowledge record was not changed",
    };
  return null;
}

export async function callPreparedKnowledgeWrite(
  memory: MemoryEngine,
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  if (!context.preparedOperation) {
    const invalid = await prepareKnowledgeWrite(
      memory,
      name,
      args,
      context,
      name === "artifact.knowledge" ? "knowledge_base_save_entry" : name,
    );
    if (invalid) return invalid;
  }
  const recovery = context.preparedOperation?.recovery as
    KnowledgeRecovery | undefined;
  if (!recovery?.knowledgeWrite)
    return callMemoryCatalogTool(memory, undefined, name, args);
  const current = contentState(await memory.reconcile(recovery.recordId));
  if (canonical(current) === canonical(recovery.after))
    return receipt(memory, name, recovery, args);
  if (canonical(current) !== canonical(recovery.before))
    return {
      ok: false,
      toolName: name,
      code: "unavailable",
      effect: "none",
      message:
        "Knowledge record changed after preparation; reload it before saving",
    };
  const result = await callMemoryCatalogTool(
    memory,
    undefined,
    recovery.catalogName,
    args,
    { creationId: recovery.creationId },
  );
  if (!result.ok) return { ...result, toolName: name };
  return receipt(memory, name, recovery, args);
}
