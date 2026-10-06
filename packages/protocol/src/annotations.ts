/** Host-authored identities; display tags are never evidence of ownership. */
export interface AnnotationBatch {
  id: string;
  taskId: string;
  name: string;
  createdAt: number;
  /** Local batch time, frozen once so labels survive timezone changes. */
  timeLabel?: string;
  named?: boolean;
  /** Durable index detects a lost PDF baseline instead of recomputing it. */
  pdfs?: string[];
}
export interface AnnotationProvenance {
  batchId?: string;
  createdBy: "confucius-agent";
  taskId: string;
  agent?: string;
  runtime?: "native" | "plugin" | "sidecar";
  createdAt?: number;
  proofOperationId?: string;
  modifiedAt?: number;
  modifiedBy?: {
    taskId: string;
    agent: string;
    runtime?: "native" | "plugin" | "sidecar";
  };
  status: "planned" | "created" | "deleted";
  expected?: string;
}
export interface AnnotationBatchFilter {
  mode: "all" | "current" | "selected";
  batchIds: string[];
  includeExisting: boolean;
}
export const ALL_ANNOTATIONS: AnnotationBatchFilter = {
  mode: "all",
  batchIds: [],
  includeExisting: false,
};
export interface AnnotationBatchView {
  batches: Array<AnnotationBatch & { count: number }>;
  existingCount: number;
  total: number;
  membership: Record<string, string | null>;
  filter: AnnotationBatchFilter;
}

/** A publication in the task's review pool, distinct from native PDF ownership. */
export type AnnotationReviewStatus =
  | "pending"
  | "writing"
  | "accepted"
  | "rejected"
  | "failed"
  | "unknown"
  | "unavailable";
export interface AnnotationReviewEntry {
  id: string;
  type: string;
  page: number;
  quote: string;
  comment: string;
  color: string;
  status: AnnotationReviewStatus;
  annotationKey?: string;
  error?: string;
}
export interface AnnotationReviewBatch {
  id: string;
  createdAt: number;
  title: string;
  libraryID: number;
  attachmentKey: string;
  entries: AnnotationReviewEntry[];
}
export interface AnnotationReviewPool {
  taskId: string;
  revision: number;
  batches: AnnotationReviewBatch[];
}
export interface AnnotationReviewDecision {
  taskId: string;
  action: "accept" | "reject" | "restore";
  entries: Array<{ batchId: string; entryId: string }>;
}
export function annotationMatchesFilter(
  batchId: string | null | undefined,
  filter: AnnotationBatchFilter,
  currentBatchId?: string,
): boolean {
  if (filter.mode === "all") return true;
  if (filter.mode === "current")
    return !!currentBatchId && batchId === currentBatchId;
  return batchId ? filter.batchIds.includes(batchId) : filter.includeExisting;
}
