import {
  createMenuSurface,
  createMenuHeader,
  createMenuGlyph,
} from "./workspaceMenus";
import { getString } from "../../utils/locale";
import type { MentionChoice } from "./workspaceComposer";
import { markScrollContainer } from "./workspaceScrollbars";
export interface SourcePickerState {
  open: boolean;
  scope: "literature" | "tasks";
  libraryName: string;
  items: MentionChoice[];
  total: number;
  index: number;
  error: string;
  loading: boolean;
  nextOffset: number | null;
}
function el(
  doc: Document,
  tag: string,
  styles?: Record<string, string>,
  attrs?: Record<string, string>,
): HTMLElement {
  const node = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElement;
  if (styles) Object.assign(node.style, styles);
  markScrollContainer(node);
  for (const [key, value] of Object.entries(attrs ?? {}))
    node.setAttribute(key, value);
  return node;
}
function button(doc: Document, _id: string, label: string): HTMLElement {
  const node = el(doc, "button", undefined, { type: "button" });
  node.textContent = label;
  return node;
}
export function renderSourcePicker(
  doc: Document,
  options: {
    state: SourcePickerState;
    preserveScroll: boolean;
    included: (item: MentionChoice) => boolean;
    selectScope: (scope: "literature" | "tasks") => void;
    hover: (index: number, menu: HTMLElement) => void;
    select: (index: number) => void;
    loadMore: () => void;
    place: (menu: HTMLElement, header: HTMLElement, list: HTMLElement) => void;
  },
): void {
  const mentionState = options.state,
    preserveScroll = options.preserveScroll;
  const previousList = doc.getElementById(
    "confucius-mention-results",
  ) as HTMLElement | null;
  const previousScrollTop = preserveScroll ? previousList?.scrollTop || 0 : 0;
  doc.getElementById("confucius-mention-menu")?.remove();
  if (!mentionState.open) return;
  const menu = createMenuSurface(
    doc,
    {
      id: "confucius-mention-menu",
      role: "dialog",
      "aria-label": getString("workspace-mention-heading"),
    },
    true,
  );
  const header = createMenuHeader(
    doc,
    getString("workspace-mention-heading"),
    mentionState.libraryName
      ? `${mentionState.libraryName} · ${mentionState.items.length}/${mentionState.total}`
      : getString("workspace-mention-hint"),
  );
  menu.appendChild(header);
  const tabs = el(doc, "div");
  tabs.className = "confucius-mention-tabs";
  for (const kind of ["literature", "tasks"] as const) {
    const tab = button(
      doc,
      "",
      getString(
        kind === "literature"
          ? "workspace-reference-literature"
          : "workspace-reference-task",
      ),
    );
    tab.setAttribute("aria-pressed", String(mentionState.scope === kind));
    tab.addEventListener("mousedown", (event) => event.preventDefault());
    tab.addEventListener("click", () => {
      options.selectScope(kind);
    });
    tabs.append(tab);
  }
  menu.appendChild(tabs);

  const list = el(doc, "div", {
    maxHeight: "258px",
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: "4px 0",
    boxSizing: "border-box",
  });
  list.id = "confucius-mention-results";
  list.setAttribute("role", "listbox");
  for (const [index, item] of mentionState.items.entries()) {
    const active = index === mentionState.index;
    const included = options.included(item);
    const row = el(doc, "div");
    row.className = "confucius-composer-menu-row";
    row.setAttribute("role", "option");
    row.setAttribute("data-mention-index", String(index));
    row.setAttribute("aria-selected", active ? "true" : "false");
    const glyph = createMenuGlyph(doc, item.taskReference ? "↗" : "▤");
    const copy = el(doc, "span", {
      flex: "1 1 auto",
      minWidth: "0",
    });
    const title = el(doc, "span", {
      display: "block",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: "var(--confucius-ink)",
      fontWeight: "500",
      fontSize: "1em",
    });
    title.textContent = item.title || getString("workspace-mention-untitled");
    const meta = el(doc, "span", {
      display: "block",
      marginTop: "2px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: "var(--confucius-muted)",
      fontSize: ".86em",
    });
    meta.textContent = item.taskReference
      ? `${item.creators[0]} · ${getString(`workspace-task-status-${item.itemType.replace(/_/g, "-")}`)} · ${item.taskReference.taskId.slice(-4)}`
      : [item.creators.slice(0, 2).join(", "), item.year, item.itemType]
          .filter(Boolean)
          .join(" · ");
    copy.appendChild(title);
    copy.appendChild(meta);
    row.appendChild(glyph);
    row.appendChild(copy);
    if (included) {
      const mark = el(doc, "span", {
        flex: "0 0 auto",
        color: "var(--confucius-muted)",
        fontSize: ".86em",
      });
      mark.textContent = `✓ ${getString("workspace-mention-added")}`;
      row.appendChild(mark);
    }
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("mouseenter", () => {
      options.hover(index, menu);
    });
    row.addEventListener("click", () => {
      options.select(index);
    });
    list.appendChild(row);
  }
  if (mentionState.error) {
    const error = el(doc, "div", {
      padding: "12px 9px",
      color: "var(--confucius-danger)",
      fontSize: "1em",
    });
    error.textContent = mentionState.error;
    list.appendChild(error);
  } else if (!mentionState.loading && mentionState.items.length === 0) {
    const empty = el(doc, "div", {
      padding: "14px 9px",
      color: "var(--confucius-muted)",
      fontSize: "1em",
    });
    empty.textContent = getString("workspace-mention-empty");
    list.appendChild(empty);
  }
  if (mentionState.loading) {
    const loading = el(doc, "div", {
      padding: "9px",
      color: "var(--confucius-muted)",
      fontSize: ".86em",
      textAlign: "center",
    });
    loading.textContent = getString("workspace-mention-loading");
    list.appendChild(loading);
  }
  list.addEventListener("scroll", () => {
    if (
      list.scrollHeight - list.scrollTop - list.clientHeight < 28 &&
      mentionState.nextOffset !== null &&
      !mentionState.loading
    ) {
      options.loadMore();
    }
  });
  menu.appendChild(list);
  options.place(menu, header, list);
  list.scrollTop = previousScrollTop;
}
