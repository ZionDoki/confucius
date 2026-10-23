import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ZoteroUri } from "@confucius/protocol";
import {
  navigateZoteroUri,
  pdfLocationForUri,
  resolveLibraryID,
  selectExistingReader,
} from "./linkNavigator";
import { parseZoteroUri } from "@confucius/protocol";

describe("selectExistingReader", () => {
  it("finds the reader for an open attachment", () => {
    const readers = [
      { itemID: 10, tabID: "tab-a" },
      { itemID: 20, tabID: "tab-b" },
    ];
    assert.equal(selectExistingReader(readers, 20)?.tabID, "tab-b");
  });

  it("returns null when the attachment is not open", () => {
    assert.equal(selectExistingReader([{ itemID: 1 }], 99), null);
    assert.equal(selectExistingReader([], 1), null);
  });
});

describe("pdfLocationForUri", () => {
  const uri = {
    kind: "open-pdf" as const,
    attachmentKey: "PDF",
    annotationKey: "ANN",
    page: 6,
  };

  it("uses a real annotation belonging to the attachment", () => {
    assert.deepEqual(
      pdfLocationForUri(uri, 10, {
        key: "ANN",
        parentItemID: 10,
        isAnnotation: () => true,
      }),
      { annotationID: "ANN" },
    );
  });

  it("falls back to the page for a missing or unrelated annotation", () => {
    assert.deepEqual(pdfLocationForUri(uri, 10, null), { pageIndex: 5 });
    assert.deepEqual(
      pdfLocationForUri(uri, 10, { key: "ANN", parentItemID: 99 }),
      { pageIndex: 5 },
    );
  });
});

describe("resolveLibraryID", () => {
  const libraries = new Set([1, 7, 9]);
  const fakeZotero = {
    Libraries: {
      userLibraryID: 1,
      get: (id: number) => (libraries.has(id) ? { id } : false),
    },
    Groups: {
      getLibraryIDFromGroupID: (id: number) => (id === 42 ? 9 : false),
    },
  };

  const resolve = (uri: ZoteroUri): number | null => {
    const previous = Reflect.get(globalThis, "Zotero");
    Reflect.set(globalThis, "Zotero", fakeZotero);
    try {
      return resolveLibraryID(uri);
    } finally {
      Reflect.set(globalThis, "Zotero", previous);
    }
  };

  it("keeps the library scope parsed from a legacy ZotFile URI", () => {
    assert.equal(
      resolve({ kind: "open-pdf", libraryID: 7, attachmentKey: "PDF" }),
      7,
    );
  });

  it("maps a legacy group index to its group library", () => {
    assert.equal(
      resolve({ kind: "open-pdf", libraryID: 42, attachmentKey: "PDF" }),
      9,
    );
  });

  it("uses the group library for the standard group URI form", () => {
    assert.equal(
      resolve({ kind: "open-pdf", groupID: 42, attachmentKey: "PDF" }),
      9,
    );
  });

  it("rejects unavailable explicit scopes", () => {
    assert.equal(
      resolve({ kind: "open-pdf", libraryID: 99, attachmentKey: "PDF" }),
      null,
    );
    assert.equal(
      resolve({ kind: "open-pdf", groupID: 99, attachmentKey: "PDF" }),
      null,
    );
  });

  it("defaults unscoped and legacy-zero links to the user library", () => {
    assert.equal(resolve({ kind: "open-pdf", attachmentKey: "PDF" }), 1);
    const legacy = parseZoteroUri("zotero://open-pdf/0_PDF/6");
    assert.ok(legacy);
    assert.equal(resolve(legacy), 1);
  });

  it("never opens a personal item with the same key as an unavailable group item", async () => {
    const lookedUp: Array<[number, string]> = [];
    const opened: number[] = [];
    const previous = Reflect.get(globalThis, "Zotero");
    Reflect.set(globalThis, "Zotero", {
      ...fakeZotero,
      Items: {
        getByLibraryAndKey: (libraryID: number, key: string) => {
          lookedUp.push([libraryID, key]);
          return libraryID === 1 && key === "SAMEKEY"
            ? { id: 101, libraryID, isFileAttachment: () => true }
            : false;
        },
      },
      Reader: { _readers: [], open: (id: number) => opened.push(id) },
    });
    try {
      for (const kind of ["select", "open-pdf"]) {
        const uri = parseZoteroUri(`zotero://${kind}/groups/99/items/SAMEKEY`);
        assert.ok(uri);
        assert.equal((await navigateZoteroUri(uri)).ok, false);
      }
      assert.deepEqual(lookedUp, []);
      assert.deepEqual(opened, []);
    } finally {
      Reflect.set(globalThis, "Zotero", previous);
    }
  });

  it("navigates a legacy group link in its own library", async () => {
    const lookedUp: Array<[number, string]> = [];
    const opened: Array<[number, Record<string, unknown> | undefined]> = [];
    const attachment = {
      id: 99,
      libraryID: 9,
      isFileAttachment: () => true,
    };
    const previous = Reflect.get(globalThis, "Zotero");
    Reflect.set(globalThis, "Zotero", {
      ...fakeZotero,
      Items: {
        getByLibraryAndKey: (libraryID: number, key: string) => {
          lookedUp.push([libraryID, key]);
          return libraryID === 9 && key === "PDF" ? attachment : false;
        },
      },
      Reader: {
        _readers: [],
        open: (itemID: number, location?: Record<string, unknown>) => {
          opened.push([itemID, location]);
        },
      },
    });
    try {
      const uri = parseZoteroUri("zotero://open-pdf/42_PDF/6");
      assert.ok(uri);
      const result = await navigateZoteroUri(uri);
      assert.deepEqual(result, { ok: true });
      assert.deepEqual(lookedUp, [[9, "PDF"]]);
      assert.deepEqual(opened, [[99, { pageIndex: 5 }]]);
    } finally {
      Reflect.set(globalThis, "Zotero", previous);
    }
  });
});
