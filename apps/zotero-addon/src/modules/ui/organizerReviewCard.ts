import type {
  OrganizerAssignmentItemReview,
  OrganizerAssignmentReview,
} from "@confucius/protocol";
import { markScrollContainer } from "./workspaceScrollbars";

const HTML_NS = "http://www.w3.org/1999/xhtml";

export interface ApprovalRowLike {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  summary?: string;
  before?: string;
  after?: string;
  kind?: string;
  origin?: string;
  organizerReview?: OrganizerAssignmentReview;
}

export interface OrganizerReviewCardOptions {
  resolve: (
    verdict: "allow" | "deny",
    scope: "once" | "session",
    editedArgs?: Record<string, unknown>,
  ) => void;
  locate?: (key: string, libraryID?: number) => void;
  language?: "de" | "en-US" | "zh-CN";
}

function l10n(lang: string) {
  const de = lang.startsWith("de");
  const zh = lang === "zh-CN";
  return {
    badge: de
      ? "Flex Annotations · Gliederungs-Zuweisung"
      : zh
        ? "Flex Annotations · 大纲归类"
        : "Flex Annotations · Outline Assignment",
    subheading: (col: string) =>
      col
        ? de
          ? `Gliederung: „${col}“`
          : zh
            ? `大纲：“${col}”`
            : `Outline: “${col}”`
        : de
          ? "Gliederungs-Zuweisungen"
          : zh
            ? "大纲归类提案"
            : "Outline assignments",
    tally: (total: number, accepted: number, rejected: number) =>
      de
        ? `${total} Vorschläge · ${accepted} angenommen · ${rejected} abgewiesen`
        : zh
          ? `${total} 条提案 · ${accepted} 条接受 · ${rejected} 条拒绝`
          : `${total} proposed · ${accepted} accepted · ${rejected} rejected`,
    all: de ? "Alle" : zh ? "全部" : "All",
    accepted: de ? "Angenommen" : zh ? "已接受" : "Accepted",
    rejected: de ? "Abgewiesen" : zh ? "已拒绝" : "Rejected",
    acceptAll: de ? "Alle annehmen" : zh ? "全选接受" : "Accept all",
    rejectAll: de ? "Alle abweisen" : zh ? "全选拒绝" : "Reject all",
    searchPlaceholder: de
      ? "In Zitaten, Kommentaren, Gliederung suchen…"
      : zh
        ? "搜索引文、评论或大纲章节…"
        : "Search quotes, comments, headings…",
    groupedView: de ? "Nach Gliederung" : zh ? "按大纲分组" : "By Heading",
    listView: de ? "Flache Liste" : zh ? "平铺列表" : "Flat List",
    applyButton: (count: number) =>
      de
        ? `✓ ${count} Zuweisung${count === 1 ? "" : "en"} anwenden`
        : zh
          ? `✓ 应用 ${count} 条归类`
          : `✓ Apply ${count} assignment${count === 1 ? "" : "s"}`,
    allowSession: de
      ? "Für Sitzung merken"
      : zh
        ? "本次会话记住"
        : "Allow for session",
    deny: de ? "✗ Alle ablehnen" : zh ? "✗ 拒绝全部" : "✗ Deny all",
    openInReader: de
      ? "Im Reader öffnen"
      : zh
        ? "在阅读器中打开"
        : "Open in reader",
    reason: de ? "Begründung" : zh ? "归类理由" : "Reason",
    comment: de ? "Kommentar" : zh ? "批注" : "Comment",
    noResults: de
      ? "Keine passenden Zuweisungen gefunden."
      : zh
        ? "未找到匹配的归类。"
        : "No matching assignments found.",
    params: de ? "Parameter (JSON)" : zh ? "参数 (JSON)" : "Parameters (JSON)",
    unassignedHeading: de
      ? "Ohne Überschrift"
      : zh
        ? "未指定大纲章节"
        : "Unassigned heading",
    acceptItem: de ? "Annehmen" : zh ? "接受" : "Accept",
    rejectItem: de ? "Abweisen" : zh ? "拒绝" : "Reject",
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  styles?: Partial<CSSStyleDeclaration> | Record<string, string>,
  attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (styles) {
    Object.assign(node.style, styles);
  }
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
  }
  return node;
}

export function cleanHeadingTitle(title: string): {
  num?: string;
  title: string;
} {
  const s = (title || "")
    .trim()
    .replace(/^§\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  // 1. Decimal numbering: "1", "1.1", "1.1.2", "1.", "1.1."
  const decMatch = s.match(/^([0-9]+(?:\.[0-9]+)*)\.?\s+(.+)$/);
  if (decMatch) {
    return { num: decMatch[1], title: decMatch[2].trim() };
  }
  // 2. Letter or Roman numeral with delimiter: "A.", "B)", "I.", "IV."
  const letterDelimMatch = s.match(/^([A-Za-z]|[IVXLCDMivxlcdm]+)[.)]\s+(.+)$/);
  if (letterDelimMatch) {
    return { num: letterDelimMatch[1], title: letterDelimMatch[2].trim() };
  }
  // 3. Multi-character Roman numerals: "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII"
  const romanMatch = s.match(/^(X{0,3}(?:IX|IV|V?I{2,3})|V|X{1,3})\s+(.+)$/i);
  if (romanMatch) {
    return { num: romanMatch[1], title: romanMatch[2].trim() };
  }
  return { title: s };
}

export function compareNumBadges(
  a: string | undefined,
  b: string | undefined,
): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const aClean = a.trim().replace(/[.)]+$/, "");
  const bClean = b.trim().replace(/[.)]+$/, "");
  const aParts = aClean.split(".");
  const bParts = bClean.split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === undefined) return -1;
    if (bp === undefined) return 1;
    const an = parseInt(ap, 10);
    const bn = parseInt(bp, 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else {
      const cmp = ap.localeCompare(bp, undefined, { numeric: true });
      if (cmp !== 0) return cmp;
    }
  }
  return aParts.length - bParts.length;
}

export function renderOrganizerReviewCard(
  doc: Document,
  item: ApprovalRowLike,
  options: OrganizerReviewCardOptions,
): HTMLElement {
  const lang = options.language ?? "de";
  const t = l10n(lang);

  // Reconstruct review data if not already populated
  let originalAssignments = Array.isArray(item.args.assignments)
    ? (item.args.assignments as Array<{
        key?: unknown;
        headings?: unknown;
        reason?: unknown;
        quote?: unknown;
      }>)
    : [];

  if (!originalAssignments.length && Array.isArray(item.args.keys)) {
    const fallbackHeadings = Array.isArray(item.args.headings)
      ? item.args.headings
      : [];
    originalAssignments = (item.args.keys as unknown[]).map((k) => ({
      key: k,
      headings: fallbackHeadings,
    }));
  } else if (
    !originalAssignments.length &&
    typeof item.args.key === "string" &&
    item.args.key
  ) {
    const fallbackHeadings = Array.isArray(item.args.headings)
      ? item.args.headings
      : [];
    originalAssignments = [{ key: item.args.key, headings: fallbackHeadings }];
  }

  const review: OrganizerAssignmentReview = item.organizerReview ?? {
    collectionTitle: String(
      item.args.collection ?? item.args.collectionKey ?? "",
    ),
    totalAssignments: originalAssignments.length,
    items: originalAssignments.map((a) => {
      const key = String(a.key ?? "");
      const headings = Array.isArray(a.headings) ? a.headings.map(String) : [];
      return {
        key,
        headings: headings.map((h) => {
          const cleaned = cleanHeadingTitle(h);
          if (cleaned.num) {
            return { num: cleaned.num, title: cleaned.title };
          }
          return { title: cleaned.title || h.trim() };
        }),
        reason:
          typeof a.reason === "string" && a.reason.trim()
            ? a.reason.trim()
            : typeof (a as any).rationale === "string" &&
                (a as any).rationale.trim()
              ? (a as any).rationale.trim()
              : typeof (a as any).explanation === "string" &&
                  (a as any).explanation.trim()
                ? (a as any).explanation.trim()
                : undefined,
        quote:
          typeof a.quote === "string" && a.quote.trim()
            ? a.quote.trim()
            : typeof (a as any).text === "string" && (a as any).text.trim()
              ? (a as any).text.trim()
              : undefined,
      };
    }),
  };

  const card = el(
    doc,
    "section",
    {
      border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
      borderRadius: "8px",
      padding: "12px 14px",
      margin: "8px 0",
      background: "var(--confucius-paper, transparent)",
      color: "var(--confucius-ink, currentColor)",
      boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
    },
    {
      "aria-label": t.badge,
      "data-review-kind": "organizer-assignment",
    },
  );
  card.className = "confucius-approval confucius-organizer-review-card";

  // State: track acceptance by entry index to prevent ID collisions when multiple assignments share a key
  const acceptedIndices = new Set<number>(review.items.map((_, i) => i));
  let filter: "all" | "accepted" | "rejected" = "all";
  let viewMode: "grouped" | "flat" = "grouped";
  let searchQuery = "";
  const collapsedHeadings = new Set<string>();

  // --- Header ---
  const header = el(doc, "header", {
    marginBottom: "10px",
  });

  const badgeRow = el(doc, "div", {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    marginBottom: "4px",
  });

  const badge = el(doc, "div", {
    fontFamily: "ui-monospace, Consolas, monospace",
    fontSize: "11px",
    fontWeight: "700",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--confucius-accent, #805f38)",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  });
  badge.textContent = `📚 ${t.badge}`;

  if (review.collectionTitle) {
    const colPill = el(doc, "span", {
      fontSize: "11px",
      fontWeight: "600",
      padding: "2px 8px",
      borderRadius: "12px",
      background: "var(--confucius-surface, rgba(128, 128, 128, 0.1))",
      color: "var(--confucius-ink, currentColor)",
      border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
      maxWidth: "260px",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    });
    colPill.textContent = `📁 ${review.collectionTitle}`;
    badgeRow.appendChild(badge);
    badgeRow.appendChild(colPill);
  } else {
    badgeRow.appendChild(badge);
  }

  const tallyLabel = el(doc, "div", {
    fontSize: "12px",
    color: "var(--confucius-muted, rgba(140, 140, 140, 0.9))",
    lineHeight: "1.4",
  });

  header.appendChild(badgeRow);
  header.appendChild(tallyLabel);
  card.appendChild(header);

  // --- Toolbar ---
  const toolbar = el(doc, "div", {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "6px 0",
    borderTop: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
    borderBottom: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
    marginBottom: "10px",
  });

  // Filter Buttons
  const filterGroup = el(doc, "div", {
    display: "flex",
    gap: "4px",
    alignItems: "center",
  });

  const filterAllBtn = el(doc, "button", {
    fontSize: "11px",
    padding: "3px 8px",
    borderRadius: "4px",
    border: "1px solid transparent",
    cursor: "pointer",
  });
  const filterAcceptedBtn = el(doc, "button", {
    fontSize: "11px",
    padding: "3px 8px",
    borderRadius: "4px",
    border: "1px solid transparent",
    cursor: "pointer",
  });
  const filterRejectedBtn = el(doc, "button", {
    fontSize: "11px",
    padding: "3px 8px",
    borderRadius: "4px",
    border: "1px solid transparent",
    cursor: "pointer",
  });

  filterGroup.append(filterAllBtn, filterAcceptedBtn, filterRejectedBtn);

  // Mode and Bulk Action Buttons
  const actionGroup = el(doc, "div", {
    display: "flex",
    gap: "6px",
    alignItems: "center",
  });

  const viewModeBtn = el(doc, "button", {
    fontSize: "11px",
    padding: "3px 8px",
    borderRadius: "4px",
    border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
    background: "transparent",
    color: "var(--confucius-ink, currentColor)",
    cursor: "pointer",
  });

  const acceptAllBtn = el(doc, "button", {
    fontSize: "11px",
    padding: "3px 8px",
    borderRadius: "4px",
    border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
    background: "transparent",
    color: "var(--confucius-ink, currentColor)",
    cursor: "pointer",
  });
  acceptAllBtn.textContent = `✓ ${t.acceptAll}`;

  const rejectAllBtn = el(doc, "button", {
    fontSize: "11px",
    padding: "3px 8px",
    borderRadius: "4px",
    border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
    background: "transparent",
    color: "var(--confucius-ink, currentColor)",
    cursor: "pointer",
  });
  rejectAllBtn.textContent = `✗ ${t.rejectAll}`;

  actionGroup.append(viewModeBtn, acceptAllBtn, rejectAllBtn);

  toolbar.append(filterGroup, actionGroup);
  card.appendChild(toolbar);

  // --- Search Bar ---
  const searchRow = el(doc, "div", {
    marginBottom: "10px",
  });
  const searchInput = el(
    doc,
    "input",
    {
      width: "100%",
      boxSizing: "border-box",
      padding: "5px 10px",
      fontSize: "12px",
      borderRadius: "6px",
      border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
      background: "var(--confucius-surface, rgba(128, 128, 128, 0.08))",
      color: "var(--confucius-ink, currentColor)",
      outline: "none",
    },
    {
      type: "search",
      placeholder: t.searchPlaceholder,
    },
  );
  searchRow.appendChild(searchInput);
  card.appendChild(searchRow);

  // --- Content Container ---
  const listContainer = el(doc, "div", {
    maxHeight: "520px",
    overflowY: "auto",
    overscrollBehavior: "contain",
    paddingRight: "16px",
    marginBottom: "12px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  });
  markScrollContainer(listContainer);
  card.appendChild(listContainer);

  // --- Bottom Actions ---
  const bottomBar = el(doc, "div", {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    paddingTop: "8px",
    borderTop: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
  });

  const buttonRow = el(doc, "div", {
    display: "flex",
    gap: "6px",
    alignItems: "center",
  });

  const allowBtn = el(doc, "button", {
    fontSize: "12px",
    fontWeight: "600",
    padding: "6px 14px",
    borderRadius: "6px",
    border: "none",
    background: "var(--confucius-primary, #33302a)",
    color: "var(--confucius-primary-ink, #ffffff)",
    cursor: "pointer",
  });

  const sessionBtn = el(doc, "button", {
    fontSize: "12px",
    padding: "6px 12px",
    borderRadius: "6px",
    border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
    background: "transparent",
    color: "var(--confucius-ink, currentColor)",
    cursor: "pointer",
  });
  sessionBtn.textContent = t.allowSession;

  const denyBtn = el(doc, "button", {
    fontSize: "12px",
    padding: "6px 12px",
    borderRadius: "6px",
    border: "1px solid var(--confucius-danger, #efaa99)",
    background: "transparent",
    color: "var(--confucius-danger, #efaa99)",
    cursor: "pointer",
  });
  denyBtn.textContent = t.deny;

  buttonRow.append(allowBtn, sessionBtn, denyBtn);
  bottomBar.appendChild(buttonRow);

  // Raw Parameters Toggle
  const paramsToggle = el(doc, "button", {
    background: "transparent",
    border: "none",
    color: "var(--confucius-muted, rgba(140, 140, 140, 0.9))",
    fontSize: "11px",
    padding: "4px 0",
    cursor: "pointer",
    textAlign: "left",
    alignSelf: "flex-start",
  });
  paramsToggle.textContent = `${t.params} ▸`;

  let paramsOpen = false;
  let paramsPre: HTMLElement | null = null;
  paramsToggle.addEventListener("click", () => {
    paramsOpen = !paramsOpen;
    paramsToggle.textContent = `${t.params} ${paramsOpen ? "▾" : "▸"}`;
    if (paramsOpen && !paramsPre) {
      paramsPre = el(doc, "pre", {
        whiteSpace: "pre-wrap",
        fontSize: "11px",
        margin: "4px 0 0",
        padding: "8px",
        borderRadius: "6px",
        background: "var(--confucius-surface, rgba(128, 128, 128, 0.08))",
        color: "var(--confucius-ink, currentColor)",
        border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
        maxHeight: "220px",
        overflowY: "auto",
      });
      paramsPre.textContent = JSON.stringify(item.args, null, 2);
      bottomBar.appendChild(paramsPre);
    } else if (paramsPre) {
      paramsPre.style.display = paramsOpen ? "" : "none";
    }
  });

  bottomBar.appendChild(paramsToggle);
  card.appendChild(bottomBar);

  // Helper to commit approval resolution
  const commitApproval = (scope: "once" | "session") => {
    const acceptedAssignments = originalAssignments.filter((_, idx) =>
      acceptedIndices.has(idx),
    );

    if (acceptedAssignments.length === 0) {
      return;
    }

    const editedArgs: Record<string, unknown> = {
      ...item.args,
      assignments: acceptedAssignments,
      dryRun: false, // Ensure write happens on approval
    };
    delete editedArgs.keys;
    delete editedArgs.key;

    options.resolve("allow", scope, editedArgs);
  };

  allowBtn.addEventListener("click", () => commitApproval("once"));
  sessionBtn.addEventListener("click", () => commitApproval("session"));
  denyBtn.addEventListener("click", () => options.resolve("deny", "once"));

  // --- Filtering & Render Logic ---

  function matchesSearch(entry: OrganizerAssignmentItemReview): boolean {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    if (entry.key.toLowerCase().includes(q)) return true;
    if (entry.quote && entry.quote.toLowerCase().includes(q)) return true;
    if (entry.comment && entry.comment.toLowerCase().includes(q)) return true;
    if (entry.reason && entry.reason.toLowerCase().includes(q)) return true;
    if (entry.sourceTitle && entry.sourceTitle.toLowerCase().includes(q))
      return true;
    if (entry.sourceCitation && entry.sourceCitation.toLowerCase().includes(q))
      return true;
    for (const h of entry.headings || []) {
      if (h && typeof h.title === "string" && h.title.toLowerCase().includes(q))
        return true;
      if (h && typeof h.num === "string" && h.num.toLowerCase().includes(q))
        return true;
      if (h && typeof h.path === "string" && h.path.toLowerCase().includes(q))
        return true;
    }
    return false;
  }

  function matchesStatus(index: number): boolean {
    if (filter === "all") return true;
    const isAccepted = acceptedIndices.has(index);
    return filter === "accepted" ? isAccepted : !isAccepted;
  }

  function resolveItemMetadataIfMissing(
    entry: OrganizerAssignmentItemReview,
  ): void {
    if ((entry.sourceCitation || entry.sourceTitle) && entry.quote) return;
    if (typeof Zotero === "undefined" || !Zotero.Items) return;
    try {
      let item: any = null;
      if (typeof (Zotero.Libraries as any)?.getAll === "function") {
        for (const lib of (Zotero.Libraries as any).getAll()) {
          const cand = (Zotero.Items as any).getByLibraryAndKey?.(
            lib.libraryID,
            entry.key,
          );
          if (cand && cand !== false) {
            item = cand;
            break;
          }
        }
      }
      if (
        !item &&
        typeof (Zotero.Items as any).getByLibraryAndKey === "function"
      ) {
        const userLib = (Zotero.Libraries as any)?.userLibraryID ?? 1;
        const cand = (Zotero.Items as any).getByLibraryAndKey(
          userLib,
          entry.key,
        );
        if (cand && cand !== false) item = cand;
      }
      if (item && item !== false) {
        if (!entry.quote) {
          entry.quote =
            item.annotationText ||
            (typeof item.getField === "function"
              ? item.getField("text")
              : "") ||
            "";
        }
        if (!entry.comment) {
          entry.comment =
            item.annotationComment ||
            (typeof item.getField === "function"
              ? item.getField("comment")
              : "") ||
            "";
        }
        if (!entry.page) {
          entry.page =
            item.annotationPageLabel ||
            (item.annotationPosition
              ? String(
                  (typeof item.annotationPosition === "string"
                    ? JSON.parse(item.annotationPosition)?.pageIndex ?? 0
                    : item.annotationPosition?.pageIndex ?? 0) + 1,
                )
              : "");
        }
        if (!entry.color && item.annotationColor) {
          entry.color = item.annotationColor;
        }
        if (!entry.sourceCitation && !entry.sourceTitle) {
          let work: any = item.topLevelItem ?? null;
          if (!work && item.parentItem) {
            const p = item.parentItem;
            work = p.topLevelItem ?? (p.isAttachment?.() ? p.parentItem : p);
          }
          if (work && typeof work === "object") {
            entry.sourceTitle =
              work.getDisplayTitle?.() ||
              (typeof work.getField === "function"
                ? work.getField("title")
                : "") ||
              "";
            try {
              if (Zotero.QuickCopy) {
                const format = Zotero.QuickCopy.getFormatFromURL(
                  (Zotero.QuickCopy as any).lastActiveURL || "",
                );
                const content = (Zotero.QuickCopy as any).getContentFromItems(
                  [work],
                  format,
                );
                entry.sourceCitation = (content?.text || "").trim();
              }
            } catch {
              // fallback below
            }
            if (!entry.sourceCitation) {
              const creators = (
                typeof work.getCreators === "function"
                  ? work.getCreators() ?? []
                  : []
              )
                .map((c: any) => c.lastName || c.name || "")
                .filter(Boolean)
                .slice(0, 2)
                .join(", ");
              const rawDate =
                typeof work.getField === "function"
                  ? work.getField("year") || work.getField("date") || ""
                  : "";
              const year = rawDate
                ? String(rawDate).match(/\b\d{4}\b/)?.[0] || String(rawDate)
                : "";
              entry.sourceCitation =
                creators && year
                  ? `${creators} (${year})`
                  : creators || entry.sourceTitle;
            }
          }
        }
      }
    } catch {
      // Best-effort live recovery
    }
  }

  function renderItemCard(
    entry: OrganizerAssignmentItemReview,
    index: number,
    currentHeadingKey?: string,
  ): HTMLElement {
    resolveItemMetadataIfMissing(entry);
    const isAccepted = acceptedIndices.has(index);

    const itemRow = el(doc, "article", {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      padding: "10px 12px",
      borderRadius: "6px",
      border: `1px solid ${isAccepted ? "var(--confucius-line, rgba(128, 128, 128, 0.2))" : "var(--confucius-danger, #efaa99)"}`,
      background: isAccepted
        ? "var(--confucius-elevated, transparent)"
        : "var(--confucius-danger-surface, rgba(239, 68, 68, 0.08))",
      borderLeft: `4px solid ${entry.color || "var(--confucius-accent, #805f38)"}`,
      opacity: isAccepted ? "1" : "0.7",
      transition: "all 0.15s ease",
      flexShrink: "0",
      boxSizing: "border-box",
      marginRight: "4px",
    });
    itemRow.dataset.key = entry.key;
    itemRow.dataset.index = String(index);
    itemRow.dataset.status = isAccepted ? "accepted" : "rejected";

    // Quote Block
    let quoteEl: HTMLElement | null = null;
    const rawQuote = (entry.quote || "").trim();
    const rawComment = (entry.comment || "").trim();
    const quoteText =
      rawQuote ||
      (!rawComment && entry.reason && !entry.reason.startsWith("[")
        ? entry.reason.trim()
        : "");
    if (quoteText) {
      quoteEl = el(doc, "blockquote", {
        margin: "0",
        fontSize: "12.5px",
        lineHeight: "1.55",
        fontWeight: "500",
        color: "var(--confucius-ink, currentColor)",
        textDecoration: isAccepted ? "none" : "line-through",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      });
      quoteEl.textContent = `“${quoteText}”`;
      itemRow.appendChild(quoteEl);
    }

    // Meta row (Source citation, page) - NO user IDs!
    const metaRow = el(doc, "div", {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "6px",
      fontSize: "11px",
      color: "var(--confucius-secondary, currentColor)",
    });

    if (entry.sourceCitation || entry.sourceTitle) {
      const citeText = `📄 ${entry.sourceCitation || entry.sourceTitle}${entry.page ? ` · S. ${entry.page}` : ""}`;
      if (options.locate) {
        const citeLink = el(doc, "button", {
          background: "transparent",
          border: "none",
          padding: "0",
          color: "var(--confucius-accent, #805f38)",
          fontSize: "11px",
          fontWeight: "400",
          cursor: "pointer",
          textAlign: "left",
          textDecoration: "underline",
          lineHeight: "1.35",
        });
        citeLink.textContent = citeText;
        citeLink.title = t.openInReader;
        citeLink.addEventListener("click", () => options.locate?.(entry.key));
        metaRow.appendChild(citeLink);
      } else {
        const citeSpan = el(doc, "span", {
          fontWeight: "400",
          fontSize: "11px",
          lineHeight: "1.35",
        });
        citeSpan.textContent = citeText;
        metaRow.appendChild(citeSpan);
      }
    } else if (entry.page) {
      const pageSpan = el(doc, "span", {
        fontWeight: "400",
        fontSize: "11px",
        lineHeight: "1.35",
      });
      pageSpan.textContent = `📄 S. ${entry.page}`;
      metaRow.appendChild(pageSpan);
    }

    const formatHeadingBadge = (h: { title: string; num?: string }) => {
      const cleaned = cleanHeadingTitle(h.title);
      const num = h.num || cleaned.num;
      const title = (cleaned.title || h.title).replace(/^§\s*/, "").trim();
      return `§ ${num ? `${num} ` : ""}${title}`;
    };

    // If flat view, show all assigned headings with outline numbering
    if (viewMode === "flat" && entry.headings.length > 0) {
      for (const h of entry.headings) {
        if (!h.title.trim()) continue;
        const hBadge = el(doc, "span", {
          fontSize: "10px",
          fontWeight: "600",
          padding: "2px 7px",
          borderRadius: "10px",
          background: "var(--confucius-surface, rgba(128, 128, 128, 0.1))",
          color: "var(--confucius-accent, #805f38)",
          border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
        });
        hBadge.textContent = formatHeadingBadge(h);
        metaRow.appendChild(hBadge);
      }
    } else if (viewMode === "grouped" && entry.headings.length > 1) {
      // In grouped view, show any other assigned headings so multi-assignments are visible
      const otherHeadings = entry.headings.filter((h) => {
        const cleaned = cleanHeadingTitle(h.title);
        const k = (cleaned.title || h.title).trim().toLowerCase();
        return k && k !== currentHeadingKey;
      });
      for (const h of otherHeadings) {
        const hBadge = el(doc, "span", {
          fontSize: "10px",
          fontWeight: "500",
          padding: "2px 7px",
          borderRadius: "10px",
          background: "var(--confucius-surface, rgba(128, 128, 128, 0.1))",
          color: "var(--confucius-secondary, currentColor)",
          border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
        });
        hBadge.textContent = `+ ${formatHeadingBadge(h)}`;
        metaRow.appendChild(hBadge);
      }
    }

    if (metaRow.childNodes.length > 0) {
      itemRow.appendChild(metaRow);
    }

    // User Comment
    if (entry.comment && entry.comment.trim()) {
      const commentEl = el(doc, "div", {
        fontSize: "11px",
        lineHeight: "1.4",
        color: "var(--confucius-ink, currentColor)",
        background: "var(--confucius-surface, rgba(128, 128, 128, 0.08))",
        padding: "6px 10px",
        borderRadius: "4px",
        border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
      });
      commentEl.textContent = `💬 ${t.comment}: ${entry.comment.trim()}`;
      itemRow.appendChild(commentEl);
    }

    // Controls Row (Accept / Reject)
    const ctrlRow = el(doc, "div", {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: "4px",
      paddingTop: "6px",
      borderTop: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
    });

    const statusPill = el(doc, "span", {
      fontSize: "11px",
      fontWeight: "700",
      letterSpacing: "0.03em",
      textTransform: "uppercase",
      color: isAccepted
        ? "var(--confucius-success, #476d4f)"
        : "var(--confucius-danger, #efaa99)",
    });
    statusPill.textContent = isAccepted ? `✓ ${t.accepted}` : `✗ ${t.rejected}`;

    const toggleBtns = el(doc, "div", {
      display: "flex",
      gap: "6px",
    });

    const acceptBtn = el(doc, "button", {
      fontSize: "11px",
      padding: "3px 10px",
      borderRadius: "4px",
      border: `1px solid ${isAccepted ? "var(--confucius-success, #476d4f)" : "var(--confucius-line, rgba(128, 128, 128, 0.2))"}`,
      background: isAccepted
        ? "var(--confucius-success, #476d4f)"
        : "transparent",
      color: isAccepted
        ? "var(--confucius-primary-ink, #ffffff)"
        : "var(--confucius-ink, currentColor)",
      cursor: "pointer",
      fontWeight: isAccepted ? "600" : "500",
    });
    acceptBtn.textContent = `✓ ${t.acceptItem}`;

    const rejectBtn = el(doc, "button", {
      fontSize: "11px",
      padding: "3px 10px",
      borderRadius: "4px",
      border: `1px solid ${!isAccepted ? "var(--confucius-danger, #efaa99)" : "var(--confucius-line, rgba(128, 128, 128, 0.2))"}`,
      background: !isAccepted
        ? "var(--confucius-danger, #efaa99)"
        : "transparent",
      color: !isAccepted
        ? "var(--confucius-primary-ink, #ffffff)"
        : "var(--confucius-ink, currentColor)",
      cursor: "pointer",
      fontWeight: !isAccepted ? "600" : "500",
    });
    rejectBtn.textContent = `✗ ${t.rejectItem}`;

    const setItemAccepted = (accepted: boolean) => {
      if (accepted) {
        acceptedIndices.add(index);
      } else {
        acceptedIndices.delete(index);
      }

      if (filter !== "all") {
        render();
        return;
      }

      // In "all" view, update in-place without rebuilding DOM or resetting scroll
      itemRow.dataset.status = accepted ? "accepted" : "rejected";
      itemRow.style.borderColor = accepted
        ? "var(--confucius-line, rgba(128, 128, 128, 0.2))"
        : "var(--confucius-danger, #efaa99)";
      itemRow.style.background = accepted
        ? "var(--confucius-elevated, transparent)"
        : "var(--confucius-danger-surface, rgba(239, 68, 68, 0.08))";
      itemRow.style.opacity = accepted ? "1" : "0.7";

      if (quoteEl) {
        quoteEl.style.textDecoration = accepted ? "none" : "line-through";
      }

      statusPill.textContent = accepted ? `✓ ${t.accepted}` : `✗ ${t.rejected}`;
      statusPill.style.color = accepted
        ? "var(--confucius-success, #476d4f)"
        : "var(--confucius-danger, #efaa99)";

      acceptBtn.style.border = `1px solid ${accepted ? "var(--confucius-success, #476d4f)" : "var(--confucius-line, rgba(128, 128, 128, 0.2))"}`;
      acceptBtn.style.background = accepted
        ? "var(--confucius-success, #476d4f)"
        : "transparent";
      acceptBtn.style.color = accepted
        ? "var(--confucius-primary-ink, #ffffff)"
        : "var(--confucius-ink, currentColor)";
      acceptBtn.style.fontWeight = accepted ? "600" : "500";

      rejectBtn.style.border = `1px solid ${!accepted ? "var(--confucius-danger, #efaa99)" : "var(--confucius-line, rgba(128, 128, 128, 0.2))"}`;
      rejectBtn.style.background = !accepted
        ? "var(--confucius-danger, #efaa99)"
        : "transparent";
      rejectBtn.style.color = !accepted
        ? "var(--confucius-primary-ink, #ffffff)"
        : "var(--confucius-ink, currentColor)";
      rejectBtn.style.fontWeight = !accepted ? "600" : "500";

      updateTallies();
    };

    acceptBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setItemAccepted(true);
    });
    rejectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setItemAccepted(false);
    });

    toggleBtns.append(acceptBtn, rejectBtn);
    ctrlRow.append(statusPill, toggleBtns);
    itemRow.appendChild(ctrlRow);

    return itemRow;
  }

  function updateTallies(): void {
    const total = review.items.length;
    const acceptedCount = acceptedIndices.size;
    const rejectedCount = total - acceptedCount;

    tallyLabel.textContent = t.tally(total, acceptedCount, rejectedCount);

    filterAllBtn.textContent = `${t.all} (${total})`;
    filterAcceptedBtn.textContent = `${t.accepted} (${acceptedCount})`;
    filterRejectedBtn.textContent = `${t.rejected} (${rejectedCount})`;

    allowBtn.textContent = t.applyButton(acceptedCount);
    allowBtn.disabled = acceptedCount === 0;
    allowBtn.style.opacity = acceptedCount === 0 ? "0.5" : "1";
    allowBtn.style.cursor = acceptedCount === 0 ? "not-allowed" : "pointer";

    sessionBtn.disabled = acceptedCount === 0;
    sessionBtn.style.opacity = acceptedCount === 0 ? "0.5" : "1";
    sessionBtn.style.cursor = acceptedCount === 0 ? "not-allowed" : "pointer";
  }

  function render(): void {
    // 1. Update tallies
    updateTallies();

    const setFilterStyle = (btn: HTMLElement, active: boolean) => {
      btn.style.background = active
        ? "var(--confucius-accent, #805f38)"
        : "transparent";
      btn.style.color = active
        ? "var(--confucius-primary-ink, #ffffff)"
        : "var(--confucius-ink, currentColor)";
      btn.style.borderColor = active
        ? "transparent"
        : "var(--confucius-line, rgba(128, 128, 128, 0.2))";
      btn.style.fontWeight = active ? "600" : "normal";
    };

    setFilterStyle(filterAllBtn, filter === "all");
    setFilterStyle(filterAcceptedBtn, filter === "accepted");
    setFilterStyle(filterRejectedBtn, filter === "rejected");

    viewModeBtn.textContent =
      viewMode === "grouped" ? `📂 ${t.groupedView}` : `☰ ${t.listView}`;

    // Save scroll positions before clearing
    const savedListScroll = listContainer.scrollTop;
    const savedGroupScrolls = new Map<string, number>();
    for (const wrapper of listContainer.querySelectorAll<HTMLElement>(
      "[data-heading-scroll]",
    )) {
      const key = wrapper.dataset.headingScroll;
      if (key) savedGroupScrolls.set(key, wrapper.scrollTop);
    }

    // 2. Clear content container
    while (listContainer.firstChild) {
      listContainer.removeChild(listContainer.firstChild);
    }

    // 3. Filter items by status and search query
    const visibleItems: Array<{
      item: OrganizerAssignmentItemReview;
      index: number;
    }> = [];
    for (let i = 0; i < review.items.length; i++) {
      const it = review.items[i];
      if (matchesStatus(i) && matchesSearch(it)) {
        visibleItems.push({ item: it, index: i });
      }
    }

    if (visibleItems.length === 0) {
      const emptyState = el(doc, "div", {
        padding: "24px 12px",
        textAlign: "center",
        fontSize: "12px",
        color: "var(--confucius-muted, #7a7265)",
      });
      emptyState.textContent = t.noResults;
      listContainer.appendChild(emptyState);
      return;
    }

    if (viewMode === "flat") {
      for (const { item: entry, index } of visibleItems) {
        listContainer.appendChild(renderItemCard(entry, index));
      }
      return;
    }

    // --- Grouped View (by Heading in Outline Order) ---
    // Pre-calculate canonical outline order from review.outlineHeadings
    const outlineOrderMap = new Map<string, number>();
    if (Array.isArray(review.outlineHeadings)) {
      review.outlineHeadings.forEach((h, idx) => {
        const clean = cleanHeadingTitle(h.title);
        outlineOrderMap.set(h.title.trim().toLowerCase(), idx);
        outlineOrderMap.set(clean.title.toLowerCase(), idx);
        if (h.path) outlineOrderMap.set(h.path.trim().toLowerCase(), idx);
        if (h.num) outlineOrderMap.set(h.num.toLowerCase(), idx);
      });
    }

    const findCanonical = (title: string, num?: string) => {
      if (!Array.isArray(review.outlineHeadings)) return undefined;
      const cleaned = cleanHeadingTitle(title);
      const bareLower = cleaned.title.toLowerCase();
      const rawLower = title.trim().toLowerCase().replace(/^§\s*/, "");
      return review.outlineHeadings.find((oh) => {
        const ohClean = cleanHeadingTitle(oh.title);
        if (oh.title.trim().toLowerCase().replace(/^§\s*/, "") === rawLower)
          return true;
        if (ohClean.title.toLowerCase() === bareLower) return true;
        if (oh.path && oh.path.trim().toLowerCase().endsWith(bareLower))
          return true;
        if (num && oh.num === num) return true;
        if (cleaned.num && oh.num === cleaned.num) return true;
        return false;
      });
    };

    interface HeadingGroup {
      headingKey: string;
      title: string;
      num?: string;
      path?: string;
      orderIndex: number;
      items: Array<{ item: OrganizerAssignmentItemReview; index: number }>;
    }

    const groupsMap = new Map<string, HeadingGroup>();

    for (const { item, index } of visibleItems) {
      const validHeadings = (item.headings || [])
        .filter(
          (h) => h && typeof h.title === "string" && h.title.trim().length > 0,
        )
        .map((h) => ({
          ...h,
          title: h.title.trim(),
        }));

      const headings =
        validHeadings.length > 0
          ? validHeadings
          : [{ title: t.unassignedHeading }];

      for (const h of headings) {
        const cleanTitle = h.title.trim();
        if (!cleanTitle) continue;

        const canonical = findCanonical(cleanTitle, h.num);
        let num = canonical?.num || h.num;
        let displayTitle = canonical?.title || cleanTitle;
        const path = canonical?.path || h.path;

        const cleaned = cleanHeadingTitle(displayTitle);
        if (!num && cleaned.num) {
          num = cleaned.num;
        }
        if (num && cleaned.num === num) {
          displayTitle = cleaned.title;
        } else if (cleaned.title) {
          displayTitle = cleaned.title;
        }
        displayTitle = displayTitle.replace(/^§\s*/, "").trim();

        const groupKey =
          canonical?.title?.trim().toLowerCase() ??
          cleanHeadingTitle(cleanTitle).title.toLowerCase();

        let group = groupsMap.get(groupKey);
        if (!group) {
          const order = outlineOrderMap.has(groupKey)
            ? outlineOrderMap.get(groupKey)!
            : canonical &&
                outlineOrderMap.has(canonical.title.trim().toLowerCase())
              ? outlineOrderMap.get(canonical.title.trim().toLowerCase())!
              : num
                ? 1000
                : 2000;
          group = {
            headingKey: groupKey,
            title: displayTitle,
            num,
            path,
            orderIndex: order,
            items: [],
          };
          groupsMap.set(groupKey, group);
        } else {
          if (!group.num && num) group.num = num;
          if (!group.path && path) group.path = path;
        }
        // Avoid adding the same item entry twice to the same heading group
        if (!group.items.some((it) => it.index === index)) {
          group.items.push({ item, index });
        }
      }
    }

    // Sort groups in canonical outline order first, then decimal outline order
    const sortedGroups = [...groupsMap.values()].sort((a, b) => {
      if (a.orderIndex !== b.orderIndex) {
        return a.orderIndex - b.orderIndex;
      }
      if (a.num || b.num) {
        const cmp = compareNumBadges(a.num, b.num);
        if (cmp !== 0) return cmp;
      }
      return a.title.localeCompare(b.title);
    });

    for (const group of sortedGroups) {
      if (!group.items.length) continue;
      const cleanTitle = (group.title || "").trim();
      if (!cleanTitle) continue;

      const isCollapsed = collapsedHeadings.has(group.headingKey);

      const section = el(doc, "section", {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        borderRadius: "8px",
        background: "var(--confucius-surface, rgba(128, 128, 128, 0.08))",
        border: "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
        overflow: "hidden",
        flexShrink: "0",
        marginRight: "6px",
      });

      // Section Header (Accordion)
      const secHeader = el(doc, "header", {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 12px",
        background: "var(--confucius-surface, rgba(128, 128, 128, 0.08))",
        cursor: "pointer",
        userSelect: "none",
        borderBottom: isCollapsed
          ? "none"
          : "1px solid var(--confucius-line, rgba(128, 128, 128, 0.2))",
      });

      const titleCol = el(doc, "div", {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        flex: "1",
        minWidth: "0",
      });

      const headingTitleRow = el(doc, "div", {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        flexWrap: "wrap",
      });

      const arrow = el(doc, "span", {
        fontSize: "10px",
        color: "var(--confucius-muted, rgba(140, 140, 140, 0.9))",
        display: "inline-block",
        width: "12px",
      });
      arrow.textContent = isCollapsed ? "▸" : "▾";

      headingTitleRow.appendChild(arrow);

      if (group.num) {
        const numPill = el(doc, "span", {
          fontSize: "11px",
          fontWeight: "700",
          fontFamily: "ui-monospace, Consolas, monospace",
          padding: "2px 8px",
          borderRadius: "12px",
          background: "var(--confucius-accent, #805f38)",
          color: "var(--confucius-primary-ink, #ffffff)",
          letterSpacing: "0.03em",
          lineHeight: "1.2",
          flexShrink: "0",
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.15)",
        });
        numPill.textContent = group.num;
        headingTitleRow.appendChild(numPill);
        headingTitleRow.append(" ");
      }

      const headingLabel = el(doc, "span", {
        fontWeight: "700",
        fontSize: "13px",
        lineHeight: "1.35",
        color: "var(--confucius-ink, currentColor)",
      });
      headingLabel.textContent = group.title;
      headingTitleRow.appendChild(headingLabel);

      const countBadge = el(doc, "span", {
        fontSize: "11px",
        fontWeight: "600",
        padding: "1px 6px",
        borderRadius: "10px",
        background: "var(--confucius-hover, rgba(128, 128, 128, 0.12))",
        color: "var(--confucius-muted, rgba(140, 140, 140, 0.9))",
      });
      countBadge.textContent = `(${group.items.length})`;
      headingTitleRow.appendChild(countBadge);

      titleCol.appendChild(headingTitleRow);

      // Only show breadcrumb if there is an ancestor path different from the heading itself
      let breadcrumbText = "";
      if (group.path) {
        const cleanPath = group.path.trim();
        const cleanTitle = group.title.trim();
        const cleanWithNum = group.num ? `${group.num} ${cleanTitle}`.trim() : "";
        if (
          cleanPath !== cleanTitle &&
          cleanPath !== cleanWithNum &&
          (cleanPath.includes(" > ") || cleanPath.includes(" / "))
        ) {
          breadcrumbText = cleanPath;
        }
      }
      if (breadcrumbText) {
        const breadcrumb = el(doc, "div", {
          fontSize: "11px",
          lineHeight: "1.35",
          color: "var(--confucius-muted, rgba(140, 140, 140, 0.9))",
          paddingLeft: "18px",
        });
        breadcrumb.textContent = `› ${breadcrumbText}`;
        titleCol.appendChild(breadcrumb);
      }

      secHeader.appendChild(titleCol);

      secHeader.addEventListener("click", () => {
        if (collapsedHeadings.has(group.headingKey)) {
          collapsedHeadings.delete(group.headingKey);
        } else {
          collapsedHeadings.add(group.headingKey);
        }
        render();
      });

      section.appendChild(secHeader);

      if (!isCollapsed) {
        const itemsWrapper = el(doc, "div", {
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          padding: "6px 12px 6px 6px",
          maxHeight: "360px",
          overflowY: "auto",
          overscrollBehavior: "contain",
        });
        itemsWrapper.dataset.headingScroll = group.headingKey;
        markScrollContainer(itemsWrapper);

        for (const { item: entry, index } of group.items) {
          itemsWrapper.appendChild(
            renderItemCard(entry, index, group.headingKey),
          );
        }

        section.appendChild(itemsWrapper);
      }

      listContainer.appendChild(section);
    }

    const restoreAllScrolls = () => {
      listContainer.scrollTop = savedListScroll;
      for (const wrapper of listContainer.querySelectorAll<HTMLElement>(
        "[data-heading-scroll]",
      )) {
        const key = wrapper.dataset.headingScroll;
        if (key && savedGroupScrolls.has(key)) {
          wrapper.scrollTop = savedGroupScrolls.get(key)!;
        }
      }
    };
    restoreAllScrolls();
    if (typeof doc.defaultView?.requestAnimationFrame === "function") {
      doc.defaultView.requestAnimationFrame(restoreAllScrolls);
    }
  }

  // Event Listeners for Toolbar
  filterAllBtn.addEventListener("click", () => {
    filter = "all";
    render();
  });
  filterAcceptedBtn.addEventListener("click", () => {
    filter = "accepted";
    render();
  });
  filterRejectedBtn.addEventListener("click", () => {
    filter = "rejected";
    render();
  });

  viewModeBtn.addEventListener("click", () => {
    viewMode = viewMode === "grouped" ? "flat" : "grouped";
    render();
  });

  acceptAllBtn.addEventListener("click", () => {
    for (let i = 0; i < review.items.length; i++) {
      if (matchesSearch(review.items[i])) {
        acceptedIndices.add(i);
      }
    }
    render();
  });

  rejectAllBtn.addEventListener("click", () => {
    for (let i = 0; i < review.items.length; i++) {
      if (matchesSearch(review.items[i])) {
        acceptedIndices.delete(i);
      }
    }
    render();
  });

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    render();
  });

  // Initial render
  render();

  return card;
}
