import {
  contextSourceVersions,
  executionBinding,
  type HistoryItem,
  type SourceObservation,
  type SourceCoverage,
  type RunState,
  type WorkingNoteState,
} from "@confucius/protocol";

export interface ProgressRecord {
  sourceId: string;
  status: "analyzed" | "failed";
  detail?: string;
  note: string;
  revision: number;
  state: WorkingNoteState;
  originalRef?: string;
}

/** Parse only a host-stamped tool response, never a search excerpt or model narrative. */
export function sourceObservation(
  item: Pick<HistoryItem, "role" | "toolName" | "binding">,
  content: string,
): SourceObservation | undefined {
  if (item.role !== "tool" || item.toolName !== "get_pages" || !item.binding)
    return;
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    return;
  }
  const result = value?.result ?? value;
  if (result?.toolName !== "get_pages" || typeof result.ok !== "boolean")
    return;
  const data = result.ok ? result.data : value.arguments;
  if (!data || !Number.isInteger(data.libraryID)) return;
  const keys = [data.key, data.attachmentKey].filter(
    (key) => typeof key === "string" && /^[\w-]+$/.test(key),
  );
  if (!keys.length) return;
  return {
    sourceIds: [...new Set(keys.map((key) => `${data.libraryID}:${key}`))],
    pages:
      result.ok && Array.isArray(data.pages)
        ? data.pages
            .filter(
              (p: { page?: number }) =>
                Number.isSafeInteger(p?.page) && p.page! > 0,
            )
            .map((p: { page: number; truncated?: boolean }) => ({
              page: p.page,
              truncated: p.truncated === true,
            }))
        : [],
    pageCount:
      Number.isSafeInteger(data.pageCount) && data.pageCount > 0
        ? data.pageCount
        : undefined,
    fileVersion:
      typeof data.sourceVersion === "string" &&
      !data.sourceVersion.startsWith("unversioned:")
        ? data.sourceVersion
        : undefined,
    error: !result.ok
      ? String(result.message ?? "Source read failed").slice(0, 500)
      : undefined,
  };
}

export function projectSourceCoverage(
  taskId: string,
  run: RunState,
  items: HistoryItem[],
  progress: ProgressRecord[],
): SourceCoverage {
  const versions = contextSourceVersions(run.sources);
  const matches = (
    stamp: {
      binding?: WorkingNoteState["binding"];
      sourceVersions?: Record<string, string>;
    },
    sourceId: string,
  ) =>
    stamp.binding?.runId === run.id &&
    (stamp.sourceVersions?.[sourceId] !== undefined
      ? stamp.sourceVersions[sourceId] === versions[sourceId]
      : stamp.binding.sourceFingerprint === run.sources.fingerprint);
  return {
    version: 1,
    binding: executionBinding(run)!,
    enumeration:
      run.sources.collection || run.sources.savedSearch
        ? "collection-members-unknown"
        : "bound-items",
    entries: run.sources.items.map((source) => {
      const sourceId = `${source.libraryID}:${source.key}`;
      const observed = items.filter(
        (item) =>
          item.observation?.sourceIds.includes(sourceId) &&
          matches(item, sourceId),
      );
      const latestRead = [...observed]
        .reverse()
        .find((i) => i.observation?.pages.length);
      const latestVersion = latestRead?.observation?.fileVersion;
      // Unversioned observations cannot establish that separate reads came from one file revision.
      const valid = observed.filter((i) =>
        latestVersion
          ? i.observation?.fileVersion === latestVersion
          : i === latestRead,
      );
      const pages = new Map<number, boolean>();
      for (const item of valid)
        for (const page of item.observation?.pages ?? [])
          pages.set(
            page.page,
            (pages.get(page.page) ?? true) && page.truncated,
          );
      const pageCount = [...valid]
        .reverse()
        .find((i) => i.observation?.pageCount)?.observation?.pageCount;
      const analysis = [...progress]
        .reverse()
        .find(
          (p) =>
            p.sourceId === sourceId &&
            matches(p.state, sourceId) &&
            p.state.binding.intentRevision === run.intentRevision,
        );
      const refs =
        analysis?.state.evidence ??
        analysis?.state.evidenceRefs.map((ref) => ({ ref })) ??
        [];
      const supported = refs.some((ref) =>
        valid.some(
          (i) => ref.ref === `h:${i.taskId}:${i.windowId}:${i.itemId}`,
        ),
      );
      const last = observed.at(-1)?.observation;
      return {
        sourceId,
        title: source.title,
        bindingVersion: versions[sourceId],
        fileVersion: latestVersion,
        pageCount,
        pagesObserved: [...pages.keys()].sort((a, b) => a - b),
        truncatedPages: [...pages]
          .filter(([, truncated]) => truncated)
          .map(([page]) => page)
          .sort((a, b) => a - b),
        read: !pages.size
          ? "unread"
          : pageCount &&
              pages.size === pageCount &&
              [...pages].every(
                ([page, truncated]) => page <= pageCount && !truncated,
              )
            ? "complete-text-observed"
            : "partial",
        analysis:
          analysis?.status === "analyzed"
            ? supported
              ? "reported"
              : "stale"
            : "unreported",
        verification: "unknown",
        failed:
          analysis?.status === "failed"
            ? (analysis.detail ?? "Analysis failed; retry required")
            : last?.error,
        evidence: valid
          .slice(-4)
          .map((i) => ({
            ref: `h:${taskId}:${i.windowId}:${i.itemId}`,
            sourceVersion: `h:${taskId}:${i.windowId}:${i.itemId}`,
          })),
        analysisNote: analysis
          ? {
              ref: analysis.originalRef ?? `n:${taskId}:${analysis.note}`,
              revision: analysis.revision,
              detail: analysis.detail,
            }
          : undefined,
      };
    }),
  };
}
