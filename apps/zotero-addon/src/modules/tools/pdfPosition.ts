export interface PdfPosition {
  pageIndex: number;
  rects: number[][];
  nextPageRects?: number[][];
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
