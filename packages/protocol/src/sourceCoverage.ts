import type { EvidenceLocation } from "./contextHandoff";
import type { LockedContextSnapshot } from "./research";
import type { ExecutionBinding } from "./run";

export interface SourceObservation {
  sourceIds: string[];
  pages: Array<{ page: number; truncated: boolean }>;
  pageCount?: number;
  fileVersion?: string;
  error?: string;
}

export interface SourceCoverage {
  version: 1;
  binding: ExecutionBinding;
  /** A collection/search binding does not establish that all its members were enumerated. */
  enumeration: "bound-items" | "collection-members-unknown";
  entries: Array<{
    sourceId: string;
    title: string;
    bindingVersion: string;
    fileVersion?: string;
    pageCount?: number;
    pagesObserved: number[];
    truncatedPages: number[];
    read: "unread" | "partial" | "complete-text-observed";
    analysis: "unreported" | "reported" | "stale";
    verification: "unknown";
    failed?: string;
    evidence: EvidenceLocation[];
    analysisNote?: { ref: string; revision: number; detail?: string };
  }>;
}

/** Binding identity only. File freshness is separately observed by actual source tools. */
export function contextSourceVersions(
  sources: LockedContextSnapshot,
): Record<string, string> {
  return Object.fromEntries(
    sources.items.map((item) => {
      const attachment =
        item.attachmentKey ??
        (sources.reader?.libraryID === item.libraryID &&
        sources.reader.parentKey === item.key
          ? sources.reader.attachmentKey
          : undefined);
      return [
        `${item.libraryID}:${item.key}`,
        JSON.stringify([item.libraryID, item.key, attachment, item.title]),
      ];
    }),
  );
}

export function coverageSummary(coverage: SourceCoverage) {
  const entries = coverage.entries;
  return {
    enumeration: coverage.enumeration,
    expected: entries.length,
    observed: entries.filter((e) => e.pagesObserved.length > 0).length,
    completeTextObserved: entries.filter(
      (e) => e.read === "complete-text-observed",
    ).length,
    analysisReported: entries.filter((e) => e.analysis === "reported").length,
    staleAnalysis: entries.filter((e) => e.analysis === "stale").length,
    failed: entries.filter((e) => e.failed).length,
    verification: "unknown",
    details:
      "context_search view=coverage; observation and reported analysis are not business verification",
  };
}
