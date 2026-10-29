import type { LiteratureQuery, LiteratureWork } from "@confucius/protocol";

function descending(left: number | undefined, right: number | undefined) {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left;
}

type RankableWork = Omit<LiteratureWork, "decision" | "queryIds" | "reads">;

function publicationTime(work: RankableWork): number | undefined {
  const timestamp = work.publicationDate
    ? Date.parse(work.publicationDate)
    : undefined;
  if (timestamp !== undefined && Number.isFinite(timestamp)) return timestamp;
  return work.year === undefined ? undefined : Date.UTC(work.year, 0, 1);
}

function sharedImpactMetric(works: RankableWork[]) {
  // Choose one measurement for the whole candidate set. Per-row fallbacks mix
  // incompatible units; pairwise fallbacks can also make sorting non-transitive.
  const metrics: Array<(work: RankableWork) => number | undefined> = [
    (work) => work.citationNormalizedPercentile?.value,
    (work) => work.fwci,
    (work) => work.citedByPercentileYear?.max,
    (work) => work.citedByPercentileYear?.min,
  ];
  return metrics.find((metric) =>
    works.every((work) => Number.isFinite(metric(work))),
  );
}

export function shortlistWorks<T extends RankableWork>(
  works: T[],
  query: LiteratureQuery | undefined,
  requestedLimit = 10,
): { items: T[]; totalCandidates: number; reranked: boolean } {
  const limit = Math.min(12, Math.max(1, Math.floor(requestedLimit || 10)));
  const eligible = works.filter((work) => {
    if (!query?.includeRetracted && work.isRetracted === true) return false;
    if (!query?.includeParatext && work.publicationType === "paratext")
      return false;
    if (
      query?.hasAbstract !== undefined &&
      Boolean(work.abstract?.trim()) !== query.hasAbstract
    )
      return false;
    return true;
  });
  const strategy = query?.sort ?? "relevance";
  const impact = sharedImpactMetric(eligible);
  const reranked =
    strategy === "relevance" &&
    !!query &&
    (query.reranked === true ||
      eligible.some(
        (work) => work.queryScores?.[query.id]?.rerankScore !== undefined,
      ));
  const ranked = [...eligible].sort((left, right) => {
    const leftScores = query ? left.queryScores?.[query.id] : undefined;
    const rightScores = query ? right.queryScores?.[query.id] : undefined;
    const leftPrimary =
      strategy === "date"
        ? publicationTime(left)
        : strategy === "citations"
          ? left.citedBy
          : leftScores?.relevanceScore;
    const rightPrimary =
      strategy === "date"
        ? publicationTime(right)
        : strategy === "citations"
          ? right.citedBy
          : rightScores?.relevanceScore;
    return (
      // OpenAlex reranks the first 100 hits. Keep that cohort ahead of the
      // unreranked tail without comparing its probabilities to text scores.
      (reranked
        ? descending(leftScores?.rerankScore, rightScores?.rerankScore)
        : 0) ||
      descending(leftPrimary, rightPrimary) ||
      descending(leftScores?.relevanceScore, rightScores?.relevanceScore) ||
      (impact ? descending(impact(left), impact(right)) : 0) ||
      descending(left.citedBy, right.citedBy) ||
      left.id.localeCompare(right.id)
    );
  });
  return {
    items: ranked.slice(0, limit).map((work, index) => ({
      ...work,
      presentation: {
        rank: index + 1,
        relevanceScore: query
          ? work.queryScores?.[query.id]?.relevanceScore
          : undefined,
        rerankScore:
          reranked && query
            ? work.queryScores?.[query.id]?.rerankScore
            : undefined,
      },
    })),
    totalCandidates: eligible.length,
    reranked,
  };
}
