import type { ModelMessage } from "@confucius/harness";
import type { ConfuciusEvent } from "@confucius/protocol";
import type { ArtifactStore } from "./ArtifactStore";

export interface TaskBranchSnapshot {
  events: ConfuciusEvent[];
  messages: ModelMessage[];
  artifactIds: string[];
}

export async function forkBranchArtifacts(
  snapshot: TaskBranchSnapshot,
  store: ArtifactStore,
  taskId: string,
  foreignOnly = false,
): Promise<boolean> {
  const selected = new Map<
    string,
    Extract<
      ConfuciusEvent,
      { type: "artifact_upserted" }
    >["payload"]["artifact"]
  >();
  for (const event of snapshot.events)
    if (event.type === "artifact_upserted")
      selected.set(event.payload.artifact.id, event.payload.artifact);
  const ids = new Map<string, string>();
  for (const [id, artifact] of selected) {
    if (!snapshot.artifactIds.includes(id)) continue;
    const source = await store.get(id);
    if (foreignOnly && (!source || source.taskId === taskId)) continue;
    const copy = await store.fork(
      id,
      artifact.revision,
      taskId,
      artifact.title,
      artifact.status,
    );
    ids.set(id, copy.id);
  }
  if (ids.size === 0) return false;
  const remap = (value: unknown): unknown => {
    if (typeof value === "string") return ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, remap(entry)]),
      );
    return value;
  };
  snapshot.events = snapshot.events.map((event) => {
    const copy = remap(event) as ConfuciusEvent;
    if (
      copy.type === "artifact_upserted" &&
      event.type === "artifact_upserted" &&
      ids.has(event.payload.artifact.id)
    ) {
      copy.payload.artifact.taskId = taskId;
      copy.payload.artifact.sessionId = taskId;
      copy.payload.artifact.writeback = undefined;
      Reflect.deleteProperty(copy.payload.artifact, "execution");
      Reflect.deleteProperty(copy.payload.artifact, "writebacks");
      if (copy.payload.artifact.status === "committed")
        copy.payload.artifact.status = "ready";
    }
    return copy;
  });
  snapshot.artifactIds = snapshot.artifactIds.map((id) => ids.get(id) ?? id);
  return ids.size > 0;
}

const TERMINAL_EVENT_TYPES = new Set<ConfuciusEvent["type"]>([
  "turn_completed",
  "turn_failed",
  "turn_aborted",
]);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Build the durable history for a conversation branch. The provider session
 * itself is deliberately not reused: sharing one external thread would make
 * the source and branch mutate the same conversation.
 */
export function createTaskBranchSnapshot(
  sourceEvents: ConfuciusEvent[],
  throughTurnId: string,
  newTaskId: string,
  nextEventId: () => string,
): TaskBranchSnapshot {
  const start = sourceEvents.findIndex(
    (event) => event.type === "turn_started" && event.turnId === throughTurnId,
  );
  if (start < 0) {
    throw new Error("The beginning of this response is no longer available");
  }

  const nextTurn = sourceEvents.findIndex(
    (event, index) =>
      index > start &&
      event.type === "turn_started" &&
      event.turnId !== throughTurnId,
  );
  const end = nextTurn < 0 ? sourceEvents.length : nextTurn;
  const through = sourceEvents.slice(0, end);
  if (
    !through.some(
      (event) =>
        event.turnId === throughTurnId && TERMINAL_EVENT_TYPES.has(event.type),
    )
  ) {
    throw new Error("Wait for this response to finish before branching");
  }

  // A note proposal can be opened after a completed turn. Never copy an
  // unresolved approval into a branch because its resolver belongs to the
  // source task and cannot be completed from the new task.
  const resolvedApprovalIds = new Set(
    through
      .filter(
        (
          event,
        ): event is Extract<ConfuciusEvent, { type: "approval_resolved" }> =>
          event.type === "approval_resolved",
      )
      .map((event) => event.payload.resolution.id),
  );
  const requestedApprovalIds = new Set(
    through
      .filter(
        (
          event,
        ): event is Extract<ConfuciusEvent, { type: "approval_required" }> =>
          event.type === "approval_required",
      )
      .map((event) => event.payload.request.id),
  );

  const events = through
    .filter((event) => {
      if (event.type === "approval_required") {
        return resolvedApprovalIds.has(event.payload.request.id);
      }
      if (event.type === "approval_resolved") {
        return requestedApprovalIds.has(event.payload.resolution.id);
      }
      return true;
    })
    .map((source) => {
      const event = cloneJson(source);
      event.id = nextEventId();
      event.sessionId = newTaskId;
      if (event.type === "approval_required") {
        event.payload.request.sessionId = newTaskId;
      }
      return event;
    });

  const turns = new Map<
    string,
    { userText: string; assistantText: string; terminal: boolean }
  >();
  const turnOrder: string[] = [];
  for (const event of through) {
    const turnId = event.turnId;
    if (!turnId) continue;
    if (event.type === "turn_started") {
      if (!turns.has(turnId)) turnOrder.push(turnId);
      turns.set(turnId, {
        userText: event.payload.userText,
        assistantText: "",
        terminal: false,
      });
      continue;
    }
    const turn = turns.get(turnId);
    if (!turn) continue;
    if (event.type === "text_delta") {
      turn.assistantText += event.payload.text;
    } else if (TERMINAL_EVENT_TYPES.has(event.type)) {
      turn.terminal = true;
    }
  }

  const messages: ModelMessage[] = [];
  for (const turnId of turnOrder) {
    const turn = turns.get(turnId);
    if (!turn?.terminal) continue;
    messages.push({ role: "user", content: turn.userText });
    if (turn.assistantText) {
      messages.push({ role: "assistant", content: turn.assistantText });
    }
  }

  const artifactIds = [
    ...new Set(
      through
        .filter(
          (
            event,
          ): event is Extract<ConfuciusEvent, { type: "artifact_upserted" }> =>
            event.type === "artifact_upserted",
        )
        .map((event) => event.payload.artifact.id),
    ),
  ];

  return { events, messages, artifactIds };
}
