import type {
  AnnotationReviewBatch,
  AnnotationReviewEntry,
  AnnotationReviewPool,
} from "@confucius/protocol";
import { createReviewPanel } from "./reviewPanel";

/** Annotation writes keep their receipt and ownership boundary behind the shared UI. */
export function createAnnotationReviewPanel(
  doc: Document,
  options: {
    rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    viewport: HTMLElement;
    anchor: HTMLElement;
    opened: () => void;
    visibilityChanged: () => void;
  },
) {
  return createReviewPanel<AnnotationReviewEntry>(doc, {
    ...options,
    kind: "annotation",
    load: async (taskId) =>
      (await options.rpc("annotation/review/list", {
        taskId,
      })) as AnnotationReviewPool,
    decide: async (taskId, action, rows) =>
      (await options.rpc("annotation/review/decide", {
        taskId,
        action,
        entries: rows.map((row) => ({
          batchId: row.batch.id,
          entryId: row.entry.id,
        })),
      })) as AnnotationReviewPool,
    locate: async (row) => {
      const batch = row.batch as AnnotationReviewBatch;
      return options.rpc("reader/open", {
        libraryID: batch.libraryID,
        key: batch.attachmentKey,
        pageIndex: row.entry.page - 1,
        annotationKey: row.entry.annotationKey,
      });
    },
  });
}
