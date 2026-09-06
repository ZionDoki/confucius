import type {
  ArtifactBody,
  ArtifactRecord,
  PreparedOperation,
  ToolResult,
} from "@confucius/protocol";
import { MEMORY_WRITE_TOOLS } from "@confucius/protocol";
import type { HistoryStore } from "@confucius/memory";
import type { ArtifactStore } from "./ArtifactStore";
import { ARTIFACT_UPSERT_TOOL } from "./ArtifactToolProvider";
import { collectTagChanges } from "./ArtifactWriteback";
import {
  verifyWritebackSnapshot,
  type WritebackSnapshot,
} from "./WritebackSnapshot";
import {
  canonical,
  type OperationRecord,
  type ToolExecutionService,
} from "./ReliableToolProvider";

export interface HostOperationDomainOptions {
  artifacts: Pick<ArtifactStore, "get">;
  history: Pick<HistoryStore, "readNote" | "listNotes">;
  tools: { reconcile(operation: OperationRecord): Promise<ToolResult | null> };
  onArtifactRecovered?: (artifact: ArtifactRecord) => void | Promise<void>;
  /** External domains must supply authoritative verification, never infer effects from caches. */
  reconcileMemory?: (operation: OperationRecord) => Promise<ToolResult | null>;
  reconcileMcp?: (operation: OperationRecord) => Promise<ToolResult | null>;
}

const absent = (operation: OperationRecord, message: string): ToolResult => ({
  ok: false,
  toolName: operation.name,
  code: "unavailable",
  effect: "none",
  retryable: true,
  message,
});
const applied = (operation: OperationRecord, data: unknown): ToolResult => ({
  ok: true,
  toolName: operation.name,
  effect: "applied",
  data,
});

async function reconcileArtifact(
  operation: OperationRecord,
  options: HostOperationDomainOptions,
): Promise<ToolResult | null> {
  const args = operation.args;
  if (operation.name === ARTIFACT_UPSERT_TOOL && args.id) {
    const artifact = await options.artifacts.get(String(args.id), true);
    const recovery = operation.intent?.recovery;
    const expectedRevision = Number(
      recovery?.artifactRevision ??
        operation.context.expectedAfter?.artifactRevision,
    );
    const previousRevision = Number(
      recovery?.expectedRevision ??
        operation.context.expected?.[`artifact:${args.id}`],
    );
    const revision = artifact?.revisions.find(
      (entry) => entry.revision === expectedRevision,
    );
    if (
      artifact &&
      revision &&
      canonical(revision.body) === canonical(args.body)
    ) {
      const result = applied(operation, {
        artifact,
        reconciledRevision: revision.revision,
      });
      try {
        await options.onArtifactRecovered?.(artifact);
      } catch (error) {
        result.warnings = [
          `Artifact exists; its task view is not yet updated: ${String(error)}`,
        ];
      }
      return result;
    }
    if (!artifact || artifact.revision === previousRevision)
      return absent(
        operation,
        "Verified that no new artifact revision was saved",
      );
    return null;
  }
  const snapshot = (args.expectedSnapshot ??
    operation.intent?.recovery.expectedSnapshot) as
    WritebackSnapshot | undefined;
  if (!snapshot) return null;
  try {
    verifyWritebackSnapshot(snapshot);
    if (
      operation.name !== "artifact.collection_diff" ||
      !args.createdCollectionKey ||
      !Zotero.Collections.getByLibraryAndKey(
        Number(args.libraryID),
        String(args.createdCollectionKey),
      )
    )
      return absent(
        operation,
        "Verified that the interrupted batch left its affected native state unchanged",
      );
  } catch {
    /* A changed before-state may be the intended committed result. */
  }
  if (operation.name === "artifact.tag_diff") {
    const changes = args.changes as ReturnType<typeof collectTagChanges>;
    if (!Array.isArray(changes) || !changes.length) return null;
    if (
      changes.every((change) => {
        const item = Zotero.Items.getByLibraryAndKey(
          change.libraryID,
          change.key,
        );
        const tags = item && new Set(item.getTags().map((tag) => tag.tag));
        return (
          tags &&
          change.add.every((tag) => tags.has(tag)) &&
          change.remove.every((tag) => !tags.has(tag))
        );
      })
    )
      return applied(operation, {
        targetRef: changes
          .map((change) => `${change.libraryID}:${change.key}`)
          .join(","),
        reconciled: true,
      });
  }
  if (operation.name === "artifact.collection_diff") {
    const body = args.body as Extract<
      ArtifactBody,
      { type: "collection_diff" }
    >;
    const collection = Zotero.Collections.getByLibraryAndKey(
      Number(args.libraryID),
      String(args.collectionKey ?? args.createdCollectionKey),
    );
    if (!collection || !body || !Array.isArray(body.operations)) return null;
    const final = new Map<
      string,
      { item: { libraryID: number; key: string }; included: boolean }
    >();
    for (const operation of body.operations)
      if (operation.item && ["add", "remove"].includes(operation.op))
        final.set(`${operation.item.libraryID}:${operation.item.key}`, {
          item: operation.item,
          included: operation.op === "add",
        });
    if (
      [...final.values()].every(({ item: ref, included }) => {
        const item = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.key);
        return (
          item && item.getCollections().includes(collection.id) === included
        );
      })
    )
      return applied(operation, {
        targetRef: `${collection.libraryID}:${collection.key}`,
        reconciled: true,
      });
  }
  return null;
}

async function reconcileHistory(
  operation: OperationRecord,
  history: HostOperationDomainOptions["history"],
): Promise<ToolResult | null> {
  if (operation.name === "new_context")
    return absent(
      operation,
      "The window-switch request was transient; it may be requested again",
    );
  const taskId = String(
    operation.intent?.recovery.taskId ?? operation.context.taskId ?? "",
  );
  if (operation.name !== "notes_write" || !taskId) return null;
  const name = String(operation.args.name);
  const previousRevision = Number(operation.intent?.recovery.previousRevision);
  const notes = await history.listNotes(taskId);
  const current = notes.find((entry) => entry.name === name);
  if (!current)
    return previousRevision === 0
      ? absent(operation, "Verified that the working note was not created")
      : null;
  let note = await history.readNote(taskId, name, 0, 20000);
  let content = note.content;
  while (note.nextOffset !== null && content.length <= 250000) {
    note = await history.readNote(taskId, name, note.nextOffset, 20000);
    content += note.content;
  }
  if (note.nextOffset === null && content === operation.args.content)
    return applied(operation, { ...note, reconciled: true });
  if (current.revision === previousRevision)
    return absent(
      operation,
      "Verified that the working note revision did not change",
    );
  return null;
}

/** AgentHost supplies dependencies; the owning domain supplies recovery rules. */
export function registerHostOperationDomains(
  execution: ToolExecutionService,
  options: HostOperationDomainOptions,
): void {
  const artifact = (operation: OperationRecord) =>
    reconcileArtifact(operation, options);
  const history = (operation: OperationRecord) =>
    reconcileHistory(operation, options.history);
  const memory = options.reconcileMemory ?? (() => Promise.resolve(null));
  const mcp = options.reconcileMcp ?? (() => Promise.resolve(null));
  for (const [name, reconcile] of Object.entries({
    artifact,
    history,
    memory,
    mcp,
    zotero: (operation: OperationRecord) => options.tools.reconcile(operation),
  }))
    execution.registerDomain(name, {
      reconcile: (_intent: PreparedOperation, operation: OperationRecord) =>
        reconcile(operation),
    });
  const artifactNames = new Set([
    ARTIFACT_UPSERT_TOOL,
    "artifact.collection_diff",
    "artifact.tag_diff",
  ]);
  const memoryNames = new Set<string>([
    ...MEMORY_WRITE_TOOLS,
    "artifact.knowledge",
  ]);
  execution.setLegacyReconciler((operation) => {
    if (artifactNames.has(operation.name)) return artifact(operation);
    if (["notes_write", "new_context"].includes(operation.name))
      return history(operation);
    if (memoryNames.has(operation.name)) return memory(operation);
    if (operation.name.startsWith("mcp.")) return mcp(operation);
    return options.tools.reconcile(operation);
  });
}
