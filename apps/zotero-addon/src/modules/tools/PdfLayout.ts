/** Spatial text for checking table columns; the original image remains authoritative. */
export function spatialPageText(
  anchors: Array<{
    text: string;
    rect: [number, number, number, number];
  }>,
): string {
  const rows: Array<{ y: number; height: number; cells: typeof anchors }> = [];
  const valid = anchors.filter((a) => a.text && a.rect.every(Number.isFinite));
  for (const cell of [...valid].sort((a, b) => a.rect[1] - b.rect[1])) {
    const center = cell.rect[1] + cell.rect[3] / 2;
    const previous = rows.at(-1);
    if (
      previous &&
      Math.abs(previous.y - center) <=
        Math.min(previous.height, cell.rect[3]) / 3
    ) {
      previous.cells.push(cell);
    } else {
      rows.push({ y: center, height: cell.rect[3], cells: [cell] });
    }
  }
  return rows
    .map((row) => {
      let line = "";
      for (const cell of row.cells.sort((a, b) => a.rect[0] - b.rect[0])) {
        const column = Math.round(cell.rect[0] / 5);
        line +=
          " ".repeat(Math.max(line ? 2 : 0, column - line.length)) + cell.text;
      }
      return line.trimEnd();
    })
    .join("\n");
}
