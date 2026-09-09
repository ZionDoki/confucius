import { CONTEXT_POLICY } from "./contextPolicy";
import { restoreRun, type RunState } from "./run";
import {
  restoreContextHandoff,
  restoreContextSwitch,
  type ContextHandoff,
  type ContextSwitchState,
} from "./contextHandoff";
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
  LockedItemContext,
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

export interface WorkflowState {
  version: 1;
  originalRequest: string;
  phase: "research" | "review" | "delivery" | "completed";
  handoff: string;
  phaseNotes?: string;
  sources: LockedContextSnapshot;
  proposalIds: string[];
  operationIds: string[];
  artifactIds: string[];
  remainingIterations: number;
  remainingToolCalls: number;
  updatedAt: number;
}

/** Schema-v3 task with a durable history and replaceable context windows. */
export interface ResearchTaskRecord extends SessionRecord {
  /** Last host-assigned event sequence, persisted across executor restarts. */
  eventSequence?: number;
  annotationBatchId?: string;
  postProcessing?: Array<{
    turnId: string;
    runId?: string;
    userText: string;
    assistantText: string;
    pending: Array<"title" | "memory">;
    error?: string;
    requests?: import("./events").ModelRequestProgress[];
    attempts?: number;
    maintenanceTarget?: string;
    maintenanceAttempts?: number;
    maintenanceSourceUpdatedAt?: number;
    maintenanceBatchId?: string;
    /** Durable model result, saved before applying any memory or deleting originals. */
    maintenanceOps?: unknown[];
    maintenanceAllowedIds?: string[];
    maintenanceApplied?: boolean;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  }>;
  schemaVersion: 4;
  contextWindow?: ContextWindowState;
  references?: TaskContextReference[];
  draft?: { text: string; references: TaskContextReference[] };
  backend: AgentBackendKind;
  runtimeModel?: RuntimeModelSelection;
  externalSessionId?: string;
  externalTurnId?: string;
  contextResetRequested?: boolean;
  contextHandoff?: ContextHandoff;
  contextSwitch?: ContextSwitchState;
  historyClearedAt?: number;
  historyCleanupBatch?: string;
  historyDistilledAt?: number;
  historyDistillationAttemptedAt?: number;
  historyRetention?: import("./contextHandoff").HistoryRetentionState;
  historyRetentionReasons?: string[];
  historyRetainedBytes?: number;
  maintenanceBudget?: {
    turnId: string;
    attempts: number;
    handoffAttempts?: number;
  };
  status: TaskStatus;
  activeKnowledgeBaseId?: string;
  lockedContext: LockedContextSnapshot;
  /** Articles selected at creation or used by submitted turns; independent of the live reader. */
  articleSources?: LockedItemContext[];
  artifactIds: string[];
  recoverableTurn?: RecoverableTurn;
  /** Legacy decode only; new writes use run. */
  workflow?: WorkflowState;
  run?: RunState;
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
        SessionRecord & { schemaVersion: 2 | 3 }),
  now = Date.now(),
): ResearchTaskRecord {
  const candidate = input as Partial<ResearchTaskRecord>;
  if ([2, 3, 4].includes(Number(candidate.schemaVersion))) {
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
      schemaVersion: 4,
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
      articleSources: isLockedContextSnapshot({
        ...emptyLockedContext(now),
        items: candidate.articleSources,
      })
        ? candidate.articleSources
        : undefined,
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
      contextResetRequested:
        candidate.contextResetRequested === true || undefined,
      contextHandoff: restoreContextHandoff(candidate.contextHandoff),
      contextSwitch: restoreContextSwitch(candidate.contextSwitch),
      historyClearedAt:
        typeof candidate.historyClearedAt === "number"
          ? candidate.historyClearedAt
          : undefined,
      maintenanceBudget:
        candidate.maintenanceBudget &&
        typeof candidate.maintenanceBudget.turnId === "string" &&
        Number.isSafeInteger(candidate.maintenanceBudget.attempts) &&
        candidate.maintenanceBudget.attempts >= 0
          ? {
              ...candidate.maintenanceBudget,
              handoffAttempts:
                Number.isSafeInteger(
                  candidate.maintenanceBudget.handoffAttempts,
                ) && candidate.maintenanceBudget.handoffAttempts! >= 0
                  ? candidate.maintenanceBudget.handoffAttempts
                  : CONTEXT_POLICY.handoffAttempts,
            }
          : undefined,
      externalTurnId:
        backend !== "native" && typeof candidate.externalTurnId === "string"
          ? candidate.externalTurnId
          : undefined,
      activeKnowledgeBaseId:
        typeof candidate.activeKnowledgeBaseId === "string"
          ? candidate.activeKnowledgeBaseId
          : undefined,
      recoverableTurn: [
        "running",
        "awaiting_approval",
        "interrupted",
        "failed",
      ].includes(status)
        ? recoverableTurn
        : undefined,
      postProcessing: Array.isArray(candidate.postProcessing)
        ? candidate.postProcessing
            .filter(
              (job) =>
                job &&
                typeof job.turnId === "string" &&
                typeof job.userText === "string" &&
                typeof job.assistantText === "string" &&
                Array.isArray(job.pending) &&
                job.pending.every(
                  (step) => step === "title" || step === "memory",
                ),
            )
            .map((job) => ({
              ...job,
              error:
                job.error ?? "Final steps were interrupted; retry to finish",
            }))
        : undefined,
      annotationBatchId:
        typeof candidate.annotationBatchId === "string"
          ? candidate.annotationBatchId
          : undefined,
      workflow: undefined,
      run:
        restoreRun(candidate.run) ?? migrateWorkflow(candidate, input.id, now),
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
    schemaVersion: 4,
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

function restoreWorkflow(
  value: WorkflowState | undefined,
): WorkflowState | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    value.version !== 1 ||
    !["research", "review", "delivery", "completed"].includes(value.phase) ||
    typeof value.originalRequest !== "string" ||
    typeof value.handoff !== "string" ||
    !isLockedContextSnapshot(value.sources) ||
    ![value.proposalIds, value.operationIds, value.artifactIds].every(
      (entries) =>
        Array.isArray(entries) &&
        entries.every((entry) => typeof entry === "string"),
    ) ||
    !Number.isSafeInteger(value.remainingIterations) ||
    value.remainingIterations < 0 ||
    !Number.isSafeInteger(value.remainingToolCalls) ||
    value.remainingToolCalls < 0 ||
    (value.phaseNotes !== undefined && typeof value.phaseNotes !== "string")
  )
    throw new Error(
      "Saved workflow is damaged; it must not be restarted as an empty plan",
    );
  return value;
}

function migrateWorkflow(
  task: Partial<ResearchTaskRecord>,
  taskId: string,
  now: number,
): RunState | undefined {
  const workflow = restoreWorkflow(task.workflow);
  const recovery =
    isRecoverableTurn(task.recoverableTurn) &&
    ["running", "awaiting_approval", "interrupted", "failed"].includes(
      task.status ?? "",
    )
      ? task.recoverableTurn
      : undefined;
  if ((!workflow || workflow.phase === "completed") && !recovery)
    return undefined;
  const sources = workflow?.sources ?? task.lockedContext;
  if (!sources) throw new Error("Interrupted task has no recoverable sources");
  return {
    version: 1,
    id: `run_${taskId}_legacy`,
    generation: 0,
    intentRevision: 1,
    request: workflow?.originalRequest ?? recovery!.userText,
    sources,
    templateId: task.templateId,
    templateVersion: 1,
    requiredArtifactKinds: [],
    status: "interrupted",
    stopReason: "host_restarted",
    budget: {
      maxIterations: 128,
      maxToolCalls: 96,
      iterationsUsed: Math.max(
        recovery?.iteration ?? 0,
        workflow ? 128 - workflow.remainingIterations : 0,
      ),
      toolCallsUsed: workflow
        ? Math.max(0, 96 - workflow.remainingToolCalls)
        : 0,
      executorStarts: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      modelRequestsObservable: task.backend === "native",
    },
    createdAt: task.createdAt ?? now,
    updatedAt: now,
    recoveryNotes:
      [workflow?.handoff, workflow?.phaseNotes].filter(Boolean).join("\n\n") ||
      undefined,
  };
}
