import type { LiteratureWork, LockedItemContext } from "@confucius/protocol";
import type { LiteratureAcquirer } from "./LiteratureService";
import {
  LiteratureError,
  normalizeDoi,
  openAlexFailure,
  publicUrl,
} from "./OpenAlexClient";
import { ResourceLocks, runtimeIoPath, runtimePath } from "./RuntimeStorage";

export function validPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 32 || bytes.length > 100 * 1024 * 1024) return false;
  const text = (part: Uint8Array) =>
    Array.from(part, (b) => String.fromCharCode(b)).join("");
  return (
    /%PDF-1\.[0-9]|%PDF-2\.[0-9]/.test(text(bytes.slice(0, 1024))) &&
    /%%EOF/.test(text(bytes.slice(-4096)))
  );
}
/** Parse before importing: a forged PDF header or an HTML login page is not fulltext. */
async function readablePdf(bytes: Uint8Array): Promise<boolean> {
  if (!validPdf(bytes)) return false;
  const worker = Zotero.PDFWorker as {
    _enqueue<T>(work: () => Promise<T>, priority?: boolean): Promise<T>;
    _query<T>(
      action: string,
      data: Record<string, unknown>,
      transfer: ArrayBuffer[],
    ): Promise<T>;
  };
  const buffer = Uint8Array.from(bytes).buffer;
  try {
    const result = await worker._enqueue(
      () =>
        worker._query<{ totalPages?: number }>(
          "pdf.getFulltext",
          { buf: buffer, maxPages: 1 },
          [buffer],
        ),
      false,
    );
    return Number(result.totalPages) > 0;
  } catch {
    return false;
  }
}
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
  private async existing(work: LiteratureWork): Promise<string | undefined> {
    const parent = this.parent(work);
    for (const id of parent.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(id);
      if (!attachment || attachment.deleted || !attachment.isPDFAttachment())
        continue;
      const path = await attachment.getFilePathAsync();
      if (path && (await IOUtils.exists(runtimeIoPath(path)))) {
        const size = (await IOUtils.stat(runtimeIoPath(path))).size ?? Infinity;
        if (
          size <= 100 * 1024 * 1024 &&
          (await readablePdf(await IOUtils.read(runtimeIoPath(path))))
        )
          return attachment.key;
      }
    }
    return undefined;
  }
  async acquire(
    work: LiteratureWork,
    signal: AbortSignal,
    stage: (stage: "existing" | "open_access" | "cache") => Promise<void>,
  ) {
    await stage("existing");
    const existing = await this.existing(work);
    if (existing)
      return { attachmentKey: existing, stage: "existing" as const };
    const urls: Array<{ url: string; stage: "open_access" | "cache" }> =
      work.pdfUrls.map((url) => ({ url, stage: "open_access" as const }));
    if (work.cachedPdfUrl)
      urls.push({ url: work.cachedPdfUrl, stage: "cache" });
    let failure: LiteratureError = new LiteratureError(
      "unavailable",
      "没有可下载的全文链接，请从浏览器补齐 / No downloadable fulltext; use the browser",
    );
    for (const location of urls) {
      if (signal.aborted) throw new LiteratureError("cancelled", "Cancelled");
      const isCache = (location.stage as string) === "cache";
      await stage(isCache ? "cache" : "open_access");
      try {
        const bytes = await this.download(location.url, isCache, signal);
        if (signal.aborted) throw new LiteratureError("cancelled", "Cancelled");
        const dir = runtimePath("literature-downloads");
        await IOUtils.makeDirectory(runtimeIoPath(dir), {
          ignoreExisting: true,
          createAncestors: true,
        });
        const path = PathUtils.join(
          dir,
          `${work.id}_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`,
        );
        try {
          await IOUtils.write(runtimeIoPath(path), bytes);
          if (signal.aborted)
            throw new LiteratureError("cancelled", "Cancelled");
          const attachmentKey = await this.attach(work, path);
          return {
            attachmentKey,
            stage: isCache ? ("cache" as const) : ("open_access" as const),
          };
        } finally {
          await IOUtils.remove(runtimeIoPath(path), { ignoreAbsent: true });
        }
      } catch (error) {
        failure =
          error instanceof LiteratureError
            ? error
            : new LiteratureError(
                "network",
                "全文下载失败 / Fulltext download failed",
              );
      }
    }
    throw failure;
  }
  private async download(raw: string, cache: boolean, signal: AbortSignal) {
    const safe = publicUrl(raw);
    if (!safe) throw new LiteratureError("unavailable", "Invalid PDF URL");
    const url = new URL(safe);
    if (cache) {
      if (url.hostname !== "content.openalex.org" || url.protocol !== "https:")
        throw new LiteratureError(
          "unavailable",
          "Invalid OpenAlex content URL",
        );
      if (!this.key())
        throw new LiteratureError(
          "authentication",
          "OpenAlex 缓存全文需要 Key / OpenAlex cached fulltext requires a key",
        );
      url.searchParams.set("api_key", this.key());
    }
    let xhr: XMLHttpRequest | undefined;
    const cancel = () => xhr?.abort();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await Zotero.HTTP.request("GET", url.href, {
        responseType: "arraybuffer",
        timeout: 60_000,
        successCodes: false,
        requestObserver: (request: XMLHttpRequest) => {
          xhr = request;
          request.onprogress = (e) => {
            if ((e as ProgressEvent).loaded > 100 * 1024 * 1024)
              request.abort();
          };
          if (signal.aborted) cancel();
        },
      });
      if (cache) {
        const failure = openAlexFailure(result.status);
        if (failure) throw failure;
      }
      if (result.status < 200 || result.status >= 300)
        throw new LiteratureError(
          result.status === 401 || result.status === 403
            ? "authentication"
            : "network",
          `全文 HTTP ${result.status}`,
        );
      const bytes = new Uint8Array(result.response as ArrayBuffer);
      if (!validPdf(bytes))
        throw new LiteratureError(
          "invalid_pdf",
          "链接返回的不是有效 PDF，可能需要浏览器登录 / Response is not a valid PDF; browser sign-in may be needed",
        );
      return bytes;
    } catch (error) {
      if (error instanceof LiteratureError) throw error;
      throw new LiteratureError(
        signal.aborted ? "cancelled" : "network",
        "全文下载中断或网络错误 / Fulltext download interrupted or network failure",
      );
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  async attach(work: LiteratureWork, path: string): Promise<string> {
    return locks.run(
      [
        `attachment:${work.acquisition.item?.libraryID}:${work.acquisition.item?.key}`,
      ],
      async () => {
        const existing = await this.existing(work);
        if (existing) return existing;
        const stat = await IOUtils.stat(runtimeIoPath(path));
        if ((stat.size ?? Infinity) > 100 * 1024 * 1024)
          throw new LiteratureError("invalid_pdf", "PDF exceeds 100 MiB");
        const bytes = await IOUtils.read(runtimeIoPath(path));
        if (!(await readablePdf(bytes)))
          throw new LiteratureError(
            "invalid_pdf",
            "请拖入有效 PDF（不超过 100 MiB） / Drop a valid PDF up to 100 MiB",
          );
        // Import exactly the validated bytes. The user's source file can change
        // while parsing, and must never be moved or rewritten by this operation.
        const directory = runtimePath("literature-downloads");
        await IOUtils.makeDirectory(runtimeIoPath(directory), {
          ignoreExisting: true,
          createAncestors: true,
        });
        const validated = PathUtils.join(
          directory,
          `verified_${work.id}_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`,
        );
        try {
          await IOUtils.write(runtimeIoPath(validated), bytes);
          const attachment = await Zotero.Attachments.importFromFile({
            file: Zotero.File.pathToFile(validated),
            parentItemID: this.parent(work).id,
          });
          return attachment.key;
        } finally {
          await IOUtils.remove(runtimeIoPath(validated), {
            ignoreAbsent: true,
          });
        }
      },
    );
  }
}
