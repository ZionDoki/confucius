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

export type CoverageSummary =
  | {
      enumeration: SourceCoverage["enumeration"];
      expected: number;
      observed: number;
      completeTextObserved: number;
      analysisReported: number;
      staleAnalysis: number;
      failed: number;
      verification: "unknown";
      details: string;
    }
  | { damaged: true; details: string };

export function coverageSummary(
  coverage: SourceCoverage | null | undefined,
): CoverageSummary {
  // Restoration validates this shape, but a direct projection must not crash on
  // an older or hand-edited snapshot, and must not report a damaged snapshot as
  // "zero sources observed".
  if (!coverage || typeof coverage !== "object") return damagedCoverage();
  const entries = Array.isArray(coverage.entries) ? coverage.entries : null;
  if (
    !entries ||
    (coverage.enumeration !== "bound-items" &&
      coverage.enumeration !== "collection-members-unknown") ||
    entries.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        !Array.isArray(entry.pagesObserved),
    )
  ) {
    return damagedCoverage();
  }
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

function damagedCoverage(): CoverageSummary {
  return {
    damaged: true,
    details:
      "Saved context coverage is damaged; source observation and analysis are unknown",
  };
}
