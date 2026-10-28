/**
 * Organizer-Review für Approvals: baut aus den Zuweisungs-Argumenten eine
 * menschenlesbare Karte (Outline-Akkordeons, Zitate, Quellen) für das
 * Bestätigungs-UI. Eigenständige Datei, damit das Feature später entfernt
 * werden kann, ohne AgentHost.ts zerschneiden zu müssen.
 *
 * Die Quelle ist duck-typed: großteils die `OrganizerTools`-Instanz auf
 * `ZoteroToolHost.organizer`, in Tests ein Mock mit denselben optionalen
 * Methoden. Alle Zugriffe laufen über optionale Methoden.
 */

import type {
  OrganizerAssignmentHeading,
  OrganizerAssignmentItemReview,
  OrganizerAssignmentReview,
} from "@confucius/protocol";
import { buildWorkCitation } from "../tools/workCitation";
import {
  buildHeadingLookup,
  cleanHeadingTitle,
  type FlatHeading,
  type OutlineNode,
} from "@confucius/zotero-tools";

/** Duck-typed Zugriff auf den Organizer-Provider (ZoteroToolHost.organizer oder Test-Mock). */
export interface OrganizerReviewSource {
  getCollectionByRef?(libraryID: number, ref: string): Zotero.Collection | null;
  getTopmostCollection?(collection: Zotero.Collection): Zotero.Collection;
  getOutlineCache?(
    libraryID: number,
    colRef?: string | null,
  ): { roots: OutlineNode[]; headings: FlatHeading[] } | undefined;
  resolveOutline?(
    libraryID: number,
    colRef?: string | null,
  ): Promise<{ roots: OutlineNode[]; headings: FlatHeading[] } | undefined>;
  getCachedAnnotation?(key: string):
    | {
        key: string;
        text: string;
        comment: string;
        pageLabel: string;
        color: string;
        workTitle: string;
        workCitation: string;
        libraryID: number;
      }
    | undefined;
}

/** Kurze Alias-Namen, für die eine Organizer-Review-Karte gebaut wird. */
const ORGANIZER_REVIEW_TOOL_NAMES = new Set<string>([
  "organizer_assign_annotations",
  "annotations_assign",
  "organizer_unassign_annotations",
  "annotations_unassign",
]);

export function isOrganizerReviewTool(toolName: string): boolean {
  return ORGANIZER_REVIEW_TOOL_NAMES.has(toolName);
}

/**
 * Baut die Approvals-Review-Karte für Zuweisungs-Tools. Ohne Zuweisungen
 * oder für andere Tools wird `undefined` geliefert (kein Review nötig).
 */
export async function buildOrganizerReview(
  tools: OrganizerReviewSource | undefined,
  toolName: string,
  args: Record<string, unknown>,
): Promise<OrganizerAssignmentReview | undefined> {
  if (!isOrganizerReviewTool(toolName)) {
    return undefined;
  }
  let rawAssignments = Array.isArray(args.assignments)
    ? (args.assignments as Array<{
        key?: unknown;
        headings?: unknown;
        reason?: unknown;
        rationale?: unknown;
        explanation?: unknown;
        quote?: unknown;
        text?: unknown;
        annotationText?: unknown;
      }>)
    : [];
  if (!rawAssignments.length) {
    if (Array.isArray(args.keys)) {
      const fallbackHeadings = Array.isArray(args.headings)
        ? args.headings
        : [];
      rawAssignments = (args.keys as unknown[]).map((k) => ({
        key: k,
        headings: fallbackHeadings,
      }));
    } else if (typeof args.key === "string" && args.key) {
      const fallbackHeadings = Array.isArray(args.headings)
        ? args.headings
        : [];
      rawAssignments = [{ key: args.key, headings: fallbackHeadings }];
    }
  }
  if (!rawAssignments.length) return undefined;

  let libraryID =
    typeof args.libraryID === "number"
      ? args.libraryID
      : typeof Zotero !== "undefined" && Zotero.Libraries?.userLibraryID
        ? Zotero.Libraries.userLibraryID
        : 1;
  const colRef = String(args.collection ?? args.collectionKey ?? "").trim();

  let collectionTitle = colRef;
  let collectionKey: string | undefined;
  let topmostKey: string | null = null;
  let roots: OutlineNode[] = [];
  let headingLookup = new Map<string, FlatHeading>();
  let outlineHeadings: FlatHeading[] = [];

  try {
    if (typeof Zotero !== "undefined" && Zotero.Collections) {
      let col: any = tools?.getCollectionByRef?.(libraryID, colRef);
      if (!col && colRef) {
        const collectionsList =
          typeof (Zotero.Collections as any).getByLibrary === "function"
            ? (Zotero.Collections as any).getByLibrary(libraryID)
            : typeof (Zotero.Collections as any).getLoaded === "function"
              ? (Zotero.Collections as any).getLoaded()
              : [];
        col =
          (typeof (Zotero.Collections as any).getByLibraryAndKey === "function"
            ? (Zotero.Collections as any).getByLibraryAndKey(libraryID, colRef)
            : null) ||
          (Array.isArray(collectionsList)
            ? collectionsList.find(
                (c: any) =>
                  c &&
                  (c.name === colRef ||
                    c.name?.toLowerCase() === colRef.toLowerCase() ||
                    c.key === colRef),
              )
            : null) ||
          null;
      }
      if (col) {
        collectionTitle = col.name;
        collectionKey = col.key;
        if (typeof col.libraryID === "number") {
          libraryID = col.libraryID;
        }
        const topmost = tools?.getTopmostCollection?.(col);
        if (topmost?.key) {
          topmostKey = topmost.key;
        } else {
          let cur = col;
          while (
            cur &&
            cur.parentID &&
            typeof (Zotero.Collections as any).get === "function"
          ) {
            const parent = (Zotero.Collections as any).get(cur.parentID);
            if (!parent || parent.id === cur.id) break;
            cur = parent;
          }
          if (cur?.key) {
            topmostKey = cur.key;
          }
        }
      }
    }
  } catch {
    // Fallback if Zotero collections not available in mock
  }

  try {
    let cached = tools?.getOutlineCache?.(libraryID, colRef);
    if (!cached && collectionKey) {
      cached = tools?.getOutlineCache?.(libraryID, collectionKey);
    }
    if (!cached && topmostKey) {
      cached = tools?.getOutlineCache?.(libraryID, topmostKey);
    }
    if (cached) {
      roots = cached.roots;
      outlineHeadings = cached.headings;
    }
    if (
      !outlineHeadings.length &&
      typeof tools?.resolveOutline === "function"
    ) {
      // resolveOutline kapselt das Finden + Parsen + Cachen der Outline-Notiz;
      // hier nicht duplizieren.
      const resolved = await tools.resolveOutline(
        libraryID,
        colRef || collectionKey || topmostKey,
      );
      if (resolved) {
        roots = resolved.roots;
        outlineHeadings = resolved.headings;
      }
    }
    if (outlineHeadings && outlineHeadings.length > 0) {
      headingLookup = buildHeadingLookup(outlineHeadings);
    } else if (roots.length > 0) {
      headingLookup = buildHeadingLookup(roots);
    }
  } catch {
    // Fallback if tools cache not available
  }

  const items: OrganizerAssignmentItemReview[] = [];
  for (const entry of rawAssignments) {
    const key = typeof entry?.key === "string" ? entry.key.trim() : "";
    if (!key) continue;

    let quote =
      typeof entry.quote === "string"
        ? entry.quote
        : typeof entry.text === "string"
          ? entry.text
          : typeof entry.annotationText === "string"
            ? entry.annotationText
            : "";
    let comment = "";
    let page = "";
    let color = "";
    let sourceTitle = "";
    let sourceCitation = "";
    const cachedAnn = tools?.getCachedAnnotation?.(key);
    if (cachedAnn) {
      if (!quote && cachedAnn.text) quote = cachedAnn.text;
      if (!comment && cachedAnn.comment) comment = cachedAnn.comment;
      if (!page && cachedAnn.pageLabel) page = cachedAnn.pageLabel;
      if (!color && cachedAnn.color) color = cachedAnn.color;
      if (!sourceTitle && cachedAnn.workTitle)
        sourceTitle = cachedAnn.workTitle;
      if (!sourceCitation && cachedAnn.workCitation)
        sourceCitation = cachedAnn.workCitation;
    }

    if (!((sourceTitle || sourceCitation) && quote)) {
      try {
        if (typeof Zotero !== "undefined" && Zotero.Items) {
        let item: any =
          (await (Zotero.Items as any).getByLibraryAndKeyAsync?.(
            libraryID,
            key,
          )) ||
          (typeof (Zotero.Items as any).getByLibraryAndKey === "function"
            ? (Zotero.Items as any).getByLibraryAndKey(libraryID, key)
            : null);
        if (item === false) item = null;

        if (!item && typeof (Zotero.Libraries as any)?.getAll === "function") {
          for (const lib of (Zotero.Libraries as any).getAll()) {
            if (lib.libraryID === libraryID) continue;
            const cand =
              (await (Zotero.Items as any).getByLibraryAndKeyAsync?.(
                lib.libraryID,
                key,
              )) ||
              (typeof (Zotero.Items as any).getByLibraryAndKey === "function"
                ? (Zotero.Items as any).getByLibraryAndKey(lib.libraryID, key)
                : null);
            if (cand && cand !== false) {
              item = cand;
              break;
            }
          }
        }
        if (item && item !== false) {
          if (!quote) {
            quote =
              item.annotationText ||
              (typeof item.getField === "function"
                ? item.getField("text")
                : "") ||
              "";
          }
          comment =
            item.annotationComment ||
            (typeof item.getField === "function"
              ? item.getField("comment")
              : "") ||
            "";
          page =
            item.annotationPageLabel ||
            (item.annotationPosition
              ? String(
                  (typeof item.annotationPosition === "string"
                    ? (JSON.parse(item.annotationPosition)?.pageIndex ?? 0)
                    : (item.annotationPosition?.pageIndex ?? 0)) + 1,
                )
              : "");
          color = item.annotationColor || "";

          let work: any = item.topLevelItem ?? null;
          if (!work && item.parentItem) {
            const p = item.parentItem;
            work = p.topLevelItem ?? (p.isAttachment?.() ? p.parentItem : p);
          }
          if (!work) {
            const parentID = (item as any).parentItemID;
            if (parentID) {
              const att: any =
                (await (Zotero.Items as any).getAsync?.(parentID)) ||
                (typeof (Zotero.Items as any).get === "function"
                  ? (Zotero.Items as any).get(parentID)
                  : null);
              if (att) {
                work = att.topLevelItem ?? null;
                if (!work) {
                  const workParentID = (att as any).parentItemID;
                  if (workParentID) {
                    work =
                      (await (Zotero.Items as any).getAsync?.(workParentID)) ||
                      (typeof (Zotero.Items as any).get === "function"
                        ? (Zotero.Items as any).get(workParentID)
                        : null);
                  }
                }
              }
            }
          }
          if (work && typeof work === "object") {
            const { title, citation } = buildWorkCitation(work);
            sourceTitle = title;
            sourceCitation = citation;
          }
        }
        }
      } catch {
        // Fallback
      }
    }

    const rawHeadings = Array.isArray(entry.headings)
      ? entry.headings
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const headings: OrganizerAssignmentHeading[] = rawHeadings.map((h) => {
      const normKey = h.trim().toLowerCase().replace(/^§\s*/, "");
      const match =
        headingLookup.get(normKey) ||
        headingLookup.get(h.toLowerCase()) ||
        headingLookup.get(`§${normKey}`);
      if (match) {
        return {
          title: match.title,
          num: match.num,
          path: match.path,
          tag: match.tag,
        };
      }
      const cleaned = cleanHeadingTitle(h);
      if (cleaned.num) {
        return {
          num: cleaned.num,
          title: cleaned.title,
        };
      }
      return { title: h };
    });

    const reason =
      typeof entry.reason === "string" && entry.reason.trim()
        ? entry.reason.trim()
        : typeof entry.rationale === "string" && entry.rationale.trim()
          ? entry.rationale.trim()
          : typeof entry.explanation === "string" && entry.explanation.trim()
            ? entry.explanation.trim()
            : undefined;

    items.push({
      key,
      headings,
      reason,
      quote: quote || undefined,
      comment: comment || undefined,
      page: page || undefined,
      color: color || undefined,
      sourceTitle: sourceTitle || undefined,
      sourceCitation: sourceCitation || undefined,
    });
  }

  return {
    collectionKey,
    collectionTitle,
    totalAssignments: items.length,
    items,
    outlineHeadings: outlineHeadings.map((h) => ({
      title: h.title,
      num: h.num,
      path: h.path,
      tag: h.tag,
    })),
  };
}
