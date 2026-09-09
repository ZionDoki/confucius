import type { Citation, ReadingGuide } from "@confucius/protocol";

export interface ReadingPdfLocation {
  libraryID: number;
  attachmentKey: string;
  pageIndex: number;
}

/** Article-order mapping. Stay on the selected checkpoint when several share a page. */
export function checkpointAtPdfPage(
  guide: ReadingGuide,
  citations: readonly Citation[],
  location: ReadingPdfLocation,
  currentId?: string,
): string | undefined {
  const starts = guide.checkpoints.flatMap((cp) => {
    const pages = cp.citationIds.flatMap((id) => {
      const c = citations.find((c) => c.id === id);
      return c?.attachmentKey === location.attachmentKey &&
        c.itemLibraryID === location.libraryID &&
        c.page
        ? [c.page - 1]
        : [];
    });
    return pages.length ? [{ id: cp.id, page: Math.min(...pages) }] : [];
  });
  if (!starts.length) return;
  const preceding = starts.filter((p) => p.page <= location.pageIndex);
  const page = preceding.length
    ? Math.max(...preceding.map((p) => p.page))
    : Math.min(...starts.map((p) => p.page));
  const matches = starts.filter((p) => p.page === page);
  return matches.find((p) => p.id === currentId)?.id ?? matches[0]?.id;
}

interface PdfFrame extends Window {
  PDFViewerApplication?: { pdfViewer?: { currentPageNumber?: number } };
}
interface FollowReader {
  itemID?: number;
  _isTabClosed?: boolean;
  _internalReader?: {
    _primaryView?: { _iframeWindow?: PdfFrame };
    _secondaryView?: { _iframeWindow?: PdfFrame };
  };
}

export interface ReadingPdfFollowEvent {
  location?: ReadingPdfLocation;
  explicit: boolean;
  /** Initial location restores the visual association without losing a saved reading position. */
  move: boolean;
}

/** Window-local subscriptions; no reading events enter a research task's history. */
export function bindReadingPdfFollow(
  win: Window,
  citations: readonly Citation[],
  navigate: (event: ReadingPdfFollowEvent) => void,
  initialFollow = false,
): () => void {
  const bound = new Map<
    Document,
    {
      reader: FollowReader;
      frame: PdfFrame;
      location: ReadingPdfLocation;
      dispose(): void;
    }
  >();
  let stopped = false;
  let scanned = false;
  let activeDocument: Document | undefined;
  let activePage: number | undefined;
  const currentPage = (frame: PdfFrame) => {
    const page = frame.PDFViewerApplication?.pdfViewer?.currentPageNumber;
    return typeof page === "number" && page >= 1 ? page - 1 : undefined;
  };
  const scan = () => {
    if (stopped) return;
    try {
      const live = new Set<Document>();
      const selectedReader = Zotero.Reader.getByTabID?.(
        Zotero.getMainWindow?.()?.Zotero_Tabs?.selectedID,
      );
      for (const reader of (Zotero.Reader._readers ??
        []) as unknown as FollowReader[]) {
        if (!reader.itemID || reader._isTabClosed) continue;
        const item = Zotero.Items.get(reader.itemID);
        if (
          !item ||
          !citations.some(
            (c) =>
              c.attachmentKey === item.key &&
              c.itemLibraryID === item.libraryID,
          )
        )
          continue;
        for (const view of [
          reader._internalReader?._primaryView,
          reader._internalReader?._secondaryView,
        ]) {
          const frame = view?._iframeWindow;
          const doc = frame?.document;
          if (!frame || !doc) continue;
          const page = currentPage(frame);
          if (page === undefined) continue;
          live.add(doc);
          let binding = bound.get(doc);
          if (!binding) {
            const location = {
              libraryID: item.libraryID,
              attachmentKey: item.key,
              pageIndex: page,
            };
            const doubleClick = (event: Event) => {
              if (stopped || !bound.has(doc)) return;
              const target = event.target as Element | null;
              if (
                !target?.closest?.(".page") ||
                target.closest("input, textarea, button, a")
              )
                return;
              const physical = Number(
                target.closest(".page")?.getAttribute("data-page-number"),
              );
              const pageIndex =
                physical >= 1 ? physical - 1 : currentPage(frame);
              if (pageIndex !== undefined) {
                activeDocument = doc;
                activePage = currentPage(frame);
                navigate({
                  location: { ...location, pageIndex },
                  explicit: true,
                  move: true,
                });
              }
            };
            doc.addEventListener("dblclick", doubleClick, { capture: true });
            binding = {
              reader,
              frame,
              location,
              dispose: () =>
                doc.removeEventListener("dblclick", doubleClick, {
                  capture: true,
                }),
            };
            bound.set(doc, binding);
          }
        }
      }
      for (const [doc, binding] of bound)
        if (!live.has(doc)) {
          binding.dispose();
          bound.delete(doc);
        }
      const entries = [...bound.entries()];
      // Prefer the focused split pane, retaining it when focus returns to the companion.
      const active =
        entries.find(([doc]) => doc.hasFocus()) ??
        entries.find(
          ([doc, binding]) =>
            doc === activeDocument && binding.reader === selectedReader,
        ) ??
        entries.find(([, binding]) => binding.reader === selectedReader);
      if (active) {
        const [doc, binding] = active;
        const page = currentPage(binding.frame);
        if (
          page !== undefined &&
          (doc !== activeDocument || page !== activePage)
        ) {
          activeDocument = doc;
          activePage = page;
          // Scrolling updates the guide without stealing focus or changing a question's scope.
          navigate({
            location: { ...binding.location, pageIndex: page },
            explicit: false,
            move: scanned || initialFollow,
          });
        }
      } else if (activeDocument) {
        activeDocument = undefined;
        activePage = undefined;
        navigate({ explicit: false, move: false });
      }
      scanned = true;
    } catch {
      // Reader frames can disappear during tab close. The next scan rebinds live frames.
    }
  };
  scan();
  const timer = win.setInterval(scan, 300);
  return () => {
    stopped = true;
    win.clearInterval(timer);
    for (const binding of bound.values()) binding.dispose();
    bound.clear();
  };
}
