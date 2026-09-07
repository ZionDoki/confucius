import {
  AnnotationOwnership,
  type AnnotationOwnerContext,
} from "./AnnotationOwnership";
import {
  annotationMatchesFilter,
  type AnnotationBatchFilter,
  type AnnotationBatchView,
} from "@confucius/protocol";
import { deadline, ToolProgress, ToolTimeout } from "./Deadline";
import { literalMatches, regexMatches } from "./RegexWorker";
import { validateArgs, validateValue } from "@confucius/harness";
import {
  TOOL_DEFINITIONS,
  TOOL_META,
  annotationSchema,
} from "@confucius/zotero-tools";
import {
  ResourceLocks,
  runtimeDigest,
  runtimeJsonStorage,
  type JsonStorage,
} from "../host/RuntimeStorage";
import { canonical, type OperationRecord } from "../host/ReliableToolProvider";
import type { OperationRepository } from "../host/OperationStore";
import { annotationExplanationIssue } from "./AnnotationQuality";
import { layoutQuoteVariants } from "./PdfQuote";
import { spatialPageText } from "./PdfLayout";
import {
  anchorPage,
  charText,
  normalizeAnchor,
  pdfPassages,
  renderPdfPassages,
  resolvePassage,
  type PdfPageChar,
  type PdfPassage,
} from "./PdfAnchors";
import type { ToolExecutionContext, ToolFailure } from "@confucius/protocol";
import type {
  AnnotationDraft,
  AnnotationType,
  ToolErrorCode,
  ToolResult,
  ToolTransientMedia,
} from "@confucius/protocol";
import {
  DEFAULT_ANNOTATION_COLORS,
  buildOpenPdfUri,
  buildSelectUri,
} from "@confucius/protocol";
import type {
  LiveContextReader,
  LiveContextSelection,
} from "@confucius/protocol";
import {
  findSection,
  parseSections,
  requireItemRef,
} from "@confucius/zotero-tools";
import {
  normalizePdfMatchPositions,
  normalizeRegionRect,
  normalizedRegionToPdfPosition,
  pdfRectToNormalizedRegion,
  type PdfPosition,
  type PdfViewportLike,
} from "./pdfPosition";

const MAX_NOTE = 20_000;

function ok(
  toolName: string,
  data: unknown,
  transientMedia?: ToolTransientMedia[],
): ToolResult {
  return { ok: true, toolName, data, transientMedia };
}

function fail(
  toolName: string,
  code: ToolErrorCode,
  message: string,
  details?: unknown,
): ToolFailure {
  return { ok: false, toolName, code, message, details };
}

function asItem(value: unknown): Zotero.Item | null {
  if (!value || value === false || Array.isArray(value)) {
    return null;
  }
  return value as Zotero.Item;
}

function defaultLibraryID(args: Record<string, unknown>): number {
  if (typeof args.libraryID === "number" && Number.isInteger(args.libraryID)) {
    return args.libraryID;
  }
  return Zotero.Libraries.userLibraryID;
}

function getItem(libraryID: number, key: string): Zotero.Item | null {
  return asItem(Zotero.Items.getByLibraryAndKey(libraryID, key));
}

export function groupIDForLibrary(libraryID: number): number | undefined {
  if (libraryID === Zotero.Libraries.userLibraryID) {
    return undefined;
  }
  const groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
  return groupID || undefined;
}

function summarizeItem(item: Zotero.Item) {
  const creators = item.getCreators?.() || [];
  const authors = creators
    .map((creator) =>
      creator.lastName
        ? `${creator.lastName}${creator.firstName ? `, ${creator.firstName}` : ""}`
        : (creator as { name?: string }).name || "",
    )
    .filter(Boolean);
  return {
    libraryID: item.libraryID,
    key: item.key,
    itemType: item.itemType,
    title: item.getDisplayTitle?.() || item.getField?.("title") || "",
    creators: authors,
    year: item.getField?.("year") || "",
    doi: item.getField?.("DOI") || "",
    zoteroUri: buildSelectUri(item.key, groupIDForLibrary(item.libraryID)),
  };
}

interface CslCreator {
  family?: string;
  given?: string;
  literal?: string;
}

interface CslMetadata {
  type?: string;
  title?: string;
  author?: CslCreator[];
  issued?: { "date-parts"?: Array<Array<number | string>> };
  "container-title"?: string;
  volume?: string | number;
  issue?: string | number;
  page?: string | number;
  DOI?: string;
  URL?: string;
  publisher?: string;
  abstract?: string;
}

function doiFromIdentifier(identifier: string): string | null {
  const match = identifier.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
  return match ? match[0].replace(/[.,;]+$/, "") : null;
}

function cslItemType(type: string | undefined): string {
  switch (String(type || "").toLowerCase()) {
    case "book":
      return "book";
    case "chapter":
      return "bookSection";
    case "paper-conference":
      return "conferencePaper";
    case "thesis":
      return "thesis";
    default:
      return "journalArticle";
  }
}

function setItemField(item: Zotero.Item, field: string, value: unknown): void {
  const text = String(value ?? "").trim();
  if (!text) return;
  try {
    item.setField(field, text);
  } catch {
    // CSL contains fields that are not valid for every Zotero item type.
  }
}

async function importDoiFromCsl(
  doi: string,
  libraryID: number,
  collections: number[],
): Promise<Zotero.Item> {
  const xhr = await Zotero.HTTP.request(
    "GET",
    `https://doi.org/${encodeURI(doi)}`,
    {
      headers: { Accept: "application/vnd.citationstyles.csl+json" },
      timeout: 30_000,
    },
  );
  const metadata = JSON.parse(xhr.responseText || "") as CslMetadata;
  if (!String(metadata.title ?? "").trim()) {
    throw new Error("DOI metadata did not include a title");
  }
  const item = new Zotero.Item(cslItemType(metadata.type) as never);
  (item as unknown as { libraryID: number }).libraryID = libraryID;
  setItemField(item, "title", metadata.title);
  setItemField(item, "publicationTitle", metadata["container-title"]);
  setItemField(item, "volume", metadata.volume);
  setItemField(item, "issue", metadata.issue);
  setItemField(item, "pages", metadata.page);
  setItemField(item, "DOI", metadata.DOI || doi);
  setItemField(item, "url", metadata.URL || `https://doi.org/${doi}`);
  setItemField(item, "publisher", metadata.publisher);
  setItemField(item, "abstractNote", metadata.abstract);
  const dateParts = metadata.issued?.["date-parts"]?.[0] ?? [];
  setItemField(item, "date", dateParts.filter(Boolean).join("-"));
  const creators: _ZoteroTypes.Item.CreatorJSON[] = [];
  for (const creator of metadata.author ?? []) {
    const literal = String(creator.literal ?? "").trim();
    const firstName = String(creator.given ?? "").trim();
    const lastName = String(creator.family ?? "").trim();
    if (literal) creators.push({ creatorType: "author", name: literal });
    else if (firstName || lastName) {
      creators.push({ creatorType: "author", firstName, lastName });
    }
  }
  if (creators.length) item.setCreators(creators);
  if (collections.length) item.setCollections(collections);
  await item.saveTx();
  return item;
}

export async function findPdf(
  item: Zotero.Item,
  attachmentKey?: string,
): Promise<Zotero.Item | null> {
  if (
    item.isAttachment?.() &&
    item.attachmentContentType === "application/pdf"
  ) {
    if (attachmentKey && attachmentKey !== item.key)
      throw new Error(
        "Explicit attachment does not belong to the selected PDF",
      );
    return item;
  }
  if (item.isNote?.()) return null;
  const pdfs = (item.getAttachments?.() || [])
    .map((id) => asItem(Zotero.Items.get(id)))
    .filter(
      (entry): entry is Zotero.Item =>
        entry?.attachmentContentType === "application/pdf",
    );
  if (attachmentKey) {
    const selected = pdfs.find((pdf) => pdf.key === attachmentKey);
    if (!selected)
      throw new Error("Explicit PDF attachment not found under this item");
    return selected;
  }
  if (pdfs.length > 1)
    throw new Error(
      `Multiple PDF attachments; specify attachmentKey: ${pdfs.map((pdf) => pdf.key).join(", ")}`,
    );
  return pdfs[0] ?? null;
}

async function pdfText(
  item: Zotero.Item,
  attachmentKey?: string,
): Promise<string | null> {
  const pdf = await findPdf(item, attachmentKey);
  if (!pdf) {
    return null;
  }
  const text = await pdf.attachmentText;
  return text || null;
}

interface PdfFindController {
  find(state: {
    type: "find";
    query: string;
    phraseSearch: boolean;
    caseSensitive: boolean;
    entireWord: boolean;
    highlightAll: boolean;
    findPrevious: boolean;
  }): void | Promise<void>;
  getMatchPositionsAsync(pageIndex: number): Promise<unknown>;
  pageMatches?: Array<number[] | undefined>;
  _pageMatches?: Array<number[] | undefined>;
  _pendingFindMatches?: Set<number>;
  state?: { query?: string };
  _dirtyMatch?: boolean;
  _pdfDocument?: {
    getPageData?: (input: { pageIndex: number }) => Promise<{
      chars?: PdfPageChar[];
    }>;
  };
}

interface PdfPageProxy {
  getTextContent?(): Promise<{
    items: Array<{ str?: string; hasEOL?: boolean }>;
  }>;
  view?: number[];
  getViewport(input: { scale: number }): PdfViewportLike;
  render(input: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewportLike;
    canvas?: HTMLCanvasElement;
  }): { promise: Promise<void> };
}

interface PdfDocumentProxy {
  numPages?: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  getPageData?(input: { pageIndex: number }): Promise<{
    chars?: PdfPageChar[];
  }>;
}

interface PdfViewerProxy {
  getPageView?(pageIndex: number): { pdfPage?: PdfPageProxy } | undefined;
}

interface PdfViewerApplicationProxy {
  pdfDocument?: PdfDocumentProxy;
  pdfViewer?: PdfViewerProxy;
}

interface PdfSelectionAnnotation {
  text?: string;
  pageLabel?: string;
  sortIndex?: string;
  position?: PdfPosition;
}

interface PdfPrimaryView {
  initializedPromise?: Promise<void>;
  _findController?: PdfFindController;
  _iframeWindow?: Window & {
    PDFViewerApplication?: PdfViewerApplicationProxy;
  };
  _selectionRanges?: unknown[];
  _pdfPages?: Array<{ chars?: PdfPageChar[] } | undefined>;
  _getAnnotationFromSelectionRanges?: (
    ranges: unknown[],
    type: "highlight",
  ) => PdfSelectionAnnotation | null;
  _ensureBasicPageData?: (pageIndex: number) => Promise<void>;
  _pdfRenderer?: {
    renderRegionCrops?: (
      pageIndex: number,
      rects: number[][],
    ) => Promise<string[]>;
  };
  setFindState?: (state: {
    active: boolean;
    query: string;
    highlightAll: boolean;
    caseSensitive: boolean;
    entireWord: boolean;
  }) => void | Promise<void>;
  getAnnotationMeta?: (position: PdfPosition) => {
    sortIndex?: string;
    pageLabel?: string;
  };
  _getPageLabel?: (pageIndex: number, usePhysical?: boolean) => string;
}

interface PdfReaderInstance {
  itemID?: number;
  _isTabClosed?: boolean;
  _instanceID: string;
  _initPromise?: Promise<unknown>;
  _waitForReader?: () => Promise<void>;
  _internalReader?: { _primaryView?: PdfPrimaryView };
  setAnnotations: (items: Zotero.Item[]) => Promise<void>;
  unsetAnnotations?: (keys: string[]) => Promise<void>;
  navigate?: (location: Record<string, unknown>) => void | Promise<void>;
}

function waiveReaderXrays<T>(value: T): T {
  if (!value) return value;
  try {
    return Components.utils.waiveXrays(value);
  } catch {
    return value;
  }
}

function readerPdfApplication(
  view: PdfPrimaryView,
): PdfViewerApplicationProxy | undefined {
  return waiveReaderXrays(view._iframeWindow?.PDFViewerApplication) as
    PdfViewerApplicationProxy | undefined;
}

function readerPdfDocument(view: PdfPrimaryView): PdfDocumentProxy | undefined {
  return waiveReaderXrays(readerPdfApplication(view)?.pdfDocument);
}

function isPdfPageProxy(value: unknown): value is PdfPageProxy {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { getViewport?: unknown }).getViewport === "function",
  );
}

async function readerPdfPage(
  view: PdfPrimaryView,
  pageNumber: number,
): Promise<PdfPageProxy> {
  const application = readerPdfApplication(view);
  const viewer = waiveReaderXrays(application?.pdfViewer);
  const cachedView = waiveReaderXrays(viewer?.getPageView?.(pageNumber - 1));
  const cachedPage = waiveReaderXrays(cachedView?.pdfPage);
  if (isPdfPageProxy(cachedPage)) return cachedPage;

  const document = readerPdfDocument(view);
  if (!document) throw new Error("PDF document is not available in Reader");
  const loadedPage = waiveReaderXrays(await document.getPage(pageNumber));
  if (isPdfPageProxy(loadedPage)) return loadedPage;

  // Zotero can initialize the visible PDFPageView while getPage() crosses a
  // compartment boundary. Check that canonical page object once more.
  const refreshedView = waiveReaderXrays(viewer?.getPageView?.(pageNumber - 1));
  const refreshedPage = waiveReaderXrays(refreshedView?.pdfPage);
  if (isPdfPageProxy(refreshedPage)) return refreshedPage;
  throw new Error(`PDF page ${pageNumber} does not expose a PDF.js viewport`);
}

function readerPageViewport(
  view: PdfPrimaryView,
  page: PdfPageProxy,
  scale: number,
): PdfViewportLike {
  const input = view._iframeWindow
    ? Components.utils.cloneInto({ scale }, view._iframeWindow)
    : { scale };
  return waiveReaderXrays(page.getViewport(input));
}

/**
 * Build a Reader.open location from tool args. The reader resolves
 * annotationID to the stored annotation position, pageIndex to a page scroll.
 */
function readerLocation(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const annotationKey =
    typeof args.annotationKey === "string" ? args.annotationKey.trim() : "";
  if (annotationKey) {
    return { annotationID: annotationKey };
  }
  if (
    typeof args.pageIndex === "number" &&
    Number.isInteger(args.pageIndex) &&
    args.pageIndex >= 0
  ) {
    return { pageIndex: args.pageIndex };
  }
  return undefined;
}

/**
 * Snapshot of what the user is looking at right now: the open reader plus the
 * current text selection. Shared by the live-context spine and the
 * get_pdf_selection tool so both stay in lockstep.
 */
export function liveReaderContext(): {
  reader: LiveContextReader | null;
  selection: LiveContextSelection | null;
} {
  try {
    const reader = Zotero.Reader.getByTabID?.(
      Zotero.getMainWindow()?.Zotero_Tabs?.selectedID,
    ) as unknown as PdfReaderInstance | undefined;
    if (!reader || reader._isTabClosed) {
      return { reader: null, selection: null };
    }
    const attachment = reader.itemID
      ? asItem(Zotero.Items.get(reader.itemID))
      : null;
    if (!attachment) {
      return { reader: null, selection: null };
    }
    const view = reader._internalReader?._primaryView;
    const currentPage = (
      view?._iframeWindow?.PDFViewerApplication as
        { pdfViewer?: { currentPageNumber?: number } } | undefined
    )?.pdfViewer?.currentPageNumber;
    const pageIndex = typeof currentPage === "number" ? currentPage - 1 : null;
    const pageLabel =
      (pageIndex === null ? undefined : view?._getPageLabel?.(pageIndex)) ??
      null;
    const parent = attachment.parentItemID
      ? asItem(Zotero.Items.get(attachment.parentItemID))
      : null;
    const readerInfo: LiveContextReader = {
      libraryID: attachment.libraryID,
      attachmentKey: attachment.key,
      parentKey: parent ? parent.key : null,
      title: String(
        parent?.getDisplayTitle?.() || attachment.getDisplayTitle?.() || "",
      ),
      pageLabel,
      pageIndex,
    };
    let selection: LiveContextSelection | null = null;
    const ranges = view?._selectionRanges || [];
    if (ranges.length) {
      const selected = view?._getAnnotationFromSelectionRanges?.(
        ranges,
        "highlight",
      );
      const fallbackText = ranges
        .map((range) =>
          range && typeof range === "object"
            ? String((range as { text?: unknown }).text ?? "")
            : "",
        )
        .filter(Boolean)
        .join(" ");
      const text = (selected?.text || fallbackText).trim();
      if (text) {
        const position = selected?.position;
        const selPage = position ? position.pageIndex : pageIndex;
        selection = {
          text,
          preview: text.slice(0, 60),
          pageLabel:
            selected?.pageLabel ||
            (selPage === null || selPage === undefined
              ? null
              : (view?._getPageLabel?.(selPage) ?? null)),
          pageIndex: selPage ?? null,
        };
      }
    }
    return { reader: readerInfo, selection };
  } catch {
    return { reader: null, selection: null };
  }
}

interface LocatedTextAnnotation {
  type: "highlight" | "underline";
  text: string;
  comment: string;
  color: string;
  position: PdfPosition;
  sortIndex: string;
  pageLabel: string;
}

type PendingTextAnnotation = Omit<
  Extract<AnnotationDraft, { type: "highlight" | "underline" }>,
  "page"
> & { page?: number; anchor?: string };

type PendingAnnotation =
  PendingTextAnnotation | Extract<AnnotationDraft, { type: "image" }>;

interface LocatedImageAnnotation {
  type: "image";
  text: "";
  comment: string;
  color: string;
  position: PdfPosition;
  sortIndex: string;
  pageLabel: string;
}

type LocatedAnnotation = LocatedTextAnnotation | LocatedImageAnnotation;

type ReaderReady = { reader: PdfReaderInstance; view: PdfPrimaryView };
const initializingReaders = new Map<
  number,
  {
    promise: Promise<ReaderReady>;
    stage: string;
    listeners: Set<ToolProgress>;
    reader?: PdfReaderInstance;
  }
>();
const readerFingerprints = new WeakMap<PdfReaderInstance, string>();
async function waitForPdfReader(
  pdf: Zotero.Item,
  progress?: ToolProgress,
): Promise<ReaderReady> {
  const fingerprint = await pdfFingerprint(pdf);
  let pending = initializingReaders.get(pdf.id);
  if (pending?.reader?._isTabClosed) {
    initializingReaders.delete(pdf.id);
    pending = undefined;
  }
  if (!pending) {
    const listeners = new Set<ToolProgress>();
    const entry = {
      promise: undefined as unknown as Promise<ReaderReady>,
      stage: "opening_pdf",
      listeners,
      reader: undefined as PdfReaderInstance | undefined,
    };
    entry.promise = openPdfReader(pdf, (reader) => {
      entry.reader = reader;
      entry.stage = "initializing_pdf";
      for (const listener of listeners) listener.setStage(entry.stage);
    }).then((ready) => {
      const previous = readerFingerprints.get(ready.reader);
      if (previous && previous !== fingerprint)
        throw new Error(
          "PDF file changed while its reader was open; reopen that PDF to load the current file",
        );
      readerFingerprints.set(ready.reader, fingerprint);
      return ready;
    });
    initializingReaders.set(pdf.id, entry);
    pending = entry;
    void entry.promise
      .finally(() => {
        if (initializingReaders.get(pdf.id) === entry)
          initializingReaders.delete(pdf.id);
      })
      .catch(() => {});
  }
  if (progress) {
    pending.listeners.add(progress);
    progress.setStage(pending.stage);
  }
  try {
    return await deadline(pending.promise, 30_000);
  } finally {
    if (progress) pending.listeners.delete(progress);
  }
}

async function openPdfReader(
  pdf: Zotero.Item,
  onInitialize: (reader: PdfReaderInstance) => void,
): Promise<{
  reader: PdfReaderInstance;
  view: PdfPrimaryView;
}> {
  const findReader = () =>
    waiveReaderXrays(
      (Zotero.Reader._readers as unknown as PdfReaderInstance[]).find(
        (candidate) =>
          candidate.itemID === pdf.id && candidate._isTabClosed !== true,
      ),
    );
  // Reader.open selects an existing tab even with openInBackground. Reuse the
  // instance directly so background tools do not activate the user's window.
  let reader = findReader();
  const tabs = Zotero.getMainWindow?.()?.Zotero_Tabs as
    | (_ZoteroTypes.Zotero_Tabs & { markAsLoaded: (id: string) => void })
    | undefined;
  let restoredTab: _ZoteroTypes.TabInstance | undefined;
  if (!reader) {
    const tabID = tabs?.getTabIDByItemID(pdf.id);
    const tab = tabID ? tabs?._getTab(tabID).tab : undefined;
    // Let an existing load finish. For an unloaded tab, initialize its existing
    // container directly; Reader.open's default restore path selects the tab.
    if (tab?.type !== "reader-loading") {
      if (tab?.type === "reader-unloaded") {
        restoredTab = tab;
        tab.type = "reader-loading";
      }
      const openOptions = {
        openInBackground: true,
        allowDuplicate: Boolean(restoredTab),
        tabID: restoredTab?.id,
        secondViewState: restoredTab?.data?.secondViewState,
      };
      try {
        reader = waiveReaderXrays(
          (await Zotero.Reader.open(pdf.id, undefined, openOptions)) as
            PdfReaderInstance | undefined,
        );
      } catch (error) {
        if (restoredTab?.type === "reader-loading")
          restoredTab.type = "reader-unloaded";
        throw error;
      }
    }
  }
  const deadline = Date.now() + 15_000;
  while (!reader && Date.now() < deadline) {
    reader = findReader();
    if (!reader) {
      await Zotero.Promise.delay(25);
    }
  }
  if (!reader) {
    throw new Error("Zotero PDF reader did not open");
  }
  onInitialize(reader);
  await reader._initPromise;
  if (restoredTab?.type === "reader-loading")
    tabs!.markAsLoaded(restoredTab.id);
  await reader._waitForReader?.();
  const view = waiveReaderXrays(reader._internalReader?._primaryView);
  if (!view) {
    throw new Error("Zotero PDF reader view is unavailable");
  }
  await view.initializedPromise;
  return { reader, view };
}

function findPageMatches(
  controller: PdfFindController,
): Array<number[] | undefined> {
  return controller.pageMatches ?? controller._pageMatches ?? [];
}

async function waitForPdfFind(
  controller: PdfFindController,
  query: string,
  pageCount: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Let the controller reset results from any previous query before checking
  // its own activity and completion signal.
  await Zotero.Promise.delay(0);
  while (Date.now() < deadline) {
    const matches = findPageMatches(controller);
    const pending = controller._pendingFindMatches?.size ?? 0;
    // Reader arrays cross a chrome-window boundary in Zotero. Requiring
    // Array.isArray() for every entry rejects valid wrapped arrays, whereas the
    // controller's pending set is its own completion signal.
    // A completed previous query is not evidence for this quote. Also wait for
    // every page: native normalization may reveal additional ambiguous matches.
    if (
      controller.state?.query === query &&
      controller._dirtyMatch !== true &&
      pending === 0 &&
      Array.from({ length: pageCount }, (_, page) => matches[page]).every(
        (page) => page !== undefined,
      )
    ) {
      return true;
    }
    await Zotero.Promise.delay(25);
  }
  return false;
}

function normalizedRect(value?: number[]): number[] | null {
  if (
    !value ||
    value.length < 4 ||
    value.some((part) => !Number.isFinite(part))
  ) {
    return null;
  }
  const [x1, y1, x2, y2] = value;
  return [
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.max(x1, x2),
    Math.max(y1, y2),
  ];
}

function rangeRects(
  chars: PdfPageChar[],
  offsetStart: number,
  offsetEnd: number,
): number[][] {
  const rects: number[][] = [];
  let start = offsetStart;
  for (let index = start; index <= offsetEnd; index += 1) {
    const current = chars[index];
    if (!current || (!current.lineBreakAfter && index !== offsetEnd)) {
      continue;
    }
    const first = chars[start];
    const firstRect = normalizedRect(first?.rect);
    const lastRect = normalizedRect(current.rect);
    const inlineRect = normalizedRect(first?.inlineRect) ?? firstRect;
    if (firstRect && lastRect && inlineRect) {
      const vertical = first?.rotation === 90 || first?.rotation === 270;
      rects.push(
        vertical
          ? [inlineRect[0], firstRect[1], inlineRect[2], lastRect[3]]
          : [firstRect[0], inlineRect[1], lastRect[2], inlineRect[3]],
      );
    }
    start = index + 1;
  }
  return rects;
}

async function setPdfFindQuery(
  view: PdfPrimaryView,
  controller: PdfFindController,
  query: string,
  pageCount: number,
  timeoutMs = 5_000,
): Promise<void> {
  const state = Components.utils.cloneInto(
    {
      active: true,
      type: "find",
      query,
      phraseSearch: true,
      highlightAll: true,
      caseSensitive: false,
      entireWord: false,
      findPrevious: false,
    },
    view._iframeWindow,
  );
  if (view.setFindState) await view.setFindState(state);
  else await controller.find(state);
  if (!(await waitForPdfFind(controller, query, pageCount, timeoutMs)))
    throw new Error(
      `Native PDF search did not complete for this quote; no reliable location is available (current query: ${controller.state?.query === query ? "matched" : "different"}, pending pages: ${controller._pendingFindMatches?.size ?? "unknown"})`,
    );
}

async function locateTextAnnotation(
  view: PdfPrimaryView,
  annotation: PendingTextAnnotation,
  occurrence: number,
  findTimeoutMs = 5_000,
): Promise<LocatedTextAnnotation> {
  const text = String(annotation.quote ?? "").trim();
  if (!text) {
    throw new Error("Text annotation quote cannot be empty");
  }
  const controller = waiveReaderXrays(view._findController);
  const pageCount =
    view._iframeWindow?.PDFViewerApplication?.pdfDocument?.numPages ?? 0;
  if (!controller || pageCount < 1) {
    throw new Error("Zotero PDF text search is unavailable");
  }
  const findDeadline = Date.now() + 3000;
  while (!controller._pdfDocument && Date.now() < findDeadline)
    await Zotero.Promise.delay(25);
  if (!controller._pdfDocument)
    throw new Error(
      "PDF text search is still initializing; retry after initialization completes",
    );
  const requestedPage = Number(annotation.page);
  const pageIndexes =
    Number.isInteger(requestedPage) && requestedPage > 0
      ? [requestedPage - 1]
      : Array.from({ length: pageCount }, (_, index) => index);
  const queries = new Set([text]);
  for (const pageIndex of pageIndexes) {
    if (pageIndex >= 0 && pageIndex < pageCount) {
      for (const variant of layoutQuoteVariants(
        await pageChars(view, pageIndex),
        text,
      ))
        queries.add(variant);
    }
  }
  const uniquePositions = new Map<string, PdfPosition>();
  const otherPages = new Set<number>();
  for (const query of queries) {
    await setPdfFindQuery(view, controller, query, pageCount, findTimeoutMs);
    const nativeMatches = findPageMatches(controller);
    for (let page = 0; page < pageCount; page++) {
      if (!pageIndexes.includes(page) && nativeMatches[page]?.length)
        otherPages.add(page + 1);
    }
    if (
      pageIndexes.reduce(
        (count, page) => count + (nativeMatches[page]?.length ?? 0),
        0,
      ) > 1
    )
      throw new Error(
        "Annotation quote is ambiguous; provide a longer unique quote on a specific physical page",
      );
    for (const pageIndex of pageIndexes) {
      if (
        pageIndex < 0 ||
        pageIndex >= pageCount ||
        !nativeMatches[pageIndex]?.length
      )
        continue;
      // Every accepted position still comes from completed native search.
      const matches = normalizePdfMatchPositions(
        pageIndex,
        await controller.getMatchPositionsAsync(pageIndex),
      );
      if (!matches.length)
        throw new Error(
          "Native PDF search found text but could not provide a reliable position",
        );
      for (const position of matches)
        uniquePositions.set(canonical(position), position);
    }
  }
  const positions = [...uniquePositions.values()];
  if (positions.length > 1)
    throw new Error(
      "Annotation quote is ambiguous; provide a longer unique quote on a specific physical page",
    );
  const position = positions[occurrence];
  if (!position?.rects?.length) {
    const pageHint =
      pageIndexes.length === 1 ? ` on page ${requestedPage}` : "";
    throw new Error(
      `Annotation quote was not found${pageHint}: ${text.slice(0, 120)}${
        otherPages.size
          ? `. Native matches exist on physical pages ${[...otherPages].sort((a, b) => a - b).join(", ")}; reread that context and correct the page before resubmitting`
          : ""
      }`,
    );
  }
  await view._ensureBasicPageData?.(position.pageIndex);
  let meta: { sortIndex?: string; pageLabel?: string } | undefined;
  try {
    const readerPosition = Components.utils.cloneInto(
      position,
      view._iframeWindow,
    );
    meta = view.getAnnotationMeta?.(readerPosition);
  } catch (error) {
    throw new Error(
      `Unable to derive PDF highlight metadata: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const pageLabel =
    String(
      meta?.pageLabel || view._getPageLabel?.(position.pageIndex, true) || "",
    ) || String(position.pageIndex + 1);
  const sortIndex =
    String(meta?.sortIndex || "") ||
    `${String(position.pageIndex).padStart(5, "0")}|000000|00000`;
  return {
    type: annotation.type,
    text,
    comment: String(annotation.comment ?? ""),
    color: annotation.color ?? DEFAULT_ANNOTATION_COLORS[annotation.type],
    position: JSON.parse(JSON.stringify(position)) as PdfPosition,
    pageLabel,
    sortIndex,
  };
}

function annotationMetaForPosition(
  view: PdfPrimaryView,
  position: PdfPosition,
): { pageLabel: string; sortIndex: string } {
  let meta: { sortIndex?: string; pageLabel?: string } | undefined;
  try {
    const readerPosition = Components.utils.cloneInto(
      position,
      view._iframeWindow,
    );
    meta = view.getAnnotationMeta?.(readerPosition);
  } catch (error) {
    throw new Error(
      `Unable to derive PDF annotation metadata: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return {
    pageLabel:
      String(
        meta?.pageLabel || view._getPageLabel?.(position.pageIndex, true) || "",
      ) || String(position.pageIndex + 1),
    sortIndex:
      String(meta?.sortIndex || "") ||
      `${String(position.pageIndex).padStart(5, "0")}|000000|00000`,
  };
}

async function locateImageAnnotation(
  view: PdfPrimaryView,
  annotation: Extract<AnnotationDraft, { type: "image" }>,
): Promise<LocatedImageAnnotation> {
  const pageIndex = annotation.page - 1;
  const document = readerPdfDocument(view);
  const pageCount = document?.numPages ?? 0;
  if (!document || pageIndex < 0 || pageIndex >= pageCount) {
    throw new Error(
      `Image annotation page is out of range: ${annotation.page}`,
    );
  }
  const page = await readerPdfPage(view, annotation.page);
  const position = normalizedRegionToPdfPosition(
    pageIndex,
    annotation.rect,
    readerPageViewport(view, page, 1),
  );
  const meta = annotationMetaForPosition(view, position);
  return {
    type: "image",
    text: "",
    comment: annotation.comment.trim(),
    color: annotation.color ?? DEFAULT_ANNOTATION_COLORS.image,
    position,
    ...meta,
  };
}

function normalizedColor(
  value: unknown,
  type: AnnotationType,
): string | undefined {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const color = String(value).trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error(`Invalid ${type} color: expected #RRGGBB`);
  }
  return color.toLowerCase();
}

function positivePage(value: unknown, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("Annotation page must be a positive integer");
  }
  return page;
}

function normalizeAnnotationList(
  value: unknown,
  legacyHighlights = false,
): PendingAnnotation[] {
  if (!Array.isArray(value)) {
    throw new Error("annotations must be an array");
  }
  return value.map((candidate, index) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error(`Annotation ${index + 1} must be an object`);
    }
    const record = candidate as Record<string, unknown>;
    const type = legacyHighlights
      ? "highlight"
      : String(record.type ?? "").trim();
    if (type !== "highlight" && type !== "underline" && type !== "image") {
      throw new Error(`Annotation ${index + 1} has an unsupported type`);
    }
    const color = normalizedColor(record.color, type);
    if (type === "image") {
      if (record.anchor !== undefined)
        throw new Error(
          "Image annotations require a region from inspect_pdf_page, not a text anchor",
        );
      const comment = String(record.comment ?? "").trim();
      if (!comment) {
        throw new Error(`Image annotation ${index + 1} requires a comment`);
      }
      return {
        type,
        page: positivePage(record.page, true)!,
        rect: normalizeRegionRect(record.rect),
        comment,
        color,
      };
    }
    if (record.anchor !== undefined) {
      const anchor = normalizeAnchor(String(record.anchor));
      const page = anchorPage(anchor);
      if (record.page !== undefined && positivePage(record.page, true) !== page)
        throw new Error(
          "Annotation page conflicts with the anchor; omit page when using an anchor",
        );
      if (record.quote !== undefined || record.text !== undefined)
        throw new Error("Use anchor alone for location; omit quote and text");
      return {
        type,
        page,
        anchor,
        quote: "",
        color,
        comment:
          record.comment === undefined ? undefined : String(record.comment),
      };
    }
    const quote = String(record.quote ?? record.text ?? "").trim();
    if (!quote) {
      throw new Error(`Text annotation ${index + 1} requires a quote`);
    }
    return {
      type,
      page: positivePage(record.page, !legacyHighlights),
      quote,
      comment:
        record.comment === undefined ? undefined : String(record.comment),
      color,
    };
  });
}

function readerPageDataInput(view: PdfPrimaryView, pageIndex: number) {
  // PDF.js forwards this object to its Worker. Privileged objects cannot be
  // structured-cloned from the Reader compartment, including on empty pages.
  return view._iframeWindow
    ? Components.utils.cloneInto({ pageIndex }, view._iframeWindow)
    : { pageIndex };
}

async function pageChars(
  view: PdfPrimaryView,
  pageIndex: number,
): Promise<PdfPageChar[]> {
  const primary = waiveReaderXrays(view);
  await primary._ensureBasicPageData?.(pageIndex);
  const copyChars = (value: unknown): PdfPageChar[] => {
    const source = waiveReaderXrays(value) as
      { length?: number; [index: number]: PdfPageChar } | undefined;
    const length = Number(source?.length ?? 0);
    if (!Number.isInteger(length) || length <= 0) return [];
    const copied: PdfPageChar[] = [];
    for (let index = 0; index < length; index += 1) {
      copied.push(waiveReaderXrays(source![index]));
    }
    return copied;
  };
  const cached = copyChars(
    waiveReaderXrays(primary._pdfPages?.[pageIndex])?.chars,
  );
  if (cached.length) return cached;
  const documentData = waiveReaderXrays(
    await readerPdfDocument(primary)?.getPageData?.(
      readerPageDataInput(primary, pageIndex),
    ),
  );
  const documentChars = copyChars(documentData?.chars);
  if (documentChars.length) return documentChars;
  const findData = waiveReaderXrays(
    await primary._findController?._pdfDocument?.getPageData?.(
      readerPageDataInput(primary, pageIndex),
    ),
  );
  return copyChars(findData?.chars);
}

function pageLineAnchors(
  chars: PdfPageChar[],
  viewport: PdfViewportLike,
): Array<{ text: string; rect: [number, number, number, number] }> {
  const lines: Array<{ text: string; rect: [number, number, number, number] }> =
    [];
  let start = 0;
  let text = "";
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    text += String(char.u ?? char.char ?? "");
    if (char.spaceAfter) text += " ";
    const closesLine =
      char.lineBreakAfter ||
      char.paragraphBreakAfter ||
      index === chars.length - 1;
    if (!closesLine) continue;
    const rects = rangeRects(chars, start, index);
    const bounds = rects.length
      ? [
          Math.min(...rects.map((rect) => rect[0])),
          Math.min(...rects.map((rect) => rect[1])),
          Math.max(...rects.map((rect) => rect[2])),
          Math.max(...rects.map((rect) => rect[3])),
        ]
      : [];
    const normalized = pdfRectToNormalizedRegion(bounds, viewport);
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed && normalized) lines.push({ text: trimmed, rect: normalized });
    start = index + 1;
    text = "";
  }
  return lines;
}

async function renderPageImage(
  view: PdfPrimaryView,
  page: PdfPageProxy,
  pageNumber: number,
): Promise<ToolTransientMedia | undefined> {
  const mediaFromDataUrl = (
    dataUrl: unknown,
  ): ToolTransientMedia | undefined => {
    const match = /^data:image\/png;base64,(.+)$/s.exec(String(dataUrl ?? ""));
    if (!match?.[1]) return undefined;
    return {
      type: "image",
      mimeType: "image/png",
      data: match[1],
      description: `PDF page ${pageNumber}; verify table headers, figures and evidence, and ground image-region annotations`,
    };
  };
  try {
    const renderer = waiveReaderXrays(waiveReaderXrays(view)._pdfRenderer);
    const pageRect = waiveReaderXrays(page.view);
    if (
      renderer?.renderRegionCrops &&
      pageRect?.length === 4 &&
      pageRect.every(Number.isFinite)
    ) {
      const cropRects = view._iframeWindow
        ? Components.utils.cloneInto([[...pageRect]], view._iframeWindow)
        : [[...pageRect]];
      const images = waiveReaderXrays(
        await renderer.renderRegionCrops(pageNumber - 1, cropRects),
      );
      const media = mediaFromDataUrl(waiveReaderXrays(images?.[0]));
      if (media) return media;
    }
  } catch {
    // Older Reader builds do not expose their internal crop renderer.
  }
  try {
    const base = readerPageViewport(view, page, 1);
    const scale = Math.max(
      0.5,
      Math.min(2, 1600 / Math.max(base.width, base.height)),
    );
    const viewport = readerPageViewport(view, page, scale);
    const canvas = view._iframeWindow?.document.createElement("canvas");
    if (!canvas) return undefined;
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const canvasContext = canvas.getContext(
      "2d",
    ) as unknown as CanvasRenderingContext2D | null;
    if (!canvasContext) return undefined;
    await page.render({ canvas, canvasContext, viewport }).promise;
    return mediaFromDataUrl(canvas.toDataURL("image/png"));
  } catch {
    return undefined;
  }
}

function annotationPosition(item: Zotero.Item): unknown {
  const raw = (item as unknown as { annotationPosition?: unknown })
    .annotationPosition;
  if (typeof raw !== "string") {
    return raw ?? null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function noteHtml(content: string): string {
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div>${escaped.replace(/\n/g, "<br/>")}</div>`;
}

/**
 * Minimal Markdown to note HTML: headings, bullet/numbered lists, bold,
 * inline code, fenced code blocks and plain paragraphs. Deliberately not a
 * full Markdown engine -- the note preview only needs structure.
 */
export function markdownToNoteHtml(markdown: string): string {
  const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (text: string) =>
    escape(text)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = String(markdown ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let code: string[] | null = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  for (const line of lines) {
    if (code) {
      if (line.trimStart().startsWith("```")) {
        out.push(`<pre>${escape(code.join("\n"))}</pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    if (trimmed.startsWith("```")) {
      closeList();
      code = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    const item = bullet ?? ordered;
    if (item) {
      const wanted: "ul" | "ol" = bullet ? "ul" : "ol";
      if (list !== wanted) {
        closeList();
        list = wanted;
        out.push(`<${list}>`);
      }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(trimmed)}</p>`);
  }
  if (code) {
    out.push(`<pre>${escape(code.join("\n"))}</pre>`);
  }
  closeList();
  return `<div>${out.join("")}</div>`;
}

class RolledBackWrite extends Error {}

async function atomicItems(
  items: Zotero.Item[],
  work: () => Promise<void>,
): Promise<void> {
  try {
    await Zotero.DB.executeTransaction(work);
  } catch (error) {
    for (const item of items)
      await item
        .reload?.(
          [
            "primaryData",
            "itemData",
            "note",
            "tags",
            "relations",
            "collections",
          ],
          true,
        )
        .catch(() => undefined);
    throw new RolledBackWrite(
      `Zotero transaction rolled back: ${String(error)}`,
    );
  }
}

async function pdfFingerprint(pdf: Zotero.Item): Promise<string> {
  const path = await pdf.getFilePathAsync?.();
  if (
    !path &&
    typeof (pdf as Partial<Zotero.Item>).getFilePathAsync === "function"
  )
    throw new Error(
      "PDF file is unavailable locally; download it before reading or annotating",
    );
  if (!path) return `${pdf.libraryID}:${pdf.key}`;
  const info = await IOUtils.stat(path);
  return canonical({
    key: pdf.key,
    path,
    size: info.size,
    modified: info.lastModified,
  });
}
function annotationCreationTime(
  item: Zotero.Item | null,
  field: "dateAdded" | "dateModified" = "dateAdded",
): number {
  const stamp = String(item?.[field] ?? "");
  const time = Date.parse(
    /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(stamp)
      ? stamp.replace(" ", "T") + "Z"
      : stamp,
  );
  return Number.isFinite(time) ? time : Date.now();
}
function readPdfAnnotations(pdf: Zotero.Item) {
  return (pdf.getAnnotations?.(false) || [])
    .map((entry) =>
      typeof entry === "object" && entry
        ? asItem(entry)
        : asItem(Zotero.Items.get(entry as number)),
    )
    .filter((annotation): annotation is Zotero.Item =>
      Boolean(annotation?.isAnnotation?.()),
    )
    .map((annotation) => ({
      libraryID: pdf.libraryID,
      key: annotation.key,
      type: annotation.annotationType,
      text: annotation.annotationText || "",
      comment: annotation.annotationComment || "",
      color: annotation.annotationColor || "",
      pageLabel: annotation.annotationPageLabel || "",
      sortIndex: annotation.annotationSortIndex || "",
      position: annotationPosition(annotation),
      zoteroUri: buildOpenPdfUri(pdf.key, {
        groupID: groupIDForLibrary(pdf.libraryID),
        annotationKey: annotation.key,
      }),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}
export function itemVersion(item: Zotero.Item): string {
  return canonical({
    modified: item.dateModified,
    version: item.version,
    note: item.isNote?.() ? item.getNote() : undefined,
    data: item.toJSON?.(),
    attachments:
      !item.isAttachment?.() && !item.isNote?.() && !item.isAnnotation?.()
        ? item.getAttachments?.()
        : undefined,
  });
}

interface AnnotationEntry {
  id: string;
  raw: Record<string, unknown>;
  draft?: PendingAnnotation;
  located?: LocatedAnnotation;
  annotationKey?: string;
  status:
    | "pending"
    | "committed"
    | "alreadyPresent"
    | "skipped"
    | "failed"
    | "unknown";
  error?: string;
  reviewIssue?: string;
  resolved?: "denied" | "omitted";
}
interface AnnotationProposal {
  id: string;
  createdAt?: number;
  runId?: string;
  intentRevision?: number;
  taskId: string;
  fingerprint: string;
  entries: AnnotationEntry[];
}
interface AnnotationRecord {
  version: 2;
  proposals: Record<string, AnnotationProposal>;
  latest: Record<string, string>;
}
const freshAnnotationRecord = (): AnnotationRecord => ({
  version: 2,
  proposals: {},
  latest: {},
});

function annotationProposalMatchesScope(
  proposal: AnnotationProposal,
  scope: Pick<ToolExecutionContext, "taskId" | "runId" | "intentRevision">,
): boolean {
  return (
    proposal.taskId === (scope.taskId ?? "local") &&
    (scope.runId === undefined || proposal.runId === scope.runId) &&
    (scope.intentRevision === undefined ||
      proposal.intentRevision === scope.intentRevision)
  );
}

function selectAnnotationProposal(
  record: AnnotationRecord,
  taskId: string,
  matches: (proposal: AnnotationProposal) => boolean,
): AnnotationProposal | undefined {
  const latest = record.proposals[record.latest[taskId]];
  if (latest && matches(latest)) return latest;
  return Object.values(record.proposals)
    .filter(matches)
    .reverse()
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}

export class ZoteroToolHost {
  private readonly renderingLocks = new ResourceLocks();
  private readonly findingLocks = new ResourceLocks();
  private readonly findingViews = new WeakMap<PdfPrimaryView, string>();
  private nextFindingView = 0;
  private readonly pageTextCache = new Map<string, string>();
  private readonly annotationLocks = new ResourceLocks();
  readonly ownership: AnnotationOwnership;
  private operations?: OperationRepository;
  private readonly pendingDownloads = new Set<string>();
  constructor(
    private readonly storage: JsonStorage = runtimeJsonStorage(
      "annotation-records",
    ),
  ) {
    this.ownership = new AnnotationOwnership(storage);
  }

  private ownerContext(context: ToolExecutionContext): AnnotationOwnerContext {
    return {
      taskId: context.taskId ?? "local",
      title: context.taskTitle ?? context.taskId ?? "Annotation task",
      createdAt: context.taskCreatedAt,
      agent: context.agent,
      runtime: context.runtime,
    };
  }

  async freezeTaskPdf(
    context: ToolExecutionContext,
    libraryID: number,
    key: string,
    attachmentKey?: string,
  ) {
    const item = getItem(libraryID, key);
    if (!item) return;
    const pdf = await findPdf(item, attachmentKey);
    if (!pdf) return;
    return this.annotationLocks.run(
      [`${pdf.libraryID}_${pdf.key}`],
      async () => {
        await pdf.reload?.(["childItems"], true);
        return this.ownership.freeze(
          `${pdf.libraryID}_${pdf.key}`,
          this.ownerContext(context),
          readPdfAnnotations(pdf).map((mark) => mark.color),
        );
      },
    );
  }

  async annotationBatchView(
    libraryID: number,
    key: string,
    filter?: AnnotationBatchFilter,
  ): Promise<AnnotationBatchView> {
    const pdf = getItem(libraryID, key);
    if (!pdf?.isAttachment?.()) throw new Error("PDF not found");
    const token = `${libraryID}_${key}`;
    await this.restoreLegacyOwnership(pdf);
    if (filter)
      await this.ownership.change(token, (record) => {
        record.filter = filter;
      });
    const record = await this.ownership.read(token);
    const marks = readPdfAnnotations(pdf);
    const membership = Object.fromEntries(
      marks.map((mark) => [
        mark.key,
        record.marks[mark.key]?.status === "created" &&
        record.batches[record.marks[mark.key].batchId ?? ""]
          ? record.marks[mark.key].batchId!
          : null,
      ]),
    );
    return {
      membership,
      filter: record.filter,
      total: marks.length,
      existingCount: Object.values(membership).filter((id) => !id).length,
      batches: Object.values(record.batches)
        .map(({ batch }) => ({
          ...batch,
          count: Object.values(membership).filter((id) => id === batch.id)
            .length,
        }))
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  /** Only an explicit committed host receipt can establish legacy creation ownership.
   * Reused annotations, proposal text, tags and task dates prove nothing. */
  private async restoreLegacyOwnership(pdf: Zotero.Item): Promise<void> {
    if (!this.operations) return;
    const token = `${pdf.libraryID}_${pdf.key}`;
    const record = await this.ownership.read(token);
    const actual = new Set(readPdfAnnotations(pdf).map((mark) => mark.key));
    if ([...actual].every((key) => record.marks[key])) return;
    const proofs: Array<{
      key: string;
      taskId: string;
      operationId: string;
      agent?: string;
    }> = [];
    for (const operation of await this.operations.listOperations({
      name: "commit_annotations",
      resources: [`zotero:${pdf.libraryID}:${pdf.key}`],
    })) {
      const result = operation.result;
      const data = result?.ok ? result.data : result?.details;
      const rows = (
        data as { committed?: Array<{ annotationKey?: string }> } | undefined
      )?.committed;
      if (!Array.isArray(rows) || !operation.context.taskId) continue;
      const planned = this.operationAnnotationEntries(operation);
      for (const row of rows)
        if (
          row.annotationKey &&
          actual.has(row.annotationKey) &&
          !record.marks[row.annotationKey] &&
          planned.some(
            (entry) =>
              entry.annotationKey === row.annotationKey &&
              entry.status === "pending",
          )
        )
          proofs.push({
            key: row.annotationKey,
            taskId: operation.context.taskId,
            operationId: operation.id,
            agent: operation.context.agent,
          });
    }
    if (proofs.length)
      await this.ownership.change(token, (value) => {
        for (const proof of proofs)
          value.marks[proof.key] ??= {
            createdBy: "confucius-agent",
            status: "created",
            taskId: proof.taskId,
            agent: proof.agent,
            proofOperationId: proof.operationId,
          };
      });
  }

  setOperationReader(operations: OperationRepository): void {
    this.operations = operations;
  }

  /** Export saved candidates without reloading PDFs, reconciling receipts or changing proposals. */
  async exportTaskProposals(taskId: string) {
    const records: Array<{
      resource: string;
      proposals: AnnotationProposal[];
    }> = [];
    const issues: string[] = [];
    for (const token of (await this.storage.keys?.()) ?? []) {
      if (!/^\d+_[^_]+$/.test(token)) continue;
      try {
        const record = await this.storage.read<AnnotationRecord>(token);
        if (!record?.proposals || typeof record.proposals !== "object")
          throw new Error("Invalid proposal record");
        const proposals = Object.values(record.proposals).filter(
          (proposal) => proposal?.taskId === taskId,
        );
        if (proposals.length) records.push({ resource: token, proposals });
      } catch (error) {
        issues.push(`${token}: ${String(error)}`);
      }
    }
    return { records, issues };
  }

  async prepare(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolFailure | null> {
    const invalid = validateArgs(
      name,
      TOOL_DEFINITIONS.find((tool) => tool.name === name)?.inputSchema,
      args,
    );
    if (invalid) return invalid;
    if (name === "batch_update_tags")
      for (const field of ["add", "remove"]) {
        if (Array.isArray(args[field]))
          args[field] = [
            ...new Set(
              (args[field] as string[])
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ];
      }
    const reject = (message: string, code: ToolErrorCode = "invalid_args") => ({
      ok: false as const,
      toolName: name,
      code,
      effect: "none" as const,
      message,
    });
    if (name === "propose_note" && args.parentKey === undefined) {
      if (!context.source)
        return reject(
          "No fixed task source is available; provide an explicit parentKey",
          "not_found",
        );
      args.parentKey = context.source.key;
      args.libraryID = context.source.libraryID;
    }
    if (args.libraryID === undefined && (args.key || args.parentKey))
      args.libraryID =
        context.source?.libraryID ?? Zotero.Libraries.userLibraryID;
    for (const field of ["key", "parentKey", "relatedKey"]) {
      if (
        !args[field] ||
        (field === "key" &&
          [
            "rename_collection",
            "get_collection_items",
            "run_saved_search",
          ].includes(name)) ||
        (field === "parentKey" && name === "create_collection")
      )
        continue;
      const item = getItem(defaultLibraryID(args), String(args[field]));
      if (!item)
        return reject(
          `Explicit ${field} was not found in library ${defaultLibraryID(args)}`,
          "not_found",
        );
      if (
        ((field === "parentKey" &&
          ["create_note", "propose_note"].includes(name)) ||
          (field === "key" && name === "attach_file")) &&
        (item.isAttachment?.() || item.isNote?.() || item.isAnnotation?.())
      )
        return reject("The explicit parent must be a regular Zotero item");
      if (TOOL_META[name]?.mutatesState) {
        if (item.isAnnotation?.()) {
          const parent = item.parentItemID
            ? asItem(Zotero.Items.get(item.parentItemID))
            : null;
          if (parent) await this.restoreLegacyOwnership(parent);
          if (
            !parent ||
            !(await this.ownership.owned(
              `${parent.libraryID}_${parent.key}`,
              item.key,
            ))
          )
            return reject(
              "Only annotations with verified Confucius Agent creation provenance may be modified or deleted",
              "permission_denied",
            );
          if (
            ![
              "update_annotation",
              "update_annotation_comment",
              "delete_annotation",
              "batch_update_tags",
            ].includes(name)
          )
            return reject(
              "Use the dedicated annotation tools to modify an Agent annotation",
              "permission_denied",
            );
          if (
            name === "batch_update_tags" &&
            [
              ...((args.add ?? []) as string[]),
              ...((args.remove ?? []) as string[]),
            ].some((tag) => tag.startsWith("Confucius "))
          )
            return reject(
              "Batch and creation tags are managed by Confucius",
              "permission_denied",
            );
        }
        if (item.isAnnotation?.() && item.parentItemID) {
          const parent = asItem(Zotero.Items.get(item.parentItemID));
          if (parent)
            context.resources = [
              ...(context.resources ?? []),
              `zotero:${parent.libraryID}:${parent.key}`,
            ];
        }
        const library = Zotero.Libraries.get?.(item.libraryID);
        if (library && library.editable === false)
          return reject("Zotero library is read-only", "permission_denied");
        const token = `${item.libraryID}:${item.key}`;
        context.expected ??= {};
        context.expected[token] ??= this.mutationVersion(name, args, item);
      }
    }
    const collectionKey =
      args.collectionKey ??
      (["rename_collection", "get_collection_items"].includes(name)
        ? args.key
        : name === "create_collection"
          ? args.parentKey
          : undefined);
    if (collectionKey) {
      const collection = Zotero.Collections.getByLibraryAndKey(
        defaultLibraryID(args),
        String(collectionKey),
      );
      if (!collection)
        return reject(
          "Explicit collection reference was not found",
          "not_found",
        );
      if (TOOL_META[name]?.mutatesState) {
        context.expected ??= {};
        context.expected[
          `collection:${collection.libraryID}:${collection.key}`
        ] ??= this.collectionMutationVersion(name, collection);
      }
    }
    if (
      (TOOL_META[name]?.catalog === "paper.read" ||
        [
          "propose_annotations",
          "propose_highlights",
          "commit_annotations",
        ].includes(name)) &&
      args.key
    ) {
      const item = getItem(defaultLibraryID(args), String(args.key));
      if (item) {
        try {
          const selected =
            args.attachmentKey ??
            (context.source?.key === item.key
              ? context.source.attachmentKey
              : undefined);
          const pdf = await findPdf(item, selected as string | undefined);
          if (pdf) {
            args.attachmentKey = pdf.key;
            if (
              [
                "propose_annotations",
                "propose_highlights",
                "commit_annotations",
                "get_annotations",
              ].includes(name)
            )
              args.key = pdf.key;
          }
        } catch (error) {
          return reject(String(error), "not_found");
        }
      }
    }
    if (
      TOOL_META[name]?.mutatesState &&
      (args.libraryID !== undefined ||
        [
          "create_item",
          "create_note",
          "create_collection",
          "create_saved_search",
          "add_item",
        ].includes(name))
    ) {
      args.libraryID ??=
        context.source?.libraryID ?? Zotero.Libraries.userLibraryID;
      const library = Zotero.Libraries.get?.(Number(args.libraryID));
      if (library && library.editable === false)
        return reject("Zotero library is read-only", "permission_denied");
    }
    if (["create_note", "propose_note", "create_item"].includes(name)) {
      context.plannedKeys ??= {};
      context.plannedKeys.item ??= (
        Zotero as typeof Zotero & {
          DataObjectUtilities: { generateKey(): string };
        }
      ).DataObjectUtilities.generateKey();
    }
    if (["create_collection", "create_saved_search"].includes(name)) {
      const kind = name === "create_collection" ? "collection" : "search";
      context.plannedKeys ??= {};
      context.plannedKeys[kind] ??= (
        Zotero as typeof Zotero & {
          DataObjectUtilities: { generateKey(): string };
        }
      ).DataObjectUtilities.generateKey();
    }
    if (
      ["create_note", "propose_note", "append_to_note", "update_note"].includes(
        name,
      )
    ) {
      const key = String(args.key ?? context.plannedKeys?.item);
      const current = args.key
        ? getItem(defaultLibraryID(args), String(args.key))
        : null;
      const html =
        name === "propose_note"
          ? markdownToNoteHtml(`# ${args.title}\n\n${args.markdown}`)
          : name === "append_to_note"
            ? `${current?.getNote?.() ?? ""}${noteHtml(String(args.content ?? ""))}`
            : noteHtml(String(args.content ?? ""));
      context.expectedAfter ??= {};
      context.expectedAfter[key] ??= html;
    }
    if (name === "batch_update_tags") {
      for (const field of ["add", "remove"])
        if (Array.isArray(args[field]))
          args[field] = [
            ...new Set(
              (args[field] as string[])
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ];
      if (
        (args.add as string[] | undefined)?.some((tag) =>
          (args.remove as string[] | undefined)?.includes(tag),
        )
      )
        return reject("A tag cannot be both added and removed in one call");
    }
    context.expectedAfter ??= {};
    if (name === "update_item_metadata")
      context.expectedAfter.fields = canonical(args.fields);
    if (
      [
        "update_annotation",
        "update_annotation_comment",
        "delete_annotation",
      ].includes(name)
    ) {
      const target = getItem(defaultLibraryID(args), String(args.key));
      if (!target?.isAnnotation?.())
        return reject("Target is not an annotation");
      const parent = target.parentItemID
        ? asItem(Zotero.Items.get(target.parentItemID))
        : null;
      if (!parent) return reject("Annotation PDF not found", "not_found");
      context.expectedAfter.ownershipPdf ??= `${parent.libraryID}_${parent.key}`;
      context.expectedAfter.modifiedAt ??= String(Date.now());
      context.expectedAfter.modifier ??= canonical(this.ownerContext(context));
      if (
        name !== "delete_annotation" &&
        !context.expectedAfter.annotationUpdate
      ) {
        if (args.comment === undefined && args.anchor === undefined)
          return reject("Provide comment or anchor");
        const change: Record<string, unknown> = {};
        if (args.comment !== undefined) change.comment = String(args.comment);
        if (args.anchor !== undefined) {
          if (!["highlight", "underline"].includes(target.annotationType))
            return reject(
              "Only text highlights and underlines support selection changes",
            );
          const progress = new ToolProgress(context, context.signal, 60_000);
          try {
            const ready = await waitForPdfReader(parent, progress);
            Object.assign(
              change,
              await this.locateAnchor(
                ready.view,
                {
                  type: target.annotationType as "highlight" | "underline",
                  quote: "",
                  anchor: String(args.anchor),
                  color: target.annotationColor,
                  comment:
                    args.comment === undefined
                      ? target.annotationComment
                      : String(args.comment),
                },
                await pdfFingerprint(parent),
                new Map(),
              ),
            );
          } finally {
            progress.close();
          }
        }
        context.expectedAfter.annotationUpdate = canonical(change);
      }
    }
    if (name === "batch_update_tags") {
      const current = getItem(defaultLibraryID(args), String(args.key));
      const tags = new Set(current?.getTags().map((tag) => tag.tag));
      for (const tag of (args.add ?? []) as string[]) tags.add(tag);
      for (const tag of (args.remove ?? []) as string[]) tags.delete(tag);
      context.expectedAfter.tags = canonical([...tags].sort());
    }
    if (name === "add_item") {
      context.resources = [
        `import:${defaultLibraryID(args)}:${String(args.identifier).trim().toLowerCase()}`,
        `attachments:${defaultLibraryID(args)}`,
      ];
      context.expectedAfter.libraryItems ??= JSON.stringify(
        await Zotero.Items.getAll(defaultLibraryID(args), false, false, true),
      );
    }
    if (name === "attach_file")
      context.resources = [
        ...(context.resources ?? []),
        `attachments:${defaultLibraryID(args)}`,
      ];
    if (name === "commit_annotations") {
      const invalid = await this.prepareAnnotationCommit(args, context);
      if (invalid) return invalid;
    }
    if (TOOL_META[name]?.mutatesState) {
      const resources = [
        ...new Set([
          ...(context.resources ?? []),
          ...Object.entries(context.plannedKeys ?? {}).map(([kind, key]) =>
            kind === "item"
              ? `zotero:${defaultLibraryID(args)}:${key}`
              : `zotero-${kind}:${defaultLibraryID(args)}:${key}`,
          ),
          ...Object.keys(context.expected ?? {}).map((key) =>
            key.startsWith("collection:") ? `zotero-${key}` : `zotero:${key}`,
          ),
        ]),
      ];
      context.resources = resources;
      context.preparedOperation = {
        schemaVersion: 1,
        domain: "zotero",
        name,
        args: JSON.parse(JSON.stringify(args)),
        resources,
        recovery: JSON.parse(
          JSON.stringify({
            expected: context.expected,
            expectedAfter: context.expectedAfter,
            plannedKeys: context.plannedKeys,
            taskId: context.taskId,
          }),
        ),
      };
    }
    return null;
  }

  private locateCandidate(
    view: PdfPrimaryView,
    draft: PendingAnnotation,
    progress: ToolProgress,
    findTimeoutMs = 5_000,
  ): Promise<LocatedAnnotation> {
    let token = this.findingViews.get(view);
    if (!token) {
      token = String(++this.nextFindingView);
      this.findingViews.set(view, token);
    }
    // The underlying reader promise retains this lock after an outer deadline.
    // A later request cannot mix its query or positions with a late result.
    return this.findingLocks.run([token], async () => {
      if (!progress.active)
        throw new ToolTimeout(
          "Annotation preflight was cancelled or timed out",
        );
      return draft.type === "image"
        ? locateImageAnnotation(view, draft)
        : locateTextAnnotation(view, draft, 0, findTimeoutMs);
    });
  }

  private async locateAnchor(
    view: PdfPrimaryView,
    draft: PendingTextAnnotation,
    fingerprint: string,
    pages: Map<
      number,
      Promise<{ chars: PdfPageChar[]; passages: PdfPassage[] }>
    >,
  ): Promise<LocatedTextAnnotation> {
    const page = anchorPage(draft.anchor!);
    if (page > (readerPdfDocument(view)?.numPages ?? 0))
      throw new Error("Annotation anchor page is outside this PDF");
    let source = pages.get(page);
    if (!source) {
      source = (async () => {
        const chars = await pageChars(view, page - 1);
        return {
          chars,
          passages: await pdfPassages(chars, page, fingerprint, runtimeDigest),
        };
      })();
      pages.set(page, source);
    }
    const { chars, passages } = await source;
    const passage = resolvePassage(passages, draft.anchor!);
    const rects = rangeRects(chars, passage.start, passage.end);
    if (
      !rects.length ||
      rects.some(
        (r) =>
          r.some((n) => !Number.isFinite(n)) || r[2] <= r[0] || r[3] <= r[1],
      )
    )
      throw new Error(
        "Annotation anchor has no reliable native selection geometry",
      );
    const position = { pageIndex: page - 1, rects };
    return {
      type: draft.type,
      text: passage.text,
      comment: draft.comment ?? "",
      color: draft.color ?? DEFAULT_ANNOTATION_COLORS[draft.type],
      position,
      ...annotationMetaForPosition(view, position),
    };
  }

  private collectionMutationVersion(
    name: string,
    collection: Zotero.Collection,
  ): string {
    return name === "rename_collection"
      ? canonical({ name: collection.name })
      : canonical({ libraryID: collection.libraryID, key: collection.key });
  }

  private mutationVersion(
    name: string,
    args: Record<string, unknown>,
    item: Zotero.Item,
  ): string {
    if (name === "update_item_metadata")
      return canonical(
        Object.fromEntries(
          Object.keys((args.fields ?? {}) as object).map((field) => [
            field,
            item.getField(field),
          ]),
        ),
      );
    if (["update_note", "append_to_note"].includes(name))
      return canonical({ note: item.getNote() });
    if (name === "batch_update_tags") {
      const current = new Set(item.getTags().map((tag) => tag.tag));
      return canonical(
        Object.fromEntries(
          [
            ...((args.add ?? []) as string[]),
            ...((args.remove ?? []) as string[]),
          ].map((tag) => [tag, current.has(tag)]),
        ),
      );
    }
    if (
      [
        "update_annotation",
        "update_annotation_comment",
        "delete_annotation",
      ].includes(name)
    )
      return canonical({
        version: itemVersion(item),
        comment: item.annotationComment,
        text: item.annotationText,
        position: item.annotationPosition,
        color: item.annotationColor,
      });
    if (["add_to_collection", "remove_from_collection"].includes(name)) {
      const collection = Zotero.Collections.getByLibraryAndKey(
        defaultLibraryID(args),
        String(args.collectionKey),
      );
      return canonical({
        membership: collection
          ? (
              item.getCollections?.() ??
              collection
                .getChildItems(true)
                .filter((id) => id === item.id)
                .map(() => collection.id)
            ).includes(collection.id)
          : false,
      });
    }
    if (name === "link_related_items") {
      const other = item.key === args.key ? args.relatedKey : args.key;
      return canonical({ related: item.relatedItems.includes(String(other)) });
    }
    if (
      [
        "commit_annotations",
        "propose_annotations",
        "propose_highlights",
        "create_note",
        "propose_note",
      ].includes(name)
    )
      return canonical({
        libraryID: item.libraryID,
        key: item.key,
        parent: item.parentItemID,
      });
    if (name === "attach_file")
      return canonical({ attachments: item.getAttachments().slice().sort() });
    return itemVersion(item);
  }

  private async prepareAnnotationCommit(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolFailure | null> {
    const reject = (
      message: string,
      code: ToolErrorCode = "invalid_args",
      details?: unknown,
    ): ToolFailure => ({
      ...fail("commit_annotations", code, message, details),
      effect: "none",
    });
    if (context.expectedAfter?.annotationArgs)
      return context.expectedAfter.annotationArgs === canonical(args)
        ? null
        : reject(
            "The approved annotation batch changed; prepare the revised candidates again",
          );
    const item = getItem(defaultLibraryID(args), String(args.key));
    const pdf = item
      ? await findPdf(item, args.attachmentKey as string | undefined)
      : null;
    if (!pdf) return reject("PDF attachment not found", "not_found");
    const token = `${pdf.libraryID}_${pdf.key}`,
      taskId = context.taskId ?? "local";
    context.resources = [
      ...new Set([
        ...(context.resources ?? []),
        `zotero:${pdf.libraryID}:${pdf.key}`,
      ]),
    ];
    return this.annotationLocks.run([token], async () => {
      const record = await this.loadAnnotationRecord(token);
      const fingerprint = await pdfFingerprint(pdf);
      let proposal = args.proposalId
        ? record.proposals[String(args.proposalId)]
        : selectAnnotationProposal(record, taskId, (candidate) =>
            annotationProposalMatchesScope(candidate, context),
          );
      if (args.proposalId && (!proposal || proposal.taskId !== taskId))
        return reject("Proposal not found in this task", "not_found");
      const explicit = args.annotations ?? args.highlights;
      if (!args.proposalId && Array.isArray(explicit) && explicit.length)
        proposal = this.makeProposal(
          record,
          explicit,
          taskId,
          fingerprint,
          context,
          args.annotations === undefined,
        );
      if (!proposal)
        return reject(
          "No annotations were proposed; provide a non-empty batch or proposalId",
        );
      if (proposal.fingerprint !== fingerprint)
        return reject(
          "PDF changed since the proposal; propose updated anchors",
          "unavailable",
        );
      await pdf.reload?.(["childItems"], true);
      const actual = readPdfAnnotations(pdf);
      const { batch } = await this.ownership.freeze(
        token,
        this.ownerContext(context),
        actual.map((mark) => mark.color),
      );
      context.annotationBatchId = batch.id;
      await this.projectAnnotationOutcomes(proposal, pdf, actual);
      const progress = new ToolProgress(context, context.signal, 120_000);
      try {
        const pending = proposal.entries.filter(
          (entry) => entry.draft && !entry.annotationKey,
        );
        const ready = pending.length
          ? await progress.run("checking_annotation_anchors", 30_000, () =>
              waitForPdfReader(pdf, progress),
            )
          : undefined;
        const anchorPages = new Map<
          number,
          Promise<{ chars: PdfPageChar[]; passages: PdfPassage[] }>
        >();
        // Reserve time to freeze and save the successful portion of a batch.
        const locatingUntil = Math.min(
          Date.now() + 60_000,
          (context.executionScope?.deadlineAt ?? Infinity) - 2_000,
        );
        let firstTextSearch = true;
        for (const entry of [...pending].sort(
          (a, b) =>
            Number(b.draft?.type !== "image" && !!b.draft?.anchor) -
            Number(a.draft?.type !== "image" && !!a.draft?.anchor),
        )) {
          try {
            if (!progress.active)
              throw new ToolTimeout(
                "Annotation preparation cancelled or timed out",
              );
            if (Date.now() >= locatingUntil)
              throw new Error(
                "Batch location budget exhausted; retry this entry using a get_pages anchor",
              );
            const anchored =
              entry.draft!.type !== "image" && !!entry.draft!.anchor;
            const initializingSearch =
              !anchored && firstTextSearch && entry.draft!.type !== "image";
            if (initializingSearch) firstTextSearch = false;
            entry.located = await progress.run(
              `checking_${entry.id}`,
              Math.min(
                initializingSearch ? 30_000 : 10_000,
                locatingUntil - Date.now(),
              ),
              () =>
                anchored
                  ? this.locateAnchor(
                      ready!.view,
                      entry.draft! as PendingTextAnnotation,
                      fingerprint,
                      anchorPages,
                    )
                  : this.locateCandidate(
                      ready!.view,
                      entry.draft!,
                      progress,
                      initializingSearch ? 30_000 : 5_000,
                    ),
            );
            entry.status = "pending";
            entry.error = undefined;
            const duplicate = actual.find((annotation) =>
              this.sameAnnotation(annotation, entry.located!),
            );
            if (duplicate) {
              entry.annotationKey = duplicate.key;
              entry.status = "alreadyPresent";
            }
          } catch (error) {
            if (error instanceof ToolTimeout && !progress.active) throw error;
            entry.status = "skipped";
            entry.error = String(error);
          }
        }
        await this.projectAnnotationOutcomes(proposal, pdf, actual);
        const eligible = proposal.entries.filter(
          (entry) => entry.status === "pending" && entry.located,
        );
        if (
          !eligible.length &&
          !proposal.entries.some((entry) => entry.annotationKey)
        ) {
          await this.saveAnnotationRecord(token, record);
          return reject(
            "No candidates have a reliable location; repair the per-entry issues",
            "invalid_args",
            { proposalId: proposal.id, entries: proposal.entries },
          );
        }
        if (
          args.proposalId &&
          explicit !== undefined &&
          canonical(
            normalizeAnnotationList(explicit, args.annotations === undefined),
          ) !== canonical(eligible.map((entry) => entry.draft))
        )
          return reject(
            "proposalId and supplied annotations conflict; prepare the revised proposal",
          );
        for (const entry of eligible) {
          entry.located!.color = await this.ownership.color(
            token,
            batch.id,
            entry.located!.color,
          );
          entry.draft!.color = entry.located!.color;
        }
        for (const entry of eligible)
          entry.annotationKey ??= (
            Zotero as typeof Zotero & {
              DataObjectUtilities: { generateKey(): string };
            }
          ).DataObjectUtilities.generateKey();
        const request = canonical(args);
        args.proposalId = proposal.id;
        args.annotations = eligible.map((entry) => ({
          ...entry.raw,
          color: entry.located!.color,
          id: entry.id,
          page: entry.located!.position.pageIndex + 1,
          ...(entry.draft?.type !== "image" && entry.draft?.anchor
            ? { anchor: undefined, quote: entry.located!.text }
            : {}),
        }));
        delete args.highlights;
        // An explicit reuse adopts this candidate for the current request;
        // immutable operation receipts keep their original execution binding.
        proposal.runId = context.runId;
        proposal.intentRevision = context.intentRevision;
        record.latest[taskId] = proposal.id;
        context.expectedAfter ??= {};
        Object.assign(context.expectedAfter, {
          annotationBatch: canonical(batch),
          annotationCreator: canonical(this.ownerContext(context)),
          annotationRequest: request,
          annotationArgs: canonical(args),
          annotationProposal: proposal.id,
          annotationFingerprint: fingerprint,
          annotationEntries: canonical(proposal.entries),
        });
        await this.saveAnnotationRecord(token, record);
        return null;
      } finally {
        progress.close();
      }
    });
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    let dispatched = false;
    try {
      if (context.preparedOperation?.domain === "zotero") {
        const intent = context.preparedOperation;
        if (intent.name !== name || canonical(intent.args) !== canonical(args))
          return {
            ...fail(
              name,
              "invalid_args",
              "The prepared operation does not match the requested write",
            ),
            effect: "none",
          };
        // Recovery fields come from the frozen intent, never mutable caller state.
        const recovery = intent.recovery as Pick<
          ToolExecutionContext,
          "expected" | "expectedAfter" | "plannedKeys"
        >;
        context = { ...context, ...JSON.parse(JSON.stringify(recovery)) };
      }
      context.signal ??= signal;
      const invalid = await this.prepare(name, args, context);
      if (invalid) return invalid;
      if (signal?.aborted)
        return {
          ...fail(name, "timeout", "Cancelled before execution"),
          effect: "none",
        };
      if (TOOL_META[name]?.mutatesState) {
        for (const [token, version] of Object.entries(context.expected ?? {})) {
          if (token.startsWith("collection:")) {
            const [, libraryID, key] = token.split(":");
            const collection = Zotero.Collections.getByLibraryAndKey(
              Number(libraryID),
              key,
            );
            if (
              !collection ||
              this.collectionMutationVersion(name, collection) !== version
            )
              return {
                ...fail(
                  name,
                  "unavailable",
                  "Collection changed after preview; review it again",
                ),
                effect: "none",
              };
            continue;
          }
          const separator = token.indexOf(":");
          const item = getItem(
            Number(token.slice(0, separator)),
            token.slice(separator + 1),
          );
          if (!item || this.mutationVersion(name, args, item) !== version)
            return {
              ...fail(
                name,
                "unavailable",
                "Zotero item changed after preflight; read it again and review the updated change",
              ),
              effect: "none",
            };
        }
      }
      dispatched = true;
      const result = await this.dispatch(name, args, signal, context);
      return result;
    } catch (error) {
      if (error instanceof RolledBackWrite)
        return {
          ...fail(name, "unavailable", error.message),
          effect: "none",
          retryable: true,
        };
      return {
        ...fail(
          name,
          error instanceof ToolTimeout ? "timeout" : "internal",
          error instanceof Error ? error.message : String(error),
        ),
        effect:
          dispatched && TOOL_META[name]?.mutatesState ? "unknown" : "none",
      };
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    switch (name) {
      case "search_items":
        return this.searchItems(args);
      case "search_fulltext":
        return this.searchFulltext(args);
      case "search_notes":
        return this.searchNotes(args);
      case "search_by_tag":
        return this.searchByTag(args);
      case "get_item":
      case "get_item_metadata":
      case "get_paper_metadata":
        return this.getItem(name, args);
      case "get_item_notes":
        return this.getItemNotes(args);
      case "get_note_content":
        return this.getNoteContent(args);
      case "get_collections":
        return this.getCollections(args);
      case "get_collection_items":
        return this.getCollectionItems(args);
      case "get_tags":
        return this.getTags(args);
      case "get_recent":
        return this.getRecent(args);
      case "list_saved_searches":
        return this.listSavedSearches(args);
      case "run_saved_search":
        return this.runSavedSearch(args);
      case "get_related_items":
        return this.getRelated(args);
      case "create_collection":
        return this.createCollection(args, context);
      case "rename_collection":
        return this.renameCollection(args);
      case "add_to_collection":
        return this.addToCollection(args);
      case "remove_from_collection":
        return this.removeFromCollection(args);
      case "create_saved_search":
        return this.createSavedSearch(args, context);
      case "add_item":
        return this.addItem(args, context);
      case "create_item":
        return this.createItem(args, context);
      case "update_item_metadata":
        return this.updateItemMetadata(args);
      case "batch_update_tags":
        return this.batchUpdateTags(args, context);
      case "link_related_items":
        return this.linkRelated(args);
      case "create_note":
        return this.createNote(args, context);
      case "propose_note":
        return this.proposeNote(args, context);
      case "append_to_note":
        return this.appendToNote(args, context);
      case "update_note":
        return this.updateNote(args, context);
      case "attach_file":
        return this.attachFile(args, context);
      case "get_outline":
      case "list_sections":
        return this.getOutline(name, args);
      case "get_paper_section":
        return this.getPaperSection(args);
      case "get_pages":
        return this.getPages(args, signal, context);
      case "get_page_count":
        return this.getPageCount(args, signal, context);
      case "search_paper_content":
      case "search_with_regex":
        return this.searchPaper(name, args, signal, context);
      case "get_annotations":
        return this.getAnnotations(args, context);
      case "get_pdf_selection":
        return this.getPdfSelection(args);
      case "inspect_pdf_page":
        return this.inspectPdfPage(args, signal, context);
      case "open_item":
        return this.openItem(args);
      case "propose_highlights":
        return this.proposeHighlights(args, context);
      case "propose_annotations":
        return this.proposeAnnotations(args, context);
      case "commit_annotations":
        return this.commitAnnotations(args, context, signal);
      case "update_annotation":
      case "update_annotation_comment":
        return this.updateAnnotation(name, args, context);
      case "delete_annotation":
        return this.deleteAnnotation(args, context);
      default:
        return fail(name, "not_found", `Unknown Zotero tool: ${name}`);
    }
  }

  private async searchItems(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return fail("search_items", "invalid_args", "query is required");
    }
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search({ libraryID });
    const field = String(args.field ?? "everywhere");
    if (field === "title") {
      search.addCondition("title", "contains", query);
    } else if (field === "creator") {
      search.addCondition("creator", "contains", query);
    } else if (field === "tag") {
      search.addCondition("tag", "is", query);
    } else {
      search.addCondition("quicksearch-titleCreatorYear", "contains", query);
    }
    const ids = await search.search();
    const limit = Math.min(Number(args.limit) || 20, 50);
    const items = await Zotero.Items.getAsync(ids.slice(0, limit));
    return ok("search_items", {
      query,
      libraryID,
      total: ids.length,
      items: items.map(summarizeItem),
    });
  }

  private async searchFulltext(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return fail("search_fulltext", "invalid_args", "query is required");
    }
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search({ libraryID });
    search.addCondition("fulltextContent", "contains", query);
    const ids = await search.search();
    const limit = Math.min(Number(args.limit) || 20, 50);
    const attachments = await Zotero.Items.getAsync(ids);
    attachments.sort((left, right) =>
      String(right.dateModified || "").localeCompare(
        String(left.dateModified || ""),
      ),
    );
    const seen = new Set<number>();
    const items: Zotero.Item[] = [];
    for (const attachment of attachments) {
      const item = attachment.parentItemID
        ? Zotero.Items.get(attachment.parentItemID)
        : attachment;
      if (!item || seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      items.push(item);
      if (items.length >= limit) {
        break;
      }
    }
    const summaries = items.map((item) => {
      const parent = item.parentItemID
        ? Zotero.Items.get(item.parentItemID)
        : item;
      return summarizeItem(parent || item);
    });
    return ok("search_fulltext", {
      query,
      libraryID,
      total: ids.length,
      items: summaries,
    });
  }

  private async searchNotes(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return fail("search_notes", "invalid_args", "query is required");
    }
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search({ libraryID });
    search.addCondition("note", "contains", query);
    const indexedIds = await search.search();
    // Zotero's note-search index is eventually consistent after a write. Add
    // recent notes from the source table so an update is immediately visible,
    // then filter the merged set against the current note body to discard
    // stale index hits. The indexed results still cover older matching notes.
    const recentIds = await Zotero.DB.columnQueryAsync<number>(
      `SELECT N.itemID
         FROM itemNotes N
         JOIN items I USING (itemID)
        WHERE I.libraryID = ?
        ORDER BY I.dateModified DESC
        LIMIT 500`,
      [libraryID],
    );
    const candidates = await Zotero.Items.getAsync([
      ...new Set([...recentIds, ...indexedIds]),
    ]);
    const normalizedQuery = query.toLocaleLowerCase();
    const items = candidates
      .filter(
        (item) =>
          item.isNote?.() &&
          String(item.getNote?.() || "")
            .toLocaleLowerCase()
            .includes(normalizedQuery),
      )
      .sort((left, right) =>
        String(right.dateModified || "").localeCompare(
          String(left.dateModified || ""),
        ),
      )
      .slice(0, 20);
    return ok("search_notes", {
      query,
      items: items.map((item) => ({
        ...summarizeItem(item),
        note: (item.getNote?.() || "").replace(/<[^>]+>/g, " ").slice(0, 400),
      })),
    });
  }

  private async searchByTag(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tag = String(args.tag ?? "").trim();
    if (!tag) {
      return fail("search_by_tag", "invalid_args", "tag is required");
    }
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search({ libraryID });
    search.addCondition("tag", "is", tag);
    const ids = await search.search();
    const items = await Zotero.Items.getAsync(ids.slice(0, 30));
    return ok("search_by_tag", { tag, items: items.map(summarizeItem) });
  }

  private getItem(toolName: string, args: Record<string, unknown>): ToolResult {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail(toolName, "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail(toolName, "not_found", "Item not found");
    }
    return ok(toolName, {
      ...summarizeItem(item),
      extra: item.getField?.("extra") || "",
      abstract: item.getField?.("abstractNote") || "",
      url: item.getField?.("url") || "",
    });
  }

  private getItemNotes(args: Record<string, unknown>): ToolResult {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_item_notes", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("get_item_notes", "not_found", "Item not found");
    }
    const notes = (item.getNotes?.() || []).map((id) => {
      const note = Zotero.Items.get(id);
      return note
        ? {
            libraryID: note.libraryID,
            key: note.key,
            zoteroUri: buildSelectUri(
              note.key,
              groupIDForLibrary(note.libraryID),
            ),
            preview: (note.getNote?.() || "")
              .replace(/<[^>]+>/g, " ")
              .trim()
              .slice(0, 240),
          }
        : null;
    });
    return ok("get_item_notes", { notes: notes.filter(Boolean) });
  }

  private getNoteContent(args: Record<string, unknown>): ToolResult {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_note_content", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item?.isNote?.()) {
      return fail("get_note_content", "not_found", "Note not found");
    }
    return ok("get_note_content", {
      libraryID: item.libraryID,
      key: item.key,
      zoteroUri: buildSelectUri(item.key, groupIDForLibrary(item.libraryID)),
      html: (item.getNote?.() || "").slice(0, MAX_NOTE),
    });
  }

  private getCollections(args: Record<string, unknown>): ToolResult {
    const libraryID = defaultLibraryID(args);
    const parentKey = args.parentKey ? String(args.parentKey) : "";
    let collections: Zotero.Collection[];
    if (parentKey) {
      const parent = Zotero.Collections.getByLibraryAndKey(
        libraryID,
        parentKey,
      );
      if (!parent) {
        return fail(
          "get_collections",
          "not_found",
          "Parent collection not found",
        );
      }
      collections = parent.getChildCollections();
    } else {
      collections = Zotero.Collections.getByLibrary(libraryID).filter(
        (collection) => !collection.parentID,
      );
    }
    return ok("get_collections", {
      libraryID,
      collections: collections.map((collection) => ({
        libraryID,
        key: collection.key,
        name: collection.name,
        itemCount: collection.getChildItems().length,
      })),
    });
  }

  private getCollectionItems(args: Record<string, unknown>): ToolResult {
    const libraryID = defaultLibraryID(args);
    const key = String(args.key ?? "");
    const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
    if (!collection) {
      return fail("get_collection_items", "not_found", "Collection not found");
    }
    const limit = Math.min(Number(args.limit) || 30, 100);
    const items = collection.getChildItems().slice(0, limit);
    return ok("get_collection_items", {
      libraryID,
      key,
      name: collection.name,
      items: items.map(summarizeItem),
    });
  }

  private async getTags(args: Record<string, unknown>): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const tags = await Zotero.Tags.getAll(libraryID);
    const names = (Array.isArray(tags) ? tags : [])
      .slice(0, 200)
      .map((tag) =>
        typeof tag === "string"
          ? tag
          : String((tag as { tag?: string }).tag || tag),
      );
    return ok("get_tags", { libraryID, tags: names });
  }

  private async getRecent(args: Record<string, unknown>): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search({ libraryID });
    search.addCondition("dateModified", "isInTheLast", "30 days");
    const ids = await search.search();
    const limit = Math.min(Number(args.limit) || 20, 50);
    const items = await Zotero.Items.getAsync(ids);
    const recent = items
      .sort((left, right) =>
        String(right.dateModified || "").localeCompare(
          String(left.dateModified || ""),
        ),
      )
      .slice(0, limit);
    return ok("get_recent", { items: recent.map(summarizeItem) });
  }

  private listSavedSearches(args: Record<string, unknown>): ToolResult {
    const libraryID = defaultLibraryID(args);
    const searches =
      (
        Zotero.Searches as unknown as {
          getByLibrary?: (id: number) => Array<{ key: string; name: string }>;
        }
      ).getByLibrary?.(libraryID) || [];
    return ok("list_saved_searches", {
      searches: searches.map((search) => ({
        libraryID,
        key: search.key,
        name: search.name,
      })),
    });
  }

  private async runSavedSearch(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const key = String(args.key ?? "");
    const saved = Zotero.Searches.getByLibraryAndKey(libraryID, key);
    if (!saved) {
      return fail("run_saved_search", "not_found", "Saved search not found");
    }
    const ids = await saved.search();
    const items = await Zotero.Items.getAsync(ids.slice(0, 30));
    return ok("run_saved_search", {
      key,
      items: items.map(summarizeItem),
    });
  }

  private getRelated(args: Record<string, unknown>): ToolResult {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_related_items", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("get_related_items", "not_found", "Item not found");
    }
    const related = (item.relatedItems || []).map((relKey: string) => {
      const relatedItem = getItem(ref.libraryID, relKey);
      return relatedItem ? summarizeItem(relatedItem) : { key: relKey };
    });
    return ok("get_related_items", { items: related });
  }

  private async createCollection(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const name = String(args.name ?? "").trim();
    if (!name) {
      return fail("create_collection", "invalid_args", "name is required");
    }
    const libraryID = defaultLibraryID(args);
    const collection = new Zotero.Collection();
    (collection as unknown as { libraryID: number }).libraryID = libraryID;
    if (context.plannedKeys?.collection) {
      (collection as unknown as { key: string }).key =
        context.plannedKeys.collection;
      // Assigning a key identifies the object in Zotero, even before it exists.
      // Its public loader must establish the missing-object state before edits.
      await collection.loadPrimaryData(false);
    }
    collection.name = name;
    const parentKey = args.parentKey ? String(args.parentKey) : "";
    if (parentKey) {
      const parent = Zotero.Collections.getByLibraryAndKey(
        libraryID,
        parentKey,
      );
      if (!parent) {
        return fail(
          "create_collection",
          "not_found",
          "Parent collection not found",
        );
      }
      collection.parentID = parent.id;
    }
    await collection.saveTx();
    return ok("create_collection", {
      libraryID,
      key: collection.key,
      name: collection.name,
    });
  }

  private async renameCollection(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const key = String(args.key ?? "");
    const name = String(args.name ?? "").trim();
    const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
    if (!collection) {
      return fail("rename_collection", "not_found", "Collection not found");
    }
    try {
      await Zotero.DB.executeTransaction(async () => {
        collection.name = name;
        await collection.save();
      });
    } catch (error) {
      await collection.reload?.(["primaryData"], true).catch(() => undefined);
      throw new RolledBackWrite(
        `Collection transaction rolled back: ${String(error)}`,
      );
    }
    return ok("rename_collection", { libraryID, key, name });
  }

  private async addToCollection(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const item = getItem(libraryID, String(args.key ?? ""));
    const collection = Zotero.Collections.getByLibraryAndKey(
      libraryID,
      String(args.collectionKey ?? ""),
    );
    if (!item || !collection) {
      return fail(
        "add_to_collection",
        "not_found",
        "Item or collection not found",
      );
    }
    await atomicItems([item], async () => {
      item.addToCollection(collection.id);
      await item.save();
    });
    return ok("add_to_collection", {
      libraryID,
      key: item.key,
      collectionKey: collection.key,
    });
  }

  private async removeFromCollection(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const item = getItem(libraryID, String(args.key ?? ""));
    const collection = Zotero.Collections.getByLibraryAndKey(
      libraryID,
      String(args.collectionKey ?? ""),
    );
    if (!item || !collection) {
      return fail(
        "remove_from_collection",
        "not_found",
        "Item or collection not found",
      );
    }
    await atomicItems([item], async () => {
      item.removeFromCollection(collection.id);
      await item.save();
    });
    return ok("remove_from_collection", {
      libraryID,
      key: item.key,
      collectionKey: collection.key,
    });
  }

  private async createSavedSearch(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const name = String(args.name ?? "").trim();
    const query = String(args.query ?? "").trim();
    if (!name || !query) {
      return fail(
        "create_saved_search",
        "invalid_args",
        "name and query are required",
      );
    }
    const libraryID = defaultLibraryID(args);
    const search = new Zotero.Search({ libraryID });
    if (context.plannedKeys?.search) {
      (search as unknown as { key: string }).key = context.plannedKeys.search;
      await search.loadPrimaryData(false);
    }
    search.name = name;
    search.addCondition("title", "contains", query);
    await search.saveTx();
    return ok("create_saved_search", {
      libraryID,
      key: search.key,
      name,
      query,
    });
  }

  private async addItem(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const identifier = String(args.identifier ?? "").trim();
    if (!identifier) {
      return fail("add_item", "invalid_args", "identifier is required");
    }
    const libraryID = defaultLibraryID(args);
    const identifiers = Zotero.Utilities.extractIdentifiers(identifier);
    if (!identifiers?.length) {
      return fail(
        "add_item",
        "invalid_args",
        "Could not parse DOI, ISBN, PMID, or arXiv id",
      );
    }
    const collections: number[] = [];
    if (args.collectionKey) {
      const collection = Zotero.Collections.getByLibraryAndKey(
        libraryID,
        String(args.collectionKey),
      );
      if (!collection) {
        return fail("add_item", "not_found", "Collection not found");
      }
      collections.push(collection.id);
    }
    const translate = new (
      Zotero.Translate as unknown as {
        Search: new () => {
          setIdentifier: (id: unknown) => void;
          getTranslators: () => Promise<unknown[]>;
          setTranslator: (translators: unknown) => void;
          translate: (opts: unknown) => Promise<Zotero.Item[]>;
        };
      }
    ).Search();
    translate.setIdentifier(identifiers[0]);
    const translators = await translate.getTranslators();
    if (!translators?.length) {
      return fail(
        "add_item",
        "unavailable",
        "No translator for that identifier",
      );
    }
    translate.setTranslator(translators);
    const before = new Set(
      await Zotero.Items.getAll(libraryID, false, false, true),
    );
    let items: Zotero.Item[] = [];
    let translatorError: unknown;
    try {
      items = await translate.translate({ libraryID, collections });
    } catch (error) {
      translatorError = error;
    }
    const newIds = (
      await Zotero.Items.getAll(libraryID, false, false, true)
    ).filter((id) => !before.has(id));
    if (translatorError || (!items?.length && newIds.length))
      return {
        ...fail(
          "add_item",
          "unavailable",
          `Translator outcome requires verification; no fallback import was started: ${String(translatorError ?? "Items appeared in the library without a translator response")}`,
          {
            createdCandidates: newIds
              .map((id) => asItem(Zotero.Items.get(id)))
              .filter((item): item is Zotero.Item => Boolean(item))
              .map(summarizeItem),
          },
        ),
        effect: "unknown",
      };
    if (!items?.length) {
      const doi = doiFromIdentifier(identifier);
      if (doi) {
        try {
          items = [await importDoiFromCsl(doi, libraryID, collections)];
        } catch (error) {
          const first =
            translatorError instanceof Error
              ? translatorError.message
              : "translator returned no items";
          const second = error instanceof Error ? error.message : String(error);
          return {
            ...fail(
              "add_item",
              "unavailable",
              `Identifier lookup failed (${first}); DOI fallback outcome requires verification (${second})`,
            ),
            effect: "unknown",
          };
        }
      }
    }
    if (!items?.length) {
      return fail(
        "add_item",
        translatorError ? "unavailable" : "not_found",
        translatorError instanceof Error
          ? translatorError.message
          : "Lookup returned no items",
      );
    }
    const warnings: string[] = [];
    const recordKey = `import_${await runtimeDigest(String(context.operationId ?? Date.now()))}`;
    const imported = items.map(summarizeItem);
    const record = {
      version: 1,
      items: imported,
      itemCreation: "applied",
      attachments: "pending",
    };
    try {
      await this.storage.write(recordKey, record);
    } catch (error) {
      return {
        ...ok("add_item", {
          items: imported,
          itemCreation: "applied",
          attachmentsComplete: false,
        }),
        effect: "partial",
        warnings: [
          `Items were saved, but their receipt could not be persisted; attachment retrieval was deferred: ${String(error)}`,
        ],
      };
    }
    // Keep this promise alive so a late download updates its own stage receipt.
    this.pendingDownloads.add(recordKey);
    const attachments = Zotero.Attachments.addAvailableFiles(items)
      .then(
        async () => {
          record.attachments = "complete";
          await this.storage.write(recordKey, record);
        },
        async (error) => {
          record.attachments = "failed";
          await this.storage.write(recordKey, record);
          throw error;
        },
      )
      .finally(() => this.pendingDownloads.delete(recordKey));
    try {
      await deadline(attachments, 60_000, context.signal);
    } catch (error) {
      if (this.pendingDownloads.has(recordKey)) record.attachments = "unknown";
      warnings.push(
        `Items were imported; automatic attachment retrieval did not finish: ${String(error)}. Verify attachments before adding them again.`,
      );
    }
    try {
      await this.storage.write(recordKey, record);
    } catch (error) {
      warnings.push(`Import stage receipt is not saved: ${String(error)}`);
    }
    const data = {
      items: imported,
      itemCreation: "applied",
      attachmentsComplete: record.attachments === "complete",
      attachmentOutcome: record.attachments,
    };
    if (record.attachments === "unknown")
      return {
        ...fail(
          "add_item",
          "timeout",
          "Items were created, but attachment downloads are still unresolved; inspect their attachments before another write",
          data,
        ),
        effect: "unknown",
        warnings,
      };
    return {
      ...ok("add_item", data),
      effect: warnings.length ? "partial" : "applied",
      warnings,
    };
  }

  private async createItem(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const itemType = String(args.itemType ?? "journalArticle");
    const title = String(args.title ?? "").trim();
    if (!title) {
      return fail("create_item", "invalid_args", "title is required");
    }
    const item = new Zotero.Item(itemType as never);
    (item as unknown as { libraryID: number }).libraryID =
      defaultLibraryID(args);
    if (context.plannedKeys?.item) {
      item.key = context.plannedKeys.item;
      await item.loadPrimaryData(false);
    }
    item.setField("title", title);
    const extra = args.extra as Record<string, string> | undefined;
    if (extra) {
      for (const [field, value] of Object.entries(extra)) {
        item.setField(field, value);
      }
    }
    await item.saveTx();
    return ok("create_item", summarizeItem(item));
  }

  private async updateItemMetadata(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("update_item_metadata", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    const fields = args.fields as Record<string, string> | undefined;
    if (!item)
      return fail("update_item_metadata", "not_found", "Item not found");
    if (!fields || !Object.keys(fields).length)
      return fail("update_item_metadata", "invalid_args", "fields required");
    try {
      const probe = new Zotero.Item(item.itemType as never);
      for (const [field, value] of Object.entries(fields)) {
        if (typeof value !== "string" && typeof value !== "number")
          throw new Error(`Invalid value for ${field}`);
        probe.setField(field, value);
      }
    } catch (error) {
      return fail("update_item_metadata", "invalid_args", String(error));
    }
    await atomicItems([item], async () => {
      for (const [field, value] of Object.entries(fields))
        item.setField(field, value);
      await item.save();
    });
    return ok("update_item_metadata", summarizeItem(item));
  }

  private async batchUpdateTags(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("batch_update_tags", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("batch_update_tags", "not_found", "Item not found");
    }
    await atomicItems([item], async () => {
      for (const tag of (args.add as string[]) || []) item.addTag(tag);
      for (const tag of (args.remove as string[]) || []) item.removeTag(tag);
      await item.save();
    });
    if (item.isAnnotation?.() && item.parentItemID) {
      const parent = asItem(Zotero.Items.get(item.parentItemID));
      if (parent)
        await this.ownership.modified(
          `${parent.libraryID}_${parent.key}`,
          item.key,
          this.ownerContext(context),
          Date.now(),
        );
    }
    return ok("batch_update_tags", {
      ...summarizeItem(item),
      tags: item.getTags?.() || [],
    });
  }

  private async linkRelated(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const libraryID = defaultLibraryID(args);
    const item = getItem(libraryID, String(args.key ?? ""));
    const other = getItem(libraryID, String(args.relatedKey ?? ""));
    if (!item || !other) {
      return fail("link_related_items", "not_found", "Item not found");
    }
    await atomicItems([item, other], async () => {
      item.addRelatedItem(other);
      other.addRelatedItem(item);
      await item.save();
      await other.save();
    });
    return ok("link_related_items", {
      key: item.key,
      relatedKey: other.key,
    });
  }

  private async createNote(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const content = String(args.content ?? "").trim();
    if (!content) {
      return fail("create_note", "invalid_args", "content is required");
    }
    const note = new Zotero.Item("note");
    note.libraryID = defaultLibraryID(args);
    if (context.plannedKeys?.item) {
      note.key = context.plannedKeys.item;
      await note.loadPrimaryData(false);
    }
    note.setNote(noteHtml(content));
    if (args.parentKey) {
      const parent = getItem(note.libraryID, String(args.parentKey));
      if (!parent)
        return fail(
          "create_note",
          "not_found",
          "Explicit parent was not found",
        );
      note.parentID = parent.id;
    }
    await note.saveTx();
    return ok("create_note", { libraryID: note.libraryID, key: note.key });
  }

  /**
   * Approval-gated note write. The draft ({title, markdown}) is what the
   * approval card shows; when allowed, this runs and creates the note.
   * Parent is resolved from the explicit reference or fixed task source before approval.
   */
  private async proposeNote(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const title = String(args.title ?? "").trim();
    const markdown = String(args.markdown ?? "").trim();
    if (!title || !markdown) {
      return fail(
        "propose_note",
        "invalid_args",
        "title and markdown are required",
      );
    }
    const parent = args.parentKey
      ? getItem(defaultLibraryID(args), String(args.parentKey))
      : null;
    if (!parent)
      return fail(
        "propose_note",
        "not_found",
        "Explicit or fixed task parent was not found",
      );
    const note = new Zotero.Item("note");
    note.libraryID = parent ? parent.libraryID : defaultLibraryID(args);
    if (context.plannedKeys?.item) {
      note.key = context.plannedKeys.item;
      await note.loadPrimaryData(false);
    }
    note.setNote(markdownToNoteHtml(`# ${title}\n\n${markdown}`));
    if (parent) {
      note.parentID = parent.id;
    }
    await note.saveTx();
    return ok("propose_note", {
      libraryID: note.libraryID,
      key: note.key,
      title,
      parentKey: parent?.key ?? null,
    });
  }

  private async appendToNote(
    args: Record<string, unknown>,
    _context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("append_to_note", "invalid_args", ref.message);
    }
    const note = getItem(ref.libraryID, ref.key);
    if (!note?.isNote?.()) {
      return fail("append_to_note", "not_found", "Note not found");
    }
    note.setNote(`${note.getNote()}${noteHtml(String(args.content ?? ""))}`);
    await note.saveTx();
    return ok("append_to_note", { libraryID: note.libraryID, key: note.key });
  }

  private async updateNote(
    args: Record<string, unknown>,
    _context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("update_note", "invalid_args", ref.message);
    }
    const note = getItem(ref.libraryID, ref.key);
    if (!note?.isNote?.()) {
      return fail("update_note", "not_found", "Note not found");
    }
    note.setNote(noteHtml(String(args.content ?? "")));
    await note.saveTx();
    return ok("update_note", { libraryID: note.libraryID, key: note.key });
  }

  private async attachFile(
    args: Record<string, unknown>,
    _context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("attach_file", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("attach_file", "not_found", "Item not found");
    }

    const path = String(args.path ?? args.filePath ?? args.file ?? "").trim();
    const url = String(args.url ?? "").trim();
    if ((!path && !url) || (path && url)) {
      return fail(
        "attach_file",
        "invalid_args",
        "Provide exactly one of path or url",
      );
    }

    let attachment: Zotero.Item;
    let source: "path" | "url";
    if (path) {
      if (!(await IOUtils.exists(path))) {
        return fail(
          "attach_file",
          "not_found",
          `Local file not found: ${path}`,
        );
      }
      const stat = await IOUtils.stat(path);
      if (stat.type !== "regular") {
        return fail(
          "attach_file",
          "invalid_args",
          "path must point to a regular file",
        );
      }
      attachment = await Zotero.Attachments.importFromFile({
        file: path,
        parentItemID: item.id,
      });
      source = "path";
    } else {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return fail(
          "attach_file",
          "invalid_args",
          "url must be a valid HTTP(S) URL; use path for local files",
        );
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return fail(
          "attach_file",
          "invalid_args",
          "url must use HTTP(S); use path for local files",
        );
      }
      attachment = await Zotero.Attachments.importFromURL({
        url: parsed.href,
        parentItemID: item.id,
      });
      source = "url";
    }
    return ok("attach_file", {
      libraryID: attachment.libraryID,
      key: attachment.key,
      parentKey: item.key,
      source,
    });
  }

  private async getOutline(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail(toolName, "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail(toolName, "not_found", "Item not found");
    }
    const text = await pdfText(item, args.attachmentKey as string | undefined);
    if (!text) {
      return fail(toolName, "unavailable", "No indexed PDF text for this item");
    }
    const sections = parseSections(text);
    return ok(toolName, {
      libraryID: ref.libraryID,
      key: ref.key,
      sections: sections.map((section) => ({
        name: section.name,
        normalizedName: section.normalizedName,
        chars: section.content.length,
      })),
    });
  }

  private async getPaperSection(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_paper_section", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("get_paper_section", "not_found", "Item not found");
    }
    const text = await pdfText(item, args.attachmentKey as string | undefined);
    if (!text) {
      return fail("get_paper_section", "unavailable", "No indexed PDF text");
    }
    const section = findSection(
      parseSections(text),
      String(args.section ?? ""),
    );
    if (!section) {
      return fail("get_paper_section", "not_found", "Section not found");
    }
    return ok("get_paper_section", {
      libraryID: ref.libraryID,
      key: ref.key,
      section: section.normalizedName,
      content: section.content.slice(0, MAX_NOTE),
    });
  }

  private async physicalPageText(
    pdf: Zotero.Item,
    view: PdfPrimaryView,
    page: number,
  ): Promise<string> {
    const key = `${await pdfFingerprint(pdf)}:${page}`;
    const cached = this.pageTextCache.get(key);
    if (cached !== undefined) return cached;
    const chars = await pageChars(view, page - 1);
    let text = chars.map(charText).join("");
    if (!text) {
      const content = await (
        await readerPdfPage(view, page)
      ).getTextContent?.();
      text =
        content?.items
          .map((item) => `${item.str ?? ""}${item.hasEOL ? "\n" : " "}`)
          .join("") ?? "";
    }
    if (this.pageTextCache.size >= 128)
      this.pageTextCache.delete(this.pageTextCache.keys().next().value!);
    this.pageTextCache.set(key, text);
    return text;
  }

  private async getPages(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const item = getItem(defaultLibraryID(args), String(args.key));
    const pdf = item
      ? await findPdf(item, args.attachmentKey as string | undefined)
      : null;
    if (!pdf) return fail("get_pages", "not_found", "PDF attachment not found");
    const progress = new ToolProgress(context, signal);
    try {
      const { view } = await progress.run(
        "opening_and_initializing_pdf",
        30_000,
        () => waitForPdfReader(pdf, progress),
      );
      const count = readerPdfDocument(view)?.numPages;
      if (!count)
        return fail(
          "get_pages",
          "unavailable",
          "Physical PDF page count is unavailable",
        );
      const start = Number(args.start ?? 1),
        end = Number(args.end ?? start);
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start ||
        end > count ||
        end - start >= 50
      )
        return fail(
          "get_pages",
          "invalid_args",
          `Use physical pages 1-${count}, at most 50 pages per call`,
        );
      const pages = [];
      const fingerprint = await pdfFingerprint(pdf);
      for (let page = start; page <= end; page++) {
        const { text, anchored, truncated } = await progress.run(
          `extracting_page_${page}`,
          10_000,
          async () => {
            const chars = await pageChars(view, page - 1);
            if (!chars.length)
              return {
                text: await this.physicalPageText(pdf, view, page),
                anchored: false,
                truncated: false,
              };
            const passages = await pdfPassages(
              chars,
              page,
              fingerprint,
              runtimeDigest,
            );
            return {
              ...renderPdfPassages(passages, 50_000),
              anchored: passages.some((p) => p.anchor),
            };
          },
        );
        pages.push({
          page,
          zoteroUri: buildOpenPdfUri(pdf.key, {
            page,
            groupID: groupIDForLibrary(pdf.libraryID),
          }),
          text: text.slice(0, 50_000),
          truncated: truncated || text.length > 50_000,
          ...(anchored
            ? {
                anchorFormat:
                  "Each [anchor:ID] or [unanchored] starts a passage. Pass ID as annotation.anchor to commit_annotations; omit page and quote. Unanchored passages have no selectable reference.",
              }
            : {}),
        });
      }
      return ok("get_pages", {
        libraryID: pdf.libraryID,
        key: args.key,
        attachmentKey: pdf.key,
        pageCount: count,
        pageSource: "pdf_physical",
        pages,
      });
    } finally {
      progress.close();
    }
  }

  private async getPageCount(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const item = getItem(defaultLibraryID(args), String(args.key));
    const pdf = item
      ? await findPdf(item, args.attachmentKey as string | undefined)
      : null;
    if (!pdf)
      return fail("get_page_count", "not_found", "PDF attachment not found");
    const progress = new ToolProgress(context, signal);
    try {
      const { view } = await progress.run(
        "opening_and_initializing_pdf",
        30_000,
        () => waitForPdfReader(pdf, progress),
      );
      const pageCount = readerPdfDocument(view)?.numPages;
      if (!pageCount)
        return fail(
          "get_page_count",
          "unavailable",
          "Physical page count unavailable; indexed text cannot establish PDF pagination",
        );
      return ok("get_page_count", {
        libraryID: pdf.libraryID,
        key: args.key,
        attachmentKey: pdf.key,
        pageCount,
        pageSource: "pdf_physical",
      });
    } finally {
      progress.close();
    }
  }

  private async searchPaper(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const item = getItem(defaultLibraryID(args), String(args.key));
    if (!item) return fail(toolName, "not_found", "Item not found");
    const pdf = await findPdf(item, args.attachmentKey as string | undefined);
    if (!pdf) return fail(toolName, "not_found", "PDF attachment not found");
    const query = String(args.query ?? args.pattern ?? "");
    const progress = new ToolProgress(context, signal);
    let subject = "",
      pages: Array<{ page: number; start: number }> = [],
      nextPage: number | null = null;
    let pageSource = "pdf_physical",
      warning: string | undefined;
    try {
      try {
        const { view } = await progress.run(
          "opening_and_initializing_pdf",
          30_000,
          () => waitForPdfReader(pdf, progress),
        );
        const count = readerPdfDocument(view)?.numPages ?? 0;
        const start = Number(args.start ?? 1);
        if (!Number.isInteger(start) || start < 1 || start > count)
          return fail(
            toolName,
            "invalid_args",
            "Search start must be an existing physical page",
          );
        for (let page = start; page <= count; page++) {
          const text = await progress.run(
            `extracting_page_${page}`,
            10_000,
            () => this.physicalPageText(pdf, view, page),
          );
          pages.push({ page, start: subject.length });
          subject += text + "\n\f\n";
          if (subject.length >= 500_000 || page - start >= 49) {
            nextPage = page < count ? page + 1 : null;
            break;
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        subject =
          (await deadline(
            Promise.resolve(pdf.attachmentText),
            10_000,
            signal,
          )) || "";
        pageSource = "indexed_unpaged";
        pages = [];
        warning = `Physical PDF extraction unavailable: ${String(error)}. Hits have no reliable page number.`;
      }
      const truncated = subject.length > 500_000 || nextPage !== null;
      subject = subject.slice(0, 500_000);
      const hits =
        toolName === "search_with_regex"
          ? await regexMatches(query, subject, signal)
          : literalMatches(query, subject);
      return ok(toolName, {
        libraryID: pdf.libraryID,
        key: args.key,
        attachmentKey: pdf.key,
        query,
        pageSource,
        warning,
        truncated: truncated || hits.length > 20,
        hitsTruncated: hits.length > 20,
        maxHits: 20,
        nextPage,
        hits: hits.slice(0, 20).map((hit) => ({
          ...hit,
          page:
            pages.filter((page) => page.start <= hit.index).at(-1)?.page ??
            null,
        })),
      });
    } finally {
      progress.close();
    }
  }

  private async getAnnotations(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const item = getItem(defaultLibraryID(args), String(args.key));
    if (!item) return fail("get_annotations", "not_found", "Item not found");
    const pdf = await findPdf(item, args.attachmentKey as string | undefined);
    if (!pdf)
      return fail("get_annotations", "not_found", "PDF attachment not found");
    const token = `${pdf.libraryID}_${pdf.key}`;
    return this.annotationLocks.run([token], async () => {
      await pdf.reload?.(["childItems"], true);
      const all = readPdfAnnotations(pdf);
      const ownershipWarnings: string[] = [];
      const ownership = await this.restoreLegacyOwnership(pdf)
        .then(() => this.ownership.read(token))
        .catch((error) => {
          ownershipWarnings.push(
            `Annotation provenance store unavailable; origin remains unknown: ${String(error)}`,
          );
          return { marks: {}, batches: {} } as Pick<
            import("./AnnotationOwnership").PdfOwnership,
            "marks" | "batches"
          >;
        });
      const annotations = all
        .map((mark) => {
          const provenance =
            ownership.marks[mark.key]?.status === "created"
              ? ownership.marks[mark.key]
              : undefined;
          const batch = provenance?.batchId
            ? ownership.batches[provenance.batchId]?.batch
            : undefined;
          return {
            ...mark,
            provenance,
            batch,
            batchName: batch?.name ?? "原有标注",
            editableByAgent: !!provenance,
          };
        })
        .filter(
          (mark) =>
            !args.batchIds ||
            annotationMatchesFilter(mark.batch?.id, {
              mode: "selected",
              batchIds: args.batchIds as string[],
              includeExisting: args.includeExisting === true,
            }),
        );
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? 25);
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50
      )
        return fail(
          "get_annotations",
          "invalid_args",
          "Use offset >= 0 and limit between 1 and 50",
        );
      const data = {
        libraryID: pdf.libraryID,
        key: item.key,
        attachmentKey: pdf.key,
        annotationKey: annotations[0]?.key,
        annotations: annotations.slice(offset, offset + limit),
        totalAnnotations: annotations.length,
        nextOffset: offset + limit < annotations.length ? offset + limit : null,
      };
      try {
        const record = await this.loadAnnotationRecord(token);
        const proposals = Object.values(record.proposals).filter(
          (proposal) => proposal.taskId === (context.taskId ?? "local"),
        );
        for (const proposal of proposals)
          await this.projectAnnotationOutcomes(proposal, pdf, all, true);
        return {
          ...ok("get_annotations", {
            ...data,
            proposals: proposals.map((proposal) => ({
              proposalId: proposal.id,
              entries: proposal.entries.map(
                ({ id, status, annotationKey, error, raw, reviewIssue }) => ({
                  id,
                  status,
                  annotationKey,
                  error,
                  draft: raw,
                  reviewIssue,
                }),
              ),
            })),
          }),
          warnings: ownershipWarnings,
        };
      } catch (error) {
        return {
          ...ok("get_annotations", data),
          warnings: [
            `Zotero contents were read, but the local proposal or receipt store is unavailable: ${String(error)}`,
          ],
        };
      }
    });
  }

  private getPdfSelection(_args: Record<string, unknown>): ToolResult {
    try {
      const reader = Zotero.Reader.getByTabID?.(
        Zotero.getMainWindow()?.Zotero_Tabs?.selectedID,
      ) as unknown as PdfReaderInstance | undefined;
      const view = reader?._internalReader?._primaryView;
      const ranges = view?._selectionRanges || [];
      const selected = view?._getAnnotationFromSelectionRanges?.(
        ranges,
        "highlight",
      );
      const fallbackText = ranges
        .map((range) =>
          range && typeof range === "object"
            ? String((range as { text?: unknown }).text ?? "")
            : "",
        )
        .filter(Boolean)
        .join(" ");
      const position = selected?.position;
      const attachment = reader?.itemID
        ? asItem(Zotero.Items.get(reader.itemID))
        : null;
      return ok("get_pdf_selection", {
        text: selected?.text || fallbackText,
        libraryID: attachment?.libraryID,
        attachmentKey: attachment?.key,
        page: position ? position.pageIndex + 1 : undefined,
        pageLabel: selected?.pageLabel || "",
        position: position || null,
      });
    } catch {
      return ok("get_pdf_selection", { text: "", position: null });
    }
  }

  private async inspectPdfPage(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("inspect_pdf_page", "invalid_args", ref.message);
    }
    const pageNumber = Number(args.page);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return fail(
        "inspect_pdf_page",
        "invalid_args",
        "page must be a positive integer",
      );
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("inspect_pdf_page", "not_found", "Item not found");
    }
    const pdf = await findPdf(item, args.attachmentKey as string | undefined);
    if (!pdf) {
      return fail(
        "inspect_pdf_page",
        "unavailable",
        "Item has no PDF attachment",
      );
    }
    const progress = new ToolProgress(context, signal);
    try {
      const { view } = await progress.run(
        "opening_and_initializing_pdf",
        30_000,
        () => waitForPdfReader(pdf, progress),
      );
      const document = readerPdfDocument(view);
      const pageCount = document?.numPages ?? 0;
      if (!document || pageNumber > pageCount) {
        return fail(
          "inspect_pdf_page",
          "invalid_args",
          `page must be between 1 and ${pageCount || "the PDF page count"}`,
        );
      }
      const { page, anchors } = await progress.run(
        "extracting_page",
        10_000,
        async () => {
          const page = await readerPdfPage(view, pageNumber);
          const viewport = readerPageViewport(view, page, 1);
          const chars = await pageChars(view, pageNumber - 1);
          return { page, anchors: pageLineAnchors(chars, viewport) };
        },
      );
      let image: ToolTransientMedia | undefined;
      let renderingWarning: string | undefined;
      let renderingAllowed = true;
      try {
        image = await progress.run("rendering_page", 20_000, () =>
          this.renderingLocks.run([`${pdf.libraryID}:${pdf.key}`], async () => {
            if (!renderingAllowed || signal?.aborted)
              throw new ToolTimeout(
                "Inspection cancelled or expired before rendering",
              );
            return renderPageImage(view, page, pageNumber);
          }),
        );
      } catch (error) {
        renderingAllowed = false;
        if (signal?.aborted) throw error;
        renderingWarning = String(error);
      }
      progress.setStage("returning_to_model");
      return ok(
        "inspect_pdf_page",
        {
          libraryID: pdf.libraryID,
          itemKey: item.key,
          attachmentKey: pdf.key,
          page: pageNumber,
          zoteroUri: buildOpenPdfUri(pdf.key, {
            page: pageNumber,
            groupID: groupIDForLibrary(pdf.libraryID),
          }),
          pageCount,
          coordinateSystem: {
            origin: "top-left",
            range: [0, 1000],
            rect: "[x,y,width,height]",
          },
          spatialText: spatialPageText(anchors),
          layoutGuidance:
            "Spatial text aligns fragments by page coordinates; keep monospaced spacing when checking table columns. It does not infer cell meanings or reading order. Prefer the page image for merged headers and use adjacent prose for definitions and denominators.",
          lineAnchors: anchors,
          visualAvailable: Boolean(image),
          renderingWarning,
          regionGuidance: image
            ? "Ground image regions in the attached transient page image and line anchors."
            : "Only text anchors are available. Do not guess image-region coordinates; omit image annotations.",
        },
        image ? [image] : undefined,
      );
    } finally {
      progress.close();
    }
  }

  private async openItem(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("open_item", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("open_item", "not_found", "Item not found");
    }
    const pane = Zotero.getActiveZoteroPane?.();
    pane?.selectItem?.(item.id);
    const pdf = await findPdf(item, args.attachmentKey as string | undefined);
    if (pdf) {
      const location = readerLocation(args);
      await Zotero.Reader.open(pdf.id, location as never);
    }
    return ok("open_item", summarizeItem(item));
  }

  private async loadAnnotationRecord(token: string): Promise<AnnotationRecord> {
    const value = await this.storage.read<
      Omit<AnnotationRecord, "version"> & {
        version: number;
        operations?: Record<string, ToolResult>;
        operationProposals?: Record<
          string,
          { proposalId: string; args: string; request?: string }
        >;
      }
    >(token);
    if (!value) return freshAnnotationRecord();
    if (![1, 2].includes(value.version) || !value.proposals || !value.latest)
      throw new Error(
        "Annotation proposal record is damaged; it was not replaced",
      );
    if (value.version === 1) {
      if (!this.operations)
        throw new Error(
          "Legacy annotation receipts require the operation repository for migration",
        );
      const [library, attachmentKey] = token.split("_");
      const resources = [`zotero:${library}:${attachmentKey}`];
      for (const [id, result] of Object.entries(value.operations ?? {})) {
        const binding = value.operationProposals?.[id];
        const data = (result.ok ? result.data : result.details) as
          { proposalId?: string } | undefined;
        const proposal =
          value.proposals[binding?.proposalId ?? data?.proposalId ?? ""];
        const args = binding
          ? JSON.parse(binding.args)
          : {
              libraryID: Number(library),
              key: attachmentKey,
              proposalId: proposal?.id,
            };
        await this.operations.importLegacyOperation({
          id,
          name: "commit_annotations",
          request: binding?.request,
          args,
          context: {
            taskId: proposal?.taskId,
            expectedAfter: {
              annotationEntries: canonical(proposal?.entries ?? []),
              annotationProposal: proposal?.id ?? "",
            },
          },
          resources,
          startedAt: 0,
          result,
        });
      }
      // Older proposals can predate per-operation receipts. Preserve their known writes in the canonical journal before removing the duplicated outcome fields.
      for (const proposal of Object.values(value.proposals)) {
        const completed = proposal.entries.filter(
          (entry) =>
            entry.annotationKey &&
            ["committed", "alreadyPresent"].includes(entry.status),
        );
        if (!completed.length) continue;
        await this.operations.importLegacyOperation({
          id: `legacy_annotation_${token}_${proposal.id}`,
          name: "commit_annotations",
          args: {
            libraryID: Number(library),
            key: attachmentKey,
            proposalId: proposal.id,
          },
          context: {
            taskId: proposal.taskId,
            expectedAfter: {
              annotationEntries: canonical(proposal.entries),
              annotationProposal: proposal.id,
            },
          },
          resources,
          startedAt: 0,
          result: {
            ...ok("commit_annotations", {
              proposalId: proposal.id,
              committed: completed,
            }),
            effect: "applied",
          },
        });
      }
      value.version = 2;
      await this.saveAnnotationRecord(token, {
        version: 2,
        proposals: value.proposals,
        latest: value.latest,
      });
    }
    return { version: 2, proposals: value.proposals, latest: value.latest };
  }

  private async saveAnnotationRecord(
    token: string,
    record: AnnotationRecord,
  ): Promise<void> {
    const proposals = Object.fromEntries(
      Object.entries(record.proposals).map(([id, proposal]) => [
        id,
        {
          ...proposal,
          entries: proposal.entries.map(
            ({ id, raw, draft, located, reviewIssue, status, error }) => ({
              id,
              raw,
              draft,
              located,
              reviewIssue,
              status: status === "skipped" && !draft ? "skipped" : "pending",
              error: status === "skipped" && !draft ? error : undefined,
            }),
          ),
        },
      ]),
    );
    await this.storage.write(token, {
      version: 2,
      proposals,
      latest: record.latest,
    });
  }

  private sameAnnotation(
    annotation: ReturnType<typeof readPdfAnnotations>[number],
    located: LocatedAnnotation,
  ): boolean {
    // An edited explanation or color is not permission to duplicate the same mark.
    return (
      annotation.type === located.type &&
      annotation.text === located.text &&
      canonical(annotation.position) === canonical(located.position)
    );
  }

  private operationAnnotationEntries(
    operation: OperationRecord,
  ): AnnotationEntry[] {
    const recovery = operation.intent?.recovery ?? operation.context;
    const after =
      recovery.expectedAfter as ToolExecutionContext["expectedAfter"];
    try {
      return JSON.parse(after?.annotationEntries ?? "[]") as AnnotationEntry[];
    } catch {
      return [];
    }
  }

  private async projectAnnotationOutcomes(
    proposal: AnnotationProposal,
    pdf: Zotero.Item,
    actual: ReturnType<typeof readPdfAnnotations>,
    includeResolved = false,
  ): Promise<void> {
    // Resolution is a projection of receipts in the candidate's current scope.
    // It must not survive a candidate being adopted by a later request.
    for (const entry of proposal.entries) {
      if (!entry.resolved) continue;
      delete entry.resolved;
      if (!entry.annotationKey) {
        entry.status = entry.draft ? "pending" : "skipped";
        if (entry.draft) entry.error = undefined;
      }
    }
    const operations =
      (await this.operations?.listOperations({
        name: "commit_annotations",
        resources: [`zotero:${pdf.libraryID}:${pdf.key}`],
      })) ?? [];
    for (const operation of operations) {
      const data = (
        operation.result?.ok
          ? operation.result.data
          : operation.result && !operation.result.ok
            ? operation.result.details
            : undefined
      ) as Record<string, unknown> | undefined;
      const rows: Array<Record<string, unknown> & { receiptStatus: string }> = [
        "committed",
        "alreadyPresent",
        "skipped",
        "failed",
        "unknown",
      ].flatMap((kind) =>
        (Array.isArray(data?.[kind])
          ? (data![kind] as Array<Record<string, unknown>>)
          : []
        ).map((row) => ({ ...row, receiptStatus: kind })),
      );
      for (const prior of this.operationAnnotationEntries(operation)) {
        const entry = proposal.entries.find(
          (candidate) =>
            (operation.context.taskId === proposal.taskId &&
              candidate.id === prior.id) ||
            (candidate.draft &&
              prior.draft &&
              canonical(candidate.draft) === canonical(prior.draft)) ||
            (candidate.located &&
              prior.located &&
              candidate.located.type === prior.located.type &&
              candidate.located.text === prior.located.text &&
              canonical(candidate.located.position) ===
                canonical(prior.located.position)),
        );
        if (!entry) continue;
        const receipt = rows.find(
          (row) =>
            row.id === prior.id ||
            (prior.annotationKey && row.annotationKey === prior.annotationKey),
        );
        if (
          includeResolved &&
          operation.result &&
          !operation.result.ok &&
          operation.result.code === "permission_denied" &&
          operation.context.taskId === proposal.taskId &&
          operation.context.runId === proposal.runId &&
          operation.context.intentRevision === proposal.intentRevision
        ) {
          entry.status = "skipped";
          entry.resolved = "denied";
          entry.error = "The user declined this prepared annotation write";
          continue;
        }
        if (
          includeResolved &&
          receipt?.receiptStatus === "skipped" &&
          receipt.status === "skipped" &&
          operation.context.taskId === proposal.taskId &&
          operation.context.runId === proposal.runId &&
          operation.context.intentRevision === proposal.intentRevision
        ) {
          entry.status = "skipped";
          entry.resolved = "omitted";
          entry.error = String(
            receipt.error ?? "Candidate was omitted from the submitted batch",
          );
        }
        const annotationKey =
          typeof receipt?.annotationKey === "string"
            ? receipt.annotationKey
            : prior.annotationKey;
        if (!annotationKey) continue;
        const known =
          receipt &&
          ["committed", "alreadyPresent"].includes(
            String(receipt.receiptStatus),
          );
        const saved = actual.find(
          (annotation) => annotation.key === annotationKey,
        );
        if (saved || known) {
          entry.annotationKey = annotationKey;
          entry.located = prior.located;
          entry.status = saved ? "alreadyPresent" : "skipped";
          entry.error = saved
            ? undefined
            : "Previously saved annotation was removed from Zotero; it will not be recreated automatically";
          if (candidateChanged(entry, prior)) {
            entry.status = "skipped";
            entry.error = `Entry was already saved as ${annotationKey}; update its comment explicitly instead of creating another mark`;
          }
        }
      }
    }
    function candidateChanged(
      entry: AnnotationEntry,
      previous: AnnotationEntry,
    ) {
      return (
        entry.id === previous.id &&
        canonical(entry.draft) !== canonical(previous.draft)
      );
    }
  }

  async workForTask(
    taskId: string,
    since: number,
    _sourceFingerprint?: string,
    options: {
      runId?: string;
      intentRevision?: number;
      includeLegacy?: boolean;
      sourceRefs?: readonly string[];
    } = {},
  ): Promise<{
    completed: Array<{ id: string; revision?: number; description: string }>;
    missing: Array<{ id: string; description: string; kind: "proposal" }>;
  }> {
    const completed: Array<{
        id: string;
        revision?: number;
        description: string;
      }> = [],
      missing: Array<{ id: string; description: string; kind: "proposal" }> =
        [];
    for (const token of (await this.storage.keys?.()) ?? []) {
      if (!/^\d+_[^_]+$/.test(token)) continue;
      const record = await this.loadAnnotationRecord(token);
      const matches = (candidate: AnnotationProposal) =>
        candidate.taskId === taskId &&
        ((options.includeLegacy &&
          !candidate.runId &&
          !candidate.createdAt &&
          candidate.intentRevision === undefined) ||
          (annotationProposalMatchesScope(candidate, { taskId, ...options }) &&
            (options.runId !== undefined ||
              (candidate.createdAt ?? 0) >= since)));
      // A newly revised batch replaces the previous batch for this PDF. Its
      // pointer also preserves explicit adoption of an older candidate ID.
      const proposal = selectAnnotationProposal(record, taskId, matches);
      if (!proposal) continue;
      const [libraryID, key] = token.split("_");
      const pdf = getItem(Number(libraryID), key);
      if (!pdf) continue;
      if (options.sourceRefs) {
        const parent = pdf.parentItemID
          ? asItem(Zotero.Items.get(pdf.parentItemID))
          : null;
        if (
          !options.sourceRefs.includes(`${pdf.libraryID}:${pdf.key}`) &&
          !(
            parent &&
            options.sourceRefs.includes(`${parent.libraryID}:${parent.key}`)
          )
        )
          continue;
      }
      await pdf.reload?.(["childItems"], true);
      await this.projectAnnotationOutcomes(
        proposal,
        pdf,
        readPdfAnnotations(pdf),
        true,
      );
      const pending = proposal.entries.filter(
        (entry) =>
          !entry.annotationKey && !entry.resolved && entry.status !== "skipped",
      );
      const invalid = proposal.entries.filter(
        (entry) =>
          !entry.annotationKey && !entry.resolved && entry.status === "skipped",
      );
      if (pending.length || invalid.length)
        missing.push({
          id: proposal.id,
          kind: "proposal",
          description: `Candidate batch ${proposal.id}: ${pending.length} candidates remain to submit and ${invalid.length} need correction or explicit omission. Use its existing IDs; preserve annotations already saved.`,
        });
      else
        completed.push({
          id: proposal.id,
          revision: proposal.intentRevision,
          description: `Candidate batch ${proposal.id} resolved; ${proposal.entries.filter((entry) => entry.status === "alreadyPresent").length} annotations currently exist. Removed marks were not recreated.`,
        });
    }
    return { completed, missing };
  }

  private makeProposal(
    record: AnnotationRecord,
    raw: unknown,
    taskId: string,
    fingerprint: string,
    context: ToolExecutionContext,
    legacy = false,
  ): AnnotationProposal {
    if (!Array.isArray(raw) || !raw.length)
      throw new Error(
        "Provide a non-empty annotations array or an existing proposalId",
      );
    if (raw.length > 100)
      throw new Error("At most 100 annotations may be proposed in one batch");
    const seenIds = new Set<string>();
    const proposalId = `proposal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const entries = raw.map((value, index): AnnotationEntry => {
      const object =
        value && typeof value === "object" && !Array.isArray(value)
          ? { ...(value as Record<string, unknown>) }
          : {};
      if (legacy) {
        object.type = "highlight";
        object.quote ??= object.text;
      }
      if (object.anchor !== undefined) object.type ??= "highlight";
      const aliasConflict =
        (object.comment !== undefined &&
          object.rationale !== undefined &&
          object.comment !== object.rationale) ||
        (object.quote !== undefined &&
          object.text !== undefined &&
          object.quote !== object.text);
      if (object.comment === undefined && object.rationale !== undefined)
        object.comment = object.rationale;
      delete object.rationale;
      // Compatible models sometimes use notes_write's field name in a text
      // candidate. Accept only the unambiguous explanation alias, never a conflict.
      if (
        object.comment === undefined &&
        (typeof object.quote === "string" ||
          typeof object.anchor === "string") &&
        typeof object.content === "string"
      ) {
        object.comment = object.content;
        delete object.content;
      }
      const id =
        typeof object.id === "string"
          ? object.id
          : `${proposalId}_${index + 1}`;
      const entry: AnnotationEntry = { id, raw: object, status: "pending" };
      try {
        if (aliasConflict)
          throw new Error(
            "Conflicting quote/text or comment/rationale aliases",
          );
        if (seenIds.has(id)) throw new Error("Duplicate annotation entry id");
        seenIds.add(id);
        const schema = legacy
          ? { ...annotationSchema, required: ["type"] }
          : annotationSchema;
        const normalized = validateValue(schema, object);
        if (normalized.issues.length)
          throw new Error(
            normalized.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; "),
          );
        const qualityIssue = annotationExplanationIssue(
          object,
          context.annotationPolicy,
        );
        if (qualityIssue) entry.reviewIssue = qualityIssue;
        entry.draft = normalizeAnnotationList([object], legacy)[0];
      } catch (error) {
        entry.status = "skipped";
        entry.error = String(error);
      }
      return entry;
    });
    const proposal: AnnotationProposal = {
      id: proposalId,
      createdAt: Date.now(),
      runId: context.runId,
      intentRevision: context.intentRevision,
      taskId,
      fingerprint,
      entries,
    };
    record.proposals[proposalId] = proposal;
    record.latest[taskId] = proposalId;
    return proposal;
  }

  private async proposeHighlights(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    return this.proposeAnnotationBatch(
      "propose_highlights",
      args,
      context,
      true,
    );
  }
  private async proposeAnnotations(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    return this.proposeAnnotationBatch(
      "propose_annotations",
      args,
      context,
      false,
    );
  }
  private async proposeAnnotationBatch(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    legacy: boolean,
  ): Promise<ToolResult> {
    const item = getItem(defaultLibraryID(args), String(args.key));
    if (!item) return fail(name, "not_found", "Item not found");
    const pdf = await findPdf(item, args.attachmentKey as string | undefined);
    if (!pdf) return fail(name, "not_found", "PDF attachment not found");
    const token = `${pdf.libraryID}_${pdf.key}`;
    return this.annotationLocks.run([token], async () => {
      const record = await this.loadAnnotationRecord(token);
      let proposal: AnnotationProposal;
      try {
        proposal = this.makeProposal(
          record,
          legacy ? args.highlights : args.annotations,
          context.taskId ?? "local",
          await pdfFingerprint(pdf),
          context,
          legacy,
        );
      } catch (error) {
        return { ...fail(name, "invalid_args", String(error)), effect: "none" };
      }
      await this.saveAnnotationRecord(token, record);
      const issues = proposal.entries
        .filter((entry) => entry.error)
        .map((entry) => ({
          path: entry.id,
          reason: "annotation_preflight",
          message: entry.error!,
          nextAction:
            "Repair this entry's arguments or explanation and propose it again",
        }));
      return {
        ...ok(name, {
          libraryID: pdf.libraryID,
          itemKey: item.key,
          key: item.key,
          attachmentKey: pdf.key,
          proposalId: proposal.id,
          count: proposal.entries.filter((entry) => entry.draft).length,
          annotations: proposal.entries.map((entry) => ({
            ...entry.raw,
            id: entry.id,
            status: entry.status,
            error: entry.error,
            reviewIssue: entry.reviewIssue,
          })),
          highlights: legacy
            ? proposal.entries.map((entry) => ({ ...entry.raw, id: entry.id }))
            : undefined,
          persisted: true,
          issues,
          reviewIssues: proposal.entries
            .filter((entry) => entry.reviewIssue)
            .map((entry) => ({ id: entry.id, message: entry.reviewIssue })),
          nextAction:
            "Review the full candidate batch, reread context where needed, remove low-value marks, and add explanations for key passages before committing",
        }),
        issues,
        effect: issues.length ? "partial" : "applied",
      };
    });
  }

  private annotationResult(
    pdf: Zotero.Item,
    proposalId: string,
    entries: AnnotationEntry[],
    operationId?: string,
    warnings: string[] = [],
  ): ToolResult {
    const rows = entries.map((entry) => ({
      id: entry.id,
      status: entry.status,
      type: entry.draft?.type,
      color: entry.located?.color ?? entry.draft?.color,
      annotationKey: entry.annotationKey,
      page: entry.located
        ? entry.located.position.pageIndex + 1
        : entry.draft?.page,
      error: entry.error,
      zoteroUri:
        entry.annotationKey &&
        ["committed", "alreadyPresent"].includes(entry.status)
          ? buildOpenPdfUri(pdf.key, {
              groupID: groupIDForLibrary(pdf.libraryID),
              annotationKey: entry.annotationKey,
              page: entry.located
                ? entry.located.position.pageIndex + 1
                : entry.draft?.page,
            })
          : undefined,
    }));
    const committed = rows.filter((entry) => entry.status === "committed"),
      alreadyPresent = rows.filter(
        (entry) => entry.status === "alreadyPresent",
      ),
      skipped = rows.filter((entry) =>
        ["skipped", "pending"].includes(entry.status),
      ),
      failed = rows.filter((entry) => entry.status === "failed"),
      unknown = rows.filter((entry) => entry.status === "unknown");
    const complete = [...committed, ...alreadyPresent];
    const data = {
      libraryID: pdf.libraryID,
      itemKey:
        (pdf.parentItemID
          ? asItem(Zotero.Items.get(pdf.parentItemID))?.key
          : undefined) ?? pdf.key,
      attachmentKey: pdf.key,
      proposalId,
      committed,
      alreadyPresent,
      skipped,
      failed,
      unknown,
      key: complete[0]?.annotationKey ?? "",
      keys: complete.map((entry) => entry.annotationKey),
      annotationKey: complete[0]?.annotationKey ?? "",
      annotationKeys: complete.map((entry) => entry.annotationKey),
      annotations: complete,
      pageIndex: complete[0]?.page ? complete[0].page - 1 : undefined,
      zoteroUri: complete[0]?.zoteroUri,
      count: complete.length,
      mode: "annotations",
    };
    if (unknown.length)
      return {
        ...fail(
          "commit_annotations",
          "unavailable",
          "Some annotation outcomes are unknown; the host will reconcile them before another write",
          data,
        ),
        effect: "unknown",
        operationId,
        warnings,
      };
    if (complete.length)
      return {
        ...ok("commit_annotations", data),
        effect:
          skipped.length || failed.length
            ? "partial"
            : committed.length
              ? "applied"
              : "none",
        operationId,
        warnings,
      };
    return {
      ...fail(
        "commit_annotations",
        "unavailable",
        "No new annotations were saved; repair the reported candidate issues",
        data,
      ),
      effect: "none",
      operationId,
      warnings,
      retryable: failed.length > 0,
    };
  }

  private async commitAnnotations(
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const item = getItem(defaultLibraryID(args), String(args.key));
    const pdf = item
      ? await findPdf(item, args.attachmentKey as string | undefined)
      : null;
    if (!pdf)
      return fail(
        "commit_annotations",
        "not_found",
        "PDF attachment not found",
      );
    const proposalId = String(
      context.expectedAfter?.annotationProposal ?? args.proposalId ?? "",
    );
    const entries = JSON.parse(
      context.expectedAfter?.annotationEntries ?? "[]",
    ) as AnnotationEntry[];
    if (!entries.length)
      return {
        ...fail(
          "commit_annotations",
          "invalid_args",
          "Prepared annotation candidates are missing",
        ),
        effect: "none",
      };
    return this.annotationLocks.run(
      [`${pdf.libraryID}_${pdf.key}`],
      async () => {
        const warnings: string[] = [];
        const progress = new ToolProgress(context, signal, 120_000);
        try {
          if (
            (await pdfFingerprint(pdf)) !==
            context.expectedAfter?.annotationFingerprint
          )
            return {
              ...fail(
                "commit_annotations",
                "unavailable",
                "PDF changed after the candidate preview; prepare updated anchors",
              ),
              effect: "none",
            };
          await pdf.reload?.(["childItems"], true);
          const actual = readPdfAnnotations(pdf);
          for (const entry of entries) {
            const saved = actual.find(
              (annotation) => annotation.key === entry.annotationKey,
            );
            if (saved) {
              entry.status = "alreadyPresent";
              entry.error = undefined;
            } else if (entry.status === "alreadyPresent") {
              entry.status = "skipped";
              entry.error =
                "Previously saved annotation was removed; it will not be recreated automatically";
            } else if (entry.status === "pending" && entry.located) {
              const duplicate = actual.find((annotation) =>
                this.sameAnnotation(annotation, entry.located!),
              );
              if (duplicate) {
                entry.annotationKey = duplicate.key;
                entry.status = "alreadyPresent";
              }
            }
          }
          const pending = entries.filter(
            (entry) => entry.status === "pending" && entry.located,
          );
          const ready = pending.length
            ? await progress.run("opening_and_initializing_pdf", 30_000, () =>
                waitForPdfReader(pdf, progress),
              )
            : undefined;
          const created: Zotero.Item[] = [];
          for (const entry of pending) {
            if (!progress.active) {
              warnings.push(
                "Submission stopped; completed annotations were retained",
              );
              break;
            }
            entry.status = "unknown";
            try {
              progress.setStage(`saving_${entry.id}`);
              // Keep the actual write promise alive: the shared executor owns timeout reporting and retains its resource lock until this non-cancellable write settles.
              const batch = JSON.parse(
                context.expectedAfter?.annotationBatch ?? "null",
              ) as import("@confucius/protocol").AnnotationBatch | null;
              if (!batch)
                throw new Error("Prepared annotation batch is missing");
              const token = `${pdf.libraryID}_${pdf.key}`;
              await this.ownership.assertColor(
                token,
                batch.id,
                entry.located!.color,
              );
              const planned = (await this.ownership.read(token)).marks[
                entry.annotationKey!
              ];
              if (!planned)
                await this.ownership.plan(
                  token,
                  entry.annotationKey!,
                  batch.id,
                  JSON.parse(context.expectedAfter?.annotationCreator ?? "{}"),
                  canonical(entry.located),
                );
              else if (
                planned.status !== "planned" ||
                planned.expected !== canonical(entry.located)
              )
                throw new Error("Annotation write identity was already used");
              const date = new Date(batch.createdAt);
              const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
              const annotation = await Zotero.Annotations.saveFromJSON(
                pdf,
                {
                  key: entry.annotationKey,
                  ...entry.located!,
                  tags: [
                    { name: `Confucius 批次：${batch.name}` },
                    { name: `Confucius 批次日期：${day}` },
                  ],
                  readOnly: false,
                } as unknown as _ZoteroTypes.Annotations.AnnotationJson,
                { notifierData: { instanceID: ready!.reader._instanceID } },
              );
              await this.ownership.confirm(
                `${pdf.libraryID}_${pdf.key}`,
                annotation.key,
                canonical(entry.located),
                annotationCreationTime(annotation),
              );
              created.push(annotation);
              entry.status = "committed";
            } catch (error) {
              await pdf.reload?.(["childItems"], true);
              const saved = getItem(pdf.libraryID, entry.annotationKey!);
              if (
                saved?.isAnnotation?.() &&
                entry.located &&
                saved.annotationColor === entry.located.color &&
                saved.annotationComment === entry.located.comment &&
                saved.annotationText === entry.located.text &&
                canonical(annotationPosition(saved)) ===
                  canonical(entry.located.position)
              ) {
                await this.ownership.confirm(
                  `${pdf.libraryID}_${pdf.key}`,
                  saved.key,
                  canonical(entry.located),
                  annotationCreationTime(saved),
                );
                entry.status = "committed";
                warnings.push(
                  `Annotation saved but its response failed: ${String(error)}`,
                );
              } else {
                entry.status =
                  error instanceof ToolTimeout ? "unknown" : "failed";
                entry.error = String(error);
              }
              break;
            }
          }
          if (created.length) {
            try {
              await ready!.reader.setAnnotations(created);
            } catch (error) {
              warnings.push(
                `Annotations are saved in Zotero; reader refresh failed: ${String(error)}`,
              );
            }
            try {
              await ready!.reader.navigate?.({ annotationID: created[0].key });
            } catch {
              /* cosmetic */
            }
          }
          return this.annotationResult(
            pdf,
            proposalId,
            entries,
            context.operationId,
            warnings,
          );
        } catch (error) {
          warnings.push(String(error));
          return this.annotationResult(
            pdf,
            proposalId,
            entries,
            context.operationId,
            warnings,
          );
        } finally {
          progress.close();
        }
      },
    );
  }

  async reconcile(operation: OperationRecord): Promise<ToolResult | null> {
    const recovery = operation.intent?.recovery ?? operation.context;
    const context = {
      ...operation.context,
      ...recovery,
    } as ToolExecutionContext;
    const libraryID = defaultLibraryID(operation.args);
    const key = String(operation.args.key ?? context.plannedKeys?.item ?? "");
    const token = `${libraryID}:${key}`;
    const item = key ? getItem(libraryID, key) : null;
    if (item)
      await item.reload?.(
        [
          "primaryData",
          "itemData",
          "note",
          "tags",
          "relations",
          "collections",
          "childItems",
        ],
        true,
      );
    const applied = (
      data: unknown = { libraryID, key, reconciled: true },
    ): ToolResult => ({ ...ok(operation.name, data), effect: "applied" });
    if (
      operation.name === "create_collection" &&
      context.plannedKeys?.collection
    ) {
      const collection = Zotero.Collections.getByLibraryAndKey(
        libraryID,
        context.plannedKeys.collection,
      );
      if (collection)
        return applied({
          libraryID,
          key: collection.key,
          name: collection.name,
          reconciled: true,
        });
      return {
        ...fail(
          operation.name,
          "unavailable",
          "Verified that the planned collection was not created",
        ),
        effect: "none",
        retryable: true,
      };
    }
    if (
      operation.name === "create_saved_search" &&
      context.plannedKeys?.search
    ) {
      const search = Zotero.Searches.getByLibraryAndKey(
        libraryID,
        context.plannedKeys.search,
      );
      if (search)
        return applied({
          libraryID,
          key: search.key,
          name: search.name,
          reconciled: true,
        });
      return {
        ...fail(
          operation.name,
          "unavailable",
          "Verified that the planned search was not created",
        ),
        effect: "none",
        retryable: true,
      };
    }
    if (operation.name === "rename_collection") {
      const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
      if (collection) await collection.reload?.(["primaryData"], true);
      if (collection && collection.name === operation.args.name)
        return applied({
          libraryID,
          key,
          name: collection.name,
          reconciled: true,
        });
      if (
        collection &&
        context.expected?.[`collection:${libraryID}:${key}`] ===
          this.collectionMutationVersion(operation.name, collection)
      )
        return {
          ...fail(
            operation.name,
            "unavailable",
            "Verified that the collection name was not changed",
          ),
          effect: "none",
          retryable: true,
        };
      return null;
    }
    if (
      ["add_to_collection", "remove_from_collection"].includes(
        operation.name,
      ) &&
      item
    ) {
      const collection = Zotero.Collections.getByLibraryAndKey(
        libraryID,
        String(operation.args.collectionKey),
      );
      if (
        collection &&
        item.getCollections().includes(collection.id) ===
          (operation.name === "add_to_collection")
      )
        return applied({
          libraryID,
          key,
          collectionKey: collection.key,
          reconciled: true,
        });
    }
    if (
      ["create_note", "propose_note", "append_to_note", "update_note"].includes(
        operation.name,
      )
    ) {
      const after = context.expectedAfter?.[key];
      if (item?.isNote?.() && after && item.getNote() === after)
        return applied();
    }
    if (
      operation.name === "create_item" &&
      item &&
      context.plannedKeys?.item === key
    )
      return applied(summarizeItem(item));
    if (
      operation.name === "update_item_metadata" &&
      item &&
      Object.entries(operation.args.fields as Record<string, string>).every(
        ([field, value]) => item.getField(field) === value,
      )
    )
      return applied();
    if (operation.name === "batch_update_tags" && item) {
      const tags = new Set(item.getTags().map((tag) => tag.tag));
      if (
        ((operation.args.add ?? []) as string[]).every((tag) =>
          tags.has(tag),
        ) &&
        ((operation.args.remove ?? []) as string[]).every(
          (tag) => !tags.has(tag),
        )
      )
        return applied();
    }
    if (
      [
        "update_annotation",
        "update_annotation_comment",
        "delete_annotation",
      ].includes(operation.name) &&
      context.expectedAfter?.ownershipPdf
    ) {
      const change = JSON.parse(context.expectedAfter.annotationUpdate ?? "{}");
      const deleted = operation.name === "delete_annotation";
      if (
        deleted
          ? !item
          : item?.isAnnotation?.() &&
            (change.comment === undefined ||
              item.annotationComment === change.comment) &&
            (!change.position ||
              (canonical(annotationPosition(item)) ===
                canonical(change.position) &&
                item.annotationText === change.text))
      ) {
        await this.ownership.modified(
          context.expectedAfter.ownershipPdf,
          key,
          JSON.parse(context.expectedAfter.modifier),
          item
            ? annotationCreationTime(item, "dateModified")
            : (operation.finishedAt ?? operation.startedAt),
          deleted,
        );
        return applied();
      }
    }
    if (operation.name === "link_related_items" && item) {
      const other = getItem(libraryID, String(operation.args.relatedKey));
      await other?.reload?.(["relations"], true);
      if (
        other &&
        item.relatedItems.includes(other.key) &&
        other.relatedItems.includes(item.key)
      )
        return applied({
          libraryID,
          key,
          relatedKey: other.key,
          reconciled: true,
        });
    }
    if (
      operation.name !== "commit_annotations" &&
      (context.expected?.[token] ===
        (item
          ? this.mutationVersion(operation.name, operation.args, item)
          : "missing") ||
        (!item && context.plannedKeys?.item === key))
    )
      return {
        ...fail(
          operation.name,
          "unavailable",
          "Verified that the interrupted operation did not change its target fields",
        ),
        effect: "none",
        retryable: true,
      };
    if (operation.name === "add_item") {
      const recordKey = `import_${await runtimeDigest(operation.id)}`;
      if (this.pendingDownloads.has(recordKey)) return null;
      const record = await this.storage.read<{
        items: Array<{ libraryID: number; key: string }>;
        attachments: string;
      }>(recordKey);
      if (
        record &&
        ["complete", "failed"].includes(record.attachments) &&
        record.items.every((ref) => getItem(ref.libraryID, ref.key))
      )
        return {
          ...ok("add_item", {
            items: record.items,
            itemCreation: "applied",
            attachmentsComplete: record.attachments === "complete",
            attachmentOutcome: record.attachments,
            reconciled: true,
          }),
          effect: record.attachments === "complete" ? "applied" : "partial",
        };
      const before = JSON.parse(
        context.expectedAfter?.libraryItems ?? "null",
      ) as number[] | null;
      if (before) {
        const current = await Zotero.Items.getAll(
          libraryID,
          false,
          false,
          true,
        );
        if (current.every((id) => before.includes(id)))
          return {
            ...fail(
              operation.name,
              "unavailable",
              "Verified that no new library item was created",
            ),
            effect: "none",
            retryable: true,
          };
      }
    }
    if (operation.name !== "commit_annotations") return null;
    const pdf = item
      ? await findPdf(item, operation.args.attachmentKey as string | undefined)
      : null;
    if (!pdf) return null;
    return this.annotationLocks.run(
      [`${pdf.libraryID}_${pdf.key}`],
      async () => {
        await pdf.reload?.(["childItems"], true);
        const actual = readPdfAnnotations(pdf);
        const entries = this.operationAnnotationEntries(operation);
        if (!entries.length) return null;
        for (const entry of entries) {
          const saved = entry.annotationKey
            ? actual.find(
                (annotation) => annotation.key === entry.annotationKey,
              )
            : undefined;
          if (saved) {
            const mark = (
              await this.ownership.read(`${pdf.libraryID}_${pdf.key}`)
            ).marks[saved.key];
            if (
              mark?.status === "planned" &&
              entry.located &&
              saved.color === entry.located.color &&
              saved.comment === entry.located.comment &&
              saved.text === entry.located.text &&
              canonical(saved.position) === canonical(entry.located.position)
            )
              await this.ownership.confirm(
                `${pdf.libraryID}_${pdf.key}`,
                saved.key,
                canonical(entry.located),
                annotationCreationTime(getItem(pdf.libraryID, saved.key)),
              );
            entry.status = "committed";
            entry.error = undefined;
          } else if (entry.status === "pending" || entry.status === "unknown") {
            entry.status = "failed";
            entry.error =
              "Authoritative Zotero read confirmed that this planned annotation was not saved";
          } else if (entry.status === "alreadyPresent") {
            entry.status = "skipped";
            entry.error =
              "Previously present annotation was removed; it will not be recreated automatically";
          }
        }
        return this.annotationResult(
          pdf,
          String(
            context.expectedAfter?.annotationProposal ??
              operation.args.proposalId ??
              "",
          ),
          entries,
          operation.id,
        );
      },
    );
  }

  private async updateAnnotation(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const item = getItem(defaultLibraryID(args), String(args.key));
    const pdf = context.expectedAfter?.ownershipPdf;
    if (
      !item?.isAnnotation?.() ||
      !pdf ||
      !(await this.ownership.owned(pdf, item.key))
    )
      return fail(
        name,
        "permission_denied",
        "Annotation creation provenance is not verified",
      );
    const change = JSON.parse(context.expectedAfter?.annotationUpdate ?? "{}");
    if (change.comment !== undefined) item.annotationComment = change.comment;
    if (change.position) {
      item.annotationText = change.text;
      item.annotationPosition = JSON.stringify(change.position);
      item.annotationPageLabel = change.pageLabel;
      item.annotationSortIndex = change.sortIndex;
    }
    await item.saveTx();
    await this.ownership.modified(
      pdf,
      item.key,
      JSON.parse(context.expectedAfter!.modifier),
      Date.now(),
    );
    return ok(name, {
      libraryID: item.libraryID,
      key: item.key,
      comment: item.annotationComment,
      text: item.annotationText,
      position: annotationPosition(item),
      provenance: await this.ownership.owned(pdf, item.key),
    });
  }

  private async deleteAnnotation(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const item = getItem(defaultLibraryID(args), String(args.key));
    const pdf = context.expectedAfter?.ownershipPdf;
    if (
      !item?.isAnnotation?.() ||
      !pdf ||
      !(await this.ownership.owned(pdf, item.key))
    )
      return fail(
        "delete_annotation",
        "permission_denied",
        "Annotation creation provenance is not verified",
      );
    await item.eraseTx();
    await this.ownership.modified(
      pdf,
      item.key,
      JSON.parse(context.expectedAfter!.modifier),
      Date.now(),
      true,
    );
    return ok("delete_annotation", {
      libraryID: item.libraryID,
      key: item.key,
    });
  }
}
