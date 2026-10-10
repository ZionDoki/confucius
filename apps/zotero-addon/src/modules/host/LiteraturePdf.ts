import type {
  LiteratureVerification,
  LiteratureVersion,
  LiteratureWork,
} from "@confucius/protocol";
import { LiteratureError, normalizeDoi } from "./OpenAlexClient";

export const MAX_PDF_BYTES = 100 * 1024 * 1024;
/** Explicit front-matter labels, not mentions of other versions in article prose. */
export function explicitPdfVersion(text: string): LiteratureVersion {
  const front = text.slice(0, 2000).split(/\babstract\b|\bintroduction\b/i)[0];
  if (
    /(?:^|\n)\s*(?:document\s+version\s*:?\s*)?(?:publisher['’]?s version|version of record|published version)\b/i.test(
      front,
    )
  )
    return "publishedVersion";
  if (
    /(?:^|\n)\s*(?:document\s+version\s*:?\s*)?(?:accepted (?:author )?manuscript|author accepted manuscript|accepted version)\b/i.test(
      front,
    )
  )
    return "acceptedVersion";
  if (
    /(?:^|\n)\s*(?:document\s+version\s*:?\s*)?(?:preprint|submitted version)\b/i.test(
      front,
    )
  )
    return "submittedVersion";
  return "unknown";
}
export function validPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 32 || bytes.length > MAX_PDF_BYTES) return false;
  const text = (part: Uint8Array) =>
    Array.from(part, (b) => String.fromCharCode(b)).join("");
  return (
    /^\s*%PDF-(?:1|2)\.[0-9]/.test(text(bytes.slice(0, 1024))) &&
    /%%EOF\s*$/.test(text(bytes.slice(-4096)))
  );
}
const words = (text: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const compact = (text: string) => words(text).join("");

/** Conservative identity evidence from the first page, never from references. */
export function verifyPdfIdentity(
  work: LiteratureWork,
  firstPage: string,
  version: LiteratureVersion = "unknown",
): LiteratureVerification {
  const page = firstPage.slice(0, 12_000);
  const bodyStart = page.search(
    /(?:^|\n)\s*(?:\d+[.]?\s+)?(?:abstract|introduction|references)\b|\babstract\s*:/i,
  );
  const front = page.slice(0, bodyStart >= 0 ? bodyStart : 4000);
  const frontLines = front.slice(0, 4000).split(/\r?\n/);
  if (
    /^\s*(?:peer[ -]?review (?:history|reports?|file)|review history|reviewer(?:s|['’]s)? (?:comments|reports?)|decision letter)\b/im.test(
      front,
    )
  )
    throw new LiteratureError(
      "identity_mismatch",
      "这是审稿材料，不是论文正文 / Peer-review material is not the article",
    );
  const supplementHeading = frontLines.some(
    (line, index) =>
      /^\s*(?:electronic\s+)?(?:supplement(?:ary|al)\s+(?:material|information|data|appendix)|supporting\s+information)(?:\s+(?:for|to)\b.*|\s*[:–-].*)?\s*$/i.test(
        line,
      ) &&
      !/^(?:is\b|are\b|can be\b|available\b|online\b|https?:)/i.test(
        frontLines[index + 1]?.trim() ?? "",
      ),
  );
  if (
    supplementHeading &&
    !/\bsupplement|supporting information/i.test(work.title)
  )
    throw new LiteratureError(
      "identity_mismatch",
      "这是补充材料，不是论文全文 / Supplementary material is not the article",
    );
  const title = compact(work.title);
  const titleMatched = title.length >= 6 && compact(front).includes(title);
  const frontWords = words(front);
  const nameText = ` ${frontWords.join(" ")} `;
  const authorMatched = work.authors.some((author) => {
    const parts = words(author);
    if (!parts.length) return false;
    if (
      (compact(author).length >= 6 ||
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Hangul}]/u.test(author)) &&
      nameText.includes(` ${parts.join(" ")} `)
    )
      return true;
    if (parts.length < 2 || (parts.at(-1)?.length ?? 0) < 3) return false;
    // Accept abbreviated given names, not merely a shared surname (e.g. two
    // different Smiths publishing papers with the same title).
    return frontWords.some((token, start) => {
      if (
        token !== parts[0] &&
        !(token.length === 1 && parts[0].startsWith(token))
      )
        return false;
      for (let end = start + 1; end <= start + parts.length + 1; end++) {
        if (frontWords[end] === parts.at(-1)) return true;
        if (
          !frontWords[end] ||
          (frontWords[end].length !== 1 &&
            !parts.slice(1, -1).includes(frontWords[end]))
        )
          break;
      }
      return false;
    });
  });
  const dois = [...front.matchAll(/\b10\.\d{4,9}\/[^\s<>"\p{Cc}]+/giu)]
    .map((match) => normalizeDoi(match[0].replace(/[.,;:]+$/, "")))
    .filter(Boolean);
  const targetDoi = normalizeDoi(work.doi);
  const doiMatched = !!targetDoi && dois.includes(targetDoi);
  if (targetDoi && dois.length && !doiMatched && version !== "submittedVersion")
    throw new LiteratureError(
      "identity_mismatch",
      "PDF 首页 DOI 与目标论文不符 / First-page DOI does not match the paper",
    );
  if (!titleMatched || (!doiMatched && !authorMatched))
    throw new LiteratureError(
      page.trim() ? "identity_mismatch" : "unverified_pdf",
      "无法核对 PDF 首页的标题与 DOI／作者，请人工核对 / Could not verify the first-page title and DOI or author; check the file manually",
    );
  return {
    method: doiMatched ? "doi_title" : "title_author",
    doiMatched,
    titleMatched,
    authorMatched,
  };
}

export async function verifyPdf(
  bytes: Uint8Array,
  work: LiteratureWork,
  version: LiteratureVersion = "unknown",
): Promise<LiteratureVerification & { detectedVersion?: LiteratureVersion }> {
  if (!validPdf(bytes))
    throw new LiteratureError(
      "invalid_pdf",
      "不是有效 PDF，或超过 100 MiB / Not a valid PDF, or exceeds 100 MiB",
    );
  const worker = Zotero.PDFWorker as {
    _enqueue<T>(work: () => Promise<T>, priority?: boolean): Promise<T>;
    _query<T>(
      action: string,
      data: Record<string, unknown>,
      transfer: ArrayBuffer[],
    ): Promise<T>;
  };
  const buffer = Uint8Array.from(bytes).buffer;
  let result: { totalPages?: number; text?: string };
  try {
    result = await worker._enqueue(
      () =>
        worker._query("pdf.getFulltext", { buf: buffer, maxPages: 1 }, [
          buffer,
        ]),
      false,
    );
  } catch {
    throw new LiteratureError(
      "invalid_pdf",
      "无法解析 PDF / Could not parse PDF",
    );
  }
  if (!(Number(result.totalPages) > 0))
    throw new LiteratureError(
      "invalid_pdf",
      "PDF 没有可读页面 / PDF has no readable pages",
    );
  const detectedVersion = explicitPdfVersion(result.text ?? "");
  return {
    ...verifyPdfIdentity(
      work,
      result.text ?? "",
      detectedVersion === "unknown" ? version : detectedVersion,
    ),
    ...(detectedVersion === "unknown" ? {} : { detectedVersion }),
  };
}
