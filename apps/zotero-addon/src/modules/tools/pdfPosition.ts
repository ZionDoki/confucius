export interface PdfPosition {
  pageIndex: number;
  rects: number[][];
  nextPageRects?: number[][];
}

export type NormalizedRegionRect = [number, number, number, number];

export interface PdfViewportLike {
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): [number, number];
  convertToViewportPoint?(x: number, y: number): [number, number];
}

export function normalizeRegionRect(value: unknown): NormalizedRegionRect {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((part) => typeof part !== "number" || !Number.isFinite(part))
  ) {
    throw new Error("Region rect must be [x,y,width,height]");
  }
  const [x, y, width, height] = value;
  if (
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > 1000 ||
    y + height > 1000
  ) {
    throw new Error(
      "Region rect must fit the top-left-origin 0-1000 page coordinate space",
    );
  }
  return [x, y, width, height];
}

/** Convert a normalized top-left region to Zotero's PDF-coordinate rect. */
export function normalizedRegionToPdfPosition(
  pageIndex: number,
  value: unknown,
  viewport: PdfViewportLike,
): PdfPosition {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error("PDF page index must be a non-negative integer");
  }
  if (!(viewport.width > 0) || !(viewport.height > 0)) {
    throw new Error("PDF page viewport is unavailable");
  }
  const [x, y, width, height] = normalizeRegionRect(value);
  const [x1, y1] = viewport.convertToPdfPoint(
    (x / 1000) * viewport.width,
    (y / 1000) * viewport.height,
  );
  const [x2, y2] = viewport.convertToPdfPoint(
    ((x + width) / 1000) * viewport.width,
    ((y + height) / 1000) * viewport.height,
  );
  return {
    pageIndex,
    rects: [
      [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
    ],
  };
}

/** Convert one PDF-coordinate rect back to the public normalized page space. */
export function pdfRectToNormalizedRegion(
  rect: number[],
  viewport: PdfViewportLike,
): NormalizedRegionRect | null {
  if (!viewport.convertToViewportPoint || rect.length < 4) return null;
  const [vx1, vy1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [vx2, vy2] = viewport.convertToViewportPoint(rect[2], rect[3]);
  const left = Math.min(vx1, vx2);
  const top = Math.min(vy1, vy2);
  const right = Math.max(vx1, vx2);
  const bottom = Math.max(vy1, vy2);
  const normalized: NormalizedRegionRect = [
    clamp((left / viewport.width) * 1000),
    clamp((top / viewport.height) * 1000),
    clamp(((right - left) / viewport.width) * 1000),
    clamp(((bottom - top) / viewport.height) * 1000),
  ];
  return normalized[2] > 0 && normalized[3] > 0 ? normalized : null;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1000, Math.round(value * 10) / 10));
}

function rectList(value: unknown): number[][] {
  if (!value || typeof value !== "object") {
    return [];
  }
  return Array.from(value as ArrayLike<unknown>).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const values = Array.from(candidate as ArrayLike<unknown>).map(Number);
    if (values.length < 4 || values.some((part) => !Number.isFinite(part))) {
      return [];
    }
    const [x1, y1, x2, y2] = values;
    const rect = [
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
    ];
    return rect[2] > rect[0] && rect[3] > rect[1] ? [rect] : [];
  });
}

/**
 * Normalize results crossing the Zotero reader chrome boundary. Some reader
 * builds omit pageIndex because the caller already supplied it, and wrapped
 * arrays do not reliably pass Array.isArray checks.
 */
export function normalizePdfMatchPositions(
  pageIndex: number,
  value: unknown,
): PdfPosition[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  return Array.from(value as ArrayLike<unknown>).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const record = candidate as Record<string, unknown>;
    const nested =
      record.position && typeof record.position === "object"
        ? (record.position as Record<string, unknown>)
        : record;
    const rects = rectList(nested.rects);
    if (!rects.length) {
      return [];
    }
    const reportedPage = Number(nested.pageIndex);
    const position: PdfPosition = {
      pageIndex:
        Number.isInteger(reportedPage) && reportedPage >= 0
          ? reportedPage
          : pageIndex,
      rects,
    };
    const nextPageRects = rectList(nested.nextPageRects);
    if (nextPageRects.length) {
      position.nextPageRects = nextPageRects;
    }
    return [position];
  });
}
