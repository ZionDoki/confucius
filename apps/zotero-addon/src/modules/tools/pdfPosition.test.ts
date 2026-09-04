import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizePdfMatchPositions } from "./pdfPosition";

describe("normalizePdfMatchPositions", () => {
  it("restores a page index omitted by the Zotero reader", () => {
    assert.deepEqual(
      normalizePdfMatchPositions(2, [{ rects: [[30, 40, 10, 20]] }]),
      [{ pageIndex: 2, rects: [[10, 20, 30, 40]] }],
    );
  });

  it("accepts nested positions and drops invisible rectangles", () => {
    assert.deepEqual(
      normalizePdfMatchPositions(4, [
        { position: { pageIndex: 1, rects: [[1, 2, 3, 4]] } },
        { rects: [[1, 2, 1, 4]] },
      ]),
      [{ pageIndex: 1, rects: [[1, 2, 3, 4]] }],
    );
  });
});
