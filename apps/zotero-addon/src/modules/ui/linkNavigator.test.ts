import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pdfLocationForUri, selectExistingReader } from "./linkNavigator";

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
