import type { ToolErrorCode, ToolResult } from "@confucius/protocol";
import { buildOpenPdfUri, buildSelectUri } from "@confucius/protocol";
import type {
  LiveContextReader,
  LiveContextSelection,
} from "@confucius/protocol";
import {
  collectMatches,
  compileSafeRegex,
  findSection,
  parseSections,
  requireItemRef,
  splitPages,
} from "@confucius/zotero-tools";

const MAX_NOTE = 20_000;

function ok(toolName: string, data: unknown): ToolResult {
  return { ok: true, toolName, data };
}

function fail(
  toolName: string,
  code: ToolErrorCode,
  message: string,
  details?: unknown,
): ToolResult {
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

function groupIDForLibrary(libraryID: number): number | undefined {
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

export async function findPdf(item: Zotero.Item): Promise<Zotero.Item | null> {
  if (
    item.isAttachment?.() &&
    item.attachmentContentType === "application/pdf"
  ) {
    return item;
  }
  if (item.isNote?.()) {
    return null;
  }
  const ids = item.getAttachments?.() || [];
  for (const id of ids) {
    const attachment = asItem(Zotero.Items.get(id));
    if (attachment?.attachmentContentType === "application/pdf") {
      return attachment;
    }
  }
  return null;
}

async function pdfText(item: Zotero.Item): Promise<string | null> {
  const pdf = await findPdf(item);
  if (!pdf) {
    return null;
  }
  const text = await pdf.attachmentText;
  return text || null;
}

interface PdfPosition {
  pageIndex: number;
  rects: number[][];
  nextPageRects?: number[][];
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
  getMatchPositionsAsync(pageIndex: number): Promise<PdfPosition[]>;
  pageMatches?: Array<number[] | undefined>;
  _pageMatches?: Array<number[] | undefined>;
  _pendingFindMatches?: Set<number>;
  _pdfDocument?: {
    getPageData?: (input: { pageIndex: number }) => Promise<{
      chars?: PdfPageChar[];
    }>;
  };
}

interface PdfSelectionAnnotation {
  text?: string;
  pageLabel?: string;
  sortIndex?: string;
  position?: PdfPosition;
}

interface PdfPageChar {
  u?: string;
  char?: string;
  rect?: number[];
  inlineRect?: number[];
  rotation?: number;
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
}

interface PdfPrimaryView {
  initializedPromise?: Promise<void>;
  _findController?: PdfFindController;
  _iframeWindow?: Window & {
    PDFViewerApplication?: {
      pdfDocument?: { numPages?: number };
    };
  };
  _selectionRanges?: unknown[];
  _pdfPages?: Array<{ chars?: PdfPageChar[] } | undefined>;
  _getAnnotationFromSelectionRanges?: (
    ranges: unknown[],
    type: "highlight",
  ) => PdfSelectionAnnotation | null;
  _ensureBasicPageData?: (pageIndex: number) => Promise<void>;
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
  _initPromise?: Promise<unknown>;
  _waitForReader?: () => Promise<void>;
  _internalReader?: { _primaryView?: PdfPrimaryView };
  navigate?: (location: Record<string, unknown>) => void | Promise<void>;
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

interface LocatedHighlight {
  text: string;
  comment: string;
  position: PdfPosition;
  sortIndex: string;
  pageLabel: string;
}

async function waitForPdfReader(pdf: Zotero.Item): Promise<{
  reader: PdfReaderInstance;
  view: PdfPrimaryView;
}> {
  let reader = (await Zotero.Reader.open(pdf.id)) as
    PdfReaderInstance | undefined;
  const deadline = Date.now() + 15_000;
  while (!reader && Date.now() < deadline) {
    reader = (Zotero.Reader._readers as unknown as PdfReaderInstance[]).find(
      (candidate) =>
        candidate.itemID === pdf.id && candidate._isTabClosed !== true,
    );
    if (!reader) {
      await Zotero.Promise.delay(25);
    }
  }
  if (!reader) {
    throw new Error("Zotero PDF reader did not open");
  }
  await reader._initPromise;
  await reader._waitForReader?.();
  const view = reader._internalReader?._primaryView;
  if (!view) {
    throw new Error("Zotero PDF reader view is unavailable");
  }
  await view.initializedPromise;
  const findDeadline = Date.now() + 15_000;
  while (!view._findController?._pdfDocument && Date.now() < findDeadline) {
    await Zotero.Promise.delay(25);
  }
  if (!view._findController?._pdfDocument) {
    throw new Error("Zotero PDF text search did not finish initializing");
  }
  return { reader, view };
}

function findPageMatches(
  controller: PdfFindController,
): Array<number[] | undefined> {
  return controller.pageMatches ?? controller._pageMatches ?? [];
}

async function waitForPdfFind(controller: PdfFindController): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  let observedActivity = false;
  // Let the controller reset results from any previous query before checking
  // its own activity and completion signal.
  await Zotero.Promise.delay(0);
  while (Date.now() < deadline) {
    const matches = findPageMatches(controller);
    const pending = controller._pendingFindMatches?.size ?? 0;
    observedActivity ||= pending > 0 || matches.length > 0;
    // Reader arrays cross a chrome-window boundary in Zotero. Requiring
    // Array.isArray() for every entry rejects valid wrapped arrays, whereas the
    // controller's pending set is its own completion signal.
    if (observedActivity && pending === 0) {
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

async function directMatchPositions(
  view: PdfPrimaryView,
  pageIndex: number,
  query: string,
): Promise<PdfPosition[]> {
  await view._ensureBasicPageData?.(pageIndex);
  let chars = view._pdfPages?.[pageIndex]?.chars || [];
  if (!chars.length) {
    const pageData = await view._findController?._pdfDocument?.getPageData?.({
      pageIndex,
    });
    chars = pageData?.chars || [];
  }
  if (!chars.length) {
    return [];
  }
  let content = "";
  const charIndexes: number[] = [];
  chars.forEach((char, index) => {
    const value = String(char.u ?? char.char ?? "");
    for (let offset = 0; offset < value.length; offset += 1) {
      content += value[offset];
      charIndexes.push(index);
    }
    if (char.spaceAfter || char.lineBreakAfter || char.paragraphBreakAfter) {
      content += " ";
      charIndexes.push(index);
    }
  });
  const needle = query.replace(/\s+/g, " ").toLocaleLowerCase();
  const haystack = content.toLocaleLowerCase();
  const positions: PdfPosition[] = [];
  let from = 0;
  while (needle && from < haystack.length) {
    const match = haystack.indexOf(needle, from);
    if (match < 0) {
      break;
    }
    const start = charIndexes[match];
    const end = charIndexes[match + needle.length - 1];
    if (Number.isInteger(start) && Number.isInteger(end)) {
      const rects = rangeRects(chars, start, end);
      if (rects.length) {
        positions.push({ pageIndex, rects });
      }
    }
    from = match + Math.max(needle.length, 1);
  }
  return positions;
}

async function locateHighlight(
  view: PdfPrimaryView,
  highlight: { text: string; page?: number; comment?: string },
  occurrence: number,
): Promise<LocatedHighlight> {
  const text = String(highlight.text ?? "").trim();
  if (!text) {
    throw new Error("Highlight text cannot be empty");
  }
  const controller = view._findController;
  const pageCount =
    view._iframeWindow?.PDFViewerApplication?.pdfDocument?.numPages ?? 0;
  if (!controller || pageCount < 1) {
    throw new Error("Zotero PDF text search is unavailable");
  }
  if (view.setFindState) {
    await view.setFindState({
      active: true,
      query: text,
      highlightAll: true,
      caseSensitive: false,
      entireWord: false,
    });
  } else {
    await controller.find({
      type: "find",
      query: text,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: false,
    });
  }
  const findReady = await waitForPdfFind(controller);

  const requestedPage = Number(highlight.page);
  const pageIndexes =
    Number.isInteger(requestedPage) && requestedPage > 0
      ? [requestedPage - 1]
      : Array.from({ length: pageCount }, (_, index) => index);
  const positions: PdfPosition[] = [];
  for (const pageIndex of pageIndexes) {
    if (pageIndex < 0 || pageIndex >= pageCount) {
      continue;
    }
    let pagePositions: PdfPosition[] = [];
    if (findReady) {
      try {
        pagePositions = await controller.getMatchPositionsAsync(pageIndex);
      } catch {
        pagePositions = [];
      }
    }
    if (!pagePositions.length) {
      pagePositions = await directMatchPositions(view, pageIndex, text);
    }
    positions.push(...pagePositions);
  }
  const position = positions[occurrence];
  if (!position?.rects?.length) {
    const pageHint =
      pageIndexes.length === 1 ? ` on page ${requestedPage}` : "";
    throw new Error(
      `Highlight text was not found${pageHint}: ${text.slice(0, 120)}`,
    );
  }
  await view._ensureBasicPageData?.(position.pageIndex);
  const meta = view.getAnnotationMeta?.(position);
  const pageLabel =
    String(
      meta?.pageLabel || view._getPageLabel?.(position.pageIndex, true) || "",
    ) || String(position.pageIndex + 1);
  const sortIndex =
    String(meta?.sortIndex || "") ||
    `${String(position.pageIndex).padStart(5, "0")}|000000|00000`;
  return {
    text,
    comment: String(highlight.comment ?? ""),
    position: JSON.parse(JSON.stringify(position)) as PdfPosition,
    pageLabel,
    sortIndex,
  };
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

export class ZoteroToolHost {
  private readonly proposals = new Map<
    string,
    Array<{ text: string; page?: number; comment?: string }>
  >();

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      return await this.dispatch(name, args);
    } catch (error) {
      return fail(
        name,
        "internal",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
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
        return this.createCollection(args);
      case "rename_collection":
        return this.renameCollection(args);
      case "add_to_collection":
        return this.addToCollection(args);
      case "remove_from_collection":
        return this.removeFromCollection(args);
      case "create_saved_search":
        return this.createSavedSearch(args);
      case "add_item":
        return this.addItem(args);
      case "create_item":
        return this.createItem(args);
      case "update_item_metadata":
        return this.updateItemMetadata(args);
      case "batch_update_tags":
        return this.batchUpdateTags(args);
      case "link_related_items":
        return this.linkRelated(args);
      case "create_note":
        return this.createNote(args);
      case "append_to_note":
        return this.appendToNote(args);
      case "update_note":
        return this.updateNote(args);
      case "attach_file":
        return this.attachFile(args);
      case "get_outline":
      case "list_sections":
        return this.getOutline(name, args);
      case "get_paper_section":
        return this.getPaperSection(args);
      case "get_pages":
        return this.getPages(args);
      case "get_page_count":
        return this.getPageCount(args);
      case "search_paper_content":
      case "search_with_regex":
        return this.searchPaper(name, args);
      case "get_annotations":
        return this.getAnnotations(args);
      case "get_pdf_selection":
        return this.getPdfSelection(args);
      case "open_item":
        return this.openItem(args);
      case "propose_highlights":
        return this.proposeHighlights(args);
      case "commit_annotations":
        return this.commitAnnotations(args);
      case "update_annotation_comment":
        return this.updateAnnotationComment(args);
      case "delete_annotation":
        return this.deleteAnnotation(args);
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
  ): Promise<ToolResult> {
    const name = String(args.name ?? "").trim();
    if (!name) {
      return fail("create_collection", "invalid_args", "name is required");
    }
    const libraryID = defaultLibraryID(args);
    const collection = new Zotero.Collection();
    (collection as unknown as { libraryID: number }).libraryID = libraryID;
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
    collection.name = name;
    await collection.saveTx();
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
    item.addToCollection(collection.id);
    await item.saveTx();
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
    item.removeFromCollection(collection.id);
    await item.saveTx();
    return ok("remove_from_collection", {
      libraryID,
      key: item.key,
      collectionKey: collection.key,
    });
  }

  private async createSavedSearch(
    args: Record<string, unknown>,
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
    const search = new Zotero.Search({ libraryID, name });
    search.addCondition("title", "contains", query);
    await search.saveTx();
    return ok("create_saved_search", {
      libraryID,
      key: search.key,
      name,
      query,
    });
  }

  private async addItem(args: Record<string, unknown>): Promise<ToolResult> {
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
    let items: Zotero.Item[] = [];
    let translatorError: unknown;
    try {
      items = await translate.translate({ libraryID, collections });
    } catch (error) {
      translatorError = error;
    }
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
          return fail(
            "add_item",
            "unavailable",
            `Identifier lookup failed (${first}); DOI fallback failed (${second})`,
          );
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
    try {
      await Zotero.Attachments.addAvailableFiles(items);
    } catch {
      // PDF attach is best-effort.
    }
    return ok("add_item", { items: items.map(summarizeItem) });
  }

  private async createItem(args: Record<string, unknown>): Promise<ToolResult> {
    const itemType = String(args.itemType ?? "journalArticle");
    const title = String(args.title ?? "").trim();
    if (!title) {
      return fail("create_item", "invalid_args", "title is required");
    }
    const item = new Zotero.Item(itemType as never);
    (item as unknown as { libraryID: number }).libraryID =
      defaultLibraryID(args);
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
    if (!item || !fields) {
      return fail("update_item_metadata", "invalid_args", "fields required");
    }
    for (const [field, value] of Object.entries(fields)) {
      item.setField(field, value);
    }
    await item.saveTx();
    return ok("update_item_metadata", summarizeItem(item));
  }

  private async batchUpdateTags(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("batch_update_tags", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("batch_update_tags", "not_found", "Item not found");
    }
    for (const tag of (args.add as string[]) || []) {
      item.addTag(tag);
    }
    for (const tag of (args.remove as string[]) || []) {
      item.removeTag(tag);
    }
    await item.saveTx();
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
    item.addRelatedItem(other);
    other.addRelatedItem(item);
    await item.saveTx();
    await other.saveTx();
    return ok("link_related_items", {
      key: item.key,
      relatedKey: other.key,
    });
  }

  private async createNote(args: Record<string, unknown>): Promise<ToolResult> {
    const content = String(args.content ?? "").trim();
    if (!content) {
      return fail("create_note", "invalid_args", "content is required");
    }
    const note = new Zotero.Item("note");
    note.libraryID = defaultLibraryID(args);
    note.setNote(noteHtml(content));
    if (args.parentKey) {
      const parent = getItem(note.libraryID, String(args.parentKey));
      if (parent) {
        note.parentID = parent.id;
      }
    }
    await note.saveTx();
    return ok("create_note", { libraryID: note.libraryID, key: note.key });
  }

  private async appendToNote(
    args: Record<string, unknown>,
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

  private async updateNote(args: Record<string, unknown>): Promise<ToolResult> {
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

  private async attachFile(args: Record<string, unknown>): Promise<ToolResult> {
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
    const text = await pdfText(item);
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
    const text = await pdfText(item);
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

  private async getPages(args: Record<string, unknown>): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_pages", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("get_pages", "not_found", "Item not found");
    }
    const text = await pdfText(item);
    if (!text) {
      return fail("get_pages", "unavailable", "No indexed PDF text");
    }
    const split = splitPages(text);
    const start = Math.max(1, Number(args.start) || 1);
    const end = Math.min(split.pageCount, Number(args.end) || start);
    return ok("get_pages", {
      libraryID: ref.libraryID,
      key: ref.key,
      pageCount: split.pageCount,
      pages: split.pages.filter(
        (page) => page.page >= start && page.page <= end,
      ),
    });
  }

  private async getPageCount(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const pages = await this.getPages({ ...args, start: 1, end: 1 });
    if (!pages.ok) {
      return pages;
    }
    const data = pages.data as { pageCount: number };
    return ok("get_page_count", {
      libraryID: args.libraryID,
      key: args.key,
      pageCount: data.pageCount,
    });
  }

  private async searchPaper(
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
    const text = await pdfText(item);
    if (!text) {
      return fail(toolName, "unavailable", "No indexed PDF text");
    }
    const query = String(args.query ?? args.pattern ?? "");
    const compiled =
      toolName === "search_with_regex"
        ? compileSafeRegex(query, text)
        : compileSafeRegex(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), text);
    if (!compiled.ok) {
      return fail(toolName, "invalid_args", compiled.reason);
    }
    const hits = collectMatches(compiled.regex, compiled.subject, 20);
    return ok(toolName, {
      libraryID: ref.libraryID,
      key: ref.key,
      query,
      hits,
    });
  }

  private async getAnnotations(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("get_annotations", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("get_annotations", "not_found", "Item not found");
    }
    const pdf = await findPdf(item);
    if (!pdf) {
      return fail(
        "get_annotations",
        "unavailable",
        "Item has no PDF attachment",
      );
    }
    const raw = pdf.getAnnotations?.(false) || [];
    const annotations = raw
      .map((entry) =>
        typeof entry === "object" && entry
          ? asItem(entry)
          : asItem(Zotero.Items.get(entry as number)),
      )
      .filter((ann): ann is Zotero.Item => Boolean(ann))
      .filter((ann) => ann.isAnnotation?.())
      .map((ann) => ({
        libraryID: ann.libraryID,
        key: ann.key,
        type: (ann as unknown as { annotationType?: string }).annotationType,
        text:
          (ann as unknown as { annotationText?: string }).annotationText || "",
        comment:
          (ann as unknown as { annotationComment?: string })
            .annotationComment || "",
        color:
          (ann as unknown as { annotationColor?: string }).annotationColor ||
          "",
        pageLabel:
          (ann as unknown as { annotationPageLabel?: string })
            .annotationPageLabel || "",
        sortIndex:
          (ann as unknown as { annotationSortIndex?: string })
            .annotationSortIndex || "",
        position: annotationPosition(ann),
        zoteroUri: buildOpenPdfUri(pdf.key, {
          groupID: groupIDForLibrary(pdf.libraryID),
          annotationKey: ann.key,
        }),
      }));
    const first = annotations[0];
    const firstPosition =
      first && typeof first.position === "object" && first.position !== null
        ? (first.position as { pageIndex?: unknown })
        : null;
    return ok("get_annotations", {
      libraryID: pdf.libraryID,
      key: item.key,
      attachmentKey: pdf.key,
      annotationKey: first?.key,
      pageIndex:
        typeof firstPosition?.pageIndex === "number"
          ? firstPosition.pageIndex
          : undefined,
      annotations,
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
    const pdf = await findPdf(item);
    if (pdf) {
      const location = readerLocation(args);
      await Zotero.Reader.open(pdf.id, location as never);
    }
    return ok("open_item", summarizeItem(item));
  }

  private async proposeHighlights(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("propose_highlights", "invalid_args", ref.message);
    }
    const highlights =
      (args.highlights as Array<{
        text: string;
        page?: number;
        comment?: string;
      }>) || [];
    const id = `${ref.libraryID}:${ref.key}`;
    this.proposals.set(id, highlights);
    const item = getItem(ref.libraryID, ref.key);
    const pdf = item ? await findPdf(item) : null;
    const firstPage = highlights.find((highlight) =>
      Number.isInteger(Number(highlight.page)),
    )?.page;
    return ok("propose_highlights", {
      libraryID: ref.libraryID,
      key: ref.key,
      attachmentKey: pdf?.key,
      pageIndex: firstPage === undefined ? undefined : Number(firstPage) - 1,
      count: highlights.length,
      highlights,
      persisted: false,
    });
  }

  private async commitAnnotations(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("commit_annotations", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("commit_annotations", "not_found", "Item not found");
    }
    const id = `${ref.libraryID}:${ref.key}`;
    const highlights =
      (args.highlights as Array<{
        text: string;
        page?: number;
        comment?: string;
      }>) ||
      this.proposals.get(id) ||
      [];
    if (!highlights.length) {
      return fail(
        "commit_annotations",
        "invalid_args",
        "No highlights were proposed or provided",
      );
    }
    const pdf = await findPdf(item);
    if (!pdf) {
      return fail(
        "commit_annotations",
        "unavailable",
        "Item has no PDF attachment",
      );
    }
    const { reader, view } = await waitForPdfReader(pdf);
    const occurrenceCounts = new Map<string, number>();
    const located: LocatedHighlight[] = [];
    for (const highlight of highlights) {
      const occurrenceKey = `${String(highlight.text ?? "").trim()}\u0000${
        Number.isInteger(Number(highlight.page)) ? Number(highlight.page) : ""
      }`;
      const occurrence = occurrenceCounts.get(occurrenceKey) ?? 0;
      located.push(await locateHighlight(view, highlight, occurrence));
      occurrenceCounts.set(occurrenceKey, occurrence + 1);
    }

    const created: Zotero.Item[] = [];
    try {
      for (const highlight of located) {
        const annotation = await Zotero.Annotations.saveFromJSON(pdf, {
          key: (
            Zotero as typeof Zotero & {
              DataObjectUtilities: { generateKey: () => string };
            }
          ).DataObjectUtilities.generateKey(),
          type: "highlight",
          text: highlight.text,
          comment: highlight.comment,
          color: Zotero.Annotations.DEFAULT_COLOR,
          pageLabel: highlight.pageLabel,
          sortIndex: highlight.sortIndex,
          position: highlight.position,
          readOnly: false,
        } as unknown as _ZoteroTypes.Annotations.AnnotationJson);
        created.push(annotation);
      }
    } catch (error) {
      for (const annotation of created.reverse()) {
        try {
          await annotation.eraseTx();
        } catch {
          // Preserve the original write error; notifier cleanup is best effort.
        }
      }
      throw error;
    }
    this.proposals.delete(id);
    const first = located[0];
    if (first?.position) {
      try {
        // Commit landed while the reader is open: jump to the first new
        // highlight so the write-back is visible right away (one-shot).
        await reader.navigate?.({ position: first.position });
      } catch {
        // Navigation is cosmetic; the committed annotations are the result.
      }
    }
    return ok("commit_annotations", {
      libraryID: pdf.libraryID,
      key: created[0]?.key || "",
      keys: created.map((annotation) => annotation.key),
      attachmentKey: pdf.key,
      pageIndex: first?.position?.pageIndex,
      mode: "annotations",
      count: created.length,
    });
  }

  private async updateAnnotationComment(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("update_annotation_comment", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail(
        "update_annotation_comment",
        "not_found",
        "Annotation not found",
      );
    }
    if (item.isAnnotation?.()) {
      item.annotationComment = String(args.comment ?? "");
      await item.saveTx();
      return ok("update_annotation_comment", {
        libraryID: item.libraryID,
        key: item.key,
        comment: item.annotationComment || "",
      });
    }
    return fail(
      "update_annotation_comment",
      "invalid_args",
      "Target item is not an annotation",
    );
  }

  private async deleteAnnotation(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ref = requireItemRef(args);
    if (!ref.ok) {
      return fail("delete_annotation", "invalid_args", ref.message);
    }
    const item = getItem(ref.libraryID, ref.key);
    if (!item) {
      return fail("delete_annotation", "not_found", "Not found");
    }
    if (!item.isAnnotation?.()) {
      return fail(
        "delete_annotation",
        "invalid_args",
        "Target item is not an annotation",
      );
    }
    await item.eraseTx();
    return ok("delete_annotation", { libraryID: ref.libraryID, key: ref.key });
  }
}
