import type {
  LiteratureWork,
  LockedItemContext,
  LiteratureAcquisitionResult,
  LiteratureAcquisitionStage,
  LiteratureAttempt,
  LiteratureVersion,
} from "@confucius/protocol";
import type { LiteratureAcquirer } from "./LiteratureService";
import { LiteratureError, normalizeDoi, publicUrl } from "./OpenAlexClient";
import { ResourceLocks, runtimeIoPath, runtimePath } from "./RuntimeStorage";
import { MAX_PDF_BYTES, validPdf, verifyPdf } from "./LiteraturePdf";
import { fulltextUrl } from "./LiteratureNetwork";
import {
  boundedLiterature,
  htmlDocument,
  nativeResolvers,
  resolverCandidates,
  translatedCandidates,
  ancillaryFile,
  pageRefresh,
  type FulltextCandidate,
} from "./LiteratureResolvers";
import { createAbortController } from "../../utils/webPlatform";
import {
  LiteratureBrowser,
  browserFulltextAvailable,
  type FulltextTransfer,
} from "./LiteratureBrowser";
import { repositoryCandidates } from "./LiteratureRepositories";
export { validPdf } from "./LiteraturePdf";

const itemRef = (item: Zotero.Item): LockedItemContext => ({
  id: `item:${item.libraryID}:${item.key}`,
  libraryID: item.libraryID,
  key: item.key,
  title: String(item.getField("title")),
  source: "library",
});
const locks = new ResourceLocks();
export class ZoteroLiteratureAcquirer implements LiteratureAcquirer {
  constructor(private readonly key: () => string) {}
  private async findItem(work: LiteratureWork, needsAbstract = false) {
    const libraryID = Zotero.Libraries.userLibraryID;
    for (const [field, value] of [
      ...work.openAlexIds.map((id) => ["extra", `OpenAlex: ${id}`]),
      ...(work.doi ? [["DOI", work.doi]] : []),
    ]) {
      const search = new Zotero.Search();
      search.addCondition("libraryID", "is", String(libraryID));
      search.addCondition(field, "contains", value);
      for (const id of await search.search()) {
        const existing = await Zotero.Items.getAsync(id);
        if (
          existing &&
          !existing.deleted &&
          existing.isRegularItem() &&
          (!needsAbstract ||
            String(existing.getField("abstractNote") || "").trim()) &&
          ((field === "extra" &&
            String(existing.getField("extra"))
              .split(/\r?\n/)
              .some((line) => line.trim() === value)) ||
            (field === "DOI" &&
              normalizeDoi(existing.getField("DOI")) === work.doi))
        )
          return existing;
      }
    }
    return undefined;
  }
  async abstract(work: LiteratureWork): Promise<string | undefined> {
    const ref = work.acquisition.item;
    const bound =
      ref && Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.key);
    const value =
      bound &&
      !bound.deleted &&
      String(bound.getField("abstractNote") || "").trim();
    if (value) return value;
    const item = await this.findItem(work, true);
    return item
      ? String(item.getField("abstractNote") || "").trim() || undefined
      : undefined;
  }
  async ensureItem(work: LiteratureWork): Promise<LockedItemContext> {
    return locks.run([`paper:${work.doi ?? work.id}`], async () => {
      const libraryID = Zotero.Libraries.userLibraryID;
      const existing = await this.findItem(work);
      if (existing) return itemRef(existing);
      const item = new Zotero.Item("journalArticle");
      item.libraryID = libraryID;
      item.setField("title", work.title);
      if (work.doi) item.setField("DOI", work.doi);
      if (work.year) item.setField("date", String(work.year));
      if (work.venue) item.setField("publicationTitle", work.venue);
      if (work.abstract) item.setField("abstractNote", work.abstract);
      if (work.landingUrl) item.setField("url", work.landingUrl);
      item.setField("extra", `OpenAlex: ${work.id}`);
      item.setCreators(
        work.authors.map((name) => ({
          name,
          creatorType: "author",
          fieldMode: 1,
        })),
      );
      await item.saveTx();
      return itemRef(item);
    });
  }
  private parent(work: LiteratureWork) {
    const ref = work.acquisition.item;
    const item = ref && Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.key);
    if (!item || item.deleted)
      throw new LiteratureError(
        "unavailable",
        "已保存条目不存在 / Saved item is unavailable",
      );
    return item;
  }
  private async existing(
    work: LiteratureWork,
    signal?: AbortSignal,
  ): Promise<LiteratureAcquisitionResult | undefined> {
    for (const id of this.parent(work).getAttachments()) {
      if (signal?.aborted) throw new LiteratureError("cancelled", "Cancelled");
      const attachment = await Zotero.Items.getAsync(id);
      if (!attachment || attachment.deleted || !attachment.isPDFAttachment())
        continue;
      const path = await attachment.getFilePathAsync();
      if (!path || !(await IOUtils.exists(runtimeIoPath(path)))) continue;
      try {
        const bytes = await this.readBytes(path);
        const version =
          work.acquisition.attachmentKey === attachment.key
            ? (work.acquisition.version ?? "unknown")
            : "unknown";
        const { detectedVersion, ...verification } = await boundedLiterature(
          verifyPdf(bytes, work, version),
          signal ?? createAbortController().signal,
        );
        return {
          attachmentKey: attachment.key,
          stage: "existing",
          version: detectedVersion ?? version,
          sourceUrl: publicUrl(attachment.getField("url")),
          verification,
        };
      } catch {
        /* Preserve existing files, but never count a mismatched attachment as fulltext. */
      }
    }
    return undefined;
  }
  private async readBytes(path: string) {
    if (
      ((await IOUtils.stat(runtimeIoPath(path))).size ?? Infinity) >
      MAX_PDF_BYTES
    )
      throw new LiteratureError("invalid_pdf", "PDF exceeds 100 MiB");
    return IOUtils.read(runtimeIoPath(path));
  }
  async acquire(
    work: LiteratureWork,
    signal: AbortSignal,
    stage: (stage: LiteratureAcquisitionStage) => Promise<void>,
    candidate?: FulltextCandidate,
    transfer?: FulltextTransfer,
  ): Promise<LiteratureAcquisitionResult> {
    const controller = createAbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 180_000);
    const browser = transfer?.browser ?? new LiteratureBrowser();
    try {
      return await this.acquireWithinDeadline(
        work,
        controller.signal,
        stage,
        candidate,
        browser,
        transfer?.prepared,
      );
    } catch (error) {
      if (!signal.aborted && controller.signal.aborted)
        throw new LiteratureError(
          "network",
          "全文获取达到时限，可重试或补充检索 / Fulltext deadline reached; retry or search for another source",
          error instanceof LiteratureError ? error.attempts : undefined,
        );
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (!transfer) browser.dispose();
    }
  }
  private async acquireWithinDeadline(
    work: LiteratureWork,
    signal: AbortSignal,
    stage: (stage: LiteratureAcquisitionStage) => Promise<void>,
    onlyCandidate?: FulltextCandidate,
    browser = new LiteratureBrowser(),
    prepared?: FulltextTransfer["prepared"],
  ): Promise<LiteratureAcquisitionResult> {
    if (signal.aborted) throw new LiteratureError("cancelled", "Cancelled");
    await stage("existing");
    const existing = await this.existing(work, signal);
    if (existing) return existing;
    const attempts: LiteratureAttempt[] = [];
    const tried = new Set<string>();
    const browserQueue = new Map<string, FulltextCandidate>();
    // Retry is explicit; within a run, including redirects and translator results,
    // one failed URL is never fetched again.
    let failure = new LiteratureError(
      "unavailable",
      "未发现可验证的全文，可补充检索或从浏览器获取 / No verified fulltext found; search for another source or use the browser",
    );
    const tryCandidate = async (
      candidate: FulltextCandidate,
      current: LiteratureAcquisitionStage,
      useBrowser = false,
    ): Promise<LiteratureAcquisitionResult | undefined> => {
      if (signal.aborted)
        throw new LiteratureError("cancelled", "Cancelled", attempts);
      let url: string | undefined;
      try {
        url = fulltextUrl(candidate.url);
        if (ancillaryFile(url))
          throw new LiteratureError(
            "identity_mismatch",
            "附件是补充材料或审稿历史 / Supplement or peer-review attachment",
          );
        const attemptKey = useBrowser ? `browser:${url}` : url;
        if (tried.has(attemptKey) || attempts.length >= 45) return undefined;
        if (useBrowser) tried.add(attemptKey);
        await stage(current);
        const attempt: LiteratureAttempt = {
          stage: current,
          method: useBrowser ? "browser" : "http",
          url,
          at: Date.now(),
        };
        attempts.push(attempt);
        try {
          let cacheKey: string | undefined;
          if (current === "cache") {
            const parsed = new URL(url);
            if (
              parsed.origin !== "https://content.openalex.org" ||
              !work.openAlexIds.some(
                (id) => parsed.pathname === `/works/${id}.pdf`,
              )
            )
              throw new LiteratureError(
                "unsafe_url",
                "Invalid OpenAlex content URL",
              );
            cacheKey = this.key();
            if (!cacheKey)
              throw new LiteratureError(
                "authentication",
                "OpenAlex 缓存全文需要 Key / OpenAlex cached fulltext requires a key",
              );
          }
          const response =
            prepared && candidate === onlyCandidate
              ? prepared
              : useBrowser
                ? await browser.read(url, signal)
                : await browser.request(url, signal, {
                    cacheKey,
                    maxHtmlBytes: 5 * 1024 * 1024,
                    beforeRequest: (next) => {
                      if (tried.has(next))
                        throw new LiteratureError(
                          "unavailable",
                          "This fulltext URL was already tried",
                        );
                      tried.add(next);
                    },
                  });
          if (response === prepared) {
            prepared = undefined;
            tried.add(url);
          }
          if (validPdf(response.bytes)) {
            const result = await this.importBytes(
              work,
              response.bytes,
              signal,
              {
                version: candidate.version,
                sourceUrl: current === "cache" ? url : response.url,
                discoveredFrom: publicUrl(candidate.sourceUrl),
                stage: current,
              },
            );
            return { ...result, attempts };
          }
          if (/html/i.test(response.contentType) || candidate.kind === "page") {
            if (response.bytes.length > 5 * 1024 * 1024)
              throw new LiteratureError(
                "unavailable",
                "Fulltext page exceeds 5 MiB",
              );
            const doc = await htmlDocument(response.bytes, response.url);
            const refresh = pageRefresh(doc, response.url);
            if (refresh) {
              const redirected = await tryCandidate(
                { ...candidate, url: refresh, sourceUrl: response.url },
                current,
                useBrowser,
              );
              if (redirected) return redirected;
            }
            const candidates = await translatedCandidates(
              doc,
              response.url,
              signal,
            );
            for (const next of candidates) {
              const result = await tryCandidate(
                // A page's version label does not identify every linked file.
                {
                  ...next,
                  version:
                    work.locations?.find(
                      (location) => location.pdfUrl === next.url,
                    )?.version ?? next.version,
                },
                current,
                useBrowser,
              );
              if (result) return result;
            }
            throw new LiteratureError(
              doc.querySelector('input[type="password"]')
                ? "authentication"
                : "unavailable",
              "页面未提供可验证的 PDF，可能需要登录 / No verified PDF on this page; sign-in may be needed",
            );
          }
          throw new LiteratureError(
            "invalid_pdf",
            "链接没有返回有效 PDF / Link did not return a valid PDF",
          );
        } catch (error) {
          attempt.error =
            error instanceof LiteratureError ? error.code : "network";
          if (
            !useBrowser &&
            current !== "cache" &&
            [
              "network",
              "authentication",
              "unavailable",
              "invalid_pdf",
            ].includes(attempt.error)
          )
            browserQueue.set(url, candidate);
          throw error;
        }
      } catch (error) {
        if (signal.aborted)
          throw new LiteratureError("cancelled", "Cancelled", attempts);
        const next =
          error instanceof LiteratureError
            ? error
            : new LiteratureError(
                "network",
                "全文获取失败 / Fulltext acquisition failed",
              );
        if (!url)
          attempts.push({ stage: current, error: next.code, at: Date.now() });
        // Preserve actionable errors instead of replacing e.g. rate limits with a later 404.
        const rank = (code: string) =>
          [
            "unavailable",
            "network",
            "invalid_pdf",
            "unverified_pdf",
            "identity_mismatch",
            "unsafe_url",
            "authentication",
            "quota",
            "rate_limit",
          ].indexOf(code);
        if (rank(next.code) >= rank(failure.code)) failure = next;
        return undefined;
      }
    };
    const tryBrowsers = async (current: LiteratureAcquisitionStage) => {
      if (!browserFulltextAvailable()) return undefined;
      // Spend the bounded browser budget on actual files and repositories before
      // DOI redirects or index records, which can otherwise starve later sources.
      const priority = (candidate: FulltextCandidate) => {
        const url = new URL(candidate.url);
        if (url.hostname === "pmc.ncbi.nlm.nih.gov") return 50;
        if (candidate.kind === "pdf") return 40;
        if (
          work.locations?.some(
            (location) =>
              location.openAccess &&
              [location.pdfUrl, location.landingUrl].includes(candidate.url),
          )
        )
          return 30;
        if (/^(?:repository|biblio)\./i.test(url.hostname)) return 20;
        if (/\/(?:handle|bitstream)\//i.test(url.pathname)) return 10;
        return 0;
      };
      const queued = [...browserQueue.values()].sort(
        (a, b) => priority(b) - priority(a),
      );
      for (const candidate of queued.slice(0, 3)) {
        const result = await tryCandidate(candidate, current, true);
        if (result) return result;
      }
      return undefined;
    };
    if (onlyCandidate) {
      const result = await tryCandidate(onlyCandidate, "agent");
      if (result) return result;
      const rendered = await tryBrowsers("agent");
      if (rendered) return rendered;
      throw new LiteratureError(failure.code, failure.message, attempts);
    }
    for (const url of work.pdfUrls) {
      const location = work.locations?.find((l) => l.pdfUrl === url);
      const result = await tryCandidate(
        { url, kind: "pdf", version: location?.version ?? "unknown" },
        "open_access",
      );
      if (result) return result;
    }
    if (work.cachedPdfUrl) {
      const result = await tryCandidate(
        { url: work.cachedPdfUrl, kind: "pdf", version: "unknown" },
        "cache",
      );
      if (result) return result;
    }
    const locations = work.locations ?? [];
    for (const location of locations) {
      for (const candidate of resolverCandidates({
        url: location.pdfUrl,
        pageURL: location.landingUrl,
        articleVersion: location.version,
      })) {
        const result = await tryCandidate(candidate, "zotero");
        if (result) return result;
      }
    }
    let resolvers: ReturnType<typeof nativeResolvers> = [];
    try {
      resolvers = nativeResolvers(this.parent(work));
    } catch (error) {
      if (signal.aborted)
        throw new LiteratureError("cancelled", "Cancelled", attempts);
      attempts.push({
        stage: "zotero",
        error: error instanceof LiteratureError ? error.code : "network",
        at: Date.now(),
      });
    }
    for (const resolver of resolvers) {
      if (signal.aborted)
        throw new LiteratureError("cancelled", "Cancelled", attempts);
      try {
        const entries =
          typeof resolver === "function"
            ? await boundedLiterature(resolver(), signal)
            : [resolver];
        for (const entry of entries.slice(0, 12))
          for (const candidate of resolverCandidates(entry)) {
            const result = await tryCandidate(candidate, "zotero");
            if (result) return result;
          }
      } catch (error) {
        if (signal.aborted)
          throw new LiteratureError("cancelled", "Cancelled", attempts);
        attempts.push({
          stage: "zotero",
          error: error instanceof LiteratureError ? error.code : "network",
          at: Date.now(),
        });
      }
    }
    // Only query repository APIs when the source and native resolver stages failed.
    for (const candidate of await repositoryCandidates(
      work,
      signal,
      attempts,
    )) {
      const result = await tryCandidate(candidate, "zotero");
      if (result) return result;
    }
    const rendered = await tryBrowsers("zotero");
    if (rendered) return rendered;
    throw new LiteratureError(failure.code, failure.message, attempts);
  }
  async acquireCandidate(
    work: LiteratureWork,
    candidate: FulltextCandidate,
    signal: AbortSignal,
    transfer?: FulltextTransfer,
  ) {
    return this.acquire(work, signal, async () => {}, candidate, transfer);
  }
  private async importBytes(
    work: LiteratureWork,
    bytes: Uint8Array,
    signal: AbortSignal,
    provenance: {
      version: LiteratureVersion;
      sourceUrl?: string;
      discoveredFrom?: string;
      stage: LiteratureAcquisitionStage;
    },
  ): Promise<LiteratureAcquisitionResult> {
    const { detectedVersion, ...verification } = await boundedLiterature(
      verifyPdf(bytes, work, provenance.version),
      signal,
    );
    if (detectedVersion)
      provenance = { ...provenance, version: detectedVersion };
    return locks.run(
      [
        `attachment:${work.acquisition.item?.libraryID}:${work.acquisition.item?.key}`,
      ],
      async () => {
        if (signal.aborted) throw new LiteratureError("cancelled", "Cancelled");
        const existing = await this.existing(work, signal);
        if (existing) return existing;
        const directory = runtimePath("literature-downloads");
        await IOUtils.makeDirectory(runtimeIoPath(directory), {
          ignoreExisting: true,
          createAncestors: true,
        });
        const path = PathUtils.join(
          directory,
          `verified_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`,
        );
        try {
          await IOUtils.write(runtimeIoPath(path), bytes);
          if (signal.aborted)
            throw new LiteratureError("cancelled", "Cancelled");
          const title =
            provenance.version === "acceptedVersion"
              ? "Accepted manuscript"
              : provenance.version === "submittedVersion"
                ? "Preprint"
                : provenance.version === "publishedVersion"
                  ? "Published version"
                  : "Full text (version unknown)";
          const attachment = await Zotero.Attachments.importFromFile({
            file: Zotero.File.pathToFile(path),
            parentItemID: this.parent(work).id,
            title,
          });
          // The imported item is already durable. Return its receipt even if cancelled now.
          if (provenance.sourceUrl) {
            try {
              attachment.setField("url", provenance.sourceUrl);
              await attachment.saveTx();
            } catch {
              /* Provenance is also retained in the durable acquisition receipt. */
            }
          }
          return { attachmentKey: attachment.key, ...provenance, verification };
        } finally {
          try {
            await IOUtils.remove(runtimeIoPath(path), { ignoreAbsent: true });
          } catch {
            /* Cleanup cannot invalidate an already committed attachment receipt. */
          }
        }
      },
    );
  }
  async attach(work: LiteratureWork, path: string): Promise<string> {
    return (await this.attachVerified(work, path)).attachmentKey;
  }
  async attachVerified(
    work: LiteratureWork,
    path: string,
  ): Promise<LiteratureAcquisitionResult> {
    return this.importBytes(
      work,
      await this.readBytes(path),
      createAbortController().signal,
      { stage: "browser", version: "unknown" },
    );
  }
}
