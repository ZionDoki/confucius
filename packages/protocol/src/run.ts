import {
  isArtifactKind,
  isLockedContextSnapshot,
  type ArtifactKind,
  type LockedContextSnapshot,
} from "./research";

/** One user request, including steering and continuations; never a provider turn. */
export interface RunState {
  version: 1;
  id: string;
  generation: number;
  intentRevision: number;
  request: string;
  sources: LockedContextSnapshot;
  templateId?: string;
  templateVersion: number;
  requiredArtifactKinds: ArtifactKind[];
  status: "running" | "interrupted" | "completed" | "failed";
  stopReason?: string;
  budget: {
    maxIterations: number;
    maxToolCalls: number;
    iterationsUsed: number;
    toolCallsUsed: number;
    executorStarts: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Active host execution time; absent in older v4 records. */
    elapsedMs?: number;
    modelRequestsObservable: boolean;
  };
  createdAt: number;
  updatedAt: number;
  /** Imported notes are evidence only, and are archived before being removed. */
  recoveryNotes?: string;
}

export interface ExecutionBinding {
  runId: string;
  intentRevision: number;
  sourceFingerprint: string;
}

export interface WorkGap {
  id: string;
  description: string;
  kind: "artifact" | "proposal" | "operation";
  /** Domain content fingerprint; changing timestamps alone is not progress. */
  progress?: string;
}

/** A projection of domain stores, not another persisted copy of their state. */
export interface WorkSnapshot {
  completed: Array<{ id: string; revision?: number; description: string }>;
  missing: WorkGap[];
  unknownOperationIds: string[];
}

export function executionBinding(run?: RunState): ExecutionBinding | undefined {
  return run
    ? {
        runId: run.id,
        intentRevision: run.intentRevision,
        sourceFingerprint: run.sources.fingerprint,
      }
    : undefined;
}

export function restoreRun(value: unknown): RunState | undefined {
  if (value === undefined) return undefined;
  const run = value as RunState;
  if (
    !run ||
    run.version !== 1 ||
    typeof run.id !== "string" ||
    typeof run.request !== "string" ||
    !isLockedContextSnapshot(run.sources) ||
    !Number.isSafeInteger(run.templateVersion) ||
    run.templateVersion < 1 ||
    !Number.isFinite(run.createdAt) ||
    !Number.isFinite(run.updatedAt) ||
    !Number.isInteger(run.generation) ||
    run.generation < 0 ||
    !Number.isInteger(run.intentRevision) ||
    run.intentRevision < 1 ||
    !Array.isArray(run.requiredArtifactKinds) ||
    !run.requiredArtifactKinds.every(isArtifactKind) ||
    !run.budget ||
    ![
      "maxIterations",
      "maxToolCalls",
      "iterationsUsed",
      "toolCallsUsed",
      "executorStarts",
      "promptTokens",
      "completionTokens",
      "totalTokens",
    ].every(
      (key) =>
        typeof (run.budget as unknown as Record<string, unknown>)[key] ===
        "number",
    ) ||
    run.budget.maxIterations < 1 ||
    typeof run.budget.modelRequestsObservable !== "boolean" ||
    !["running", "interrupted", "completed", "failed"].includes(run.status) ||
    !Object.entries(run.budget).every(([key, number]) =>
      key === "modelRequestsObservable"
        ? typeof number === "boolean"
        : typeof number === "number" && Number.isFinite(number) && number >= 0,
    )
  ) {
    throw new Error(
      "Saved execution is damaged; original recovery evidence was retained",
    );
  }
  const restored = JSON.parse(JSON.stringify(run)) as RunState;
  if (restored.status === "running") {
    restored.status = "interrupted";
    restored.stopReason = "host_restarted";
  }
  return restored;
}
