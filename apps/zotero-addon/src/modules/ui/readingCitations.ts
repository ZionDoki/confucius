import type { Citation } from "@confucius/protocol";

export type CitationTarget = {
  libraryID: number;
  key: string;
  pageIndex?: number;
  annotationKey?: string;
  selectItem?: boolean;
};

export function citationTarget(citation: Citation): CitationTarget {
  return {
    libraryID: citation.itemLibraryID,
    key: citation.attachmentKey || citation.itemKey,
    pageIndex: citation.page === undefined ? undefined : citation.page - 1,
    annotationKey: citation.annotationKey,
    ...(!citation.attachmentKey &&
    citation.page === undefined &&
    !citation.annotationKey
      ? { selectItem: true }
      : {}),
  };
}

/** Ambiguous or missing IDs remain visible text; never guess a source. */
export function hydrateReadingCitations(
  root: HTMLElement,
  citations: readonly Citation[],
  locateLink: (doc: Document, target: CitationTarget) => HTMLElement,
): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  for (const marker of root.querySelectorAll("[data-citation-id]")) {
    const id = marker.getAttribute("data-citation-id");
    const matches = citations.filter((citation) => citation.id === id);
    if (matches.length !== 1) continue;
    const citation = matches[0];
    const link = locateLink(doc, citationTarget(citation));
    link.classList.add("confucius-citation-link");
    const label = citation.title || citation.section || citation.itemKey;
    const page = citation.page === undefined ? "" : `p. ${citation.page}`;
    link.textContent = page || label;
    link.setAttribute(
      "aria-label",
      [label, page, citation.quote].filter(Boolean).join(" · "),
    );
    link.title = [label, page, citation.quote].filter(Boolean).join("\n");
    link.setAttribute("data-citation-id", id!);
    marker.replaceWith(link);
  }
}
