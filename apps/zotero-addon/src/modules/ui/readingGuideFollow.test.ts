import assert from "node:assert/strict";
import { test } from "node:test";
import type { Citation, ReadingGuide } from "@confucius/protocol";
import {
  checkpointAtPdfPage,
  bindReadingPdfFollow,
} from "./readingGuideFollow";
const citations: Citation[] = [
  {
    id: "intro",
    itemLibraryID: 1,
    itemKey: "ITEM",
    attachmentKey: "PDF",
    page: 1,
  },
  {
    id: "method",
    itemLibraryID: 1,
    itemKey: "ITEM",
    attachmentKey: "PDF",
    page: 4,
  },
  {
    id: "results",
    itemLibraryID: 1,
    itemKey: "ITEM",
    attachmentKey: "PDF",
    page: 8,
  },
];
const guide = {
  checkpoints: [
    { id: "opening", citationIds: ["intro"] },
    { id: "method", citationIds: ["method"] },
    { id: "formula", citationIds: ["method"] },
    { id: "results", citationIds: ["results"] },
  ],
} as ReadingGuide;
test("PDF follow maps physical pages within the same paper, preserving a same-page checkpoint", () => {
  const page = (pageIndex: number) => ({
    libraryID: 1,
    attachmentKey: "PDF",
    pageIndex,
  });
  assert.equal(checkpointAtPdfPage(guide, citations, page(2)), "opening");
  assert.equal(checkpointAtPdfPage(guide, citations, page(3)), "method");
  assert.equal(
    checkpointAtPdfPage(guide, citations, page(3), "formula"),
    "formula",
  );
  assert.equal(
    checkpointAtPdfPage(guide, citations, page(8), "formula"),
    "results",
  );
  assert.equal(
    checkpointAtPdfPage(guide, citations, {
      ...page(3),
      attachmentKey: "OTHER",
    }),
    undefined,
  );
  assert.equal(
    checkpointAtPdfPage(guide, citations, { ...page(3), libraryID: 2 }),
    undefined,
  );
});
test("reader follow observes active-page changes, double-clicks and cleans up without task events", (t) => {
  class Doc extends EventTarget {
    focused = true;
    hasFocus() {
      return this.focused;
    }
  }
  const doc = new Doc();
  const frame = {
    document: doc,
    PDFViewerApplication: { pdfViewer: { currentPageNumber: 1 } },
  };
  const reader = {
    itemID: 12,
    _internalReader: { _primaryView: { _iframeWindow: frame } },
  };
  let selectedReader: unknown = reader;
  const before = Object.getOwnPropertyDescriptor(globalThis, "Zotero");
  Object.defineProperty(globalThis, "Zotero", {
    configurable: true,
    value: {
      Reader: { _readers: [reader], getByTabID: () => selectedReader },
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "pdf-tab" } }),
      Items: { get: () => ({ libraryID: 1, key: "PDF" }) },
    },
  });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, "Zotero", before);
    else Reflect.deleteProperty(globalThis, "Zotero");
  });
  let poll = () => {},
    cleared = false;
  const win = {
    setInterval: (f: () => void) => {
      poll = f;
      return 1;
    },
    clearInterval: () => {
      cleared = true;
    },
  } as unknown as Window;
  const events: unknown[] = [];
  const dispose = bindReadingPdfFollow(win, citations, (event) =>
    events.push(event),
  );
  assert.deepEqual(events, [
    {
      location: { libraryID: 1, attachmentKey: "PDF", pageIndex: 0 },
      explicit: false,
      move: false,
    },
  ]);
  poll();
  assert.equal(
    events.length,
    1,
    "Unchanged pages retain the current visual state",
  );
  frame.PDFViewerApplication.pdfViewer.currentPageNumber = 4;
  poll();
  assert.deepEqual(events[1], {
    location: { libraryID: 1, attachmentKey: "PDF", pageIndex: 3 },
    explicit: false,
    move: true,
  });
  doc.focused = false;
  frame.PDFViewerApplication.pdfViewer.currentPageNumber = 8;
  poll();
  assert.deepEqual(events[2], {
    location: { libraryID: 1, attachmentKey: "PDF", pageIndex: 7 },
    explicit: false,
    move: true,
  });
  selectedReader = undefined;
  poll();
  assert.deepEqual(events[3], { explicit: false, move: false });
  frame.PDFViewerApplication.pdfViewer.currentPageNumber = 9;
  poll();
  assert.equal(
    events.length,
    4,
    "Background papers do not reactivate the highlight",
  );
  selectedReader = reader;
  poll();
  assert.deepEqual(events[4], {
    location: { libraryID: 1, attachmentKey: "PDF", pageIndex: 8 },
    explicit: false,
    move: true,
  });
  const event = new Event("dblclick");
  Object.defineProperty(event, "target", {
    value: {
      closest: (selector: string) =>
        selector === ".page" ? { getAttribute: () => "6" } : null,
    },
  });
  doc.dispatchEvent(event);
  assert.deepEqual(events[5], {
    location: { libraryID: 1, attachmentKey: "PDF", pageIndex: 5 },
    explicit: true,
    move: true,
  });
  poll();
  assert.equal(
    events.length,
    6,
    "Double-click association persists until the reader moves",
  );
  dispose();
  doc.dispatchEvent(event);
  poll();
  assert.equal(events.length, 6);
  assert.equal(cleared, true);
  const initial: unknown[] = [];
  const stopInitial = bindReadingPdfFollow(
    win,
    citations,
    (event) => initial.push(event),
    true,
  );
  assert.deepEqual(initial[0], {
    location: { libraryID: 1, attachmentKey: "PDF", pageIndex: 8 },
    explicit: false,
    move: true,
  });
  const secondaryDoc = new Doc();
  const secondaryFrame = {
    document: secondaryDoc,
    PDFViewerApplication: { pdfViewer: { currentPageNumber: 6 } },
  };
  const internal = reader._internalReader as typeof reader._internalReader & {
    _secondaryView?: { _iframeWindow: typeof secondaryFrame };
  };
  internal._secondaryView = { _iframeWindow: secondaryFrame };
  poll();
  assert.deepEqual(initial[1], {
    location: { libraryID: 1, attachmentKey: "PDF", pageIndex: 5 },
    explicit: false,
    move: true,
  });
  secondaryDoc.focused = false;
  frame.PDFViewerApplication.pdfViewer.currentPageNumber = 10;
  poll();
  assert.equal(
    initial.length,
    2,
    "The last active split pane remains selected when focus moves to the companion",
  );
  secondaryFrame.PDFViewerApplication.pdfViewer.currentPageNumber = 7;
  poll();
  assert.deepEqual(initial[2], {
    location: { libraryID: 1, attachmentKey: "PDF", pageIndex: 6 },
    explicit: false,
    move: true,
  });
  internal._secondaryView = undefined;
  poll();
  assert.deepEqual(initial[3], {
    location: { libraryID: 1, attachmentKey: "PDF", pageIndex: 9 },
    explicit: false,
    move: true,
  });
  secondaryDoc.dispatchEvent(event);
  assert.equal(initial.length, 4, "Closed split panes no longer navigate");
  stopInitial();
});
