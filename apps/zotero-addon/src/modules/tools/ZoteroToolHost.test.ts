import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZoteroToolHost } from "./ZoteroToolHost";

interface InstalledHost {
  host: ZoteroToolHost;
  saved: Array<Record<string, unknown>>;
  erased: string[];
  refreshed: string[][];
  unset: string[][];
  navigated: Array<Record<string, unknown>>;
}

function installHost(
  options: {
    libraryID?: number;
    failSaveAt?: number;
    failRefresh?: boolean;
    useReaderPageView?: boolean;
  } = {},
): InstalledHost {
  const libraryID = options.libraryID ?? 1;
  const saved: Array<Record<string, unknown>> = [];
  const erased: string[] = [];
  const refreshed: string[][] = [];
  const unset: string[][] = [];
  const navigated: Array<Record<string, unknown>> = [];
  let keyIndex = 0;

  const parent = {
    id: 100,
    libraryID,
    key: "ITEMKEY1",
    isAttachment: () => false,
    isNote: () => false,
    getAttachments: () => [200],
  };
  const attachment = {
    id: 200,
    libraryID,
    key: "PDFKEY01",
    isAttachment: () => true,
    isFileAttachment: () => true,
    isNote: () => false,
    attachmentContentType: "application/pdf",
  };
  const viewport = {
    width: 1000,
    height: 1000,
    convertToPdfPoint: (x: number, y: number): [number, number] => [
      x,
      1000 - y,
    ],
    convertToViewportPoint: (x: number, y: number): [number, number] => [
      x,
      1000 - y,
    ],
  };
  const pdfPage = {
    getViewport: () => viewport,
    render: () => ({ promise: Promise.resolve() }),
  };
  const pdfDocument = {
    numPages: 4,
    getPage: async () => (options.useReaderPageView ? {} : pdfPage),
  };
  const controller = {
    _pdfDocument: {},
    _pendingFindMatches: new Set<number>(),
    pageMatches: [[0], [0], [0], [0]],
    find: async () => undefined,
    getMatchPositionsAsync: async () => [{ rects: [[10, 20, 40, 35]] }],
  };
  const view = {
    initializedPromise: Promise.resolve(),
    _findController: controller,
    _iframeWindow: {
      PDFViewerApplication: {
        pdfDocument,
        pdfViewer: options.useReaderPageView
          ? { getPageView: () => ({ pdfPage }) }
          : undefined,
      },
    },
    _ensureBasicPageData: async () => undefined,
    setFindState: async () => undefined,
    getAnnotationMeta: (position: { pageIndex: number }) => ({
      pageLabel: String(position.pageIndex + 1),
      sortIndex: `${String(position.pageIndex).padStart(5, "0")}|000010|00000`,
    }),
    _getPageLabel: (pageIndex: number) => String(pageIndex + 1),
  };
  const reader = {
    itemID: attachment.id,
    _instanceID: "reader-instance",
    _initPromise: Promise.resolve(),
    _waitForReader: async () => undefined,
    _internalReader: { _primaryView: view },
    setAnnotations: async (items: Array<{ key: string }>) => {
      refreshed.push(items.map((item) => item.key));
      if (options.failRefresh) throw new Error("refresh failed");
    },
    unsetAnnotations: async (keys: string[]) => {
      unset.push([...keys]);
    },
    navigate: async (location: Record<string, unknown>) => {
      navigated.push(location);
    },
  };

  (globalThis as unknown as { Components: unknown }).Components = {
    utils: { cloneInto: (value: unknown) => value },
  };
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    Libraries: { userLibraryID: 1 },
    Groups: {
      getGroupIDFromLibraryID: (id: number) => (id === 1 ? 0 : 77),
    },
    Items: {
      getByLibraryAndKey: (id: number, key: string) =>
        id === libraryID && key === parent.key ? parent : null,
      get: (id: number) => (id === attachment.id ? attachment : null),
    },
    Reader: {
      _readers: [reader],
      open: async () => reader,
    },
    Promise: { delay: async () => undefined },
    DataObjectUtilities: {
      generateKey: () => `ANNKEY0${++keyIndex}`,
    },
    Annotations: {
      DEFAULT_COLOR: "#ffd400",
      saveFromJSON: async (
        _attachment: unknown,
        json: Record<string, unknown>,
      ) => {
        saved.push(json);
        if (options.failSaveAt === saved.length) {
          throw new Error("save failed");
        }
        return {
          key: String(json.key),
          eraseTx: async () => {
            erased.push(String(json.key));
          },
        };
      },
    },
  };

  return {
    host: new ZoteroToolHost(),
    saved,
    erased,
    refreshed,
    unset,
    navigated,
  };
}

describe("ZoteroToolHost PDF annotation commit", () => {
  it("writes highlight, underline, and image notes then refreshes once", async () => {
    const installed = installHost({ libraryID: 5 });
    const result = await installed.host.execute("commit_annotations", {
      libraryID: 5,
      key: "ITEMKEY1",
      annotations: [
        { type: "highlight", page: 1, quote: "Core claim" },
        {
          type: "underline",
          page: 2,
          quote: "Read this carefully",
          color: "#123ABC",
          comment: "Method detail",
        },
        {
          type: "image",
          page: 3,
          rect: [100, 200, 300, 400],
          comment: "Figure evidence",
        },
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      installed.saved.map((json) => ({
        type: json.type,
        color: json.color,
        text: json.text,
        comment: json.comment,
      })),
      [
        {
          type: "highlight",
          color: "#ffd400",
          text: "Core claim",
          comment: "",
        },
        {
          type: "underline",
          color: "#123abc",
          text: "Read this carefully",
          comment: "Method detail",
        },
        {
          type: "image",
          color: "#a28ae5",
          text: "",
          comment: "Figure evidence",
        },
      ],
    );
    assert.deepEqual(installed.saved[2]?.position, {
      pageIndex: 2,
      rects: [[100, 400, 400, 800]],
    });
    assert.deepEqual(installed.refreshed, [
      ["ANNKEY01", "ANNKEY02", "ANNKEY03"],
    ]);
    assert.deepEqual(installed.navigated, [{ annotationID: "ANNKEY01" }]);
    if (result.ok) {
      const data = result.data as {
        itemKey: string;
        attachmentKey: string;
        annotationKey: string;
        annotationKeys: string[];
        zoteroUri: string;
        annotations: Array<{ zoteroUri: string }>;
      };
      assert.equal(data.itemKey, "ITEMKEY1");
      assert.equal(data.attachmentKey, "PDFKEY01");
      assert.equal(data.annotationKey, "ANNKEY01");
      assert.deepEqual(data.annotationKeys, [
        "ANNKEY01",
        "ANNKEY02",
        "ANNKEY03",
      ]);
      assert.equal(
        data.zoteroUri,
        "zotero://open-pdf/groups/77/items/PDFKEY01?annotation=ANNKEY01&page=1",
      );
      assert.match(
        data.annotations[2]!.zoteroUri,
        /annotation=ANNKEY03&page=3$/,
      );
    }
  });

  it("accepts the legacy highlight list", async () => {
    const installed = installHost();
    const result = await installed.host.execute("commit_annotations", {
      libraryID: 1,
      key: "ITEMKEY1",
      highlights: [{ text: "Legacy quote", page: 4 }],
    });

    assert.equal(result.ok, true);
    assert.equal(installed.saved[0]?.type, "highlight");
    assert.equal(installed.saved[0]?.color, "#ffd400");
  });

  it("uses the Reader PDFPageView when the document page is Xray-wrapped", async () => {
    const installed = installHost({ useReaderPageView: true });
    const result = await installed.host.execute("commit_annotations", {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        {
          type: "image",
          page: 2,
          rect: [100, 200, 300, 400],
          comment: "Reader page view",
        },
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(installed.saved[0]?.position, {
      pageIndex: 1,
      rects: [[100, 400, 400, 800]],
    });
  });

  it("rolls back earlier annotations when a later save fails", async () => {
    const installed = installHost({ failSaveAt: 2 });
    const result = await installed.host.execute("commit_annotations", {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { type: "highlight", page: 1, quote: "First" },
        { type: "underline", page: 2, quote: "Second" },
      ],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(installed.erased, ["ANNKEY01"]);
    assert.deepEqual(installed.unset, [["ANNKEY01"]]);
    assert.deepEqual(installed.refreshed, []);
  });

  it("rolls back the complete batch when Reader refresh fails", async () => {
    const installed = installHost({ failRefresh: true });
    const result = await installed.host.execute("commit_annotations", {
      libraryID: 1,
      key: "ITEMKEY1",
      annotations: [
        { type: "highlight", page: 1, quote: "First" },
        { type: "underline", page: 2, quote: "Second" },
      ],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(installed.erased, ["ANNKEY02", "ANNKEY01"]);
    assert.deepEqual(installed.unset, [["ANNKEY01", "ANNKEY02"]]);
    assert.deepEqual(installed.navigated, []);
  });
});
