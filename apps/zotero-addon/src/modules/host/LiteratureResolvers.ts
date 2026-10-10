import type { LiteratureVersion } from "@confucius/protocol";
import { LiteratureError, literatureVersion } from "./OpenAlexClient";
import { fulltextUrl } from "./LiteratureNetwork";

export interface FulltextCandidate {
  url: string;
  kind: "pdf" | "page";
  version: LiteratureVersion;
  sourceUrl?: string;
}
interface Resolver {
  url?: string;
  pageURL?: string;
  articleVersion?: string;
}
type NativeResolver = string | Resolver | (() => Promise<Resolver[]>);
interface NativeAttachments {
  getFileResolvers?: (item: Zotero.Item, methods: string[]) => NativeResolver[];
  getPDFResolvers?: (item: Zotero.Item, methods: string[]) => NativeResolver[];
}
export function nativeResolvers(item: Zotero.Item): NativeResolver[] {
  const api = Zotero.Attachments as unknown as NativeAttachments;
  const get = api.getFileResolvers ?? api.getPDFResolvers;
  // The OA method already uses Zotero's Unpaywall mirror. No duplicate Unpaywall request.
  const resolvers = get?.call(api, item, ["doi", "url", "oa"]) ?? [];
  if (!Array.isArray(resolvers))
    throw new LiteratureError(
      "unavailable",
      "Invalid native fulltext resolvers",
    );
  return resolvers;
}
export function resolverCandidates(
  resolver: string | Resolver,
): FulltextCandidate[] {
  const entry = typeof resolver === "string" ? { url: resolver } : resolver;
  if (!entry || typeof entry !== "object") return [];
  const version = literatureVersion(entry.articleVersion);
  return [
    ...(entry.url
      ? [
          {
            url: entry.url,
            kind: "pdf" as const,
            version,
            sourceUrl: entry.pageURL,
          },
        ]
      : []),
    ...(entry.pageURL
      ? [{ url: entry.pageURL, kind: "page" as const, version }]
      : []),
  ];
}

export async function boundedLiterature<T>(
  work: Promise<T>,
  signal: AbortSignal,
  ms = 20_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new LiteratureError("cancelled", "Cancelled"));
        timer = setTimeout(
          () =>
            reject(
              new LiteratureError(
                "network",
                "全文解析超时 / Fulltext resolution timed out",
              ),
            ),
          ms,
        );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export async function htmlDocument(
  bytes: Uint8Array,
  url: string,
): Promise<Document> {
  const BlobClass = Zotero.getMainWindow().Blob;
  return Zotero.Utilities.Internal.blobToHTMLDocument(
    new BlobClass([Uint8Array.from(bytes).buffer], { type: "text/html" }),
    url,
  );
}
/** Remove non-content before measuring a page; script bytes are not article text. */
export function visiblePageText(doc: Document) {
  const page = doc.cloneNode ? (doc.cloneNode(true) as Document) : doc;
  for (const element of page.querySelectorAll(
    "script, style, noscript, iframe, form, nav, [hidden], [aria-hidden='true']",
  ))
    element.remove();
  return (page.body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Only follow an actual, short-delay refresh target; never interpret inline JS. */
export function pageRefresh(doc: Document, base: string) {
  for (const meta of doc.querySelectorAll("meta[http-equiv]")) {
    if (meta.getAttribute("http-equiv")?.toLowerCase() !== "refresh") continue;
    const match = meta
      .getAttribute("content")
      ?.match(/^\s*(\d+(?:\.\d+)?)\s*;\s*url\s*=\s*(.*?)\s*$/i);
    if (!match || Number(match[1]) > 10) continue;
    try {
      return fulltextUrl(
        new URL(match[2].replace(/^['"]|['"]$/g, ""), base).href,
      );
    } catch {
      /* Ignore unsafe or malformed targets. */
    }
  }
  return undefined;
}

export function pageLinks(doc: Document, url: string) {
  const links: Array<{ url: string; text: string; kind: "pdf" | "page" }> = [];
  for (const element of doc.querySelectorAll(
    "meta[name='citation_pdf_url'], meta[name='DC.identifier'], link[type='application/pdf'], a[href]",
  )) {
    const raw = element.getAttribute("content") ?? element.getAttribute("href");
    if (!raw) continue;
    try {
      const resolved = fulltextUrl(new URL(raw, url).href);
      if (links.some((link) => link.url === resolved)) continue;
      const label = [
        element.textContent,
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("download"),
      ]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (ancillaryFile(resolved, label)) continue;
      links.push({
        url: resolved,
        text: (
          element.textContent ||
          element.getAttribute("title") ||
          element.getAttribute("name") ||
          ""
        )
          .trim()
          .slice(0, 240),
        kind:
          element.getAttribute("name") === "citation_pdf_url" ||
          element.getAttribute("type") === "application/pdf" ||
          /\.pdf(?:\?|$)/i.test(resolved) ||
          /\b(?:download|view|read|full[ -]?text)\s*(?:article\s*)?\(?PDF\b|^PDF$|下载\s*(?:全文|PDF)|全文\s*PDF/i.test(
            label,
          ) ||
          (element.hasAttribute?.("download") && /\bpdf\b/i.test(label))
            ? "pdf"
            : "page",
      });
    } catch {
      /* Ignore local, executable and malformed links. */
    }
  }
  return links
    .sort((a, b) => Number(b.kind === "pdf") - Number(a.kind === "pdf"))
    .slice(0, 60);
}
export function ancillaryFile(url: string, label = "") {
  return (
    /supp\d+\.pdf$/i.test(new URL(url).pathname) ||
    /(?:^|[/_-])(?:supp\d*|supplement(?:ary|al)?\d*|review[_-]?history|peer[_-]?review)(?:[._/-]|$)/i.test(
      new URL(url).pathname,
    ) ||
    /\b(?:supplement(?:ary|al) (?:material|information|data)|supporting information|peer review|review history)\b/i.test(
      label,
    )
  );
}
export async function translatedCandidates(
  doc: Document,
  url: string,
  signal: AbortSignal,
): Promise<FulltextCandidate[]> {
  const internal = Zotero.Utilities.Internal as unknown as {
    getFileFromDocument?: (
      doc: Document,
    ) => Promise<{ url?: string; mimeType?: string } | false>;
    getPDFFromDocument?: (doc: Document) => Promise<{ url?: string } | false>;
  };
  const get = internal.getFileFromDocument ?? internal.getPDFFromDocument;
  let translated: string | undefined;
  if (get) {
    try {
      const result = await boundedLiterature(get.call(internal, doc), signal);
      translated = result ? result.url : undefined;
    } catch (error) {
      if (signal.aborted) throw error;
      // A translator failure must not discard explicit citation/download links.
    }
  }
  const urls = [
    translated,
    ...pageLinks(doc, url)
      .filter((l) => l.kind === "pdf" && !ancillaryFile(l.url, l.text))
      .map((l) => l.url),
  ];
  const normalized = urls
    .filter((u): u is string => !!u)
    .flatMap((candidate) => {
      try {
        const resolved = fulltextUrl(new URL(candidate, url).href);
        return ancillaryFile(resolved) ? [] : [resolved];
      } catch {
        return [];
      }
    });
  return [...new Set(normalized)].slice(0, 6).map((candidate) => ({
    url: candidate,
    kind: "pdf",
    version: "unknown",
    sourceUrl: url,
  }));
}
