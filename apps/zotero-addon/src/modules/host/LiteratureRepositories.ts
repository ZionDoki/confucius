import type { LiteratureAttempt, LiteratureWork } from "@confucius/protocol";
import { LiteratureError, normalizeDoi } from "./OpenAlexClient";
import { requestFulltext } from "./LiteratureNetwork";
import type { FulltextCandidate } from "./LiteratureResolvers";

/** DOI-based discovery, not title guessing. Each PDF URL comes from API metadata. */
export async function repositoryCandidates(
  work: LiteratureWork,
  signal: AbortSignal,
  attempts: LiteratureAttempt[],
): Promise<FulltextCandidate[]> {
  if (!work.doi) return [];
  const candidates: FulltextCandidate[] = [];
  const read = async (url: string) => {
    const attempt: LiteratureAttempt = {
      stage: "zotero",
      method: "repository",
      url,
      at: Date.now(),
    };
    attempts.push(attempt);
    try {
      const result = await requestFulltext(url, signal, {
        maxBytes: 2 * 1024 * 1024,
      });
      return new TextDecoder().decode(result.bytes);
    } catch (error) {
      attempt.error = error instanceof LiteratureError ? error.code : "network";
      if (signal.aborted) throw error;
      return undefined;
    }
  };
  const url = new URL(
    "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
  );
  url.search = new URLSearchParams({
    query: `DOI:"${work.doi.replace(/["\\]/g, "")}"`,
    format: "json",
    resultType: "core",
    pageSize: "5",
  }).toString();
  const raw = await read(url.href);
  if (!raw) return [];
  const discoveryAttempt = attempts.at(-1)!;
  let records: Array<{
    doi?: string;
    pmcid?: string;
    fullTextUrlList?: {
      fullTextUrl?: Array<{
        url: string;
        availabilityCode?: string;
        documentStyle?: string;
      }>;
    };
  }>;
  try {
    records = JSON.parse(raw)?.resultList?.result;
    if (!Array.isArray(records)) throw new Error("Invalid repository records");
  } catch {
    discoveryAttempt.error = "unavailable";
    return [];
  }
  for (const record of records.slice(0, 5)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      discoveryAttempt.error = "unavailable";
      continue;
    }
    if (normalizeDoi(record.doi) !== normalizeDoi(work.doi)) continue;
    const pmcid = record.pmcid;
    if (pmcid && /^PMC\d+$/.test(pmcid)) {
      const sourceUrl = `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`;
      candidates.push({
        url: sourceUrl,
        kind: "page",
        sourceUrl: url.href,
        version: "unknown",
      });
      // Since August 2026 PMC distributes versioned objects. Do not assume .1 exists.
      const bucket = "https://pmc-oa-opendata.s3.amazonaws.com/";
      const listing = await read(
        `${bucket}?list-type=2&prefix=${pmcid}.&delimiter=/&max-keys=10`,
      );
      const versions = [
        ...(listing ?? "").matchAll(
          /<CommonPrefixes><Prefix>([^<]+)<\/Prefix>/g,
        ),
      ]
        .map((match) => match[1])
        .filter((prefix) => new RegExp(`^${pmcid}\\.\\d+/$`).test(prefix));
      for (const prefix of versions.slice(0, 3)) {
        const metadataUrl = `${bucket}${prefix}${prefix.slice(0, -1)}.json`;
        const metadata = await read(metadataUrl);
        if (!metadata) continue;
        try {
          const data = JSON.parse(metadata);
          if (
            normalizeDoi(data.doi) === normalizeDoi(work.doi) &&
            typeof data.pdf_url === "string"
          )
            candidates.push({
              url: data.pdf_url,
              kind: "pdf",
              sourceUrl: metadataUrl,
              version:
                data.is_manuscript === "yes"
                  ? "acceptedVersion"
                  : data.is_manuscript === "no"
                    ? "publishedVersion"
                    : "unknown",
            });
        } catch {
          attempts.at(-1)!.error = "unavailable";
        }
      }
    }
    const links = record.fullTextUrlList?.fullTextUrl;
    if (links !== undefined && !Array.isArray(links))
      discoveryAttempt.error = "unavailable";
    for (const link of (Array.isArray(links) ? links : []).slice(0, 8))
      if (
        link &&
        typeof link.url === "string" &&
        ["F", "OA"].includes(link.availabilityCode ?? "") &&
        ["pdf", "html"].includes(link.documentStyle ?? "")
      )
        candidates.push({
          url: link.url,
          kind: link.documentStyle === "pdf" ? "pdf" : "page",
          sourceUrl: url.href,
          version: "unknown",
        });
  }
  return candidates;
}
