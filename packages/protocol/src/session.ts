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

/** Schema-v2 product record. A research task owns exactly one conversation. */
export interface ResearchTaskRecord extends SessionRecord {
  schemaVersion: 2;
  backend: AgentBackendKind;
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
  input: SessionRecord | ResearchTaskRecord,
  now = Date.now(),
): ResearchTaskRecord {
  const candidate = input as Partial<ResearchTaskRecord>;
  if (candidate.schemaVersion === 2) {
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
      schemaVersion: 2,
      backend,
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
    schemaVersion: 2,
    backend: "native",
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
