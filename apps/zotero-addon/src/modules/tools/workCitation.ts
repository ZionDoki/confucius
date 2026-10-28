/**
 * Gemeinsame Quellenaufbereitung für Organizer-Listen und Review-Karten.
 * Baut aus einem Zotero-Werk den Anzeigetitel und ein Kurzzitat (QuickCopy,
 * sonst Creator/Jahr-Ableitung). Eine Stelle statt Duplikation in
 * OrganizerTools.listAnnotations und buildOrganizerReview.
 */

/** Minimaler Blick auf ein Zotero-Werk, wie ihn die Zitat-Ableitung braucht. */
interface WorkLike {
  getDisplayTitle?(): string;
  getField?(field: string): unknown;
  getCreators?(): Array<{
    firstName?: string;
    lastName?: string;
    name?: string;
  }>;
  firstCreator?: string;
}

export function buildWorkCitation(work: unknown): {
  title: string;
  citation: string;
} {
  const w = (work ?? {}) as WorkLike;
  const title =
    w.getDisplayTitle?.() ||
    (typeof w.getField === "function"
      ? String(w.getField("title") ?? "")
      : "") ||
    "";

  let citation = "";
  try {
    if (typeof Zotero !== "undefined" && (Zotero as any).QuickCopy) {
      const format = (Zotero as any).QuickCopy.getFormatFromURL(
        (Zotero as any).QuickCopy.lastActiveURL || "",
      );
      const content = (Zotero as any).QuickCopy.getContentFromItems(
        [work],
        format,
      );
      citation = (content?.text || "").trim();
    }
  } catch {
    // Fallback below
  }

  if (!citation) {
    const creators =
      w.firstCreator ||
      (w.getCreators?.() ?? [])
        .map(
          (c) =>
            `${c.firstName || ""} ${c.lastName || ""}`.trim() || c.name || "",
        )
        .filter(Boolean)
        .slice(0, 2)
        .join(", ") ||
      "";
    const year =
      (typeof w.getField === "function"
        ? String(w.getField("year") ?? "") ||
          String(w.getField("date") ?? "").match(/\b\d{4}\b/)?.[0] ||
          ""
        : "") || "";
    citation = creators && year ? `${creators} (${year})` : creators || title;
  }

  return { title, citation };
}
