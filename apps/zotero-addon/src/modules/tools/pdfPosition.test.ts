import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizePdfMatchPositions,
  normalizedRegionToPdfPosition,
  pdfRectToNormalizedRegion,
} from "./pdfPosition";

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

describe("normalized PDF regions", () => {
  const viewport = {
    width: 600,
    height: 800,
    convertToPdfPoint: (x: number, y: number): [number, number] => [x, 800 - y],
    convertToViewportPoint: (x: number, y: number): [number, number] => [
      x,
      800 - y,
    ],
  };

  it("converts top-left normalized coordinates to Zotero PDF coordinates", () => {
    assert.deepEqual(
      normalizedRegionToPdfPosition(2, [100, 250, 500, 250], viewport),
      { pageIndex: 2, rects: [[60, 400, 360, 600]] },
    );
    assert.deepEqual(
      pdfRectToNormalizedRegion([60, 400, 360, 600], viewport),
      [100, 250, 500, 250],
    );
  });

  it("rejects regions outside the normalized page", () => {
    assert.throws(
      () => normalizedRegionToPdfPosition(0, [900, 0, 101, 10], viewport),
      /0-1000/,
    );
  });
});
