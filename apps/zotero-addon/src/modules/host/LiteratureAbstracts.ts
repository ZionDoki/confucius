import type { LiteratureWork } from "@confucius/protocol";
import { createAbortController } from "../../utils/webPlatform";
import {
  LiteratureError,
  normalizeDoi,
  zoteroOpenAlexTransport,
  type OpenAlexClient,
  type OpenAlexTransport,
} from "./OpenAlexClient";

/** Crossref abstracts may contain JATS XML. Store plain text, never markup. */
export function abstractText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  const text = value
    .slice(0, 100_000)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?[a-zA-Z][\w:.-]*(?:\s[^<>]*)?\s*\/?>/g, " ")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (raw, key: string) => {
        if (!key.startsWith("#")) return entities[key.toLowerCase()] ?? raw;
        const code =
          key.slice(0, 2).toLowerCase() === "#x"
            ? parseInt(key.slice(2), 16)
            : Number(key.slice(1));
        return code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : " ";
      },
    )
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

/** Per-source deadlines also settle if a transport ignores cancellation. */
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  ms: number,
): Promise<T> {
  const controller = createAbortController();
  let reject!: (error: Error) => void;
  const stopped = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const abort = () => {
    controller.abort();
    reject(new LiteratureError("cancelled", "Cancelled"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    reject(new LiteratureError("network", "Abstract lookup timed out"));
  }, ms);
  try {
    if (signal?.aborted) {
      abort();
      return await stopped;
    }
    return await Promise.race([work(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export class LiteratureAbstracts {
  constructor(
    private readonly client: Pick<OpenAlexClient, "abstract">,
    private readonly local: (
      work: LiteratureWork,
    ) => Promise<string | undefined>,
    private readonly transport: OpenAlexTransport = zoteroOpenAlexTransport,
    private readonly timeoutMs = 5_000,
  ) {}
  async resolve(work: LiteratureWork, signal?: AbortSignal) {
    let failed = false;
    const sources: Array<
      [
        "zotero" | "openalex" | "crossref",
        (signal: AbortSignal) => Promise<unknown>,
      ]
    > = [
      ["zotero", () => this.local(work)],
      ["openalex", (signal) => this.client.abstract(work, signal)],
    ];
    const doi = normalizeDoi(work.doi);
    if (doi)
      sources.push([
        "crossref",
        async (signal) => {
          // The OpenAlex credential must never be forwarded to another provider.
          const response = await this.transport(
            `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
            "",
            signal,
          );
          if (response.status === 404) return undefined;
          if (response.status !== 200)
            throw new Error("Crossref metadata unavailable");
          const message = (
            response.data as { message?: { DOI?: string; abstract?: string } }
          )?.message;
          return normalizeDoi(message?.DOI) === doi
            ? message?.abstract
            : undefined;
        },
      ]);
    for (const [source, lookup] of sources) {
      if (signal?.aborted) throw new LiteratureError("cancelled", "Cancelled");
      try {
        const abstract = abstractText(
          await bounded(
            lookup,
            signal,
            source === "zotero"
              ? Math.min(2_000, this.timeoutMs)
              : this.timeoutMs,
          ),
        );
        if (signal?.aborted)
          throw new LiteratureError("cancelled", "Cancelled");
        if (abstract)
          return {
            abstract,
            abstractLookup: {
              status: "available" as const,
              source,
              checkedAt: Date.now(),
            },
          };
      } catch {
        if (signal?.aborted)
          throw new LiteratureError("cancelled", "Cancelled");
        failed = true;
      }
    }
    return {
      abstractLookup: {
        status: failed ? ("unavailable" as const) : ("missing" as const),
        checkedAt: Date.now(),
      },
    };
  }
}
