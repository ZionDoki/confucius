import type { ContextWindowState } from "./history";
import type { ExecutionBinding, WorkSnapshot } from "./run";
import type { SourceCoverage } from "./sourceCoverage";

/** A location in an archived original. Optional fields preserve legacy whole-ref calls. */
export interface EvidenceLocation {
  ref: string;
  offset?: number;
  endOffset?: number;
  sourceVersion?: string;
  page?: number;
  section?: string;
}

export function validEvidenceLocation(
  value: unknown,
): value is EvidenceLocation {
  const e = value as EvidenceLocation;
  return Boolean(
    e &&
    typeof e.ref === "string" &&
    e.ref.length <= 512 &&
    /^(?:h:[\w-]+:[\w-]+:[\w-]+|n:[\w-]+:[\w-]+|m:[\w-]+)$/.test(e.ref) &&
    (e.offset === undefined ||
      (Number.isSafeInteger(e.offset) && e.offset >= 0)) &&
    (e.endOffset === undefined ||
      (Number.isSafeInteger(e.endOffset) && e.endOffset > (e.offset ?? 0))) &&
    (e.sourceVersion === undefined ||
      (typeof e.sourceVersion === "string" && e.sourceVersion.length <= 512)) &&
    (e.page === undefined || (Number.isSafeInteger(e.page) && e.page > 0)) &&
    (e.section === undefined ||
      (typeof e.section === "string" && e.section.length <= 120)),
  );
}

export interface SourceProgressNote {
  sourceId: string;
  status: "analyzed" | "failed";
  detail?: string;
}

/** Host-stamped identity. Text inside a note never changes permissions. */
export interface WorkingNoteState {
  version: 1;
  binding: ExecutionBinding;
  throughItemId?: string;
  nextAction?: string;
  evidenceRefs: string[];
  evidence?: EvidenceLocation[];
  /** Model-reported analysis with evidence; never a host verification receipt. */
  sourceProgress?: SourceProgressNote[];
  sourceVersions?: Record<string, string>;
}

export interface ContextEvidence extends EvidenceLocation {
  sourceIds: string[];
  offset: number;
  excerpt: string;
  /** Host delivery is observable for CLI tools; inclusion in its model is not. */
  delivery: "archived" | "host-provided" | "native-request";
  verification: "unknown" | "verified";
  reason?: "direct" | "next-action" | "pending" | "recent";
  needIds?: string[];
}

export interface ContextHandoff {
  version: 1;
  id: string;
  taskId: string;
  binding: ExecutionBinding;
  createdAt: number;
  throughItemId?: string;
  work: WorkSnapshot;
  nextAction: string;
  notes: Array<{ ref: string; revision: number; excerpt: string }>;
  evidence: ContextEvidence[];
  supplemented: boolean;
  recordRef?: string;
}

/** Saved before starting any replacement inference. Retrying never renews budgets. */
export interface ContextSwitchState {
  version: 1;
  id: string;
  binding: ExecutionBinding;
  handoffId: string;
  from: ContextWindowState;
  to: ContextWindowState;
  phase: "prepared" | "session-ready" | "committed";
  previousExternalSessionId?: string;
  nextExternalSessionId?: string;
  createdAt: number;
}

export interface HistoryRetentionState {
  version: 1;
  tier: "hot" | "archived" | "pruned";
  archivedAt?: number;
  projectionPending?: boolean;
  lastReadAt?: number;
  prunedAt?: number;
}

export function sameContextBinding(
  a: ExecutionBinding | undefined,
  b: ExecutionBinding | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.runId === b.runId &&
    a.intentRevision === b.intentRevision &&
    a.sourceFingerprint === b.sourceFingerprint
  );
}

export function validContextBinding(value: unknown): value is ExecutionBinding {
  const binding = value as ExecutionBinding;
  return (
    !!binding &&
    typeof binding.runId === "string" &&
    /^[\w-]+$/.test(binding.runId) &&
    Number.isSafeInteger(binding.intentRevision) &&
    binding.intentRevision > 0 &&
    typeof binding.sourceFingerprint === "string" &&
    !!binding.sourceFingerprint
  );
}

/** Validate a persisted coverage snapshot before handoff projection reads it. */
function validSourceCoverage(value: unknown): boolean {
  const coverage = value as SourceCoverage;
  return Boolean(
    coverage &&
    coverage.version === 1 &&
    validContextBinding(coverage.binding) &&
    ["bound-items", "collection-members-unknown"].includes(
      coverage.enumeration,
    ) &&
    Array.isArray(coverage.entries) &&
    coverage.entries.every((entry) => {
      const e = entry as SourceCoverage["entries"][number];
      return (
        e &&
        typeof e.sourceId === "string" &&
        typeof e.title === "string" &&
        typeof e.bindingVersion === "string" &&
        (e.fileVersion === undefined || typeof e.fileVersion === "string") &&
        (e.pageCount === undefined ||
          (Number.isSafeInteger(e.pageCount) && e.pageCount >= 0)) &&
        Array.isArray(e.pagesObserved) &&
        e.pagesObserved.every(
          (page) => Number.isSafeInteger(page) && page > 0,
        ) &&
        Array.isArray(e.truncatedPages) &&
        e.truncatedPages.every(
          (page) => Number.isSafeInteger(page) && page >= 0,
        ) &&
        ["unread", "partial", "complete-text-observed"].includes(e.read) &&
        ["unreported", "reported", "stale"].includes(e.analysis) &&
        e.verification === "unknown" &&
        (e.failed === undefined || typeof e.failed === "string") &&
        Array.isArray(e.evidence) &&
        e.evidence.every(validEvidenceLocation) &&
        (e.analysisNote === undefined ||
          (e.analysisNote &&
            typeof e.analysisNote.ref === "string" &&
            Number.isSafeInteger(e.analysisNote.revision) &&
            e.analysisNote.revision > 0 &&
            (e.analysisNote.detail === undefined ||
              typeof e.analysisNote.detail === "string")))
      );
    }),
  );
}

export function restoreContextHandoff(
  value: unknown,
): ContextHandoff | undefined {
  if (value === undefined) return undefined;
  const state = value as ContextHandoff;
  if (
    !state ||
    state.version !== 1 ||
    !validContextBinding(state.binding) ||
    typeof state.id !== "string" ||
    !/^[\w-]+$/.test(state.id) ||
    typeof state.taskId !== "string" ||
    !/^[\w-]+$/.test(state.taskId) ||
    typeof state.nextAction !== "string" ||
    !state.nextAction.trim() ||
    !Number.isFinite(state.createdAt) ||
    !Array.isArray(state.notes) ||
    !state.notes.every(
      (n) =>
        n &&
        typeof n.ref === "string" &&
        Number.isSafeInteger(n.revision) &&
        n.revision > 0 &&
        typeof n.excerpt === "string",
    ) ||
    !Array.isArray(state.evidence) ||
    !state.evidence.every(
      (e) =>
        e &&
        typeof e.ref === "string" &&
        typeof e.excerpt === "string" &&
        validEvidenceLocation(e) &&
        Number.isSafeInteger(e.offset) &&
        e.offset >= 0 &&
        Array.isArray(e.sourceIds) &&
        e.sourceIds.every((id) => typeof id === "string") &&
        ["archived", "host-provided", "native-request"].includes(e.delivery) &&
        ["unknown", "verified"].includes(e.verification),
    ) ||
    !state.work ||
    !Array.isArray(state.work.completed) ||
    !state.work.completed.every(
      (c) =>
        c &&
        typeof c.id === "string" &&
        typeof c.description === "string" &&
        (c.revision === undefined ||
          (Number.isSafeInteger(c.revision) && c.revision > 0)),
    ) ||
    !Array.isArray(state.work.missing) ||
    !state.work.missing.every(
      (m) =>
        m &&
        typeof m.id === "string" &&
        typeof m.description === "string" &&
        ["artifact", "proposal", "operation"].includes(m.kind),
    ) ||
    !Array.isArray(state.work.unknownOperationIds) ||
    !state.work.unknownOperationIds.every((id) => typeof id === "string") ||
    (state.work.coverage !== undefined &&
      !validSourceCoverage(state.work.coverage)) ||
    typeof state.supplemented !== "boolean"
  )
    throw new Error(
      "Saved context handoff is damaged; original context retained",
    );
  return JSON.parse(JSON.stringify(state)) as ContextHandoff;
}

export function restoreContextSwitch(
  value: unknown,
): ContextSwitchState | undefined {
  if (value === undefined) return undefined;
  const state = value as ContextSwitchState;
  if (
    !state ||
    state.version !== 1 ||
    !validContextBinding(state.binding) ||
    typeof state.id !== "string" ||
    !/^[\w-]+$/.test(state.id) ||
    typeof state.handoffId !== "string" ||
    !state.from ||
    !state.to ||
    ![state.from, state.to].every(
      (w) =>
        typeof w.id === "string" &&
        /^[\w-]+$/.test(w.id) &&
        Number.isSafeInteger(w.number) &&
        w.number > 0,
    ) ||
    !["prepared", "session-ready", "committed"].includes(state.phase) ||
    !Number.isFinite(state.createdAt)
  )
    throw new Error(
      "Saved context switch is damaged; original context retained",
    );
  return JSON.parse(JSON.stringify(state)) as ContextSwitchState;
}
