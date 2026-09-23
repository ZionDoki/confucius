import type {
  LiteratureErrorCode,
  LiteratureSearch,
  LiteratureWork,
} from "@confucius/protocol";

export class LiteratureError extends Error {
  constructor(
    readonly code: LiteratureErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export interface OpenAlexResponse {
  status: number;
  data: unknown;
  remaining?: string | null;
  retryAfter?: string | null;
}
export type OpenAlexTransport = (
  url: string,
  key: string,
  signal?: AbortSignal,
) => Promise<OpenAlexResponse>;
export function normalizeDoi(value: unknown): string | undefined {
  const doi = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined;
}
export function publicUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return;
    for (const key of ["api_key", "apikey", "access_token", "token"])
      url.searchParams.delete(key);
    return url.href;
  } catch {
    return;
  }
}
type Obj = Record<string, any>;
export function openAlexWork(raw: Obj, queryId: string): LiteratureWork | null {
  const id = String(raw.id ?? "")
    .match(/(?:^|\/)W\d+$/)?.[0]
    .replace(/^\//, "");
  if (!id) return null;
  const locations: Obj[] = [
    raw.best_oa_location,
    raw.primary_location,
    ...(Array.isArray(raw.locations) ? raw.locations : []),
  ].filter(Boolean);
  const words: Array<[number, string]> = [];
  if (
    raw.abstract_inverted_index &&
    typeof raw.abstract_inverted_index === "object"
  )
    for (const [word, positions] of Object.entries(raw.abstract_inverted_index))
      if (Array.isArray(positions))
        for (const p of positions)
          if (Number.isSafeInteger(p) && p >= 0 && p < 30_000)
            words.push([p, word]);
  const cache =
    raw.has_content?.pdf === true
      ? publicUrl(raw.content_urls?.pdf)
      : undefined;
  return {
    id,
    openAlexIds: [id],
    doi: normalizeDoi(raw.doi),
    title: String(raw.title ?? raw.display_name ?? id),
    authors: (Array.isArray(raw.authorships) ? raw.authorships : [])
      .map((a: Obj) => String(a.author?.display_name ?? ""))
      .filter(Boolean),
    year: Number.isInteger(raw.publication_year)
      ? raw.publication_year
      : undefined,
    abstract: words.length
      ? words
          .sort((a, b) => a[0] - b[0])
          .map((w) => w[1])
          .join(" ")
      : undefined,
    venue: raw.primary_location?.source?.display_name,
    citedBy: Number(raw.cited_by_count) || 0,
    openAccess: raw.open_access?.is_oa === true,
    landingUrl:
      locations.map((l) => publicUrl(l.landing_page_url)).find(Boolean) ??
      publicUrl(raw.doi),
    pdfUrls: [
      ...new Set(
        locations
          .filter((l) => l.is_oa === true)
          .map((l) => publicUrl(l.pdf_url))
          .filter((u): u is string => !!u),
      ),
    ],
    cachedPdfUrl:
      cache && new URL(cache).hostname === "content.openalex.org"
        ? cache
        : undefined,
    queryIds: [queryId],
    decision: {
      selected: false,
      evaluated: false,
      actor: "agent",
      revision: 0,
    },
    acquisition: { status: "missing" },
  };
}
export function openAlexFailure(status: number): LiteratureError | undefined {
  if (status === 401 || status === 403)
    return new LiteratureError(
      "authentication",
      "OpenAlex Key 无效或无权限 / Invalid OpenAlex key or access denied",
    );
  if (status === 402)
    return new LiteratureError(
      "quota",
      "OpenAlex 额度不足 / OpenAlex credits exhausted",
    );
  if (status === 429)
    return new LiteratureError(
      "rate_limit",
      "OpenAlex 请求限流或当日额度已用完，请稍后重试 / Rate limit or daily credits exhausted; retry later",
    );
  if (status < 200 || status >= 300)
    return new LiteratureError("network", `OpenAlex HTTP ${status}`);
  return undefined;
}
export class OpenAlexClient {
  constructor(
    private readonly key: () => string,
    private readonly transport: OpenAlexTransport = zoteroOpenAlexTransport,
    private readonly wait: (
      ms: number,
      signal?: AbortSignal,
    ) => Promise<void> = (ms, signal) =>
      new Promise((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new LiteratureError("cancelled", "Cancelled"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, ms);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
  ) {}
  async test() {
    await this.request("https://api.openalex.org/rate-limit");
    return { ok: true, hasKey: !!this.key() };
  }
  async abstract(work: LiteratureWork, signal?: AbortSignal) {
    const id = work.openAlexIds.find((id) => /^W\d+$/.test(id));
    if (!id) return undefined;
    const response = await this.request(
      `https://api.openalex.org/works/${id}`,
      signal,
    );
    const found = response && openAlexWork(response, work.queryIds[0] ?? "");
    if (!found || !work.openAlexIds.includes(found.id)) return undefined;
    return found.abstract;
  }
  private async request(url: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new LiteratureError("cancelled", "Cancelled");
    let response: OpenAlexResponse;
    try {
      for (let attempt = 0; ; attempt++) {
        response = await this.transport(url, this.key(), signal);
        if (response.status !== 429) break;
        if (
          response.remaining === "0" ||
          /daily|budget|credit|quota/i.test(JSON.stringify(response.data))
        )
          throw new LiteratureError(
            "quota",
            "OpenAlex 当日额度已用完 / OpenAlex daily credits exhausted",
          );
        if (attempt >= 2) break;
        const retry = Number(response.retryAfter);
        await this.wait(
          Number.isFinite(retry) && retry > 0
            ? Math.min(10_000, retry * 1000)
            : 1000 * 2 ** attempt,
          signal,
        );
      }
    } catch (e) {
      if (e instanceof LiteratureError) throw e;
      throw new LiteratureError(
        "network",
        "无法连接 OpenAlex / Could not connect to OpenAlex",
      );
    }
    if (signal?.aborted) throw new LiteratureError("cancelled", "Cancelled");
    const error = openAlexFailure(response.status);
    if (error) throw error;
    return response.data as Obj;
  }
  async search(
    input: LiteratureSearch,
    queryId: string,
    cursor = "*",
    signal?: AbortSignal,
  ) {
    if (!input.query.trim() || input.query.length > 2000)
      throw new Error("Enter a search query (1–2000 characters)");
    for (const year of [input.fromYear, input.toYear])
      if (
        year !== undefined &&
        (!Number.isInteger(year) || year < 1000 || year > 9999)
      )
        throw new Error("Invalid year");
    if (input.fromYear && input.toYear && input.fromYear > input.toYear)
      throw new Error("Invalid year range");
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", input.query.trim());
    url.searchParams.set("per_page", "100");
    url.searchParams.set("cursor", cursor);
    const filters: string[] = [];
    if (input.fromYear || input.toYear)
      filters.push(
        `publication_year:${input.fromYear ?? ""}-${input.toYear ?? ""}`,
      );
    if (input.openAccess) filters.push("open_access.is_oa:true");
    if (filters.length) url.searchParams.set("filter", filters.join(","));
    url.searchParams.set(
      "sort",
      input.sort === "date"
        ? "publication_date:desc"
        : input.sort === "citations"
          ? "cited_by_count:desc"
          : "relevance_score:desc",
    );
    const data = await this.request(url.href, signal);
    if (!Array.isArray(data.results))
      throw new LiteratureError("network", "Invalid OpenAlex response");
    return {
      works: data.results
        .slice(0, 100)
        .map((w: Obj) => openAlexWork(w, queryId))
        .filter((w: LiteratureWork | null): w is LiteratureWork => !!w),
      total: Number(data.meta?.count) || 0,
      cursor: data.results.length ? (data.meta?.next_cursor ?? null) : null,
    };
  }
}
export const zoteroOpenAlexTransport: OpenAlexTransport = async (
  url,
  key,
  signal,
) => {
  let xhr: XMLHttpRequest | undefined;
  const abort = () => xhr?.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: 30_000,
      successCodes: false,
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      requestObserver: (request: XMLHttpRequest) => {
        xhr = request;
        if (signal?.aborted) abort();
      },
    });
    return {
      status: response.status,
      data: response.response,
      remaining: response.getResponseHeader("X-RateLimit-Remaining"),
      retryAfter: response.getResponseHeader("Retry-After"),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
};
