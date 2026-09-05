import {
  runtimeModelSelection,
  type RuntimeModelSelection,
} from "./modelReasoning";
import {
  initialContextWindow,
  taskContextReferences,
  type ContextWindowState,
  type TaskContextReference,
} from "./history";
import type { CollectionRef, ItemRef } from "./item";
import type { PermissionMode } from "./permissions";
import type {
  AgentBackendKind,
  CapabilityProfile,
  LockedContextSnapshot,
  RecoverableTurn,
  TaskStatus,
} from "./research";
import {
  emptyLockedContext,
  isAgentBackendKind,
  isLockedContextSnapshot,
  isRecoverableTurn,
  legacyContextSnapshot,
  withLockedContextFingerprint,
} from "./research";
import {
  isPlaceholderTaskTitle,
  isTaskTitleState,
  type TaskTitleState,
} from "./taskTitle";

export type SessionMode = "plan" | "agent";

export type TurnPhase =
  | "planning"
  | "acting"
  | "awaiting_approval"
  | "compacting"
  | "delivering"
  | "done"
  | "failed"
  | "aborted";

export interface SessionContext {
  item?: ItemRef;
  collection?: CollectionRef;
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode: SessionMode;
  context: SessionContext;
  permissionMode: PermissionMode;
}

/** Schema-v3 task with a durable history and replaceable context windows. */
export interface ResearchTaskRecord extends SessionRecord {
  schemaVersion: 3;
  contextWindow?: ContextWindowState;
  references?: TaskContextReference[];
  draft?: { text: string; references: TaskContextReference[] };
  backend: AgentBackendKind;
  runtimeModel?: RuntimeModelSelection;
  externalSessionId?: string;
  externalTurnId?: string;
  status: TaskStatus;
  activeKnowledgeBaseId?: string;
  lockedContext: LockedContextSnapshot;
  artifactIds: string[];
  recoverableTurn?: RecoverableTurn;
  capabilityProfile: CapabilityProfile;
  workingDirectory?: string;
  templateId?: string;
  titleState: TaskTitleState;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  phase: TurnPhase;
  userText: string;
  createdAt: number;
  updatedAt: number;
}

export function migrateSessionRecord(
  input:
    | SessionRecord
    | ResearchTaskRecord
    | (Omit<Partial<ResearchTaskRecord>, "schemaVersion"> &
        SessionRecord & { schemaVersion: 2 }),
  now = Date.now(),
): ResearchTaskRecord {
  const candidate = input as Partial<ResearchTaskRecord>;
  if (Number(candidate.schemaVersion) === 2 || candidate.schemaVersion === 3) {
    const locked = candidate.lockedContext;
    const backend = isAgentBackendKind(candidate.backend)
      ? candidate.backend
      : "native";
    const workingDirectory =
      typeof candidate.workingDirectory === "string" &&
      candidate.workingDirectory.trim()
        ? candidate.workingDirectory.trim()
        : undefined;
    const capabilityProfile =
      candidate.capabilityProfile === "workspace" && workingDirectory
        ? "workspace"
        : "zotero_only";
    const status = isTaskStatus(candidate.status) ? candidate.status : "ready";
    const recoverableTurn = isRecoverableTurn(candidate.recoverableTurn)
      ? {
          ...candidate.recoverableTurn,
          unknownToolCallIds: [
            ...new Set(candidate.recoverableTurn.unknownToolCallIds),
          ],
        }
      : undefined;
    return {
      ...(input as SessionRecord),
      schemaVersion: 3,
      backend,
      contextWindow:
        candidate.contextWindow &&
        /^[\w-]+$/.test(candidate.contextWindow.id) &&
        Number.isInteger(candidate.contextWindow.number) &&
        candidate.contextWindow.number > 0
          ? candidate.contextWindow
          : initialContextWindow(input.id, backend, now),
      references: taskContextReferences(candidate.references),
      status,
      lockedContext: isLockedContextSnapshot(locked)
        ? withLockedContextFingerprint(locked)
        : emptyLockedContext(now),
      artifactIds: Array.isArray(candidate.artifactIds)
        ? [
            ...new Set(
              candidate.artifactIds.filter(
                (id): id is string =>
                  typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id),
              ),
            ),
          ]
        : [],
      capabilityProfile,
      runtimeModel:
        backend === "native"
          ? undefined
          : runtimeModelSelection(candidate.runtimeModel),
      externalSessionId:
        backend !== "native" && typeof candidate.externalSessionId === "string"
          ? candidate.externalSessionId
          : undefined,
      externalTurnId:
        backend !== "native" && typeof candidate.externalTurnId === "string"
          ? candidate.externalTurnId
          : undefined,
      activeKnowledgeBaseId:
        typeof candidate.activeKnowledgeBaseId === "string"
          ? candidate.activeKnowledgeBaseId
          : undefined,
      recoverableTurn: ["running", "awaiting_approval", "interrupted"].includes(
        status,
      )
        ? recoverableTurn
        : undefined,
      workingDirectory:
        capabilityProfile === "workspace" ? workingDirectory : undefined,
      templateId:
        typeof candidate.templateId === "string"
          ? candidate.templateId
          : undefined,
      titleState: isTaskTitleState(candidate.titleState)
        ? candidate.titleState
        : isPlaceholderTaskTitle(candidate.title)
          ? "pending"
          : "fixed",
    };
  }
  const legacy = input as SessionRecord;
  return {
    ...legacy,
    schemaVersion: 3,
    backend: "native",
    contextWindow: initialContextWindow(input.id, "native", now),
    references: [],
    status: "ready",
    lockedContext: legacy.context
      ? legacyContextSnapshot(legacy.context, legacy.createdAt || now)
      : emptyLockedContext(legacy.createdAt || now),
    artifactIds: [],
    capabilityProfile: "zotero_only",
    titleState: isPlaceholderTaskTitle(legacy.title) ? "pending" : "fixed",
  };
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === "ready" ||
    value === "running" ||
    value === "awaiting_approval" ||
    value === "interrupted" ||
    value === "completed" ||
    value === "failed"
  );
}
