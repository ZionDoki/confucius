import { UI_FONT_STACKS } from "./workspaceTypography";
import { WorkspaceFormDrafts } from "./workspaceDrafts";
import {
  createComposerStatusChip,
  createWorkspaceButton,
  bindDialogNavigation,
  bindTabNavigation,
} from "./workspaceControls";
import { renderSourcePicker } from "./workspaceSourcePicker";
import {
  createMenuSurface,
  createMenuHeader,
  createMenuHeading,
  createMenuGlyph,
  bindMenuNavigation,
} from "./workspaceMenus";
import { renderReadingSurface } from "./workspaceReading";
import { TUI_CSS } from "./workspaceTheme";
import {
  ensureScrollbarStyles,
  markScrollContainer,
} from "./workspaceScrollbars";
import { createTaskList } from "./workspaceTasks";
import { keyedTimeline, reconcileActivity } from "./workspaceActivity";
import {
  composerKeyAction,
  taskMentionChoice,
  mergeTaskReferences,
  type MentionChoice,
} from "./workspaceComposer";
import type {
  AgentBackendKind,
  ArtifactRecord,
  ConfuciusEvent,
  ContextSearchItem,
  ContextSearchItemsResult,
  LaunchIntent,
  LockedContextSnapshot,
  MemoryConsent,
  MemoryProposal,
  ResearchTaskRecord,
  RuntimeListResult,
  RuntimeStatus,
  TaskAttachment,
  TaskTemplate,
  UpdateStatus,
  TaskContextReference,
  HistoryTask,
  HistoryItemRef,
  SessionContextStats,
} from "@confucius/protocol";
import {
  modelReasoning,
  normalizeModelEffort,
  type ReasoningEffort,
  type RuntimeModelOption,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_UI_FONT,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_UI_LINE_HEIGHT,
  FEATURED_TASK_TEMPLATES,
  UI_LINE_HEIGHT_VALUES,
  clampUiFontSize,
  emptyLockedContext,
  isUiFont,
  isUiLanguage,
  isUiLineHeight,
  mergeLockedContexts,
  nextReasoningFold,
  parseMindMapOutline,
  renderMarkdownHtml,
  toolLineStatus,
  toolsSummary,
  type ReasoningFold,
  type TimelineBlock,
  type TimelineToolCall,
  type MindMapNode,
  type UiFont,
  type UiLanguage,
  type UiLineHeight,
  type LaunchConsumeResult,
  type LiveContextResult,
  taskTemplate,
  withLockedContextFingerprint,
} from "@confucius/protocol";
import { durableExcerpt } from "@confucius/memory";
import { slashMenuToken, type ConfuciusSkill } from "@confucius/skill-format";
import { renderToString as katexRender } from "katex";
import { getString } from "../../utils/locale";
import { hrefFromEvent } from "./anchorFromEvent";
import { droppedFilePaths, droppedFilename, hasDroppedFiles } from "./fileDrop";
import {
  libraryMentionTokenAtCaret,
  replaceLibraryMention,
  type LibraryMentionToken,
} from "./libraryMention";
import { pickRuntimeExecutable } from "./runtimeExecutablePicker";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_COMPOSER_ATTACHMENTS = 5;

let workspaceViewState:
  | {
      taskId: string | null;
      drafts: Map<string, string>;
      references: Map<string, TaskContextReference[]>;
      viewports: Map<string, { scrollTop: number; followsBottom: boolean }>;
    }
  | undefined;
const linkHosts = new WeakMap<HTMLElement, WorkspaceHost | null>();
const linkListeners = new WeakSet<HTMLElement>();
let lastNavHref = "";
let lastNavAt = 0;

function workspaceRootOf(node: Element | null): HTMLElement | null {
  let current: {
    classList?: { contains: (name: string) => boolean };
    parentElement?: Element | null;
  } | null = node;
  while (current) {
    if (current.classList?.contains("confucius-workspace-root")) {
      return current as HTMLElement;
    }
    current = current.parentElement ?? null;
  }
  return null;
}

function pluginOpenLink():
  ((href: string) => Promise<{ ok: boolean; message?: string }>) | undefined {
  try {
    return (
      Zotero as unknown as {
        Confucius?: {
          openLink?: (
            href: string,
          ) => Promise<{ ok: boolean; message?: string }>;
        };
      }
    ).Confucius?.openLink;
  } catch {
    return undefined;
  }
}

function reportLinkError(from: Element, message: string): void {
  const status = from.ownerDocument?.getElementById(
    "confucius-status",
  ) as HTMLElement | null;
  if (!status) {
    return;
  }
  status.style.color = "#b3452f";
  status.textContent = message;
}

function openWorkspaceHref(from: Element, href: string): void {
  const now = Date.now();
  if (href === lastNavHref && now - lastNavAt < 500) {
    return;
  }
  lastNavHref = href;
  lastNavAt = now;
  const root = workspaceRootOf(from);
  const opener =
    (root ? linkHosts.get(root)?.openLink : undefined) ?? pluginOpenLink();
  if (!opener) {
    return;
  }
  void opener(href)
    .then((result) => {
      if (!result.ok && result.message) {
        reportLinkError(from, result.message);
      }
    })
    .catch((error: unknown) => {
      reportLinkError(
        from,
        error instanceof Error ? error.message : String(error),
      );
    });
}

export interface WorkspaceHost {
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  openLink?(href: string): Promise<{ ok: boolean; message?: string }>;
}

export type WorkspaceLayout = "window" | "sidebar";

export interface MountOptions {
  root?: HTMLElement;
  layout?: WorkspaceLayout;
  onLayoutChange?: (layout: WorkspaceLayout) => void;
}

type SessionRow = ResearchTaskRecord;

type ApprovalRow = {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  summary?: string;
  before?: string;
  after?: string;
  kind?: string;
  origin?: string;
};

type MemoryRow = {
  id: string;
  type: string;
  title: string;
  content: string;
  tags?: string[];
};

type KnowledgeEntryKind =
  "paper" | "note" | "insight" | "method" | "discussion" | "mindmap";

type KnowledgeEntryRow = {
  id: string;
  knowledgeBaseId: string;
  kind: KnowledgeEntryKind;
  title: string;
  content: string;
  tags: string[];
  source?: { libraryID: number; key: string };
  updatedAt: number;
};

type KnowledgeBaseRow = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  entryCount: number;
  counts: Partial<Record<KnowledgeEntryKind, number>>;
  updatedAt: number;
};

type KnowledgeBaseDetail = KnowledgeBaseRow & { entries: KnowledgeEntryRow[] };

type ModelEndpoint = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  reasoningEffort: ReasoningEffort;
  contextWindowTokens: number;
};

type ModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  streamResponses: boolean;
  memoryAutoExtract: boolean;
  memoryConsent: MemoryConsent;
  pluginRuntimeHost: boolean;
  reasoningEffort: ReasoningEffort;
  contextWindowTokens: number;
  hasApiKey: boolean;
  configured?: boolean;
  endpoints?: ModelEndpoint[];
  activeEndpointId?: string;
  maxIterations?: number;
  maxToolCalls?: number;
  uiFont?: UiFont;
  uiFontSize?: number;
  uiLanguage?: UiLanguage;
  uiLineHeight?: UiLineHeight;
};

function configReady(config: ModelConfig | null): boolean {
  if (!config) {
    return false;
  }
  if (typeof config.configured === "boolean") {
    return config.configured;
  }
  return Boolean(config.baseUrl && config.model);
}

function endpointHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function endpointLabel(endpoint?: ModelEndpoint | null): string {
  if (!endpoint) {
    return "";
  }
  return (
    endpoint.name ||
    endpoint.model ||
    endpointHost(endpoint.baseUrl) ||
    endpoint.id
  );
}

type Styles = Record<string, string>;

function el(
  doc: Document,
  tag: string,
  styles?: Styles,
  attrs?: Record<string, string>,
): HTMLElement {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElement;
  if (styles) {
    Object.assign(node.style, styles);
  }
  markScrollContainer(node);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
  }
  return node;
}

function ensureTuiStyles(doc: Document): void {
  ensureScrollbarStyles(doc);
  const existing = doc.getElementById("confucius-tui-css");
  if (existing) {
    if (existing.textContent !== TUI_CSS) existing.textContent = TUI_CSS;
    return;
  }
  const style = doc.createElementNS(HTML_NS, "style");
  style.id = "confucius-tui-css";
  style.textContent = TUI_CSS;
  const host = doc.head ?? doc.documentElement;
  if (host) {
    host.appendChild(style);
  }
}

function readAnchorHref(el: Element): string {
  const fromData = String(el.getAttribute("data-href") || "").trim();
  if (fromData) {
    return fromData;
  }
  const fromAttr = String(el.getAttribute("href") || "").trim();
  if (fromAttr && !/^chrome:/i.test(fromAttr)) {
    return fromAttr;
  }
  return "";
}

function collectAnchors(node: HTMLElement): Element[] {
  const found: Element[] = [];
  const visit = (el: Element) => {
    if (String(el.localName || "").toLowerCase() === "a") {
      found.push(el);
    }
    const children = el.children;
    for (let i = 0; i < children.length; i += 1) {
      visit(children[i]);
    }
  };
  visit(node);
  return found;
}

function bindAnchorNavigation(anchor: Element, href: string): void {
  anchor.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    openWorkspaceHref(anchor, href);
  });
}

function hydrateAnswerLinks(node: HTMLElement): void {
  const doc = node.ownerDocument;
  if (!doc) {
    return;
  }
  for (const old of collectAnchors(node)) {
    const href = readAnchorHref(old);
    if (!href) {
      continue;
    }
    const replacement = doc.createElementNS(HTML_NS, "a");
    // chrome:// XHTML swallows clicks on zotero:// hrefs; the locate button
    // works because it is a plain click handler with no custom protocol.
    replacement.setAttribute("href", /^zotero:/i.test(href) ? "#" : href);
    replacement.setAttribute("data-href", href);
    replacement.setAttribute("rel", "noreferrer");
    replacement.setAttribute("title", href);
    while (old.firstChild) {
      replacement.appendChild(old.firstChild);
    }
    old.parentNode?.replaceChild(replacement, old);
    bindAnchorNavigation(replacement, href);
  }
}

function fillAnswerHtml(node: HTMLElement, text: string): void {
  node.innerHTML = renderMarkdownHtml(text);
  try {
    hydrateAnswerLinks(node);
  } catch {
    // Links still render; root-level click delegation remains.
  }
  node.querySelectorAll(".tui-math").forEach((el: Element) => {
    const html = el as HTMLElement;
    const tex = html.getAttribute("data-tex") || html.textContent || "";
    const display = html.getAttribute("data-display") === "1";
    try {
      html.innerHTML = katexRender(tex, {
        throwOnError: false,
        displayMode: display,
        output: "mathml",
      });
    } catch {
      html.textContent = tex;
    }
  });
}

function tuiBlock(doc: Document, extra?: Styles): HTMLElement {
  return el(doc, "div", {
    margin: "0 0 8px",
    padding: "0",
    border: "none",
    background: "transparent",
    ...extra,
  });
}

function formatToolResult(call: TimelineToolCall): string {
  if (!call.result) {
    return call.progress || "";
  }
  if (call.result.ok) {
    return JSON.stringify(call.result.data, null, 2).slice(0, 4000);
  }
  return JSON.stringify(call.result, null, 2).slice(0, 4000);
}

type LocateTarget = {
  libraryID?: number;
  key: string;
  pageIndex?: number;
  annotationKey?: string;
};

/**
 * Pull a jump target out of a tool result payload: anything that names an
 * attachment (attachmentKey/key) plus a way to land on a spot in it
 * (pageIndex, position.pageIndex or annotationKey).
 */
function locateFromData(data: unknown): LocateTarget | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  const attachmentKey =
    typeof record.attachmentKey === "string" ? record.attachmentKey.trim() : "";
  const key =
    attachmentKey || (typeof record.key === "string" ? record.key.trim() : "");
  if (!key) {
    return null;
  }
  const annotationKey =
    typeof record.annotationKey === "string" ? record.annotationKey.trim() : "";
  let pageIndex: number | undefined;
  if (
    typeof record.pageIndex === "number" &&
    Number.isInteger(record.pageIndex)
  ) {
    pageIndex = record.pageIndex;
  } else {
    const position = record.position as
      { pageIndex?: unknown } | null | undefined;
    if (
      position &&
      typeof position === "object" &&
      typeof position.pageIndex === "number"
    ) {
      pageIndex = position.pageIndex;
    }
  }
  if (!annotationKey && pageIndex === undefined) {
    return null;
  }
  return {
    libraryID:
      typeof record.libraryID === "number" ? record.libraryID : undefined,
    key,
    pageIndex,
    annotationKey: annotationKey || undefined,
  };
}

/** Approval cards only carry args; derive a jump target for write-back tools. */
function locateFromApproval(
  toolName: string,
  args: Record<string, unknown>,
): LocateTarget | null {
  if (
    toolName !== "commit_annotations" &&
    toolName !== "propose_highlights" &&
    toolName !== "propose_annotations"
  ) {
    return null;
  }
  const key = typeof args.key === "string" ? args.key.trim() : "";
  if (!key) {
    return null;
  }
  const annotations = Array.isArray(args.annotations)
    ? (args.annotations as Array<{ page?: unknown }>)
    : Array.isArray(args.highlights)
      ? (args.highlights as Array<{ page?: unknown }>)
      : [];
  const firstPage = annotations
    .map((annotation) => Number(annotation?.page))
    .find((page) => Number.isInteger(page) && page > 0);
  return {
    libraryID: typeof args.libraryID === "number" ? args.libraryID : undefined,
    key,
    pageIndex: firstPage === undefined ? undefined : firstPage - 1,
  };
}

function applyFill(node: HTMLElement, compact = false): void {
  Object.assign(node.style, {
    position: compact ? "absolute" : "fixed",
    top: "0px",
    right: "0px",
    bottom: "0px",
    left: "0px",
    display: "flex",
    flexDirection: "column",
    margin: "0px",
    padding: "0px",
    width: "auto",
    height: "auto",
    maxWidth: compact ? "100%" : "none",
    minWidth: compact ? "0px" : "640px",
    minHeight: compact ? "0px" : "420px",
    overflow: "hidden",
    containerType: "inline-size",
    boxSizing: "border-box",
    background: "#f5f3ee",
    color: "#33302a",
    font: '13px/1.45 "Segoe UI", "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  });
}

function paneLabel(doc: Document, text: string): HTMLElement {
  const node = el(doc, "div", {
    fontSize: "11px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#6b665c",
    marginBottom: "10px",
  });
  node.textContent = text;
  return node;
}

function muted(doc: Document, text: string): HTMLElement {
  const node = el(doc, "div", { color: "#6b665c" });
  node.textContent = text;
  return node;
}

const button = createWorkspaceButton;
let lastSettingsTab:
  "model" | "runtime" | "memory" | "security" | "appearance" | "update" =
  "model";

function brandMark(doc: Document): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const mark = doc.createElementNS(SVG_NS, "path");
  mark.setAttribute(
    "d",
    "M200 76 A 90 90 0 1 0 200 180 Q 187 178 173 164 A 58 58 0 1 1 173 92 Q 187 80 200 76 Z",
  );
  mark.setAttribute("fill", "#201d1a");
  svg.appendChild(mark);
  return svg;
}

function workspaceLayoutIcon(doc: Document, target: WorkspaceLayout): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const frame = doc.createElementNS(SVG_NS, "rect");
  frame.setAttribute("x", "3");
  frame.setAttribute("y", "4");
  frame.setAttribute("width", "18");
  frame.setAttribute("height", "16");
  frame.setAttribute("rx", "2");
  svg.appendChild(frame);

  const divider = doc.createElementNS(SVG_NS, "path");
  divider.setAttribute("d", target === "sidebar" ? "M15 4v16" : "M3 8.5h18");
  svg.appendChild(divider);

  if (target === "window") {
    const dot = doc.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", "6");
    dot.setAttribute("cy", "6.3");
    dot.setAttribute("r", "0.55");
    dot.setAttribute("fill", "currentColor");
    dot.setAttribute("stroke", "none");
    svg.appendChild(dot);
  }
  return svg;
}

function workspaceSettingsIcon(doc: Document): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const gear = doc.createElementNS(SVG_NS, "path");
  gear.setAttribute(
    "d",
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
  );
  svg.appendChild(gear);

  const center = doc.createElementNS(SVG_NS, "circle");
  center.setAttribute("cx", "12");
  center.setAttribute("cy", "12");
  center.setAttribute("r", "3");
  svg.appendChild(center);
  return svg;
}

function workspaceKnowledgeIcon(doc: Document): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const paths = [
    "M12 5v5",
    "M6 14v-1.5A2.5 2.5 0 0 1 8.5 10h7A2.5 2.5 0 0 1 18 12.5V14",
  ];
  for (const data of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", data);
    svg.appendChild(path);
  }
  for (const [cx, cy] of [
    [12, 4],
    [6, 17],
    [12, 17],
    [18, 17],
  ]) {
    const node = doc.createElementNS(SVG_NS, "circle");
    node.setAttribute("cx", String(cx));
    node.setAttribute("cy", String(cy));
    node.setAttribute("r", "2");
    svg.appendChild(node);
  }
  return svg;
}

function artifactActionIcon(
  doc: Document,
  kind: "close" | "artifacts" | "writeback",
): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const paths =
    kind === "close"
      ? ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"]
      : kind === "artifacts"
        ? ["M7 4.5h7.5L18 8v11.5H7z", "M14.5 4.5V8H18", "M4 7.5v13h11"]
        : ["M12 3.5v12", "m-4-4 4 4 4-4", "M5 19.5h14"];
  for (const data of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", data);
    svg.appendChild(path);
  }
  return svg;
}

function replyActionIcon(
  doc: Document,
  kind: "copy" | "branch" | "note" | "check",
): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const paths =
    kind === "copy"
      ? [
          "M8 8h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z",
          "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h1",
        ]
      : kind === "note"
        ? ["M6 3.5h8l4 4v13H6z", "M14 3.5v4h4", "M9 12h6", "M9 16h4"]
        : kind === "check"
          ? ["m5 12.5 4.2 4.2L19 7"]
          : [
              "M7.5 6h2.25A4.25 4.25 0 0 1 14 10.25V12",
              "M7.5 18h2.25A4.25 4.25 0 0 0 14 13.75V12",
              "M14 12h2.5",
            ];
  for (const data of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", data);
    svg.appendChild(path);
  }
  if (kind === "branch") {
    for (const [cx, cy] of [
      [5, 6],
      [5, 18],
      [19, 12],
    ]) {
      const circle = doc.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", "2.2");
      svg.appendChild(circle);
    }
  }
  return svg;
}

function effortLabel(value: string, fallback = value): string {
  const labels: Record<string, string> = {
    auto: getString("workspace-effort-auto"),
    off: getString("workspace-effort-off"),
    none: getString("workspace-effort-off"),
    disabled: getString("workspace-effort-off"),
    instant: getString("workspace-effort-off"),
    on: getString("workspace-effort-on"),
    enabled: getString("workspace-effort-on"),
    thinking: getString("workspace-effort-on"),
    minimal: getString("workspace-effort-minimal"),
    low: getString("workspace-effort-low"),
    medium: getString("workspace-effort-medium"),
    high: getString("workspace-effort-high"),
    xhigh: getString("workspace-effort-xhigh"),
    max: getString("workspace-effort-max"),
    ultra: getString("workspace-effort-ultra"),
  };
  return labels[value] ?? fallback;
}

/** Settings and the composer use the same model-specific capability resolver. */
function effortPicker(doc: Document, id: string, value: string) {
  let current: ReasoningEffort = "auto";
  let model = "";
  let baseUrl = "";
  const node = el(
    doc,
    "div",
    { display: "flex", flexWrap: "wrap", gap: "4px" },
    { id, role: "radiogroup" },
  );
  const paint = () => {
    node.textContent = "";
    const options = modelReasoning(model, baseUrl).efforts;
    for (const effort of options) {
      const btn = el(
        doc,
        "button",
        {
          appearance: "none",
          border: "0",
          padding: "5px 10px",
          borderRadius: "8px",
          cursor: "pointer",
          font: "inherit",
          minHeight: "28px",
          lineHeight: "1.2",
          background: current === effort ? "#ebe5d9" : "transparent",
          color: "#4a4135",
        },
        {
          type: "button",
          role: "radio",
          "data-effort": effort,
          "aria-checked": String(current === effort),
        },
      );
      btn.textContent = effortLabel(effort);
      btn.addEventListener("click", () => {
        current = effort;
        paint();
        (
          node.querySelector(`[data-effort="${effort}"]`) as HTMLElement
        )?.focus();
      });
      btn.addEventListener("keydown", (event) => {
        const key = (event as KeyboardEvent).key;
        if (!["ArrowLeft", "ArrowRight"].includes(key)) return;
        event.preventDefault();
        current =
          options[
            (options.indexOf(effort) +
              (key === "ArrowRight" ? 1 : options.length - 1)) %
              options.length
          ];
        paint();
        (
          node.querySelector(`[data-effort="${current}"]`) as HTMLElement
        )?.focus();
      });
      node.appendChild(btn);
    }
  };
  const setValue = (value: string) => {
    current = normalizeModelEffort(model, baseUrl, value);
    paint();
  };
  setValue(value);
  return {
    node,
    getValue: () => current,
    setValue,
    setModel: (
      nextModel: string,
      nextBaseUrl: string,
      effort: string = current,
    ) => {
      model = nextModel;
      baseUrl = nextBaseUrl;
      setValue(effort);
    },
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Circular context-usage indicator for the composer. update() takes a 0..100
 * fill and a tooltip label like "8.2k / 32k tokens".
 */
function buildContextRing(doc: Document): {
  node: HTMLElement;
  update: (percent: number, label: string) => void;
} {
  const size = 30;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const node = el(
    doc,
    "div",
    {
      position: "relative",
      width: `${size}px`,
      height: `${size}px`,
      flex: "0 0 auto",
      cursor: "pointer",
      margin: "0 2px",
    },
    {
      id: "confucius-context-ring",
      title: getString("workspace-context-details"),
      role: "button",
      tabindex: "0",
    },
  ) as HTMLElement;
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  const bg = doc.createElementNS(SVG_NS, "circle");
  bg.setAttribute("cx", String(size / 2));
  bg.setAttribute("cy", String(size / 2));
  bg.setAttribute("r", String(radius));
  bg.setAttribute("fill", "none");
  bg.setAttribute("stroke", "#ddd8cc");
  bg.setAttribute("stroke-width", String(stroke));
  const fg = doc.createElementNS(SVG_NS, "circle");
  fg.setAttribute("cx", String(size / 2));
  fg.setAttribute("cy", String(size / 2));
  fg.setAttribute("r", String(radius));
  fg.setAttribute("fill", "none");
  fg.setAttribute("stroke", "#33302a");
  fg.setAttribute("stroke-width", String(stroke));
  fg.setAttribute("stroke-linecap", "round");
  fg.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
  const text = doc.createElementNS(SVG_NS, "text");
  text.setAttribute("x", "50%");
  text.setAttribute("y", "54%");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "middle");
  text.setAttribute("font-size", "9");
  text.setAttribute("fill", "#33302a");
  text.textContent = "—";
  svg.appendChild(bg);
  svg.appendChild(fg);
  svg.appendChild(text);
  node.appendChild(svg);

  const update = (percent: number, label: string) => {
    const unknown = !Number.isFinite(percent);
    const clamped = unknown ? 0 : Math.max(0, Math.min(100, percent));
    fg.setAttribute(
      "stroke-dasharray",
      `${(clamped / 100) * circumference} ${circumference}`,
    );
    fg.setAttribute(
      "stroke",
      clamped >= 90 ? "#b3452f" : clamped >= 70 ? "#8c6a3f" : "#33302a",
    );
    text.textContent = unknown ? "—" : `${Math.round(clamped)}%`;
    node.setAttribute("aria-label", label);
    node.setAttribute(
      "title",
      `${label} · ${getString("workspace-context-details")}`,
    );
  };
  return { node, update };
}

function requireDocument(root: HTMLElement): Document {
  const doc = root.ownerDocument;
  if (!doc) {
    throw new Error("workspace root has no document");
  }
  return doc;
}

function showMountError(root: HTMLElement, error: unknown): void {
  const doc = requireDocument(root);
  root.textContent = "";
  applyFill(root, root.getAttribute("data-confucius-layout") === "sidebar");
  const panel = el(doc, "div", {
    padding: "24px",
    color: "#8a2e1d",
    background: "#f5f3ee",
  });
  const title = el(doc, "div", { fontWeight: "700", marginBottom: "8px" });
  title.textContent = getString("workspace-mount-error");
  const detail = el(doc, "pre", {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  });
  detail.textContent =
    error instanceof Error ? error.stack || error.message : String(error);
  panel.appendChild(title);
  panel.appendChild(detail);
  root.appendChild(panel);
}

const pollTimers = new WeakMap<HTMLElement, number>();
const layoutCleanups = new WeakMap<HTMLElement, () => void>();

export function unmountWorkspace(root?: HTMLElement | null): void {
  if (!root) {
    return;
  }
  const doc = requireDocument(root);
  const win = doc.defaultView;
  const timer = pollTimers.get(root);
  if (timer && win) {
    win.clearInterval(timer);
  }
  pollTimers.delete(root);
  layoutCleanups.get(root)?.();
  layoutCleanups.delete(root);
  for (const id of [
    "confucius-settings-overlay",
    "confucius-knowledge-overlay",
    "confucius-artifact-overlay",
    "confucius-artifact-choice-menu",
    "confucius-security-profile-menu",
    "confucius-writeback-overlay",
    "confucius-slash-menu",
    "confucius-mention-menu",
    "confucius-plus-menu",
    "confucius-source-menu",
    "confucius-endpoint-menu",
    "confucius-context-details",
  ]) {
    doc.getElementById(id)?.remove();
  }
}

export function mountWorkspace(
  win: Window,
  host: WorkspaceHost | null,
  options: MountOptions = {},
): void {
  const doc = win.document;
  const compact = options.layout === "sidebar";
  const html = doc.documentElement as HTMLElement | null;
  const body = (doc.body || html) as HTMLElement | null;
  if (!html || !body) {
    throw new Error("workspace document has no body");
  }

  if (!compact) {
    html.style.margin = "0";
    html.style.padding = "0";
    html.style.width = "100%";
    html.style.height = "100%";
    html.style.background = "#f5f3ee";
    body.style.margin = "0";
    body.style.padding = "0";
    body.style.width = "100%";
    body.style.height = "100%";
    body.style.background = "#f5f3ee";
    try {
      win.document.title = getString("workspace-title");
    } catch {
      win.document.title = "Confucius";
    }
  }

  let root =
    options.root ||
    (doc.getElementById("confucius-root") as HTMLElement | null);
  if (!root) {
    root = el(doc, "div", undefined, { id: "confucius-root" });
    body.appendChild(root);
  }
  root.setAttribute("data-confucius-layout", compact ? "sidebar" : "window");

  try {
    bindWorkspace(root, host, options);
  } catch (error) {
    showMountError(root, error);
    throw error;
  }
}

function bindWorkspace(
  root: HTMLElement,
  host: WorkspaceHost | null,
  options: MountOptions = {},
): void {
  const doc = requireDocument(root);
  const win = doc.defaultView;
  const layout: WorkspaceLayout =
    options.layout === "sidebar" ? "sidebar" : "window";
  const compact = layout === "sidebar";
  const existingTimer = pollTimers.get(root);
  if (existingTimer && win) {
    win.clearInterval(existingTimer);
    pollTimers.delete(root);
  }
  layoutCleanups.get(root)?.();
  layoutCleanups.delete(root);
  root.textContent = "";
  root.classList.add("confucius-workspace-root");
  ensureTuiStyles(doc);
  applyFill(root, compact);

  linkHosts.set(root, host);
  if (!linkListeners.has(root)) {
    linkListeners.add(root);
    const onWorkspaceLink = (event: Event) => {
      const mouseButton = (event as { button?: number }).button;
      if (typeof mouseButton === "number" && mouseButton !== 0) {
        return;
      }
      const href = hrefFromEvent(event);
      if (!href || href === "#") {
        return;
      }
      const start =
        (event.target as { parentElement?: Element | null } | null)
          ?.parentElement ?? (event.target as Element | null);
      if (!start) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openWorkspaceHref(start, href);
    };
    root.addEventListener("click", onWorkspaceLink, true);
  }

  const cachedView = workspaceViewState;
  const state = {
    sessions: [] as SessionRow[],
    sessionId: cachedView?.taskId ?? (null as string | null),
    events: [] as ConfuciusEvent[],
    lastEventId: null as string | null,
    skills: [] as ConfuciusSkill[],
    approvals: [] as ApprovalRow[],
    memories: [] as MemoryRow[],
    logCount: 0,
    mode: "agent" as "agent" | "plan",
    pendingUserText: "",
    sendError: "",
    sending: false,
    config: null as ModelConfig | null,
    running: false,
    permission: "ask" as "ask" | "auto_allow" | "deny",
    contextStats: null as SessionContextStats | null,
    live: null as LiveContextResult | null,
    artifacts: [] as ArtifactRecord[],
    selectedArtifactId: null as string | null,
    selectedArtifactRevision: null as number | null,
    memoryProposals: [] as MemoryProposal[],
    runtimes: [] as RuntimeStatus[],
    runtimeHostEnabled: true,
    runtimeHostConnected: false,
  };
  const composerDrafts = cachedView?.drafts ?? new Map<string, string>();
  const referenceDrafts =
    cachedView?.references ?? new Map<string, TaskContextReference[]>();
  let composing = false;
  const draftSaves = new Map<string, { timer: number; save: () => void }>();
  let pendingDraftSave: Promise<unknown> = Promise.resolve();
  const timelineViewports =
    cachedView?.viewports ??
    new Map<string, { scrollTop: number; followsBottom: boolean }>();
  let renderedTimelineTaskId: string | null = null;
  let loadedComposerTaskId: string | null = null;
  let taskLoadGeneration = 0;
  let pendingPermissionUpdate: Promise<void> = Promise.resolve();
  let pendingContextUpdate: Promise<void> = Promise.resolve();
  let presetUpdatePending = false;
  let modeUpdatePending = false;
  const pendingMentionItems = new Map<string, ContextSearchItem>();
  let mentionSearchTimer: number | null = null;
  type PendingAttachment = {
    uiId: string;
    path: string;
    name: string;
    status: "preparing" | "ready" | "error";
    record?: TaskAttachment;
    error?: string;
  };
  const pendingAttachments: PendingAttachment[] = [];
  let attachmentDragDepth = 0;

  type ModelListCache = {
    status: "idle" | "loading" | "ok" | "error";
    models: string[];
    error: string;
  };
  const modelLists = new Map<string, ModelListCache>();
  const reasoningFold = new Map<string, ReasoningFold>();
  const toolsOpen = new Set<string>();
  const toolOpen = new Set<string>();
  let artifactViewerOpen = false;
  const artifactScrolls = new Map<string, number>();
  let renderedArtifactKey = "";
  function rememberArtifactScroll(): void {
    const body = doc.getElementById("confucius-artifact-dialog-body");
    if (body && renderedArtifactKey)
      artifactScrolls.set(renderedArtifactKey, body.scrollTop);
  }
  let artifactViewerReturnFocus: HTMLElement | null = null;
  let lastArtifactViewerSignature = "";
  let artifactChoiceMenu: {
    kind: "artifact" | "revision";
    anchor: HTMLElement;
  } | null = null;
  let endpointMenuOpen = false;
  type ComposerModelChoice = {
    backend: AgentBackendKind;
    endpointId?: string;
    model: RuntimeModelOption;
  };
  let endpointSelection: ComposerModelChoice | null = null;
  let modelUpdatePending = false;
  let modelMenuError = "";

  const topbar = el(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 14px",
    borderBottom: "0",
    background: "#faf9f6",
    minHeight: "48px",
    boxSizing: "border-box",
    flex: "0 0 auto",
  });
  topbar.className = "confucius-topbar";
  const brandGroup = el(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: "0px",
  });
  brandGroup.className = "confucius-brand-group";
  const brand = el(doc, "div", {
    flex: "0 0 auto",
    fontWeight: "700",
    fontSize: "15px",
    letterSpacing: "-0.02em",
  });
  brand.textContent = "Confucius";
  const status = el(
    doc,
    "span",
    {
      minWidth: "0px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: "#8c6a3f",
    },
    { id: "confucius-status" },
  );
  status.textContent = host
    ? getString("workspace-connecting")
    : getString("workspace-host-missing");
  brandGroup.appendChild(brandMark(doc));
  brandGroup.appendChild(brand);
  brandGroup.appendChild(status);
  let newSessionLabel = getString("workspace-new-session");
  const newSessionBtn = button(doc, "confucius-new-session", newSessionLabel);
  newSessionBtn.setAttribute("aria-label", newSessionLabel);
  newSessionBtn.setAttribute("title", newSessionLabel);
  const settingsLabel = getString("workspace-settings");
  const settingsBtn = el(doc, "button", undefined, {
    id: "confucius-settings",
    type: "button",
    title: settingsLabel,
  });
  settingsBtn.className = "confucius-icon-button";
  settingsBtn.appendChild(workspaceSettingsIcon(doc));
  settingsBtn.setAttribute("aria-label", settingsLabel);
  const knowledgeLabel = getString("workspace-knowledge");
  const knowledgeBtn = el(doc, "button", undefined, {
    id: "confucius-knowledge",
    type: "button",
    title: knowledgeLabel,
  });
  knowledgeBtn.className = "confucius-icon-button";
  knowledgeBtn.appendChild(workspaceKnowledgeIcon(doc));
  knowledgeBtn.setAttribute("aria-label", knowledgeLabel);
  const layoutTarget: WorkspaceLayout = compact ? "window" : "sidebar";
  const layoutLabel = compact
    ? getString("workspace-layout-window")
    : getString("workspace-layout-sidebar");
  const layoutBtn = el(doc, "button", undefined, {
    id: "confucius-layout",
    type: "button",
    title: layoutLabel,
  });
  layoutBtn.className = "confucius-icon-button";
  layoutBtn.appendChild(workspaceLayoutIcon(doc, layoutTarget));
  layoutBtn.setAttribute("aria-label", layoutLabel);
  const sessionsToggle = el(
    doc,
    "button",
    {
      background: "transparent",
      color: "#33302a",
      border: "0",
      borderRadius: "8px",
      padding: "6px 10px",
      cursor: "pointer",
      minHeight: "32px",
      font: "inherit",
      display: compact ? "inline-flex" : "none",
    },
    { id: "confucius-toggle-sessions", type: "button" },
  );
  sessionsToggle.textContent = getString("workspace-toggle-sessions");
  sessionsToggle.setAttribute("aria-label", sessionsToggle.textContent);
  sessionsToggle.setAttribute("aria-pressed", "false");
  const topbarActions = el(doc, "div", {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "8px",
    minWidth: "0px",
    marginLeft: "auto",
  });
  topbarActions.className = "confucius-topbar-actions";
  topbarActions.appendChild(newSessionBtn);
  topbarActions.appendChild(sessionsToggle);
  topbarActions.appendChild(knowledgeBtn);
  topbarActions.appendChild(layoutBtn);
  topbarActions.appendChild(settingsBtn);
  topbar.appendChild(brandGroup);
  topbar.appendChild(topbarActions);

  const columns = el(doc, "div", {
    display: "flex",
    flex: "1 1 auto",
    minHeight: "0px",
    overflow: "hidden",
    position: "relative",
  });
  columns.className = "confucius-columns";
  let showSessions = !compact;
  const sessionPane = el(doc, "div", {
    width: compact ? "160px" : "220px",
    minWidth: compact ? "140px" : "180px",
    padding: "14px",
    overflowX: "hidden",
    overflowY: "auto",
    borderRight: "0",
    background: "#f5f3ee",
    boxSizing: "border-box",
    display: showSessions ? "block" : "none",
  });
  sessionPane.className = "confucius-pane confucius-session-pane";
  sessionPane.setAttribute(
    "aria-label",
    getString("workspace-toggle-sessions"),
  );
  const workbenchPane = el(doc, "div", {
    flex: "1 1 auto",
    minWidth: "0px",
    minHeight: "0px",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "#f5f3ee",
  });
  workbenchPane.className = "confucius-workbench-pane";
  const timelinePane = el(
    doc,
    "main",
    {
      display: "block",
      flex: "1 1 0px",
      minWidth: "0px",
      minHeight: "0px",
      overflowX: "hidden",
      overflowY: "auto",
      padding: compact ? "12px 10px" : "18px 24px",
      background: "#faf9f6",
      boxSizing: "border-box",
    },
    {
      id: "confucius-activity-stream",
      "aria-label": getString("workspace-activity"),
    },
  );
  timelinePane.className = "confucius-pane confucius-timeline-pane";
  workbenchPane.appendChild(timelinePane);
  columns.appendChild(sessionPane);
  columns.appendChild(workbenchPane);

  const composer = el(doc, "form");
  composer.className = "confucius-composer";
  const composerCard = el(doc, "div");
  composerCard.className = "confucius-composer-card";
  const composerSources = el(doc, "div");
  composerSources.className = "confucius-composer-sources";
  const attachmentTray = el(
    doc,
    "div",
    { display: "none" },
    {
      id: "confucius-attachment-tray",
      "aria-live": "polite",
      "aria-label": getString("workspace-attachment-list"),
    },
  );
  attachmentTray.className = "confucius-attachment-tray";
  const composerToolbar = el(doc, "div");
  composerToolbar.className = "confucius-composer-toolbar";
  const composerLeading = el(doc, "div");
  composerLeading.className = "confucius-composer-leading";
  const dropHint = el(doc, "div", undefined, {
    id: "confucius-drop-hint",
    "aria-hidden": "true",
  });
  dropHint.className = "confucius-drop-hint";
  dropHint.textContent = getString("workspace-attachment-drop");
  const prompt = el(
    doc,
    "textarea",
    {
      display: "block",
      minWidth: "0px",
      border: "0",
      background: "transparent",
      color: "#33302a",
      fontFamily: "inherit",
      fontSize: "inherit",
    },
    {
      id: "confucius-prompt",
      rows: "1",
      "aria-label": getString("workspace-composer-placeholder"),
      placeholder: getString("workspace-composer-placeholder"),
    },
  ) as HTMLTextAreaElement;
  prompt.style.boxSizing = "border-box";
  const sourceTray = el(doc, "div");
  sourceTray.className = "confucius-source-tray";
  composerSources.appendChild(sourceTray);
  function currentReferences(): TaskContextReference[] {
    return (
      referenceDrafts.get(state.sessionId ?? "new") ??
      currentTask()?.draft?.references ??
      currentTask()?.references ??
      []
    );
  }
  let sourceTagSignature = "";
  function renderSourceTags(): void {
    const references = currentReferences();
    const signature = JSON.stringify(
      references.map((ref) => [
        ref,
        state.sessions.some((task) => task.id === ref.taskId),
      ]),
    );
    if (signature === sourceTagSignature) return;
    sourceTagSignature = signature;
    sourceTray.replaceChildren();
    for (const ref of references) {
      const available = state.sessions.some((task) => task.id === ref.taskId);
      const tag = el(doc, "span", undefined, {
        "data-unavailable": String(!available),
      });
      tag.className = "confucius-source-tag";
      const title = button(
        doc,
        "",
        `${getString("workspace-reference-task")} · ${ref.title}`,
      );
      title.className = "confucius-source-title";
      title.title = `${ref.title} · ${ref.taskId}${available ? "" : ` · ${getString("workspace-source-unavailable")}`}`;
      title.setAttribute("aria-disabled", String(!available));
      title.addEventListener("click", () => {
        if (available) void loadTask(ref.taskId).then(renderLists);
      });
      const remove = button(doc, "", "×");
      remove.setAttribute(
        "aria-label",
        `${getString("workspace-reference-remove")} ${ref.title}`,
      );
      remove.addEventListener("click", () => {
        referenceDrafts.set(
          state.sessionId ?? "new",
          currentReferences().filter((item) => item.taskId !== ref.taskId),
        );
        rememberComposerDraft();
        renderSourceTags();
        prompt.focus();
      });
      tag.append(title);
      if (!available) {
        const unavailable = el(doc, "small");
        unavailable.className = "confucius-source-unavailable";
        unavailable.textContent = getString(
          "workspace-source-unavailable-short",
        );
        tag.append(unavailable);
      }
      tag.append(remove);
      sourceTray.append(tag);
    }
  }
  const sendBtn = el(doc, "button", undefined, {
    id: "confucius-send",
    type: "submit",
    "aria-label": getString("workspace-send"),
    title: getString("workspace-send"),
  });
  sendBtn.className = "confucius-composer-action";
  const stopBtn = el(doc, "button", undefined, {
    id: "confucius-stop",
    type: "button",
    "aria-label": getString("workspace-stop"),
    title: getString("workspace-stop"),
  });
  stopBtn.className = "confucius-composer-action";
  stopBtn.style.display = "none";

  const plusBtn = el(
    doc,
    "button",
    {
      background: "transparent",
      color: "#555046",
      border: "0",
      cursor: "pointer",
      font: "inherit",
      fontSize: "24px",
    },
    {
      id: "confucius-plus",
      type: "button",
      title: getString("workspace-plus"),
    },
  );
  plusBtn.textContent = "+";
  plusBtn.setAttribute("aria-label", getString("workspace-plus"));

  const planStatus = createComposerStatusChip(
    doc,
    "confucius-mode",
    "plan",
    async () => {
      const taskId = state.sessionId;
      if ((await applyMode("agent")) && state.sessionId === taskId)
        prompt.focus({ preventScroll: true });
    },
  );
  const presetStatus = createComposerStatusChip(
    doc,
    "confucius-preset",
    "preset",
    clearPreset,
  );
  const presetChip = presetStatus.node;
  const presetLabel = presetStatus.label;

  const endpointBtn = el(
    doc,
    "button",
    {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      margin: "0",
      border: "0",
      background: "transparent",
      color: "#33302a",
      cursor: "pointer",
      font: "inherit",
      boxSizing: "border-box",
    },
    {
      id: "confucius-endpoint",
      type: "button",
      title: getString("workspace-model"),
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    },
  );
  const endpointName = el(doc, "span", {
    flex: "1 1 auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "left",
  });
  endpointName.className = "confucius-endpoint-name";
  const endpointChevron = el(doc, "span", {
    flex: "0 0 auto",
    color: "#6b665c",
  });
  endpointChevron.textContent = "▾";
  endpointBtn.appendChild(endpointName);
  endpointBtn.appendChild(endpointChevron);

  const contextRing = buildContextRing(doc);
  contextRing.node.style.margin = "0";

  composerLeading.append(plusBtn, planStatus.node, presetChip);
  composerToolbar.appendChild(composerLeading);
  composerToolbar.appendChild(endpointBtn);
  composerToolbar.appendChild(contextRing.node);
  composerToolbar.appendChild(sendBtn);
  composerToolbar.appendChild(stopBtn);
  composerSources.appendChild(attachmentTray);
  composerCard.appendChild(composerSources);
  composerCard.appendChild(prompt);
  composerCard.appendChild(composerToolbar);
  composer.appendChild(composerCard);
  const latest = button(
    doc,
    "confucius-latest",
    getString("workspace-back-to-latest"),
  );
  latest.classList.add("confucius-latest");
  latest.hidden = true;
  const syncLatest = () => {
    latest.hidden =
      timelinePane.scrollHeight -
        timelinePane.scrollTop -
        timelinePane.clientHeight <
        96 || !state.events.length;
  };
  latest.addEventListener("click", () => {
    timelinePane.scrollTop = timelinePane.scrollHeight;
    rememberTimelineViewport();
    syncLatest();
  });
  timelinePane.addEventListener("scroll", syncLatest, { passive: true });
  composer.appendChild(latest);
  workbenchPane.appendChild(composer);

  root.appendChild(topbar);
  root.appendChild(columns);
  root.appendChild(dropHint);

  let sessionsLabel = getString("workspace-toggle-sessions");
  let sendLabel = getString("workspace-send");
  let stopLabel = getString("workspace-stop");
  let auxiliaryOverlay = compact;
  let responsiveWidth = 0;
  let density: "wide" | "compact" | "narrow" = compact ? "compact" : "wide";

  function applyLocalizedChrome(): void {
    if (!compact) {
      doc.title = getString("workspace-title");
    }
    newSessionLabel = getString("workspace-new-session");
    newSessionBtn.setAttribute("aria-label", newSessionLabel);
    newSessionBtn.setAttribute("title", newSessionLabel);
    const nextSettingsLabel = getString("workspace-settings");
    settingsBtn.setAttribute("aria-label", nextSettingsLabel);
    settingsBtn.setAttribute("title", nextSettingsLabel);
    const nextKnowledgeLabel = getString("workspace-knowledge");
    knowledgeBtn.setAttribute("aria-label", nextKnowledgeLabel);
    knowledgeBtn.setAttribute("title", nextKnowledgeLabel);
    const nextLayoutLabel = compact
      ? getString("workspace-layout-window")
      : getString("workspace-layout-sidebar");
    layoutBtn.setAttribute("aria-label", nextLayoutLabel);
    layoutBtn.setAttribute("title", nextLayoutLabel);
    sessionsLabel = getString("workspace-toggle-sessions");
    sendLabel = getString("workspace-send");
    stopLabel = getString("workspace-stop");
    sessionPane.setAttribute("aria-label", sessionsLabel);
    timelinePane.setAttribute("aria-label", getString("workspace-activity"));
    attachmentTray.setAttribute(
      "aria-label",
      getString("workspace-attachment-list"),
    );
    dropHint.textContent = getString("workspace-attachment-drop");
    prompt.setAttribute(
      "placeholder",
      getString("workspace-composer-placeholder"),
    );
    sendBtn.setAttribute("aria-label", sendLabel);
    stopBtn.setAttribute("aria-label", stopLabel);
    sendBtn.setAttribute("title", sendLabel);
    stopBtn.setAttribute("title", stopLabel);
    const nextPlusLabel = getString("workspace-plus");
    plusBtn.setAttribute("aria-label", nextPlusLabel);
    plusBtn.setAttribute("title", nextPlusLabel);
    endpointBtn.setAttribute("title", getString("workspace-model"));
    syncPresetChip();
    applyResponsiveLayout();
  }

  function paintToggle(node: HTMLElement, active: boolean): void {
    node.setAttribute("aria-pressed", active ? "true" : "false");
    node.style.background = active ? "#eeebe3" : "transparent";
    node.style.color = "#33302a";
  }

  function syncAuxiliaryPanes(): void {
    sessionsToggle.style.display = auxiliaryOverlay ? "inline-flex" : "none";
    paintToggle(sessionsToggle, auxiliaryOverlay && showSessions);

    if (!auxiliaryOverlay) {
      sessionPane.style.position = "static";
      sessionPane.style.top = "";
      sessionPane.style.right = "";
      sessionPane.style.bottom = "";
      sessionPane.style.left = "";
      sessionPane.style.zIndex = "";
      sessionPane.style.maxWidth = "";
      sessionPane.style.boxShadow = "none";
      sessionPane.style.display = "block";
      sessionPane.style.width = "220px";
      sessionPane.style.minWidth = "180px";
      return;
    }

    const drawerWidth = Math.min(320, Math.max(0, responsiveWidth));
    Object.assign(sessionPane.style, {
      position: "absolute",
      top: "0px",
      bottom: "0px",
      left: "0px",
      right: "auto",
      zIndex: "20",
      width: `${drawerWidth}px`,
      minWidth: "0px",
      maxWidth: "100%",
      boxShadow: "8px 0 32px rgba(51, 42, 28, 0.08)",
      display: showSessions ? "block" : "none",
    });
  }

  function applyResponsiveLayout(): void {
    const measured = Math.round(
      root.getBoundingClientRect().width || root.clientWidth || 0,
    );
    if (!measured) {
      return;
    }
    const previousOverlay = auxiliaryOverlay;
    responsiveWidth = measured;
    density = measured < 300 ? "narrow" : measured < 620 ? "compact" : "wide";
    auxiliaryOverlay = compact || measured < 760;
    if (auxiliaryOverlay && !previousOverlay) {
      showSessions = false;
    }
    root.setAttribute("data-confucius-density", density);
    root.setAttribute("data-confucius-compact-panels", String(measured < 900));

    const stacked = density !== "wide";
    const narrow = density === "narrow";
    Object.assign(topbar.style, {
      alignItems: stacked ? "stretch" : "center",
      flexDirection: stacked ? "column" : "row",
      gap: stacked ? "6px" : "10px",
      padding: stacked ? "8px" : "10px 14px",
      minHeight: stacked ? "0px" : "48px",
    });
    Object.assign(brandGroup.style, {
      width: stacked ? "100%" : "auto",
      minHeight: stacked ? "24px" : "0px",
    });
    status.style.display = narrow ? "none" : "inline";
    Object.assign(topbarActions.style, {
      display: stacked ? "grid" : "flex",
      gridTemplateColumns: stacked ? "repeat(5, minmax(0, 1fr))" : "",
      width: stacked ? "100%" : "auto",
      marginLeft: stacked ? "0px" : "auto",
      gap: stacked ? "4px" : "8px",
    });
    for (const action of [newSessionBtn, sessionsToggle]) {
      Object.assign(action.style, {
        minWidth: "0px",
        maxWidth: "100%",
        justifyContent: "center",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        padding: narrow ? "5px 4px" : "6px 8px",
        fontSize: stacked ? "12px" : "13px",
      });
    }
    newSessionBtn.textContent = narrow ? "+" : newSessionLabel;
    sessionsToggle.textContent = narrow ? "☰" : sessionsLabel;

    sendBtn.textContent = "↑";
    stopBtn.textContent = "■";
    timelinePane.style.padding = stacked ? "10px" : "18px 24px";
    sessionPane.style.padding = stacked ? "10px" : "14px";
    syncAuxiliaryPanes();
  }

  const onWindowResize = () => {
    applyResponsiveLayout();
    closeArtifactChoiceMenu(false);
  };
  const ResizeObserverCtor = win?.ResizeObserver;
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(() => {
        applyResponsiveLayout();
        closeArtifactChoiceMenu(false);
      })
    : null;
  resizeObserver?.observe(root);
  win?.addEventListener("resize", onWindowResize);
  layoutCleanups.set(root, () => {
    rememberComposerDraft();
    rememberTimelineViewport();
    workspaceViewState = {
      taskId: state.sessionId,
      drafts: composerDrafts,
      references: referenceDrafts,
      viewports: timelineViewports,
    };
    for (const pending of draftSaves.values()) {
      win?.clearTimeout(pending.timer);
      pending.save();
    }
    resizeObserver?.disconnect();
    win?.removeEventListener("resize", onWindowResize);
    root.removeEventListener("dragenter", onAttachmentDragEnter);
    root.removeEventListener("dragover", onAttachmentDragOver);
    root.removeEventListener("dragleave", onAttachmentDragLeave);
    root.removeEventListener("drop", onAttachmentDrop);
    resetAttachmentDrop();
    if (mentionSearchTimer && win) win.clearTimeout(mentionSearchTimer);
    clearPendingAttachments();
  });
  applyResponsiveLayout();

  async function rpc(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!host) {
      throw new Error("Confucius host is not available");
    }
    return host.rpc(method, params);
  }

  function attachmentKindLabel(item: PendingAttachment): string {
    if (item.record?.kind === "pdf" || /\.pdf$/iu.test(item.name)) return "PDF";
    if (
      item.record?.kind === "markdown" ||
      /\.(?:md|markdown)$/iu.test(item.name)
    ) {
      return "MD";
    }
    return "TXT";
  }

  function formatAttachmentBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function attachmentMeta(item: PendingAttachment): string {
    if (item.status === "preparing") {
      return getString("workspace-attachment-reading");
    }
    if (item.status === "error") {
      return item.error || getString("workspace-attachment-error");
    }
    const record = item.record!;
    const parts = [formatAttachmentBytes(record.size)];
    if (record.kind === "pdf" && typeof record.extractedPages === "number") {
      parts.push(
        typeof record.totalPages === "number"
          ? `${record.extractedPages}/${record.totalPages} ${getString("workspace-attachment-pages")}`
          : `${record.extractedPages} ${getString("workspace-attachment-pages")}`,
      );
    }
    if (record.truncated) {
      parts.push(getString("workspace-attachment-truncated"));
    }
    return parts.join(" · ");
  }

  function renderAttachmentTray(): void {
    attachmentTray.textContent = "";
    attachmentTray.style.display = pendingAttachments.length ? "flex" : "none";
    for (const item of pendingAttachments) {
      const chip = el(doc, "div", undefined, {
        "data-status": item.status,
        title: item.error || item.name,
      });
      chip.className = "confucius-attachment-chip";
      const kind = el(doc, "span");
      kind.className = "confucius-attachment-kind";
      kind.textContent = attachmentKindLabel(item);
      const copy = el(doc, "span");
      copy.className = "confucius-attachment-copy";
      const name = el(doc, "span");
      name.className = "confucius-attachment-name";
      name.textContent = item.name;
      const meta = el(doc, "span");
      meta.className = "confucius-attachment-meta";
      meta.textContent = attachmentMeta(item);
      copy.appendChild(name);
      copy.appendChild(meta);
      const remove = el(doc, "button", undefined, {
        type: "button",
        title: getString("workspace-attachment-remove"),
        "aria-label": `${getString("workspace-attachment-remove")}: ${item.name}`,
      });
      remove.className = "confucius-attachment-remove";
      remove.textContent = "×";
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        removePendingAttachment(item.uiId);
      });
      chip.appendChild(kind);
      chip.appendChild(copy);
      chip.appendChild(remove);
      attachmentTray.appendChild(chip);
    }
    updateRunningUI();
  }

  function removePendingAttachment(uiId: string): void {
    const index = pendingAttachments.findIndex((item) => item.uiId === uiId);
    if (index < 0) return;
    const [removed] = pendingAttachments.splice(index, 1);
    if (removed.record?.id) {
      void rpc("attachment/release", { id: removed.record.id }).catch(
        () => undefined,
      );
    }
    renderAttachmentTray();
  }

  function clearPendingAttachments(): void {
    const ids = pendingAttachments
      .map((item) => item.record?.id)
      .filter((id): id is string => Boolean(id));
    pendingAttachments.splice(0);
    for (const id of ids) {
      void rpc("attachment/release", { id }).catch(() => undefined);
    }
    attachmentTray.textContent = "";
    attachmentTray.style.display = "none";
  }

  async function prepareDroppedFiles(paths: string[]): Promise<void> {
    if (!paths.length) {
      state.sendError = getString("workspace-attachment-path-error");
      renderLists();
      return;
    }
    const existing = new Set(
      pendingAttachments.map((item) =>
        item.path.replaceAll("/", "\\").toLocaleLowerCase(),
      ),
    );
    const accepted: PendingAttachment[] = [];
    for (const path of paths) {
      const key = path.replaceAll("/", "\\").toLocaleLowerCase();
      if (existing.has(key)) continue;
      if (pendingAttachments.length >= MAX_COMPOSER_ATTACHMENTS) {
        state.sendError = getString("workspace-attachment-limit");
        break;
      }
      existing.add(key);
      const item: PendingAttachment = {
        uiId: `drop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        path,
        name: droppedFilename(path),
        status: "preparing",
      };
      pendingAttachments.push(item);
      accepted.push(item);
    }
    if (!accepted.length) {
      renderAttachmentTray();
      return;
    }
    state.sendError = "";
    renderAttachmentTray();
    await Promise.all(
      accepted.map(async (item) => {
        try {
          const result = (await rpc("attachment/prepare", {
            path: item.path,
          })) as { attachment: TaskAttachment };
          const current = pendingAttachments.find(
            (entry) => entry.uiId === item.uiId,
          );
          if (!current) {
            void rpc("attachment/release", {
              id: result.attachment.id,
            }).catch(() => undefined);
            return;
          }
          current.record = result.attachment;
          current.name = result.attachment.name;
          current.status = "ready";
        } catch (error) {
          const current = pendingAttachments.find(
            (entry) => entry.uiId === item.uiId,
          );
          if (!current) return;
          current.status = "error";
          current.error =
            error instanceof Error ? error.message : String(error);
        }
        renderAttachmentTray();
      }),
    );
    prompt.focus();
  }

  function showAttachmentDrop(active: boolean): void {
    const visible = active && canAcceptFileDrop();
    root.setAttribute("data-file-drop-active", visible ? "true" : "false");
    dropHint.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  function canAcceptFileDrop(): boolean {
    if (!prompt.isConnected || !composer.isConnected || prompt.disabled) {
      return false;
    }
    if (artifactViewerOpen || knowledgeUi.open) {
      return false;
    }
    for (const id of [
      "confucius-settings-overlay",
      "confucius-knowledge-overlay",
      "confucius-artifact-overlay",
      "confucius-writeback-overlay",
    ]) {
      if (doc.getElementById(id)) return false;
    }
    try {
      const promptStyle = win?.getComputedStyle(prompt);
      const composerStyle = win?.getComputedStyle(composer);
      if (
        promptStyle?.display === "none" ||
        promptStyle?.visibility === "hidden" ||
        composerStyle?.display === "none" ||
        composerStyle?.visibility === "hidden"
      ) {
        return false;
      }
    } catch {
      // Geometry below remains a reliable fallback in embedded XUL documents.
    }
    const promptRect = prompt.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    return (
      promptRect.width > 0 &&
      promptRect.height > 0 &&
      composerRect.width > 0 &&
      composerRect.height > 0
    );
  }

  function resetAttachmentDrop(): void {
    attachmentDragDepth = 0;
    showAttachmentDrop(false);
  }

  const knowledgeKinds: KnowledgeEntryKind[] = [
    "paper",
    "note",
    "insight",
    "method",
    "discussion",
    "mindmap",
  ];
  const knowledgeUi = {
    open: false,
    loading: false,
    bases: [] as KnowledgeBaseRow[],
    base: null as KnowledgeBaseDetail | null,
    baseId: "",
    entryId: "",
    filter: "all" as "all" | KnowledgeEntryKind,
    editor: "empty" as "empty" | "base" | "entry",
    creatingBase: false,
    entryEditing: false,
    stage: "topics" as "topics" | "entries" | "editor",
    memoriesOpen: false,
    topicQuery: "",
    entryQuery: "",
    error: "",
  };
  const knowledgeDrafts = new WorkspaceFormDrafts();
  let knowledgeLoadGeneration = 0;
  const knowledgeScrolls = new Map<string, number>();
  let knowledgeReturnFocus: HTMLElement | null = null;
  const knowledgeEditor = () =>
    doc.querySelector<HTMLElement>(".confucius-knowledge-editor");
  const clearKnowledgeDraft = () => knowledgeDrafts.clear(knowledgeEditor());

  const knowledgeKindLabel = (kind: KnowledgeEntryKind): string =>
    getString(`workspace-knowledge-kind-${kind}`);

  async function openKnowledgeWindow(): Promise<void> {
    if (!knowledgeUi.open)
      knowledgeReturnFocus = doc.activeElement as HTMLElement | null;
    knowledgeUi.open = true;
    knowledgeUi.loading = true;
    knowledgeUi.error = "";
    renderKnowledgeWindow();
    void refreshMemories().then(() => renderKnowledgeWindow());
    try {
      await refreshKnowledgeBases(knowledgeUi.baseId);
    } catch (error) {
      knowledgeUi.error =
        error instanceof Error ? error.message : String(error);
    } finally {
      knowledgeUi.loading = false;
      renderKnowledgeWindow();
    }
  }

  async function refreshKnowledgeBases(preferredId = ""): Promise<void> {
    const result = (await rpc("knowledge/list", { limit: 200 })) as {
      knowledgeBases?: KnowledgeBaseRow[];
    };
    knowledgeUi.bases = result.knowledgeBases ?? [];
    const nextId =
      (preferredId &&
        knowledgeUi.bases.some((base) => base.id === preferredId) &&
        preferredId) ||
      knowledgeUi.bases[0]?.id ||
      "";
    if (nextId) {
      await loadKnowledgeBase(nextId, false);
    } else {
      knowledgeUi.baseId = "";
      knowledgeUi.base = null;
      knowledgeUi.entryId = "";
      knowledgeUi.editor = "empty";
    }
  }

  async function loadKnowledgeBase(id: string, repaint = true): Promise<void> {
    const generation = ++knowledgeLoadGeneration;
    const result = (await rpc("knowledge/get", { id, limit: 2_000 })) as {
      knowledgeBase?: KnowledgeBaseDetail;
    };
    if (generation !== knowledgeLoadGeneration || !knowledgeUi.open) return;
    const preserveSelection =
      !repaint &&
      knowledgeUi.baseId === id &&
      result.knowledgeBase?.entries.some(
        (entry) => entry.id === knowledgeUi.entryId,
      );
    knowledgeUi.baseId = id;
    knowledgeUi.creatingBase = false;
    knowledgeUi.error = "";
    knowledgeUi.base = result.knowledgeBase ?? null;
    if (!preserveSelection) {
      knowledgeUi.entryId = "";
      knowledgeUi.editor = "empty";
      knowledgeUi.entryEditing = false;
      if (!repaint && knowledgeUi.stage === "editor")
        knowledgeUi.stage = "entries";
    }
    if (repaint) {
      knowledgeUi.stage = "entries";
      renderKnowledgeWindow();
    }
  }

  function closeKnowledgeWindow(): void {
    knowledgeLoadGeneration += 1;
    knowledgeDrafts.remember(knowledgeEditor());
    knowledgeUi.open = false;
    doc.getElementById("confucius-knowledge-overlay")?.remove();
    if (knowledgeReturnFocus?.isConnected)
      knowledgeReturnFocus.focus({ preventScroll: true });
  }

  function renderKnowledgeWindow(): void {
    const previous = doc.getElementById("confucius-knowledge-overlay");
    const previousKey = knowledgeEditor()?.dataset.viewKey;
    const active = previous?.contains(doc.activeElement)
      ? (doc.activeElement as HTMLInputElement)
      : null;
    const focusId = active?.id;
    const selection =
      active && "selectionStart" in active
        ? [active.selectionStart, active.selectionEnd]
        : null;
    knowledgeDrafts.remember(knowledgeEditor());
    for (const pane of Array.from(
      previous?.querySelectorAll("[data-view-key]") ?? [],
    ) as HTMLElement[]) {
      knowledgeScrolls.set(pane.dataset.viewKey!, pane.scrollTop);
    }
    previous?.remove();
    if (!knowledgeUi.open) return;

    const overlay = el(doc, "div", undefined, {
      id: "confucius-knowledge-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": getString("workspace-knowledge"),
    });
    overlay.className = "confucius-knowledge-overlay";
    const shell = el(doc, "section");
    shell.className = "confucius-knowledge-shell";
    shell.dataset.stage = knowledgeUi.stage;
    bindDialogNavigation(overlay, closeKnowledgeWindow);
    overlay.appendChild(shell);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeKnowledgeWindow();
    });

    const header = el(doc, "header");
    header.className = "confucius-knowledge-header";
    const back = button(doc, "confucius-kb-back", "←");
    back.classList.add("confucius-kb-back");
    back.setAttribute("aria-label", getString("workspace-back"));
    back.addEventListener("click", () => {
      knowledgeUi.stage =
        knowledgeUi.stage === "editor" && knowledgeUi.base
          ? "entries"
          : "topics";
      renderKnowledgeWindow();
    });
    header.appendChild(back);
    const icon = el(doc, "div", { color: "#33302a" });
    icon.appendChild(workspaceKnowledgeIcon(doc));
    const copy = el(doc, "div");
    copy.className = "confucius-knowledge-header-copy";
    const eyebrow = el(doc, "div");
    eyebrow.className = "confucius-knowledge-eyebrow";
    eyebrow.textContent = getString("workspace-knowledge-research-memory");
    const heading = el(doc, "div");
    heading.className = "confucius-knowledge-heading";
    heading.textContent =
      knowledgeUi.base?.title || getString("workspace-knowledge");
    copy.appendChild(eyebrow);
    copy.appendChild(heading);
    const close = el(doc, "button", undefined, {
      type: "button",
      title: getString("workspace-knowledge-close"),
      "aria-label": getString("workspace-knowledge-close"),
    });
    close.className = "confucius-icon-button";
    close.textContent = "×";
    close.style.fontSize = "24px";
    close.addEventListener("click", closeKnowledgeWindow);
    header.appendChild(icon);
    header.appendChild(copy);
    header.appendChild(close);
    shell.appendChild(header);

    const body = el(doc, "div");
    body.className = "confucius-knowledge-body";
    body.appendChild(renderKnowledgeTopics());
    body.appendChild(renderKnowledgeEntries());
    body.appendChild(renderKnowledgeEditor());
    shell.appendChild(body);
    root.appendChild(overlay);
    const editor = knowledgeEditor();
    if (editor) {
      editor.dataset.viewKey = `${knowledgeUi.baseId}:${knowledgeUi.editor}:${knowledgeUi.entryId}:${knowledgeUi.creatingBase}`;
      if (editor.querySelector("input"))
        knowledgeDrafts.restore(editor, editor.dataset.viewKey);
    }
    for (const pane of Array.from(
      overlay.querySelectorAll("[data-view-key]"),
    ) as HTMLElement[]) {
      pane.scrollTop = knowledgeScrolls.get(pane.dataset.viewKey!) ?? 0;
    }
    const restore =
      previousKey === editor?.dataset.viewKey && focusId
        ? (doc.getElementById(focusId) as HTMLInputElement | null)
        : null;
    const focusTarget = restore?.getClientRects().length
      ? restore
      : knowledgeUi.stage === "topics"
        ? doc.getElementById("confucius-kb-topic-search")
        : knowledgeUi.stage === "entries"
          ? doc.getElementById("confucius-kb-entry-search")
          : (editor?.querySelector<HTMLElement>("input, button") ?? close);
    (focusTarget as HTMLElement | null)?.focus({ preventScroll: true });
    if (
      restore &&
      restore === focusTarget &&
      selection &&
      selection[0] !== null
    ) {
      try {
        restore.setSelectionRange(selection[0], selection[1] ?? selection[0]);
      } catch {
        /* Number inputs have no caret. */
      }
    }
  }

  function sectionLabel(text: string): HTMLElement {
    const label = el(doc, "div");
    label.className = "confucius-kb-section-label";
    label.textContent = text;
    return label;
  }

  function renderKnowledgeTopics(): HTMLElement {
    const pane = el(doc, "aside");
    pane.className = "confucius-knowledge-pane confucius-knowledge-topics";
    pane.dataset.viewKey = "topics";
    const toolbar = el(doc, "div");
    toolbar.className = "confucius-kb-toolbar";
    const search = el(doc, "input", undefined, {
      id: "confucius-kb-topic-search",
      type: "search",
      placeholder: getString("workspace-knowledge-search-topics"),
      "aria-label": getString("workspace-knowledge-search-topics"),
    }) as HTMLInputElement;
    const add = button(doc, "confucius-kb-add-base", "+");
    add.setAttribute("aria-label", getString("workspace-knowledge-new"));
    add.setAttribute("title", getString("workspace-knowledge-new"));
    add.style.width = "34px";
    add.style.padding = "4px";
    add.addEventListener("click", () => {
      knowledgeLoadGeneration += 1;
      knowledgeUi.creatingBase = true;
      knowledgeUi.editor = "base";
      knowledgeUi.stage = "editor";
      knowledgeUi.entryId = "";
      renderKnowledgeWindow();
    });
    toolbar.appendChild(search);
    toolbar.appendChild(add);
    pane.appendChild(toolbar);
    pane.appendChild(sectionLabel(getString("workspace-knowledge-topics")));

    const list = el(doc, "div");
    list.className = "confucius-kb-topic-list";
    if (knowledgeUi.loading) {
      list.appendChild(muted(doc, getString("workspace-knowledge-loading")));
    } else if (!knowledgeUi.bases.length) {
      list.appendChild(muted(doc, getString("workspace-knowledge-no-topics")));
    }
    for (const base of knowledgeUi.bases) {
      const row = el(doc, "button", undefined, {
        id: `confucius-kb-topic-${base.id}`,
        type: "button",
        "data-search":
          `${base.title} ${base.description} ${base.tags.join(" ")}`.toLowerCase(),
      });
      row.className = `confucius-kb-row${
        base.id === knowledgeUi.baseId ? " active" : ""
      }`;
      const title = el(doc, "div", { fontWeight: "650" });
      title.textContent = base.title;
      const meta = el(doc, "div");
      meta.className = "confucius-kb-meta";
      meta.textContent = `${base.entryCount} ${getString("workspace-knowledge-items")}`;
      row.appendChild(title);
      row.appendChild(meta);
      row.addEventListener("click", () => void loadKnowledgeBase(base.id));
      list.appendChild(row);
    }
    search.value = knowledgeUi.topicQuery;
    const filterTopics = () => {
      knowledgeUi.topicQuery = search.value;
      const query = search.value.trim().toLowerCase();
      for (const row of Array.from(
        list.querySelectorAll("[data-search]"),
      ) as HTMLElement[]) {
        row.style.display =
          !query || (row.dataset.search ?? "").includes(query) ? "" : "none";
      }
    };
    search.addEventListener("input", filterTopics);
    filterTopics();
    pane.appendChild(list);

    const memories = el(doc, "details");
    memories.className = "confucius-kb-memories";
    if (knowledgeUi.memoriesOpen) memories.setAttribute("open", "");
    const memoryHeading = el(doc, "summary");
    memoryHeading.textContent = `${getString("workspace-memory")} · ${state.memories.length}`;
    memories.appendChild(memoryHeading);
    memories.addEventListener("toggle", () => {
      knowledgeUi.memoriesOpen = memories.hasAttribute("open");
    });
    if (state.logCount > 0) {
      memories.appendChild(
        muted(doc, `${state.logCount} ${getString("workspace-session-logs")}`),
      );
    }
    if (!state.memories.length) {
      memories.appendChild(muted(doc, getString("workspace-no-memory")));
    }
    for (const memory of state.memories) {
      const card = el(doc, "div");
      card.className = "confucius-kb-memory";
      const memoryTitle = el(doc, "div", {
        fontSize: "11px",
        color: "#33302a",
        fontWeight: "700",
      });
      const tags = memory.tags ?? [];
      const pinned = tags.includes("confucius:pinned");
      const fromLog = tags.includes("promoted-from-log");
      memoryTitle.textContent = `${pinned ? "★ " : ""}[${memory.type}] ${durableExcerpt(memory.title)}${
        fromLog ? ` · ${getString("workspace-memory-from-log")}` : ""
      }`;
      const memoryBody = el(doc, "div", { fontSize: "12px" });
      fillAnswerHtml(memoryBody, durableExcerpt(memory.content));
      const del = el(
        doc,
        "button",
        {
          border: "none",
          background: "transparent",
          color: "#b3452f",
          cursor: "pointer",
          font: "inherit",
          fontSize: "11px",
          padding: "0",
        },
        { type: "button" },
      );
      del.textContent = getString("workspace-memory-delete");
      del.addEventListener("click", () => {
        void (async () => {
          await rpc("memory/delete", { id: memory.id });
          await refreshMemories();
          renderKnowledgeWindow();
          renderLists();
        })();
      });
      card.appendChild(memoryTitle);
      card.appendChild(memoryBody);
      card.appendChild(del);
      memories.appendChild(card);
    }
    pane.appendChild(memories);
    return pane;
  }

  function renderKnowledgeEntries(): HTMLElement {
    const pane = el(doc, "main");
    pane.className = "confucius-knowledge-pane confucius-knowledge-entries";
    pane.dataset.viewKey = `entries:${knowledgeUi.baseId}`;
    if (!knowledgeUi.base) {
      const empty = el(doc, "div");
      empty.className = "confucius-kb-empty";
      empty.textContent = getString("workspace-knowledge-create-first");
      pane.appendChild(empty);
      return pane;
    }
    const titleRow = el(doc, "div", {
      display: "flex",
      gap: "8px",
      alignItems: "flex-start",
      marginBottom: "10px",
    });
    const titleCopy = el(doc, "div", { flex: "1", minWidth: "0" });
    const title = el(doc, "div", {
      fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif',
      fontSize: "18px",
      fontWeight: "700",
    });
    title.textContent = knowledgeUi.base.title;
    const description = el(doc, "div", {
      marginTop: "3px",
      color: "#6b665c",
      fontSize: "12px",
      lineHeight: "1.45",
    });
    description.textContent =
      knowledgeUi.base.description ||
      getString("workspace-knowledge-no-description");
    titleCopy.appendChild(title);
    titleCopy.appendChild(description);
    const editBase = button(
      doc,
      "confucius-kb-edit-base",
      getString("workspace-knowledge-edit-topic"),
    );
    editBase.style.background = "#ffffff";
    editBase.style.padding = "4px 8px";
    editBase.addEventListener("click", () => {
      knowledgeLoadGeneration += 1;
      knowledgeUi.creatingBase = false;
      knowledgeUi.editor = "base";
      knowledgeUi.stage = "editor";
      knowledgeUi.entryId = "";
      renderKnowledgeWindow();
    });
    titleRow.appendChild(titleCopy);
    titleRow.appendChild(editBase);
    pane.appendChild(titleRow);

    const filters = el(doc, "div");
    filters.className = "confucius-kb-filters";
    const choices: Array<"all" | KnowledgeEntryKind> = [
      "all",
      ...knowledgeKinds,
    ];
    for (const choice of choices) {
      const filter = el(doc, "button", undefined, { type: "button" });
      filter.className = `confucius-kb-filter${
        knowledgeUi.filter === choice ? " active" : ""
      }`;
      const count =
        choice === "all"
          ? knowledgeUi.base.entryCount
          : (knowledgeUi.base.counts[choice] ?? 0);
      if (choice !== "all" && count === 0 && knowledgeUi.filter !== choice)
        continue;
      filter.textContent = `${
        choice === "all"
          ? getString("workspace-knowledge-kind-all")
          : knowledgeKindLabel(choice)
      } ${count}`;
      filter.addEventListener("click", () => {
        knowledgeUi.filter = choice;
        renderKnowledgeWindow();
      });
      filters.appendChild(filter);
    }
    pane.appendChild(filters);

    const toolbar = el(doc, "div");
    toolbar.className = "confucius-kb-toolbar";
    const search = el(doc, "input", undefined, {
      id: "confucius-kb-entry-search",
      type: "search",
      placeholder: getString("workspace-knowledge-search-entries"),
      "aria-label": getString("workspace-knowledge-search-entries"),
    }) as HTMLInputElement;
    const add = button(
      doc,
      "confucius-kb-add-entry",
      getString("workspace-knowledge-add-entry"),
    );
    add.addEventListener("click", () => {
      knowledgeLoadGeneration += 1;
      knowledgeUi.entryId = "";
      knowledgeUi.editor = "entry";
      knowledgeUi.stage = "editor";
      knowledgeUi.entryEditing = true;
      renderKnowledgeWindow();
    });
    toolbar.appendChild(search);
    toolbar.appendChild(add);
    pane.appendChild(toolbar);

    const list = el(doc, "div");
    const entries = knowledgeUi.base.entries.filter(
      (entry) =>
        knowledgeUi.filter === "all" || entry.kind === knowledgeUi.filter,
    );
    if (!entries.length) {
      list.appendChild(muted(doc, getString("workspace-knowledge-no-entries")));
    }
    for (const entry of entries) {
      const row = el(doc, "button", undefined, {
        id: `confucius-kb-entry-${entry.id}`,
        type: "button",
        "data-search":
          `${entry.title} ${entry.content} ${entry.tags.join(" ")}`.toLowerCase(),
      });
      row.className = `confucius-kb-entry-row${
        entry.id === knowledgeUi.entryId ? " active" : ""
      }`;
      const kind = el(doc, "div", {
        color: "#33302a",
        fontSize: "10px",
        fontWeight: "700",
        letterSpacing: ".08em",
        textTransform: "uppercase",
      });
      kind.textContent = knowledgeKindLabel(entry.kind);
      const entryTitle = el(doc, "div", {
        marginTop: "2px",
        fontWeight: "650",
      });
      entryTitle.textContent = entry.title;
      const excerpt = el(doc, "div");
      excerpt.className = "confucius-kb-meta";
      excerpt.textContent = entry.content
        .replace(/[#*_`>|]/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 90);
      row.appendChild(kind);
      row.appendChild(entryTitle);
      row.appendChild(excerpt);
      row.addEventListener("click", () => {
        knowledgeLoadGeneration += 1;
        knowledgeUi.entryId = entry.id;
        knowledgeUi.editor = "entry";
        knowledgeUi.stage = "editor";
        knowledgeUi.entryEditing = false;
        renderKnowledgeWindow();
      });
      list.appendChild(row);
    }
    search.value = knowledgeUi.entryQuery;
    const filterEntries = () => {
      knowledgeUi.entryQuery = search.value;
      const query = search.value.trim().toLowerCase();
      for (const row of Array.from(
        list.querySelectorAll("[data-search]"),
      ) as HTMLElement[]) {
        row.style.display =
          !query || (row.dataset.search ?? "").includes(query) ? "" : "none";
      }
    };
    search.addEventListener("input", filterEntries);
    filterEntries();
    pane.appendChild(list);
    return pane;
  }

  function kbField(labelText: string, control: HTMLElement): HTMLElement {
    const label = el(doc, "label");
    label.className = "confucius-kb-field";
    const caption = el(doc, "span");
    caption.textContent = labelText;
    label.appendChild(caption);
    label.appendChild(control);
    return label;
  }

  function renderKnowledgeEditor(): HTMLElement {
    const pane = el(doc, "section");
    pane.className = "confucius-knowledge-pane confucius-knowledge-editor";
    if (knowledgeUi.error) {
      const error = el(doc, "div");
      error.className = "confucius-kb-error";
      error.textContent = knowledgeUi.error;
      pane.appendChild(error);
    }
    if (knowledgeUi.editor === "base") {
      pane.appendChild(renderKnowledgeBaseForm());
      return pane;
    }
    if (knowledgeUi.editor === "entry" && knowledgeUi.base) {
      const entry = knowledgeUi.base.entries.find(
        (item) => item.id === knowledgeUi.entryId,
      );
      if (entry && !knowledgeUi.entryEditing) {
        const actions = el(doc, "div");
        actions.className = "confucius-kb-editor-actions";
        actions.appendChild(sectionLabel(knowledgeKindLabel(entry.kind)));
        const edit = button(
          doc,
          "confucius-kb-edit-entry",
          getString("workspace-knowledge-edit-entry"),
        );
        edit.addEventListener("click", () => {
          knowledgeUi.entryEditing = true;
          renderKnowledgeWindow();
        });
        actions.appendChild(edit);
        const title = el(doc, "h2", {
          margin: "0 0 20px",
          fontSize: "1.5em",
          lineHeight: "1.3",
          overflowWrap: "anywhere",
        });
        title.textContent = entry.title;
        pane.append(
          actions,
          title,
          renderReadingSurface(
            doc,
            { type: "markdown", markdown: entry.content },
            { fillAnswerHtml, locateLink },
          ),
        );
        if (entry.source)
          pane.appendChild(
            locateLink(doc, {
              libraryID: entry.source.libraryID,
              key: entry.source.key,
            }),
          );
        return pane;
      }
      pane.appendChild(renderKnowledgeEntryForm());
      return pane;
    }
    const empty = el(doc, "div");
    empty.className = "confucius-kb-empty";
    empty.textContent = getString("workspace-knowledge-select-entry");
    pane.appendChild(empty);
    return pane;
  }

  function renderKnowledgeBaseForm(): HTMLElement {
    const wrap = el(doc, "div");
    wrap.appendChild(
      sectionLabel(
        knowledgeUi.creatingBase
          ? getString("workspace-knowledge-new")
          : getString("workspace-knowledge-edit-topic"),
      ),
    );
    const current = knowledgeUi.creatingBase ? null : knowledgeUi.base;
    const title = el(doc, "input", undefined, {
      id: "confucius-kb-base-title",
      type: "text",
      value: current?.title ?? "",
      placeholder: getString("workspace-knowledge-topic-title-placeholder"),
    }) as HTMLInputElement;
    const description = el(doc, "textarea", undefined, {
      id: "confucius-kb-base-description",
      placeholder: getString(
        "workspace-knowledge-topic-description-placeholder",
      ),
    }) as HTMLTextAreaElement;
    description.value = current?.description ?? "";
    description.style.minHeight = "110px";
    const tags = el(doc, "input", undefined, {
      id: "confucius-kb-base-tags",
      type: "text",
      value: current?.tags.join(", ") ?? "",
      placeholder: getString("workspace-knowledge-tags-placeholder"),
    }) as HTMLInputElement;
    wrap.appendChild(kbField(getString("workspace-knowledge-title"), title));
    wrap.appendChild(
      kbField(getString("workspace-knowledge-description"), description),
    );
    wrap.appendChild(kbField(getString("workspace-knowledge-tags"), tags));
    const actions = el(doc, "div");
    actions.className = "confucius-kb-actions";
    const save = button(
      doc,
      "confucius-kb-save-base",
      getString("workspace-knowledge-save"),
      "primary",
    );
    save.addEventListener("click", async () => {
      if (!title.value.trim()) {
        showKnowledgeError(getString("workspace-knowledge-title-required"));
        return;
      }
      save.setAttribute("disabled", "true");
      try {
        const payload = {
          title: title.value.trim(),
          description: description.value.trim(),
          tags: splitTags(tags.value),
        };
        const result = (await rpc(
          knowledgeUi.creatingBase ? "knowledge/create" : "knowledge/update",
          knowledgeUi.creatingBase
            ? payload
            : { ...payload, id: knowledgeUi.baseId },
        )) as { knowledgeBase?: KnowledgeBaseRow };
        clearKnowledgeDraft();
        knowledgeUi.creatingBase = false;
        await refreshKnowledgeBases(
          result.knowledgeBase?.id ?? knowledgeUi.baseId,
        );
        knowledgeUi.editor = "base";
        renderKnowledgeWindow();
      } catch (error) {
        showKnowledgeError(
          error instanceof Error ? error.message : String(error),
        );
        save.removeAttribute("disabled");
      }
    });
    actions.appendChild(save);
    if (current) {
      const remove = button(
        doc,
        "confucius-kb-delete-base",
        getString("workspace-knowledge-delete-topic"),
      );
      remove.className = "confucius-kb-danger";
      remove.addEventListener("click", async () => {
        if (
          !win?.confirm(getString("workspace-knowledge-delete-topic-confirm"))
        ) {
          return;
        }
        await rpc("knowledge/delete", { id: current.id });
        await refreshKnowledgeBases();
        renderKnowledgeWindow();
      });
      actions.appendChild(remove);
    }
    wrap.appendChild(actions);
    return wrap;
  }

  function renderKnowledgeEntryForm(): HTMLElement {
    const wrap = el(doc, "div");
    const current =
      knowledgeUi.base?.entries.find(
        (entry) => entry.id === knowledgeUi.entryId,
      ) ?? null;
    wrap.appendChild(
      sectionLabel(
        current
          ? getString("workspace-knowledge-edit-entry")
          : getString("workspace-knowledge-add-entry"),
      ),
    );
    let selectedKind: KnowledgeEntryKind = current?.kind ?? "note";
    const kind = el(doc, "div", undefined, {
      id: "confucius-kb-entry-kind",
      role: "radiogroup",
      "aria-label": getString("workspace-knowledge-kind"),
    });
    kind.className = "confucius-kb-filters";
    const kindButtons = new Map<KnowledgeEntryKind, HTMLElement>();
    const paintKinds = () => {
      for (const [choice, option] of kindButtons) {
        const active = choice === selectedKind;
        option.className = `confucius-kb-filter${active ? " active" : ""}`;
        option.setAttribute("aria-checked", active ? "true" : "false");
      }
    };
    for (const choice of knowledgeKinds) {
      const option = el(doc, "button", undefined, {
        type: "button",
        role: "radio",
        "data-value": choice,
      });
      option.textContent = knowledgeKindLabel(choice);
      option.addEventListener("click", () => {
        selectedKind = choice;
        paintKinds();
        syncKind();
      });
      kindButtons.set(choice, option);
      kind.appendChild(option);
    }
    paintKinds();
    const title = el(doc, "input", undefined, {
      id: "confucius-kb-entry-title",
      type: "text",
      value: current?.title ?? "",
      placeholder: getString("workspace-knowledge-entry-title-placeholder"),
    }) as HTMLInputElement;
    const tags = el(doc, "input", undefined, {
      id: "confucius-kb-entry-tags",
      type: "text",
      value: current?.tags.join(", ") ?? "",
      placeholder: getString("workspace-knowledge-tags-placeholder"),
    }) as HTMLInputElement;
    const source = el(doc, "div", {
      display: "grid",
      gridTemplateColumns: "minmax(0, .55fr) minmax(0, 1fr)",
      gap: "8px",
    });
    source.id = "confucius-kb-source-fields";
    const libraryID = el(doc, "input", undefined, {
      type: "number",
      min: "1",
      value: current?.source ? String(current.source.libraryID) : "",
      id: "confucius-kb-source-library",
      placeholder: "libraryID",
      "aria-label": "Zotero libraryID",
    }) as HTMLInputElement;
    const key = el(doc, "input", undefined, {
      type: "text",
      value: current?.source?.key ?? "",
      id: "confucius-kb-source-key",
      placeholder: "Zotero key",
      "aria-label": "Zotero key",
    }) as HTMLInputElement;
    source.appendChild(libraryID);
    source.appendChild(key);
    const content = el(doc, "textarea", undefined, {
      id: "confucius-kb-entry-content",
      placeholder: getString("workspace-knowledge-content-placeholder"),
    }) as HTMLTextAreaElement;
    content.value = current?.content ?? "";
    const kindField = el(doc, "div");
    kindField.className = "confucius-kb-field";
    const kindCaption = el(doc, "span");
    kindCaption.textContent = getString("workspace-knowledge-kind");
    kindField.appendChild(kindCaption);
    kindField.appendChild(kind);
    wrap.appendChild(kindField);
    wrap.appendChild(kbField(getString("workspace-knowledge-title"), title));
    wrap.appendChild(kbField(getString("workspace-knowledge-tags"), tags));
    const sourceField = kbField(
      getString("workspace-knowledge-paper-source"),
      source,
    );
    wrap.appendChild(sourceField);
    const contentField = kbField(
      getString("workspace-knowledge-content"),
      content,
    );
    const mindWorkspace = el(doc, "div");
    mindWorkspace.className = "confucius-mindmap-workspace";
    const preview = el(doc, "div", undefined, {
      id: "confucius-mindmap-preview",
    });
    preview.className = "confucius-mindmap-preview";
    const paintPreview = () => {
      preview.textContent = "";
      const nodes = parseMindMapOutline(content.value);
      if (!nodes.length) {
        preview.appendChild(
          muted(doc, getString("workspace-knowledge-mindmap-empty")),
        );
      } else {
        appendMindMapTree(preview, nodes);
      }
    };
    content.addEventListener("input", paintPreview);
    mindWorkspace.appendChild(contentField);
    mindWorkspace.appendChild(preview);
    const mdPreview = el(doc, "div");
    mdPreview.className = "confucius-kb-md-preview";
    const previewCaption = el(doc, "div");
    previewCaption.className = "confucius-kb-section-label";
    previewCaption.textContent = getString("workspace-knowledge-preview");
    const paintMarkdownPreview = () => {
      const hidden = selectedKind === "mindmap" || !content.value.trim();
      previewCaption.style.display = hidden ? "none" : "";
      mdPreview.style.display = hidden ? "none" : "";
      if (!hidden) {
        fillAnswerHtml(mdPreview, content.value);
      }
    };
    content.addEventListener("input", paintMarkdownPreview);
    const syncKind = () => {
      const isPaper = selectedKind === "paper";
      const isMindMap = selectedKind === "mindmap";
      sourceField.style.display = isPaper ? "grid" : "none";
      mindWorkspace.style.display = isMindMap ? "grid" : "block";
      contentField.style.display = "grid";
      preview.style.display = isMindMap ? "block" : "none";
      if (isMindMap) paintPreview();
      paintMarkdownPreview();
    };
    wrap.appendChild(mindWorkspace);
    const previewDisclosure = el(doc, "details");
    previewDisclosure.className = "confucius-settings-advanced";
    const previewSummary = el(doc, "summary");
    previewSummary.textContent = getString("workspace-knowledge-preview");
    previewDisclosure.append(previewSummary, mdPreview);
    wrap.appendChild(previewDisclosure);
    syncKind();

    const actions = el(doc, "div");
    actions.className = "confucius-kb-actions";
    const save = button(
      doc,
      "confucius-kb-save-entry",
      getString("workspace-knowledge-save"),
      "primary",
    );
    save.addEventListener("click", async () => {
      if (!title.value.trim() || !content.value.trim()) {
        showKnowledgeError(getString("workspace-knowledge-entry-required"));
        return;
      }
      save.setAttribute("disabled", "true");
      try {
        const result = (await rpc("knowledge/saveEntry", {
          id: current?.id,
          knowledgeBaseId: knowledgeUi.baseId,
          kind: selectedKind,
          title: title.value.trim(),
          content: content.value.trim(),
          tags: splitTags(tags.value),
          libraryID: Number(libraryID.value) || undefined,
          key: key.value.trim() || undefined,
          clearSource:
            selectedKind !== "paper" ||
            !Number(libraryID.value) ||
            !key.value.trim(),
        })) as { entry?: KnowledgeEntryRow };
        clearKnowledgeDraft();
        await loadKnowledgeBase(knowledgeUi.baseId, false);
        knowledgeUi.entryId = result.entry?.id ?? "";
        knowledgeUi.editor = "entry";
        knowledgeUi.entryEditing = false;
        const list = (await rpc("knowledge/list", { limit: 200 })) as {
          knowledgeBases?: KnowledgeBaseRow[];
        };
        knowledgeUi.bases = list.knowledgeBases ?? knowledgeUi.bases;
        renderKnowledgeWindow();
      } catch (error) {
        showKnowledgeError(
          error instanceof Error ? error.message : String(error),
        );
        save.removeAttribute("disabled");
      }
    });
    actions.appendChild(save);
    if (current) {
      const remove = button(
        doc,
        "confucius-kb-delete-entry",
        getString("workspace-knowledge-delete-entry"),
      );
      remove.className = "confucius-kb-danger";
      remove.addEventListener("click", async () => {
        if (
          !win?.confirm(getString("workspace-knowledge-delete-entry-confirm"))
        ) {
          return;
        }
        await rpc("knowledge/deleteEntry", {
          knowledgeBaseId: knowledgeUi.baseId,
          id: current.id,
        });
        await loadKnowledgeBase(knowledgeUi.baseId, false);
        knowledgeUi.entryId = "";
        knowledgeUi.editor = "base";
        renderKnowledgeWindow();
      });
      actions.appendChild(remove);
    }
    wrap.appendChild(actions);
    return wrap;
  }

  function appendMindMapTree(parent: HTMLElement, nodes: MindMapNode[]): void {
    const list = el(doc, "ul");
    for (const node of nodes) {
      const item = el(doc, "li");
      if (node.children.length) {
        const details = el(doc, "details", undefined, { open: "" });
        const summary = el(doc, "summary");
        summary.textContent = node.label;
        details.appendChild(summary);
        appendMindMapTree(details, node.children);
        item.appendChild(details);
      } else {
        item.textContent = node.label;
      }
      list.appendChild(item);
    }
    parent.appendChild(list);
  }

  function splitTags(value: string): string[] {
    return value
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  function showKnowledgeError(message: string): void {
    knowledgeUi.error = message;
    const current = doc.querySelector(
      ".confucius-knowledge-editor .confucius-kb-error",
    );
    if (current) {
      current.textContent = message;
      return;
    }
    const error = el(doc, "div");
    error.className = "confucius-kb-error";
    error.textContent = message;
    doc.querySelector(".confucius-knowledge-editor")?.prepend(error);
  }

  function renderUserLine(targetDoc: Document, text: string): HTMLElement {
    const row = el(targetDoc, "div");
    row.className = "confucius-user-message";
    row.textContent = text;
    return row;
  }

  async function copyAnswerText(
    targetDoc: Document,
    text: string,
  ): Promise<void> {
    try {
      Zotero.Utilities.Internal.copyTextToClipboard(text);
      return;
    } catch {
      // Test pages and some unprivileged views do not expose Zotero globals.
    }
    const clipboard = targetDoc.defaultView?.navigator.clipboard;
    if (!clipboard) throw new Error("Clipboard is unavailable");
    await clipboard.writeText(text);
  }

  function flashReplyAction(
    action: HTMLButtonElement,
    kind: "copy" | "branch" | "note",
    label: string,
  ): void {
    const actionDoc = action.ownerDocument ?? doc;
    action.setAttribute("data-state", "success");
    action.setAttribute("title", getString("workspace-reply-done"));
    action.setAttribute("aria-label", getString("workspace-reply-done"));
    action.replaceChildren(replyActionIcon(actionDoc, "check"));
    actionDoc.defaultView?.setTimeout(() => {
      if (!action.isConnected) return;
      action.removeAttribute("data-state");
      action.setAttribute("title", label);
      action.setAttribute("aria-label", label);
      action.replaceChildren(replyActionIcon(actionDoc, kind));
    }, 1_200);
  }

  function renderAnswer(
    targetDoc: Document,
    text: string,
    turnId?: string,
  ): HTMLElement {
    const shell = tuiBlock(targetDoc, {
      color: "#33302a",
      fontSize: "1.08em",
      lineHeight: "1.7",
      margin: "6px 0 14px",
      padding: "2px 4px",
      maxWidth: "78ch",
    });
    shell.classList.add("confucius-answer-shell");
    if (turnId) shell.setAttribute("data-turn-id", turnId);
    const body = el(targetDoc, "div");
    body.classList.add("tui-answer");
    fillAnswerHtml(body, text);
    shell.appendChild(body);

    const actions = el(targetDoc, "div", undefined, {
      role: "group",
      "aria-label": getString("workspace-reply-actions"),
    });
    actions.className = "confucius-answer-actions";
    const actionButton = (
      kind: "copy" | "branch" | "note",
      label: string,
      onClick: (button: HTMLButtonElement) => void,
      disabled = false,
    ): HTMLButtonElement => {
      const action = el(targetDoc, "button", undefined, {
        type: "button",
        title: label,
        "aria-label": label,
        "data-action": kind,
      }) as HTMLButtonElement;
      action.className = "confucius-answer-action";
      action.disabled = disabled;
      action.appendChild(replyActionIcon(targetDoc, kind));
      action.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!action.disabled) onClick(action);
      });
      actions.appendChild(action);
      return action;
    };

    const copyLabel = getString("workspace-reply-copy");
    actionButton("copy", copyLabel, (action) => {
      action.disabled = true;
      void copyAnswerText(targetDoc, text)
        .then(() => flashReplyAction(action, "copy", copyLabel))
        .catch((error) => {
          state.sendError =
            error instanceof Error ? error.message : String(error);
          renderLists();
        })
        .finally(() => {
          if (action.isConnected) action.disabled = false;
        });
    });

    const turnFinished = Boolean(
      turnId &&
      state.events.some(
        (event) =>
          event.turnId === turnId &&
          (event.type === "turn_completed" ||
            event.type === "turn_failed" ||
            event.type === "turn_aborted"),
      ),
    );
    const branchLabel = turnFinished
      ? getString("workspace-reply-branch")
      : getString("workspace-reply-branch-wait");
    actionButton(
      "branch",
      branchLabel,
      (action) => {
        const source = currentTask();
        if (!source || !turnId) return;
        action.disabled = true;
        void (async () => {
          try {
            const branched = (await rpc("task/branch", {
              taskId: source.id,
              throughTurnId: turnId,
              title: `${source.title || getString("workspace-untitled-task")} · ${getString("workspace-reply-branch-suffix")}`,
            })) as ResearchTaskRecord;
            await refreshSessions();
            await loadTask(branched.id);
            renderLists();
            prompt.focus();
          } catch (error) {
            state.sendError =
              error instanceof Error ? error.message : String(error);
            renderLists();
          } finally {
            if (action.isConnected) action.disabled = false;
          }
        })();
      },
      !turnFinished,
    );

    const noteLabel = getString("workspace-reply-note");
    actionButton(
      "note",
      noteLabel,
      (action) => {
        const taskId = state.sessionId;
        if (!taskId || !turnId) return;
        action.disabled = true;
        void rpc("note/propose-from-reply", { taskId, turnId, text })
          .then(async () => {
            flashReplyAction(action, "note", noteLabel);
            await poll();
          })
          .catch((error) => {
            state.sendError =
              error instanceof Error ? error.message : String(error);
            renderLists();
          })
          .finally(() => {
            if (action.isConnected) action.disabled = false;
          });
      },
      !turnId,
    );
    shell.appendChild(actions);
    return shell;
  }

  function renderReasoning(
    targetDoc: Document,
    text: string,
    key: string,
  ): HTMLElement {
    const fold = reasoningFold.get(key) ?? "preview";
    const row = tuiBlock(targetDoc, {
      color: "#7b766b",
      fontSize: "0.93em",
      cursor: "pointer",
      margin: "0 0 8px",
      padding: "0 4px",
    });
    const head = el(targetDoc, "div", {
      fontSize: "0.85em",
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      color: "#70695f",
      marginBottom: "2px",
    });
    head.textContent = `${fold === "open" ? "▾" : "▸"} ${getString("workspace-tui-thinking")}`;
    const clamp =
      fold === "preview" ? "4.4em" : fold === "compact" ? "1.45em" : "";
    const body = el(targetDoc, "div", {
      overflow: clamp ? "hidden" : "visible",
      maxHeight: clamp || "",
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end",
    });
    if (clamp) {
      const fade = "linear-gradient(180deg, transparent 0%, #000 45%)";
      body.style.setProperty("-webkit-mask-image", fade);
      body.style.setProperty("mask-image", fade);
    }
    const inner = el(targetDoc, "div", { whiteSpace: "pre-wrap" });
    inner.textContent = text;
    body.appendChild(inner);
    row.appendChild(head);
    row.appendChild(body);
    row.addEventListener("click", () => {
      reasoningFold.set(key, nextReasoningFold(fold));
      renderLists();
    });
    return row;
  }

  function renderWaiting(
    targetDoc: Document,
    events: ConfuciusEvent[],
  ): HTMLElement {
    const wrap = tuiBlock(targetDoc, { margin: "10px 0 4px" });
    const label = el(targetDoc, "div");
    label.className = "tui-waiting";
    const mark = targetDoc.createElementNS(SVG_NS, "svg");
    mark.setAttribute("viewBox", "0 0 256 256");
    mark.setAttribute("aria-hidden", "true");
    mark.classList.add("tui-waiting-mark");
    const markPath = targetDoc.createElementNS(SVG_NS, "path");
    markPath.setAttribute(
      "d",
      "M200 76 A 90 90 0 1 0 200 180 Q 187 178 173 164 A 58 58 0 1 1 173 92 Q 187 80 200 76 Z",
    );
    markPath.setAttribute("fill", "currentColor");
    mark.appendChild(markPath);
    const text = el(targetDoc, "span");
    text.className = "tui-waiting-text";
    text.textContent = runningStageText(events);
    label.appendChild(mark);
    label.appendChild(text);
    wrap.appendChild(label);
    return wrap;
  }

  function locateLink(
    targetDoc: Document,
    target: LocateTarget,
    extraStyle?: Record<string, string>,
  ): HTMLElement {
    const link = el(
      targetDoc,
      "button",
      {
        border: "none",
        background: "transparent",
        color: "#b3452f",
        cursor: "pointer",
        font: "inherit",
        fontSize: "0.85em",
        padding: "0",
        ...(extraStyle || {}),
      },
      { type: "button" },
    );
    link.textContent = getString("workspace-locate");
    link.title = getString("workspace-ctx-open");
    link.addEventListener("click", (event) => {
      event.stopPropagation();
      void rpc("reader/open", {
        libraryID: target.libraryID,
        key: target.key,
        pageIndex: target.pageIndex,
        annotationKey: target.annotationKey,
      }).catch(() => {
        /* locate is cosmetic */
      });
    });
    return link;
  }

  function renderTools(
    targetDoc: Document,
    calls: TimelineToolCall[],
    key: string,
  ): HTMLElement {
    const open = toolsOpen.has(key);
    const wrap = tuiBlock(targetDoc, {
      color: "#7b766b",
      fontSize: "0.93em",
      fontFamily: UI_FONT_STACKS.mono,
      margin: "0 0 8px",
      background: "#efece4",
      borderRadius: "8px",
      padding: "6px 10px",
    });
    const head = el(targetDoc, "div", {
      cursor: "pointer",
      padding: "2px 0",
      marginBottom: "2px",
    });
    const names = toolsSummary(calls);
    head.textContent = `${open ? "▾" : "▸"} ${calls.length} ${getString("workspace-tui-tools")}${
      names ? `  ${names}` : ""
    }`;
    head.addEventListener("click", () => {
      if (open) {
        toolsOpen.delete(key);
      } else {
        toolsOpen.add(key);
      }
      renderLists();
    });
    wrap.appendChild(head);
    if (open) {
      for (const call of calls) {
        const expanded = toolOpen.has(call.callId);
        const line = el(targetDoc, "div", {
          cursor: "pointer",
          padding: "1px 0 1px 12px",
        });
        line.textContent = `${expanded ? "▾" : "▸"} ${call.toolName}  ${toolLineStatus(call)}`;
        line.addEventListener("click", (event) => {
          event.stopPropagation();
          if (expanded) {
            toolOpen.delete(call.callId);
          } else {
            toolOpen.add(call.callId);
          }
          renderLists();
        });
        wrap.appendChild(line);
        if (expanded) {
          const result = el(targetDoc, "pre", {
            margin: "2px 0 6px 24px",
            padding: "6px 8px",
            fontSize: "0.85em",
            color: "#555046",
            background: "#faf9f6",
            borderRadius: "6px",
            whiteSpace: "pre-wrap",
          });
          result.textContent = formatToolResult(call);
          wrap.appendChild(result);
          const locate =
            call.result && call.result.ok
              ? locateFromData(call.result.data)
              : null;
          if (locate) {
            wrap.appendChild(
              locateLink(targetDoc, locate, {
                display: "block",
                margin: "0 0 6px 24px",
              }),
            );
          }
        }
      }
    }
    return wrap;
  }

  function renderArtifactFileBlock(
    targetDoc: Document,
    summary: Extract<TimelineBlock, { kind: "artifact" }>["artifact"],
  ): HTMLElement {
    const record = state.artifacts.find((item) => item.id === summary.id);
    const revision =
      record?.revisions.find((item) => item.revision === summary.revision) ??
      record?.revisions.at(-1);
    const file = el(targetDoc, "button", undefined, {
      type: "button",
      "data-artifact-id": summary.id,
      "data-revision": String(summary.revision),
      "data-update": summary.revision > 1 ? "true" : "false",
      "aria-label": `${getString("workspace-artifact-open")}: ${summary.title}`,
    });
    file.className = "confucius-artifact-file";

    const icon = el(targetDoc, "span", undefined, { "aria-hidden": "true" });
    icon.className = "confucius-artifact-file-icon";
    icon.textContent = "≡";
    const copy = el(targetDoc, "span");
    copy.className = "confucius-artifact-file-copy";
    const kind = el(targetDoc, "span");
    kind.className = "confucius-artifact-file-kind";
    kind.textContent = `${artifactKindLabel(summary.kind)} · ${
      summary.revision > 1
        ? getString("workspace-artifact-updated")
        : getString("workspace-artifact-created")
    }`;
    const title = el(targetDoc, "span");
    title.className = "confucius-artifact-file-title";
    title.textContent = summary.title;
    const meta = el(targetDoc, "span");
    meta.className = "confucius-artifact-file-meta";
    const details = [`r${summary.revision}`];
    if (revision?.citations.length) {
      details.push(
        `${revision.citations.length} ${getString("workspace-artifact-citations")}`,
      );
    }
    if (summary.writeback?.state === "committed") {
      details.push(getString("workspace-writeback-committed"));
    }
    meta.textContent = details.join(" · ");
    copy.appendChild(kind);
    copy.appendChild(title);
    copy.appendChild(meta);
    const open = el(targetDoc, "span", undefined, { "aria-hidden": "true" });
    open.className = "confucius-artifact-file-open";
    open.textContent = `${getString("workspace-artifact-open")} →`;
    file.appendChild(icon);
    file.appendChild(copy);
    file.appendChild(open);

    file.addEventListener("click", () => {
      if (state.artifacts.some((item) => item.id === summary.id)) {
        openArtifactViewer(summary.id, summary.revision, file);
        return;
      }
      void refreshArtifacts(summary.taskId)
        .then(() => {
          if (state.artifacts.some((item) => item.id === summary.id)) {
            openArtifactViewer(summary.id, summary.revision, file);
          }
        })
        .catch((error) => {
          state.sendError =
            error instanceof Error ? error.message : String(error);
          renderLists();
        });
    });
    return file;
  }

  function renderTimelineBlock(
    targetDoc: Document,
    block: TimelineBlock,
    index: number,
  ): HTMLElement | null {
    if (block.kind === "user") {
      return renderUserLine(targetDoc, block.text);
    }
    if (block.kind === "text") {
      return renderAnswer(targetDoc, block.text, block.turnId);
    }
    if (block.kind === "reasoning") {
      return renderReasoning(targetDoc, block.text, `reasoning:${index}`);
    }
    if (block.kind === "tools") {
      const key = `tools:${block.calls[0]?.callId || index}`;
      return renderTools(targetDoc, block.calls, key);
    }
    if (block.kind === "artifact") {
      return renderArtifactFileBlock(targetDoc, block.artifact);
    }
    if (block.kind === "plan") {
      const plan = el(targetDoc, "div");
      plan.className = "confucius-plan";
      const heading = el(targetDoc, "div", {
        marginBottom: "4px",
        color: "#6b665c",
        fontSize: "11px",
        fontWeight: "700",
        textTransform: "uppercase",
      });
      heading.textContent = getString("workspace-activity-plan");
      plan.appendChild(heading);
      for (const step of block.steps) {
        const row = el(targetDoc, "div", {
          padding: "2px 0",
          color: step.status === "failed" ? "#b3452f" : "#4f4a42",
        });
        row.textContent = `${
          step.status === "done"
            ? "✓"
            : step.status === "running"
              ? "→"
              : step.status === "failed"
                ? "!"
                : "·"
        } ${step.label}`;
        plan.appendChild(row);
      }
      return plan;
    }
    if (block.kind === "command" || block.kind === "file") {
      const action = el(targetDoc, "div");
      action.className = "confucius-command";
      const heading = el(targetDoc, "div", {
        color:
          block.status === "failed" || block.status === "rejected"
            ? "#b3452f"
            : "#555046",
      });
      heading.textContent =
        block.kind === "command"
          ? `$ ${block.command} · ${block.status}`
          : `${block.path} · ${block.status}`;
      action.appendChild(heading);
      const detail = block.kind === "command" ? block.output : block.diff;
      if (detail) {
        const pre = el(targetDoc, "pre", {
          maxHeight: "180px",
          margin: "5px 0 0",
          overflowX: "scroll",
          overflowY: "auto",
          whiteSpace: "pre-wrap",
        });
        pre.textContent = detail;
        action.appendChild(pre);
      }
      return action;
    }
    const row = tuiBlock(targetDoc, {
      color: block.tone === "fail" ? "#8a2e1d" : "#7b766b",
      fontSize: "0.93em",
      padding: "0 4px",
    });
    row.textContent = block.text;
    return row;
  }

  function applyAppearance(): void {
    const font = isUiFont(state.config?.uiFont)
      ? state.config.uiFont
      : DEFAULT_UI_FONT;
    const size = clampUiFontSize(
      state.config?.uiFontSize ?? DEFAULT_UI_FONT_SIZE,
    );
    const lineHeight = isUiLineHeight(state.config?.uiLineHeight)
      ? state.config.uiLineHeight
      : DEFAULT_UI_LINE_HEIGHT;
    root.style.fontFamily = UI_FONT_STACKS[font];
    root.style.fontSize = `${size}px`;
    root.style.setProperty("--confucius-markdown-font-size", `${size}px`);
    root.style.setProperty(
      "--confucius-reading-line-height",
      String(UI_LINE_HEIGHT_VALUES[lineHeight]),
    );
  }

  function renderApprovalCard(
    targetDoc: Document,
    item: ApprovalRow,
  ): HTMLElement {
    const card = el(targetDoc, "section", undefined, {
      "aria-label": getString("workspace-awaiting-approval"),
    });
    card.className = "confucius-approval";
    const name = el(targetDoc, "div", {
      fontFamily: "ui-monospace, Consolas, monospace",
      fontSize: "11px",
      fontWeight: "600",
      letterSpacing: "0.04em",
      color: "#b05c2e",
    });
    name.textContent = item.toolName;
    // Default view: the tool plus the object it acts on. Raw args stay
    // behind the params toggle below.
    if (item.summary) {
      const summary = el(targetDoc, "div", {
        color: "#33302a",
        fontSize: "0.95em",
        lineHeight: "1.45",
        margin: "2px 0 0",
        overflowWrap: "anywhere",
      });
      summary.textContent = item.summary;
      card.appendChild(summary);
    }
    if (item.before !== undefined || item.after !== undefined) {
      const diff = el(targetDoc, "div");
      diff.className = "confucius-before-after";
      for (const [label, value] of [
        [getString("workspace-writeback-before"), item.before ?? ""],
        [getString("workspace-writeback-after"), item.after ?? ""],
      ]) {
        const column = el(targetDoc, "div");
        const heading = el(targetDoc, "div", {
          color: "#6b665c",
          fontSize: "10px",
          fontWeight: "700",
          letterSpacing: ".06em",
          textTransform: "uppercase",
        });
        heading.textContent = label;
        const content = el(targetDoc, "pre");
        content.textContent = value;
        column.appendChild(heading);
        column.appendChild(content);
        diff.appendChild(column);
      }
      card.appendChild(diff);
    }
    const actions = el(targetDoc, "div", {
      display: "flex",
      gap: "6px",
      marginTop: "6px",
    });
    const allow = button(
      targetDoc,
      "",
      getString("workspace-approval-allow-once"),
      "primary",
    );
    const always = button(
      targetDoc,
      "",
      getString("workspace-approval-allow-task"),
    );
    const deny = button(targetDoc, "", getString("workspace-approval-deny"));
    deny.style.background = "#ffffff";
    deny.style.border = "1px solid #b3452f";
    deny.style.color = "#b3452f";
    allow.addEventListener("click", () => {
      void resolveApproval(item.id, "allow", "once");
    });
    always.addEventListener("click", () => {
      void resolveApproval(item.id, "allow", "session");
    });
    deny.addEventListener("click", () => {
      void resolveApproval(item.id, "deny", "once");
    });
    actions.appendChild(allow);
    actions.appendChild(always);
    actions.appendChild(deny);
    card.appendChild(name);
    const approvalLocate = locateFromApproval(item.toolName, item.args);
    if (approvalLocate) {
      card.appendChild(
        locateLink(targetDoc, approvalLocate, {
          display: "block",
          margin: "4px 0 0",
        }),
      );
    }
    const paramsToggle = button(
      targetDoc,
      "",
      `${getString("workspace-approval-params")} ▸`,
    );
    paramsToggle.style.background = "transparent";
    paramsToggle.style.border = "none";
    paramsToggle.style.color = "#70695f";
    paramsToggle.style.fontSize = "11px";
    paramsToggle.style.padding = "2px 0";
    paramsToggle.style.marginTop = "4px";
    paramsToggle.style.display = "block";
    let paramsOpen = false;
    let paramsPre: HTMLElement | null = null;
    paramsToggle.addEventListener("click", () => {
      paramsOpen = !paramsOpen;
      paramsToggle.textContent = `${getString("workspace-approval-params")} ${
        paramsOpen ? "▾" : "▸"
      }`;
      if (paramsOpen && !paramsPre) {
        paramsPre = el(targetDoc, "pre", {
          whiteSpace: "pre-wrap",
          fontSize: "11px",
          margin: "2px 0 0",
        });
        paramsPre.textContent = JSON.stringify(item.args, null, 2);
        card.insertBefore(paramsPre, paramsToggle.nextSibling);
      } else if (paramsPre) {
        paramsPre.style.display = paramsOpen ? "" : "none";
      }
    });
    card.appendChild(paramsToggle);
    card.appendChild(actions);
    return card;
  }

  function currentTask(): ResearchTaskRecord | undefined {
    return state.sessions.find((item) => item.id === state.sessionId);
  }

  async function refreshArtifacts(taskId = state.sessionId): Promise<void> {
    if (!taskId) {
      state.artifacts = [];
      state.selectedArtifactId = null;
      state.selectedArtifactRevision = null;
      return;
    }
    try {
      const listed = (await rpc("artifact/list", { taskId })) as {
        artifacts?: ArtifactRecord[];
      };
      if (state.sessionId !== taskId) return;
      state.artifacts = listed.artifacts ?? [];
      const selected = state.artifacts.find(
        (artifact) => artifact.id === state.selectedArtifactId,
      );
      if (!selected) {
        state.selectedArtifactId = state.artifacts[0]?.id ?? null;
        state.selectedArtifactRevision = state.artifacts[0]?.revision ?? null;
      } else if (
        !selected.revisions.some(
          (revision) => revision.revision === state.selectedArtifactRevision,
        )
      ) {
        state.selectedArtifactRevision = selected.revision;
      }
    } catch {
      if (state.sessionId === taskId) state.artifacts = [];
    }
  }

  async function refreshRuntimes(force = false): Promise<void> {
    try {
      const listed = (await rpc(
        force ? "runtime/refresh" : "runtime/list",
        {},
      )) as RuntimeListResult;
      state.runtimeHostEnabled = listed.runtimeHostEnabled;
      state.runtimeHostConnected = listed.runtimeHostConnected;
      state.runtimes = listed.runtimes ?? [];
    } catch {
      state.runtimeHostConnected = false;
      state.runtimes = [];
    }
  }

  async function refreshMemoryProposals(): Promise<void> {
    try {
      const listed = (await rpc("memory/proposal/list", {})) as {
        proposals?: MemoryProposal[];
      };
      state.memoryProposals = listed.proposals ?? [];
    } catch {
      state.memoryProposals = [];
    }
  }

  function rememberComposerDraft(taskId = state.sessionId): void {
    composerDrafts.set(taskId ?? "new", prompt.value);
    referenceDrafts.set(taskId ?? "new", currentReferences());
    const previousSave = taskId ? draftSaves.get(taskId) : undefined;
    if (previousSave && win) win.clearTimeout(previousSave.timer);
    const text = prompt.value,
      references = currentReferences();
    if (!taskId) return;
    const save = () => {
      draftSaves.delete(taskId);
      pendingDraftSave = pendingDraftSave
        .catch(() => undefined)
        .then(() =>
          state.sessions.some((task) => task.id === taskId)
            ? rpc("task/draft", { taskId, text, references })
            : undefined,
        )
        .catch((error) => {
          state.sendError = String(error);
          renderLists();
        });
    };
    if (win) draftSaves.set(taskId, { timer: win.setTimeout(save, 250), save });
    else save();
  }

  function rememberTimelineViewport(taskId = renderedTimelineTaskId): void {
    if (!taskId) return;
    timelineViewports.set(taskId, {
      scrollTop: timelinePane.scrollTop,
      followsBottom:
        timelinePane.scrollHeight -
          timelinePane.scrollTop -
          timelinePane.clientHeight <
        96,
    });
  }

  async function loadTask(
    taskId: string,
    preserveModelMenu = false,
  ): Promise<void> {
    const generation = ++taskLoadGeneration;
    const previousTaskId = state.sessionId;
    const switching = previousTaskId !== taskId;
    if (switching) {
      if (!preserveModelMenu) closeEndpointMenu();
      closePlusMenu();
      doc.getElementById("confucius-source-menu")?.remove();
      rememberComposerDraft(previousTaskId);
      rememberTimelineViewport();
      closeArtifactViewer();
      clearPendingAttachments();
    }
    const [loaded, bundle] = (await Promise.all([
      rpc("task/load", { taskId }),
      rpc("task/events", { taskId }),
    ])) as [ResearchTaskRecord, { events?: ConfuciusEvent[] }];
    if (generation !== taskLoadGeneration) return;
    if (switching && state.sessionId === previousTaskId) {
      // The user may have kept typing or scrolling while the task loaded.
      rememberComposerDraft(previousTaskId);
      rememberTimelineViewport();
    }
    if (!composerDrafts.has(taskId))
      composerDrafts.set(taskId, loaded.draft?.text ?? "");
    if (!referenceDrafts.has(taskId))
      referenceDrafts.set(
        taskId,
        loaded.draft?.references ?? loaded.references ?? [],
      );
    state.sessionId = taskId;
    state.lastEventId = null;
    state.running = false;
    state.pendingUserText = "";
    state.sendError = "";
    state.selectedArtifactId = null;
    state.selectedArtifactRevision = null;
    if (switching || loadedComposerTaskId !== taskId) {
      loadedComposerTaskId = taskId;
      prompt.value = composerDrafts.get(taskId) ?? "";
      closeSlashMenu();
      closeMentionMenu();
    }
    const index = state.sessions.findIndex((item) => item.id === taskId);
    if (index >= 0) state.sessions[index] = loaded;
    else state.sessions.unshift(loaded);
    state.mode = loaded.mode === "plan" ? "plan" : "agent";
    state.permission =
      loaded.permissionMode === "auto_allow"
        ? "auto_allow"
        : loaded.permissionMode === "deny"
          ? "deny"
          : "ask";
    state.events = mergeEvents([], bundle.events ?? [], true);
    state.lastEventId = state.events.at(-1)?.id ?? null;
    state.running =
      loaded.status === "running" || loaded.status === "awaiting_approval";
    collectApprovals();
    await refreshArtifacts(taskId);
    if (generation !== taskLoadGeneration || state.sessionId !== taskId) return;
    syncModeButton();
    updateRunningUI();
  }

  async function createTask(
    options: {
      title?: string;
      context?: LockedContextSnapshot;
      backend?: AgentBackendKind;
      templateId?: string;
      prompt?: string;
      skillSlug?: string;
      preserveModelMenu?: boolean;
    } = {},
  ): Promise<ResearchTaskRecord> {
    const current = currentTask();
    const initialContext = pendingMentionItems.size
      ? contextWithPendingMentions(
          options.context ?? state.live?.lockedSnapshot,
        )
      : options.context;
    const created = (await rpc("task/new", {
      title: options.title ?? "Untitled research task",
      // With no explicit launch context, let AgentHost capture the live Zotero
      // state while handling this click's RPC. The polled value can lag a
      // reader-tab or item-selection change.
      context: initialContext,
      backend: options.backend ?? current?.backend ?? "native",
      mode: current?.mode ?? state.mode,
      activeKnowledgeBaseId: current?.activeKnowledgeBaseId,
      capabilityProfile: current?.capabilityProfile ?? "zotero_only",
      workingDirectory: current?.workingDirectory,
      confirmed: current?.capabilityProfile === "workspace",
      templateId: options.templateId,
      autoStart: false,
    })) as ResearchTaskRecord;
    state.sessions = [
      created,
      ...state.sessions.filter((row) => row.id !== created.id),
    ];
    pendingMentionItems.clear();
    await loadTask(created.id, options.preserveModelMenu);
    if (options.skillSlug) {
      await rpc("skill/activate", {
        sessionId: created.id,
        slug: options.skillSlug,
      });
    }
    if (current && created.permissionMode !== current.permissionMode) {
      await rpc("task/setPermissions", {
        taskId: created.id,
        permissionMode: current.permissionMode,
      });
    }
    return created;
  }

  function taskHasConversation(): boolean {
    return state.events.some((event) => event.type === "turn_started");
  }

  function localizedTemplateTitle(template: TaskTemplate): string {
    return getString(`workspace-template-${template.id}`);
  }

  function localizedTemplatePrompt(template: TaskTemplate): string {
    return getString(`workspace-template-${template.id}-prompt`);
  }

  function syncPresetChip(): void {
    syncModeButton();
    const template = taskTemplate(currentTask()?.templateId);
    presetChip.hidden = !template;
    composerToolbar.dataset.statusActive = String(
      Boolean(template) || state.mode === "plan",
    );
    presetChip.toggleAttribute(
      "disabled",
      presetUpdatePending ||
        modeUpdatePending ||
        modelUpdatePending ||
        state.running ||
        state.sending,
    );
    if (presetChip.hidden || presetChip.disabled) presetStatus.resetPreview();
    if (!template) return;
    const label = localizedTemplateTitle(template);
    if (presetLabel.textContent !== label) presetLabel.textContent = label;
    presetChip.dataset.templateId = template.id;
    const hint = getString("workspace-preset-dismiss");
    presetChip.title = `${label} · ${hint}`;
    presetChip.setAttribute("aria-label", `${label} · ${hint}`);
  }

  async function clearPreset(): Promise<void> {
    const task = currentTask();
    if (
      !task?.templateId ||
      presetUpdatePending ||
      modeUpdatePending ||
      modelUpdatePending ||
      state.running ||
      state.sending
    )
      return;
    presetUpdatePending = true;
    updateRunningUI();
    try {
      const updated = (await rpc("task/stageTemplate", {
        taskId: task.id,
        templateId: null,
      })) as ResearchTaskRecord;
      const index = state.sessions.findIndex((row) => row.id === updated.id);
      if (index >= 0) state.sessions[index] = updated;
      if (state.sessionId === task.id) {
        state.sendError = "";
        rememberComposerDraft();
        prompt.focus({ preventScroll: true });
      }
    } catch (error) {
      if (state.sessionId === task.id)
        state.sendError =
          error instanceof Error ? error.message : String(error);
    } finally {
      presetUpdatePending = false;
      updateRunningUI();
      renderLists();
    }
  }

  async function stageTemplate(
    template: TaskTemplate,
    context?: LockedContextSnapshot,
    promptOverride?: string,
  ): Promise<void> {
    if (presetUpdatePending || modeUpdatePending || state.sending) return;
    presetUpdatePending = true;
    updateRunningUI();
    state.sendError = "";
    try {
      const existing = currentTask();
      const stagedContext = context ?? existing?.lockedContext;
      const reuse = Boolean(
        existing &&
        !state.running &&
        !taskHasConversation() &&
        state.artifacts.length === 0,
      );
      let task: ResearchTaskRecord;
      if (reuse && existing) {
        if (stagedContext) {
          task = (await rpc("task/setContext", {
            taskId: existing.id,
            mode: "replace",
            context: stagedContext,
          })) as ResearchTaskRecord;
        } else {
          task = existing;
        }
        task = (await rpc("task/stageTemplate", {
          taskId: task.id,
          templateId: template.id,
        })) as ResearchTaskRecord;
        const index = state.sessions.findIndex((row) => row.id === task.id);
        if (index >= 0) state.sessions[index] = task;
      } else {
        task = await createTask({
          title: localizedTemplateTitle(template),
          context: stagedContext,
          templateId: template.id,
          skillSlug: template.skillSlug,
        });
      }
      const draft = String(
        promptOverride ?? localizedTemplatePrompt(template),
      ).trim();
      prompt.value = draft;
      composerDrafts.set(task.id, draft);
      rememberComposerDraft();
      closeSlashMenu();
      closeMentionMenu();
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      await refreshArtifacts();
      renderLists();
    } catch (error) {
      state.sendError = error instanceof Error ? error.message : String(error);
      renderLists();
    } finally {
      presetUpdatePending = false;
      updateRunningUI();
    }
  }

  async function consumeLaunchIntent(intent: LaunchIntent): Promise<void> {
    const template = taskTemplate(intent.templateId);
    const promptText = String(
      intent.prompt ?? (template ? localizedTemplatePrompt(template) : ""),
    ).trim();
    if (template) {
      await stageTemplate(template, intent.context, promptText);
    } else {
      const created = await createTask({
        title: promptText || "Research task",
        context: intent.context,
        skillSlug: intent.skillSlug,
      });
      const draft =
        promptText || (intent.skillSlug ? `/${intent.skillSlug} ` : "");
      prompt.value = draft;
      composerDrafts.set(created.id, draft);
      rememberComposerDraft();
      prompt.focus();
    }
    await refreshSessions();
    await refreshArtifacts();
    renderLists();
  }

  function artifactKindLabel(kind: ArtifactRecord["kind"]): string {
    return getString(`workspace-artifact-kind-${kind.replace(/_/g, "-")}`);
  }

  function taskStatusLabel(task: ResearchTaskRecord): string {
    return getString(`workspace-task-status-${task.status.replace(/_/g, "-")}`);
  }

  function runtimeLabel(backend: AgentBackendKind): string {
    return backend === "native"
      ? getString("workspace-runtime-native")
      : backend[0].toUpperCase() + backend.slice(1);
  }

  function runtimeStatus(backend: AgentBackendKind): RuntimeStatus | undefined {
    if (backend === "native") {
      return {
        backend,
        state: configReady(state.config) ? "ready" : "unavailable",
        message: configReady(state.config)
          ? getString("workspace-runtime-native-ready")
          : getString("workspace-config-banner"),
        checkedAt: Date.now(),
      };
    }
    return state.runtimes.find((runtime) => runtime.backend === backend);
  }

  function contextSummary(context: LockedContextSnapshot): string {
    const pieces: string[] = [];
    if (context.selection) {
      pieces.push(getString("workspace-source-selection"));
    }
    if (context.items.length) {
      pieces.push(
        `${context.items.length} ${getString("workspace-ctx-items")}`,
      );
    }
    if (context.collection) pieces.push(context.collection.name);
    if (context.savedSearch) pieces.push(context.savedSearch.name);
    if (context.reader?.pageLabel)
      pieces.push(`p. ${context.reader.pageLabel}`);
    return pieces.join(" · ") || getString("workspace-source-empty");
  }

  function contextHasSources(context: LockedContextSnapshot): boolean {
    return Boolean(
      context.items.length ||
      context.collection ||
      context.savedSearch ||
      context.reader ||
      context.selection,
    );
  }

  function contextDetail(context: LockedContextSnapshot): string {
    const details = context.items
      .map((item) => item.title || item.key)
      .filter(Boolean);
    if (context.reader?.title && !details.includes(context.reader.title)) {
      details.push(context.reader.title);
    }
    return details.join("\n");
  }

  function mentionItemKey(item: Pick<ContextSearchItem, "libraryID" | "key">) {
    return `${item.libraryID}:${item.key}`;
  }

  function contextForMentionItem(
    item: ContextSearchItem,
  ): LockedContextSnapshot {
    return withLockedContextFingerprint({
      version: 1,
      capturedAt: Date.now(),
      items: [
        {
          id: `item:${mentionItemKey(item)}`,
          libraryID: item.libraryID,
          key: item.key,
          title: item.title,
          source: "library",
        },
      ],
    });
  }

  function contextWithPendingMentions(
    base?: LockedContextSnapshot,
  ): LockedContextSnapshot | undefined {
    let merged = base;
    for (const item of pendingMentionItems.values()) {
      const incoming = contextForMentionItem(item);
      merged = merged ? mergeLockedContexts(merged, incoming) : incoming;
    }
    return merged;
  }

  function taskHasMentionItem(item: ContextSearchItem): boolean {
    const task = currentTask();
    return Boolean(
      task?.lockedContext.items.some(
        (locked) => mentionItemKey(locked) === mentionItemKey(item),
      ) || pendingMentionItems.has(mentionItemKey(item)),
    );
  }

  async function addMentionContext(item: ContextSearchItem): Promise<void> {
    const task = currentTask();
    const key = mentionItemKey(item);
    if (!task) {
      pendingMentionItems.set(key, item);
      flashContextUpdated();
      return;
    }
    if (taskHasMentionItem(item)) {
      flashContextUpdated();
      return;
    }
    const taskId = task.id;
    const update = pendingContextUpdate
      .catch(() => undefined)
      .then(async () => {
        const updated = (await rpc("task/setContext", {
          taskId,
          mode: "add",
          context: contextForMentionItem(item),
        })) as ResearchTaskRecord;
        const index = state.sessions.findIndex((entry) => entry.id === taskId);
        if (index >= 0) state.sessions[index] = updated;
        else state.sessions.unshift(updated);
      });
    pendingContextUpdate = update.then(
      () => undefined,
      () => undefined,
    );
    try {
      await update;
      state.sendError = "";
      renderLists();
      flashContextUpdated();
    } catch (error) {
      state.sendError = error instanceof Error ? error.message : String(error);
      renderLists();
    }
  }

  let contextFlashGeneration = 0;
  function flashContextUpdated(): void {
    const source = doc.getElementById(
      "confucius-task-sources",
    ) as HTMLElement | null;
    if (!source) return;
    const generation = ++contextFlashGeneration;
    const label = getString("workspace-context-updated");
    const text = source.textContent;
    const title = source.title;
    source.textContent = `${text} · ${label}`;
    source.title = label;
    source.setAttribute("aria-live", "polite");
    doc.defaultView?.setTimeout(() => {
      if (generation !== contextFlashGeneration || !source.isConnected) return;
      source.textContent = text;
      source.title = title;
      source.removeAttribute("aria-live");
    }, 1_200);
  }

  async function updateTaskContext(mode: "add" | "replace"): Promise<void> {
    const task = currentTask();
    if (!task) return;
    closePlusMenu();
    try {
      // Capture again at action time. A polled live snapshot may be stale if
      // the Zotero selection changed while this menu was open.
      const live = (await rpc("context/live", {})) as LiveContextResult;
      state.live = live;
      const current = live.lockedSnapshot;
      if (!current || !contextHasSources(current)) {
        throw new Error(getString("workspace-context-current-empty"));
      }
      await rpc("task/setContext", {
        taskId: task.id,
        mode,
        context: current,
      });
      await refreshSessions();
      await loadTask(task.id);
      state.sendError = "";
      renderLists();
      flashContextUpdated();
    } catch (error) {
      state.sendError = error instanceof Error ? error.message : String(error);
      renderLists();
    }
  }

  function renderTemplatePicker(
    target: HTMLElement,
    context: LockedContextSnapshot,
  ): void {
    const heading = el(doc, "div", {
      marginTop: "22px",
      fontSize: "11px",
      color: "#70695f",
      fontWeight: "700",
      letterSpacing: "0.09em",
      textTransform: "uppercase",
    });
    heading.textContent = getString("workspace-template-heading");
    target.appendChild(heading);
    const grid = el(doc, "div");
    grid.className = "confucius-template-grid";
    for (const template of FEATURED_TASK_TEMPLATES) {
      const templateButton = el(doc, "button", undefined, {
        type: "button",
        "data-template-id": template.id,
      });
      templateButton.className = "confucius-template-button";
      const name = el(doc, "span");
      name.className = "confucius-template-title";
      name.textContent = getString(`workspace-template-${template.id}`);
      const copy = el(doc, "span");
      copy.className = "confucius-template-copy";
      copy.textContent = getString(`workspace-template-${template.id}-help`);
      templateButton.appendChild(name);
      templateButton.appendChild(copy);
      templateButton.addEventListener("click", () => {
        void stageTemplate(template, context);
      });
      grid.appendChild(templateButton);
    }
    target.appendChild(grid);
  }

  function writebackTargets(
    artifact: ArtifactRecord,
  ): Array<{ value: string; label: string }> {
    const targets = [
      {
        value: "zotero_note",
        label: getString("workspace-writeback-note"),
      },
      {
        value: "knowledge_base",
        label: getString("workspace-writeback-knowledge"),
      },
    ];
    if (artifact.kind === "annotation_set") {
      targets.unshift({
        value: "zotero_annotations",
        label: getString("workspace-writeback-annotations"),
      });
    }
    if (artifact.kind === "collection_diff") {
      targets.unshift({
        value: "zotero_tags",
        label: getString("workspace-writeback-tags"),
      });
      targets.unshift({
        value: "zotero_collection",
        label: getString("workspace-writeback-collection"),
      });
    }
    return targets;
  }

  function openWritebackPreview(
    artifact: ArtifactRecord,
    revision: number,
  ): void {
    const task = state.sessions.find((row) => row.id === artifact.taskId);
    if (task?.status === "running" || task?.status === "awaiting_approval") {
      state.sendError = getString("workspace-writeback-disabled-running");
      renderLists();
      return;
    }
    if (artifact.writeback?.state === "pending") {
      state.sendError = getString("workspace-writeback-disabled-pending");
      renderLists();
      return;
    }
    doc.getElementById("confucius-writeback-overlay")?.remove();
    const returnFocus = doc.activeElement as HTMLElement | null;
    const overlay = el(
      doc,
      "div",
      { zIndex: "1300" },
      {
        id: "confucius-writeback-overlay",
        "aria-label": getString("workspace-writeback-preview"),
      },
    );
    overlay.className = "confucius-dialog";
    const closeWriteback = () => {
      overlay.remove();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    bindDialogNavigation(overlay, closeWriteback);
    const panel = el(doc, "div");
    panel.className = "confucius-dialog-panel";
    const heading = el(doc, "div", {
      marginBottom: "10px",
      fontSize: "16px",
      fontWeight: "700",
    });
    heading.textContent = getString("workspace-writeback-preview");
    const targetSelect = el(
      doc,
      "select",
      {
        width: "100%",
        height: "34px",
        marginBottom: "10px",
        border: "1px solid #ddd8cc",
        borderRadius: "7px",
        background: "#fff",
      },
      { id: "confucius-writeback-target" },
    ) as HTMLSelectElement;
    for (const target of writebackTargets(artifact)) {
      const option = el(doc, "option", undefined, { value: target.value });
      option.textContent = target.label;
      targetSelect.appendChild(option);
    }
    const knowledgeInput = el(
      doc,
      "input",
      {
        display: "none",
        width: "100%",
        height: "34px",
        marginBottom: "10px",
        padding: "0 8px",
        boxSizing: "border-box",
        border: "1px solid #ddd8cc",
        borderRadius: "7px",
      },
      {
        type: "text",
        placeholder: getString("workspace-writeback-knowledge-id"),
      },
    ) as HTMLInputElement;
    const preview = el(doc, "div");
    preview.className = "confucius-before-after";
    const errorLine = el(doc, "div", {
      minHeight: "18px",
      marginTop: "8px",
      color: "#b3452f",
    });
    const actions = el(doc, "div", {
      display: "flex",
      justifyContent: "flex-end",
      gap: "8px",
      marginTop: "10px",
    });
    const cancel = button(doc, "", getString("workspace-settings-cancel"));
    const requestApproval = button(
      doc,
      "confucius-writeback-request",
      getString("workspace-writeback-request"),
      "primary",
    );
    requestApproval.setAttribute("disabled", "true");
    const loadPreview = async (): Promise<void> => {
      requestApproval.setAttribute("disabled", "true");
      errorLine.textContent = "";
      preview.textContent = "";
      try {
        const result = (await rpc("artifact/writebackPreview", {
          id: artifact.id,
          revision,
          target: targetSelect.value,
        })) as { before: string; after: string };
        for (const [label, value] of [
          [getString("workspace-writeback-before"), result.before],
          [getString("workspace-writeback-after"), result.after],
        ]) {
          const column = el(doc, "div");
          const title = el(doc, "div", {
            color: "#6b665c",
            fontSize: "11px",
            fontWeight: "700",
          });
          title.textContent = label;
          const content = el(doc, "pre");
          content.textContent = value;
          column.appendChild(title);
          column.appendChild(content);
          preview.appendChild(column);
        }
        requestApproval.removeAttribute("disabled");
      } catch (error) {
        errorLine.textContent =
          error instanceof Error ? error.message : String(error);
      }
    };
    targetSelect.addEventListener("change", () => {
      knowledgeInput.style.display =
        targetSelect.value === "knowledge_base" ? "block" : "none";
      void loadPreview();
    });
    cancel.addEventListener("click", closeWriteback);
    requestApproval.addEventListener("click", () => {
      requestApproval.setAttribute("disabled", "true");
      void (async () => {
        try {
          await rpc("artifact/writebackCommit", {
            id: artifact.id,
            revision,
            target: targetSelect.value,
            knowledgeBaseId: knowledgeInput.value.trim() || undefined,
          });
          closeWriteback();
          const keepViewerOpen = artifactViewerOpen;
          await loadTask(artifact.taskId);
          if (
            keepViewerOpen &&
            state.artifacts.some((item) => item.id === artifact.id)
          ) {
            state.selectedArtifactId = artifact.id;
            state.selectedArtifactRevision = revision;
          }
          renderLists();
        } catch (error) {
          errorLine.textContent =
            error instanceof Error ? error.message : String(error);
          requestApproval.removeAttribute("disabled");
        }
      })();
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });
    actions.appendChild(cancel);
    actions.appendChild(requestApproval);
    panel.appendChild(heading);
    panel.appendChild(targetSelect);
    panel.appendChild(knowledgeInput);
    panel.appendChild(preview);
    panel.appendChild(errorLine);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    const viewer = doc.getElementById("confucius-artifact-overlay");
    (viewer?.parentElement ?? root).appendChild(overlay);
    targetSelect.focus({ preventScroll: true });
    void loadPreview();
  }

  function renderActivityOverview(): HTMLElement {
    const task = currentTask();
    const overview = el(doc, "section");
    overview.className = task
      ? "confucius-task-overview"
      : "confucius-task-empty";

    if (!task) {
      const eyebrow = el(doc, "div", {
        color: "#9a4f25",
        fontSize: "11px",
        fontWeight: "700",
        letterSpacing: ".11em",
        textTransform: "uppercase",
      });
      eyebrow.textContent = getString("workspace-research-workbench");
      const heading = el(doc, "h1", {
        maxWidth: "700px",
        margin: "7px 0 8px",
        fontSize: compact ? "24px" : "31px",
        lineHeight: "1.15",
        letterSpacing: "-.025em",
      });
      heading.textContent = getString("workspace-empty-heading");
      const copy = el(doc, "p", {
        maxWidth: "620px",
        margin: "0",
        color: "#6b665c",
        lineHeight: "1.55",
      });
      copy.textContent = getString("workspace-empty-copy");
      overview.appendChild(eyebrow);
      overview.appendChild(heading);
      overview.appendChild(copy);
      const context = state.live?.lockedSnapshot ?? emptyLockedContext();
      if (context) {
        const source = el(doc, "div", {
          marginTop: "12px",
          color: "#6b665c",
          fontSize: ".9em",
        });
        source.textContent = `${getString("workspace-current-source")}: ${contextSummary(context)}`;
        overview.appendChild(source);
        renderTemplatePicker(overview, context);
      }
      return overview;
    }

    const header = el(doc, "div");
    header.className = "confucius-task-overview-header";
    const headerCopy = el(doc, "div", { minWidth: "0px", flex: "1 1 280px" });
    const meta = el(doc, "div", {
      color: "#70695f",
      fontSize: "11px",
      fontWeight: "700",
      letterSpacing: ".08em",
      textTransform: "uppercase",
    });
    meta.textContent = `${runtimeLabel(task.backend)} · ${taskStatusLabel(task)}`;
    const title = el(doc, "h1");
    title.textContent = task.title || getString("workspace-untitled-task");
    const source = el(
      doc,
      "button",
      {
        color: "#6b665c",
        fontSize: ".9em",
        fontFamily: "inherit",
        textAlign: "start",
        background: "transparent",
        border: "0",
        padding: "4px 0",
        cursor: "pointer",
        maxWidth: "100%",
      },
      { id: "confucius-task-sources", type: "button", "aria-haspopup": "menu" },
    );
    source.textContent = `${contextSummary(task.lockedContext)} ⌄`;
    source.title =
      contextDetail(task.lockedContext) ||
      getString("workspace-context-heading");
    source.addEventListener("click", (event) => {
      event.stopPropagation();
      const existing = doc.getElementById("confucius-source-menu");
      if (existing) {
        existing.remove();
        return;
      }
      closeEndpointMenu();
      closePlusMenu();
      closeMentionMenu();
      closeSlashMenu();
      const menu = menuPanel("confucius-source-menu");
      menu.appendChild(
        createMenuHeader(
          doc,
          getString("workspace-context-heading"),
          contextSummary(task.lockedContext),
        ),
      );
      for (const mode of ["add", "replace"] as const) {
        const row = menuRow(
          getString(
            mode === "add"
              ? "workspace-context-add"
              : "workspace-context-replace",
          ),
          {
            onClick: () => {
              menu.remove();
              if (currentTask()?.id === task.id) void updateTaskContext(mode);
            },
          },
        );
        row.dataset.contextAction = mode;
        menu.appendChild(row);
      }
      placeMenu(source, menu, 300);
    });
    headerCopy.appendChild(meta);
    headerCopy.appendChild(title);
    headerCopy.appendChild(source);

    header.appendChild(headerCopy);
    if (state.artifacts.length) {
      const files = button(
        doc,
        "confucius-task-files",
        `${getString("workspace-artifacts")} · ${state.artifacts.length}`,
      );
      files.addEventListener("click", () =>
        openArtifactViewer(state.artifacts[0].id, undefined, files),
      );
      header.append(files);
    }
    if (task.status === "interrupted") {
      const controls = el(doc, "div", {
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "7px",
      });
      const resume = button(
        doc,
        "confucius-task-continue",
        getString("workspace-task-continue"),
        "primary",
      );
      resume.addEventListener("click", () => {
        void (async () => {
          try {
            await rpc("task/continue", { taskId: task.id });
            await refreshSessions();
            await loadTask(task.id);
            renderLists();
          } catch (error) {
            state.sendError =
              error instanceof Error ? error.message : String(error);
            renderLists();
          }
        })();
      });
      controls.appendChild(resume);
      header.appendChild(controls);
    }
    overview.appendChild(header);

    if (
      !state.artifacts.length &&
      !state.events.some((event) => event.type === "turn_started")
    ) {
      const guide = el(doc, "p", {
        color: "#70695f",
        margin: "20px 0 8px",
        lineHeight: "1.6",
      });
      guide.textContent = getString("workspace-start-guide");
      overview.appendChild(guide);
      if (!state.running) renderTemplatePicker(overview, task.lockedContext);
    }
    return overview;
  }

  function closeArtifactChoiceMenu(restoreFocus = false): void {
    const current = artifactChoiceMenu;
    artifactChoiceMenu = null;
    doc.getElementById("confucius-artifact-choice-menu")?.remove();
    doc
      .getElementById("confucius-artifact-switcher-trigger")
      ?.setAttribute("aria-expanded", "false");
    doc
      .getElementById("confucius-artifact-revision-trigger")
      ?.setAttribute("aria-expanded", "false");
    if (restoreFocus && current?.anchor.isConnected) current.anchor.focus();
  }

  function selectArtifactChoice(kind: "artifact" | "revision", value: string) {
    if (kind === "artifact") {
      const selected = state.artifacts.find((item) => item.id === value);
      if (!selected) return;
      state.selectedArtifactId = selected.id;
      state.selectedArtifactRevision = selected.revision;
    } else {
      const revision = Number(value);
      const selected = state.artifacts.find(
        (item) => item.id === state.selectedArtifactId,
      );
      if (
        !selected ||
        !selected.revisions.some((item) => item.revision === revision)
      ) {
        return;
      }
      state.selectedArtifactRevision = revision;
    }
    closeArtifactChoiceMenu(false);
    renderArtifactViewer(true, true);
  }

  function renderArtifactChoiceMenu(
    kind: "artifact" | "revision",
    anchor: HTMLElement,
  ): void {
    const artifact =
      state.artifacts.find((item) => item.id === state.selectedArtifactId) ??
      state.artifacts[0];
    if (!artifact) {
      closeArtifactChoiceMenu(false);
      return;
    }
    const menu = createMenuSurface(doc, {
      id: "confucius-artifact-choice-menu",
      role: "listbox",
      "data-placement": "left",
      "aria-label": getString(
        kind === "artifact"
          ? "workspace-artifact-switch"
          : "workspace-artifact-revision",
      ),
    });
    menu.style.zIndex = "1300";
    menu.classList.add("confucius-artifact-choice-menu");
    const choices =
      kind === "artifact"
        ? state.artifacts.map((item) => ({
            value: item.id,
            title: item.title,
            meta: `${artifactKindLabel(item.kind)} · r${item.revision}`,
            selected: item.id === artifact.id,
          }))
        : [...artifact.revisions].reverse().map((item) => ({
            value: String(item.revision),
            title: `r${item.revision}`,
            meta: runtimeLabel(item.backend),
            selected: item.revision === state.selectedArtifactRevision,
          }));

    for (const choice of choices) {
      const row = el(doc, "button", undefined, {
        type: "button",
        role: "option",
        "data-value": choice.value,
        "data-selected": choice.selected ? "true" : "false",
        "aria-selected": choice.selected ? "true" : "false",
      });
      row.className = "confucius-artifact-choice";
      const copy = el(doc, "span");
      copy.className = "confucius-artifact-choice-copy";
      const title = el(doc, "span");
      title.className = "confucius-artifact-choice-title";
      title.textContent = choice.title;
      const meta = el(doc, "span");
      meta.className = "confucius-artifact-choice-meta";
      meta.textContent = choice.meta;
      const check = el(doc, "span", undefined, { "aria-hidden": "true" });
      check.className = "confucius-artifact-choice-check";
      check.textContent = choice.selected ? "✓" : "";
      copy.appendChild(title);
      copy.appendChild(meta);
      row.appendChild(copy);
      row.appendChild(check);
      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectArtifactChoice(kind, choice.value);
      });
      menu.appendChild(row);
    }

    menu.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeArtifactChoiceMenu(true);
        return;
      }
      if (key === "Tab") {
        closeArtifactChoiceMenu(false);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return;
      event.preventDefault();
      const rows = Array.from(
        menu.querySelectorAll(".confucius-artifact-choice"),
      ) as HTMLElement[];
      if (!rows.length) return;
      const current = rows.indexOf(doc.activeElement as HTMLElement);
      const index =
        key === "Home"
          ? 0
          : key === "End"
            ? rows.length - 1
            : key === "ArrowUp"
              ? (current - 1 + rows.length) % rows.length
              : (current + 1) % rows.length;
      rows[index]?.focus();
    });

    placeMenu(anchor, menu, kind === "artifact" ? 320 : 176, "left");
    const selected = menu.querySelector(
      '[data-selected="true"]',
    ) as HTMLElement | null;
    (selected ?? (menu.firstElementChild as HTMLElement | null))?.focus();
  }

  function artifactMenuTrigger(
    kind: "artifact" | "revision",
    value: string,
  ): HTMLElement {
    const controlLabel = getString(
      kind === "artifact"
        ? "workspace-artifact-switch"
        : "workspace-artifact-revision",
    );
    const trigger = el(doc, "button", undefined, {
      id:
        kind === "artifact"
          ? "confucius-artifact-switcher-trigger"
          : "confucius-artifact-revision-trigger",
      type: "button",
      "data-kind": kind,
      title: `${controlLabel}: ${value}`,
      "aria-haspopup": "listbox",
      "aria-controls": "confucius-artifact-choice-menu",
      "aria-expanded": artifactChoiceMenu?.kind === kind ? "true" : "false",
      "aria-label": `${controlLabel}: ${value}`,
    });
    trigger.className = "confucius-artifact-menu-trigger";
    if (kind === "artifact") {
      trigger.appendChild(artifactActionIcon(doc, "artifacts"));
    } else {
      const label = el(doc, "span");
      label.className = "confucius-artifact-menu-trigger-value";
      label.textContent = value;
      trigger.appendChild(label);
    }
    const chevron = el(doc, "span", undefined, { "aria-hidden": "true" });
    chevron.className = "confucius-artifact-menu-trigger-chevron";
    chevron.textContent = "‹";
    trigger.appendChild(chevron);
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (
        artifactChoiceMenu?.kind === kind &&
        doc.getElementById("confucius-artifact-choice-menu")
      ) {
        closeArtifactChoiceMenu(true);
        return;
      }
      closeArtifactChoiceMenu(false);
      artifactChoiceMenu = { kind, anchor: trigger };
      trigger.setAttribute("aria-expanded", "true");
      renderArtifactChoiceMenu(kind, trigger);
    });
    return trigger;
  }

  function closeArtifactViewer(restoreFocus = true): void {
    rememberArtifactScroll();
    closeArtifactChoiceMenu(false);
    artifactViewerOpen = false;
    lastArtifactViewerSignature = "";
    doc.getElementById("confucius-artifact-overlay")?.remove();
    const returnFocus = artifactViewerReturnFocus;
    artifactViewerReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) {
      returnFocus.focus();
    }
  }

  function openArtifactViewer(
    artifactId: string,
    revision?: number,
    returnFocus?: HTMLElement,
  ): void {
    const artifact = state.artifacts.find((item) => item.id === artifactId);
    if (!artifact) return;
    artifactViewerReturnFocus =
      returnFocus ?? (doc.activeElement as HTMLElement | null);
    artifactViewerOpen = true;
    state.selectedArtifactId = artifact.id;
    state.selectedArtifactRevision = artifact.revisions.some(
      (item) => item.revision === revision,
    )
      ? (revision ?? artifact.revision)
      : artifact.revision;
    renderArtifactViewer(true, true);
  }

  function artifactViewerSignature(): string {
    return [
      state.selectedArtifactId ?? "",
      String(state.selectedArtifactRevision ?? ""),
      ...state.artifacts.map(
        (artifact) =>
          `${artifact.id}:${artifact.revision}:${artifact.status}:${
            artifact.writeback?.state ?? "none"
          }`,
      ),
    ].join("|");
  }

  function renderArtifactViewer(force = false, resetScroll = false): void {
    const existing = doc.getElementById(
      "confucius-artifact-overlay",
    ) as HTMLElement | null;
    if (!artifactViewerOpen) {
      existing?.remove();
      return;
    }

    const artifact =
      state.artifacts.find((item) => item.id === state.selectedArtifactId) ??
      state.artifacts[0];
    const task = artifact
      ? state.sessions.find((item) => item.id === artifact.taskId)
      : undefined;
    if (!artifact || !task) {
      closeArtifactViewer(false);
      return;
    }
    const requestedRevision =
      state.selectedArtifactRevision ?? artifact.revision;
    const revision =
      artifact.revisions.find((item) => item.revision === requestedRevision) ??
      artifact.revisions.at(-1);
    if (!revision) {
      closeArtifactViewer(false);
      return;
    }
    state.selectedArtifactId = artifact.id;
    state.selectedArtifactRevision = revision.revision;
    const signature = artifactViewerSignature();
    if (!force && existing && signature === lastArtifactViewerSignature) {
      return;
    }

    const previousBody = doc.getElementById(
      "confucius-artifact-dialog-body",
    ) as HTMLElement | null;
    rememberArtifactScroll();
    const artifactKey = `${artifact.id}:${revision.revision}`;
    const previousScroll =
      artifactKey !== renderedArtifactKey || resetScroll
        ? (artifactScrolls.get(artifactKey) ?? 0)
        : (previousBody?.scrollTop ?? 0);
    renderedArtifactKey = artifactKey;
    const wasOpen = Boolean(existing);
    closeArtifactChoiceMenu(false);
    existing?.remove();

    // Sidebar layout: the pane is too narrow for the mask to show, so the
    // viewer mounts on the main document root and covers the whole window.
    // The Zotero main window is a XUL document: doc.body may not exist.
    const mountToWindow = compact;

    const overlay = el(doc, "div", undefined, {
      id: "confucius-artifact-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "confucius-artifact-dialog-title",
    });
    overlay.className = "confucius-artifact-overlay";
    overlay.style.fontFamily = root.style.fontFamily;
    overlay.style.fontSize = root.style.fontSize;
    for (const property of [
      "--confucius-markdown-font-size",
      "--confucius-reading-line-height",
    ]) {
      overlay.style.setProperty(
        property,
        root.style.getPropertyValue(property),
      );
    }
    if (wasOpen) overlay.setAttribute("data-refresh", "true");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeArtifactViewer();
    });
    bindDialogNavigation(overlay, () => closeArtifactViewer());

    const dialog = el(doc, "section");
    dialog.className = "confucius-artifact-dialog";
    const rail = el(doc, "aside", undefined, {
      role: "toolbar",
      "aria-orientation": "vertical",
      "aria-label": getString("workspace-artifact-actions"),
    });
    rail.className = "confucius-artifact-action-rail";
    const closeButton = el(doc, "button", undefined, {
      type: "button",
      title: getString("workspace-artifact-close"),
      "aria-label": getString("workspace-artifact-close"),
    });
    closeButton.className = "confucius-artifact-rail-button";
    closeButton.appendChild(artifactActionIcon(doc, "close"));
    closeButton.addEventListener("click", () => closeArtifactViewer());
    rail.appendChild(closeButton);
    const divider = el(doc, "span", undefined, { "aria-hidden": "true" });
    divider.className = "confucius-artifact-rail-divider";
    rail.appendChild(divider);
    if (state.artifacts.length > 1) {
      rail.appendChild(artifactMenuTrigger("artifact", artifact.title));
    }
    if (artifact.revisions.length > 1) {
      rail.appendChild(
        artifactMenuTrigger("revision", `r${revision.revision}`),
      );
    } else {
      const revisionLabel = `${getString("workspace-artifact-revision")}: r${revision.revision}`;
      const revisionBadge = el(doc, "span", undefined, {
        title: revisionLabel,
        "aria-label": revisionLabel,
      });
      revisionBadge.className = "confucius-artifact-revision-badge";
      revisionBadge.textContent = `r${revision.revision}`;
      rail.appendChild(revisionBadge);
    }
    const spacer = el(doc, "span", undefined, { "aria-hidden": "true" });
    spacer.className = "confucius-artifact-rail-spacer";
    rail.appendChild(spacer);

    const writeback = el(doc, "button", undefined, {
      id: "confucius-artifact-writeback",
      type: "button",
      title: getString("workspace-writeback"),
      "aria-label": getString("workspace-writeback"),
    });
    writeback.className = "confucius-artifact-rail-button";
    writeback.appendChild(artifactActionIcon(doc, "writeback"));
    const writebackBlocked =
      task.status === "running" ||
      task.status === "awaiting_approval" ||
      artifact.writeback?.state === "pending";
    if (writebackBlocked) {
      writeback.setAttribute("disabled", "true");
      writeback.title =
        artifact.writeback?.state === "pending"
          ? getString("workspace-writeback-disabled-pending")
          : getString("workspace-writeback-disabled-running");
    }
    writeback.addEventListener("click", () =>
      openWritebackPreview(artifact, revision.revision),
    );
    rail.appendChild(writeback);
    dialog.appendChild(rail);

    const dialogBody = el(doc, "div", undefined, {
      id: "confucius-artifact-dialog-body",
    });
    dialogBody.className = "confucius-artifact-dialog-body";
    const shell = el(doc, "div");
    shell.className = "confucius-artifact-shell";
    const paper = el(doc, "article");
    paper.className = "confucius-artifact-paper";
    const paperMeta = el(doc, "div", {
      display: "flex",
      alignItems: "center",
      flexWrap: "wrap",
      gap: "7px",
      color: "#70695f",
      fontSize: "11px",
      fontWeight: "700",
      letterSpacing: ".07em",
      textTransform: "uppercase",
    });
    const kind = el(doc, "span");
    kind.textContent = `${artifactKindLabel(artifact.kind)} · ${runtimeLabel(
      revision.backend,
    )} · r${revision.revision}`;
    paperMeta.appendChild(kind);
    if (
      artifact.writeback?.state === "committed" &&
      artifact.writeback.revision === revision.revision
    ) {
      const committed = el(doc, "span", { color: "#4f7657" });
      committed.textContent = getString("workspace-writeback-committed");
      paperMeta.appendChild(committed);
    }
    const artifactTitle = el(
      doc,
      "h2",
      {
        margin: "10px 0 20px",
        fontSize: compact && !mountToWindow ? "23px" : "30px",
        lineHeight: "1.16",
        letterSpacing: "-.025em",
      },
      { id: "confucius-artifact-dialog-title" },
    );
    artifactTitle.textContent = artifact.title;
    paper.appendChild(paperMeta);
    paper.appendChild(artifactTitle);
    paper.appendChild(
      renderReadingSurface(doc, revision.body, { fillAnswerHtml, locateLink }),
    );
    if (revision.citations.length) {
      const citationHeading = el(doc, "h3", {
        margin: "28px 0 8px",
        paddingTop: "14px",
        borderTop: "1px solid #e5e1d8",
        fontSize: "13px",
      });
      citationHeading.textContent = getString("workspace-artifact-citations");
      paper.appendChild(citationHeading);
      const list = el(doc, "ol", { paddingLeft: "22px" });
      for (const citation of revision.citations) {
        const item = el(doc, "li", { marginBottom: "8px" });
        const label = el(doc, "div");
        label.textContent =
          citation.quote ||
          citation.section ||
          `${citation.itemLibraryID}:${citation.itemKey}`;
        item.appendChild(label);
        item.appendChild(
          locateLink(doc, {
            libraryID: citation.itemLibraryID,
            key: citation.itemKey,
            pageIndex:
              typeof citation.page === "number"
                ? Math.max(0, citation.page - 1)
                : undefined,
          }),
        );
        list.appendChild(item);
      }
      paper.appendChild(list);
    }
    shell.appendChild(paper);
    dialogBody.appendChild(shell);
    dialog.appendChild(dialogBody);
    overlay.appendChild(dialog);
    const windowHost = mountToWindow
      ? ((doc.body ?? doc.documentElement) as HTMLElement | null)
      : null;
    if (windowHost) {
      overlay.setAttribute("data-mount", "window");
      windowHost.appendChild(overlay);
    } else {
      root.appendChild(overlay);
    }
    dialogBody.scrollTop = previousScroll;
    lastArtifactViewerSignature = signature;
    if (!wasOpen) closeButton.focus();
  }

  const updateTaskList = createTaskList(doc, sessionPane, {
    text: (key) => getString(key),
    status: taskStatusLabel,
    open: (taskId) => {
      void loadTask(taskId).then(() => {
        if (auxiliaryOverlay) {
          showSessions = false;
          syncAuxiliaryPanes();
        }
        renderLists();
      });
    },
    remove: (taskId) => {
      void (async () => {
        await rpc("task/delete", { taskId: taskId });
        composerDrafts.delete(taskId);
        timelineViewports.delete(taskId);
        if (state.sessionId === taskId) {
          taskLoadGeneration += 1;
          state.sessionId = null;
          state.events = [];
          state.lastEventId = null;
          state.running = false;
          state.pendingUserText = "";
          state.artifacts = [];
          state.selectedArtifactId = null;
          state.selectedArtifactRevision = null;
          prompt.value = "";
          renderedTimelineTaskId = null;
          closeArtifactViewer();
        }
        await refreshSessions();
        renderLists();
        referenceDrafts.delete(taskId);
      })().catch((error) => {
        state.sendError = String(error);
        renderLists();
      });
    },
  });

  let lastListSignature = "";

  function listSignature(): string {
    return [
      state.sessionId ?? "",
      state.lastEventId ?? "",
      String(state.events.length),
      state.running ? "1" : "0",
      state.sending ? "1" : "0",
      state.pendingUserText,
      state.sendError,
      state.mode,
      state.approvals.map((item) => item.id).join(","),
      state.sessions
        .map(
          (item) =>
            `${item.id}:${item.title ?? ""}:${item.status}:${item.backend}:${item.templateId ?? ""}:${item.lockedContext.fingerprint}`,
        )
        .join("|"),
      state.artifacts
        .map((item) => `${item.id}:${item.revision}:${item.status}`)
        .join("|"),
      state.runtimes.map((item) => `${item.backend}:${item.state}`).join("|"),
      state.config && configReady(state.config) ? "1" : "0",
    ].join("\u0000");
  }

  function renderLists(): void {
    applyAppearance();
    syncEndpointButton();
    syncPresetChip();
    lastListSignature = listSignature();
    updateTaskList(state.sessions, state.sessionId);
    renderSourceTags();

    const timelineTaskId = state.sessionId;
    const taskChanged = renderedTimelineTaskId !== timelineTaskId;
    rememberTimelineViewport();
    const savedViewport = timelineTaskId
      ? timelineViewports.get(timelineTaskId)
      : undefined;
    const followTimeline = taskChanged
      ? (savedViewport?.followsBottom ?? true)
      : timelinePane.scrollHeight -
          timelinePane.scrollTop -
          timelinePane.clientHeight <
        96;
    const savedTimelineScroll = taskChanged
      ? (savedViewport?.scrollTop ?? 0)
      : timelinePane.scrollTop;
    if (taskChanged) timelinePane.replaceChildren();
    const session = state.sessions.find((item) => item.id === state.sessionId);
    const activityStream = el(doc, "div");
    activityStream.className = "confucius-activity-shell";
    const timelineHead = el(doc, "div");
    timelineHead.className = "confucius-activity-head";
    timelineHead.appendChild(
      paneLabel(
        doc,
        `${getString("workspace-timeline")}${
          state.approvals.length
            ? ` · ${state.approvals.length} ${getString("workspace-awaiting-approval")}`
            : ""
        }`,
      ),
    );
    activityStream.appendChild(timelineHead);
    const overview = renderActivityOverview();
    overview.dataset.entryId = `overview:${state.sessionId ?? "new"}`;
    activityStream.appendChild(overview);
    if (
      session?.backend === "native" &&
      state.config &&
      !configReady(state.config)
    ) {
      const banner = el(doc, "div");
      banner.className = "confucius-notice";
      const bannerText = el(doc, "div", { marginBottom: "6px" });
      bannerText.textContent = getString("workspace-config-banner");
      const configure = button(
        doc,
        "confucius-configure",
        getString("workspace-configure"),
      );
      configure.addEventListener("click", () => openSettings());
      banner.appendChild(bannerText);
      banner.appendChild(configure);
      activityStream.appendChild(banner);
    }
    if (state.pendingUserText) {
      activityStream.appendChild(renderUserLine(doc, state.pendingUserText));
    }
    if (state.sendError) {
      const err = tuiBlock(doc, { color: "#8a2e1d" });
      err.textContent = state.sendError;
      activityStream.appendChild(err);
    }
    const keyedBlocks = keyedTimeline(state.events);
    const timelineBlocks = keyedBlocks.map((entry) => entry.block);
    if (
      !state.events.length &&
      !state.artifacts.length &&
      !state.pendingUserText &&
      !state.sendError
    ) {
      // The task overview already provides the starting actions.
    } else {
      timelineBlocks.forEach((block, index) => {
        const node = renderTimelineBlock(doc, block, index);
        if (node) {
          node.dataset.entryId = keyedBlocks[index].key;
          activityStream.appendChild(node);
        }
      });
    }
    const representedArtifactRevisions = new Set(
      timelineBlocks
        .filter(
          (block): block is Extract<TimelineBlock, { kind: "artifact" }> =>
            block.kind === "artifact",
        )
        .map((block) => `${block.artifact.id}:${block.artifact.revision}`),
    );
    for (const artifact of state.artifacts) {
      if (
        !representedArtifactRevisions.has(`${artifact.id}:${artifact.revision}`)
      ) {
        activityStream.appendChild(renderArtifactFileBlock(doc, artifact));
      }
    }
    for (const item of state.approvals) {
      const card = renderApprovalCard(doc, item);
      card.dataset.entryId = `approval:${item.id}`;
      activityStream.appendChild(card);
    }
    if (state.sending || turnAwaitingReply(state.events)) {
      activityStream.appendChild(renderWaiting(doc, state.events));
    }
    const sources = renderHistorySources();
    if (sources) activityStream.appendChild(sources);
    const previousStream = timelinePane.firstElementChild as HTMLElement | null;
    if (previousStream) reconcileActivity(previousStream, activityStream);
    else {
      const initialStream = el(doc, "div");
      initialStream.className = activityStream.className;
      reconcileActivity(initialStream, activityStream);
      timelinePane.appendChild(initialStream);
    }
    renderedTimelineTaskId = timelineTaskId;
    timelinePane.scrollTop =
      followTimeline && (state.events.length > 0 || state.pendingUserText)
        ? timelinePane.scrollHeight
        : savedTimelineScroll;
    rememberTimelineViewport();
    syncLatest();
    renderArtifactViewer();
  }

  function renderHistorySources(): HTMLElement | null {
    const events = state.events.filter(
      (event): event is Extract<ConfuciusEvent, { type: "history_recalled" }> =>
        event.type === "history_recalled",
    );
    const unique = new Map(
      events.map((event) => [JSON.stringify(event.payload.ref), event.payload]),
    );
    if (!unique.size) return null;
    const details = el(doc, "details");
    details.className = "confucius-history-sources";
    details.dataset.entryId = "history-sources";
    const summary = el(doc, "summary");
    summary.textContent = `${getString("workspace-history-sources")} · ${unique.size}`;
    details.append(summary);
    for (const payload of unique.values()) {
      const row = el(doc, "div");
      const read = button(
        doc,
        "",
        `${payload.title} · ${payload.sourceIds.join(", ") || payload.ref.itemId}`,
      );
      const preview = el(doc, "pre");
      preview.hidden = true;
      const more = button(doc, "", getString("workspace-history-more"));
      more.hidden = true;
      let offset = 0;
      const load = async (ref: HistoryItemRef) => {
        try {
          const result = (await rpc("task/history", {
            ...ref,
            offset,
            limit: 4000,
          })) as { content: string; nextOffset: number | null };
          preview.textContent = result.content;
          preview.hidden = false;
          more.hidden = result.nextOffset === null;
          offset = result.nextOffset ?? 0;
        } catch {
          preview.textContent = getString("workspace-source-unavailable");
          preview.hidden = false;
          more.hidden = true;
        }
      };
      read.addEventListener("click", () => {
        offset = 0;
        void load(payload.ref);
      });
      more.addEventListener("click", () => void load(payload.ref));
      const open = button(doc, "", getString("workspace-reference-open"));
      open.addEventListener(
        "click",
        () =>
          void loadTask(payload.ref.taskId)
            .then(renderLists)
            .catch(() => {
              preview.textContent = getString("workspace-source-unavailable");
              preview.hidden = false;
            }),
      );
      row.append(read, open, preview, more);
      details.append(row);
    }
    return details;
  }

  function syncModeButton(): void {
    if (!modeUpdatePending) state.mode = currentTask()?.mode ?? state.mode;
    const chip = planStatus.node;
    chip.hidden = state.mode !== "plan";
    chip.disabled =
      modeUpdatePending ||
      presetUpdatePending ||
      modelUpdatePending ||
      state.running ||
      state.sending;
    if (chip.hidden || chip.disabled) planStatus.resetPreview();
    const label = getString("workspace-mode-plan-label");
    if (planStatus.label.textContent !== label)
      planStatus.label.textContent = label;
    chip.title = `${getString("workspace-mode-plan")} · ${getString("workspace-mode-dismiss")}`;
    chip.setAttribute("aria-label", chip.title);
  }

  function syncEndpointButton(): void {
    const task = currentTask();
    if (task && task.backend !== "native") {
      const runtime = runtimeStatus(task.backend);
      const model =
        runtime?.models?.find(
          (model) => model.id === task.runtimeModel?.modelId,
        ) ??
        (!task.runtimeModel
          ? runtime?.models?.find((model) => model.isDefault)
          : undefined);
      const label =
        model?.label ||
        task.runtimeModel?.modelId ||
        runtimeLabel(task.backend);
      const effort = task.runtimeModel?.reasoningEffort;
      endpointName.textContent = effort
        ? `${label} · ${effortLabel(effort)}`
        : label;
      endpointBtn.setAttribute(
        "aria-label",
        `${runtimeLabel(task.backend)} · ${endpointName.textContent}`,
      );
      endpointBtn.title =
        runtime?.message || getString("workspace-runtime-external");
      endpointBtn.setAttribute(
        "aria-expanded",
        endpointMenuOpen ? "true" : "false",
      );
      return;
    }
    const active = state.config?.endpoints?.find(
      (endpoint) => endpoint.id === state.config?.activeEndpointId,
    );
    const label =
      active?.model ||
      endpointLabel(active) ||
      getString("workspace-no-endpoint");
    const activeEffort = normalizeModelEffort(
      active?.model ?? "",
      active?.baseUrl ?? "",
      active?.reasoningEffort,
    );
    endpointName.textContent =
      activeEffort !== "auto"
        ? `${label} · ${effortLabel(activeEffort)}`
        : label;
    endpointBtn.setAttribute("aria-label", label);
    const detail = [
      active?.name,
      active?.model,
      endpointHost(active?.baseUrl ?? ""),
    ]
      .filter(Boolean)
      .join(" · ");
    endpointBtn.title = detail || getString("workspace-model");
    endpointBtn.setAttribute(
      "aria-expanded",
      endpointMenuOpen ? "true" : "false",
    );
  }

  function collectApprovals(): void {
    const open = new Map<string, ApprovalRow>();
    for (const event of state.events) {
      if (event.type === "approval_required") {
        const request = event.payload.request;
        open.set(request.id, {
          id: request.id,
          toolName: request.toolName,
          args: request.args,
          summary: request.summary,
          before: request.before,
          after: request.after,
          kind: request.kind,
          origin: request.origin,
        });
      }
      if (event.type === "approval_resolved") {
        open.delete(event.payload.resolution.id);
      }
    }
    state.approvals = [...open.values()];
  }

  /**
   * Merge event snapshots without rendering the same event more than once.
   * The id is the cursor key; turn/type/payload are included so histories
   * created by older addon versions with reused ids still remain readable.
   */
  function eventKey(event: ConfuciusEvent): string {
    let payload: string;
    try {
      payload = JSON.stringify(event.payload) || "";
    } catch {
      payload = String(event.payload);
    }
    return `${event.id}\u0000${event.turnId ?? ""}\u0000${event.type}\u0000${payload}`;
  }

  function mergeEvents(
    existing: ConfuciusEvent[],
    incoming: ConfuciusEvent[],
    replace = false,
  ): ConfuciusEvent[] {
    const merged: ConfuciusEvent[] = [];
    const seen = new Set<string>();
    for (const event of replace ? incoming : [...existing, ...incoming]) {
      const key = eventKey(event);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(event);
    }
    return merged;
  }

  async function refreshSessions(): Promise<void> {
    const listed = (await rpc("task/list", {})) as {
      tasks?: SessionRow[];
    };
    state.sessions = listed.tasks || [];
    if (
      state.sessionId &&
      !state.sessions.some((task) => task.id === state.sessionId)
    )
      state.sessionId = null;
    if (!state.sessionId && !state.sessions.length)
      prompt.value = composerDrafts.get("new") ?? "";
    if (!state.sessionId && state.sessions[0]) {
      state.sessionId = state.sessions[0].id;
    }
    // The first poll restores the selected task without calling loadTask.
    // Hydrate its composer too, including a cached task retained across layouts.
    const selected = currentTask();
    if (selected && loadedComposerTaskId !== selected.id) {
      if (!composerDrafts.has(selected.id))
        composerDrafts.set(selected.id, selected.draft?.text ?? "");
      if (!referenceDrafts.has(selected.id))
        referenceDrafts.set(
          selected.id,
          selected.draft?.references ?? selected.references ?? [],
        );
      prompt.value = composerDrafts.get(selected.id) ?? "";
      loadedComposerTaskId = selected.id;
    }
  }

  async function sendPrompt(): Promise<void> {
    const enteredText = prompt.value.trim();
    const submittedReferences = currentReferences().map((ref) => ({ ...ref }));
    if (
      state.sending ||
      state.running ||
      presetUpdatePending ||
      modeUpdatePending ||
      modelUpdatePending
    ) {
      return;
    }
    if (pendingAttachments.some((item) => item.status === "preparing")) {
      status.style.color = "#8c6a3f";
      status.textContent = getString("workspace-attachment-wait");
      return;
    }
    if (pendingAttachments.some((item) => item.status === "error")) {
      state.sendError = getString("workspace-attachment-failed");
      renderLists();
      return;
    }
    const submittedAttachments = pendingAttachments.filter(
      (item): item is PendingAttachment & { record: TaskAttachment } =>
        item.status === "ready" && Boolean(item.record),
    );
    const text =
      enteredText ||
      (submittedAttachments.length
        ? getString("workspace-attachment-default-prompt")
        : "");
    if (!text) return;
    const submittedUiIds = new Set(
      submittedAttachments.map((item) => item.uiId),
    );
    const attachmentIds = submittedAttachments.map((item) => item.record.id);
    const selectedTask = currentTask();
    if (
      (selectedTask?.backend ?? "native") === "native" &&
      state.config &&
      !configReady(state.config)
    ) {
      state.sendError = getString("workspace-config-banner");
      renderLists();
      openSettings();
      return;
    }
    state.sending = true;
    state.sendError = "";
    state.pendingUserText = text;
    sendBtn.setAttribute("disabled", "true");
    status.style.color = "#8c6a3f";
    status.textContent = getString("workspace-sending");
    renderLists();
    try {
      if (!state.sessionId) {
        const lockedContext = contextWithPendingMentions(
          state.live?.lockedSnapshot,
        );
        const created = (await rpc("task/new", {
          title: (enteredText || submittedAttachments[0]?.name || text).slice(
            0,
            72,
          ),
          lockedContext,
          mode: state.mode,
        })) as SessionRow;
        state.sessionId = created.id;
        referenceDrafts.set(created.id, submittedReferences);
        referenceDrafts.delete("new");
        state.events = [];
        state.lastEventId = null;
        state.running = false;
        pendingMentionItems.clear();
      }
      // A user can select a permission mode and immediately press Send. Wait
      // for the queued session update so the visible mode is the mode used by
      // the turn that follows.
      await Promise.all([pendingPermissionUpdate, pendingContextUpdate]);
      const promptSessionId = state.sessionId;
      await refreshSessions();
      renderLists();
      const started = (await rpc("task/prompt", {
        taskId: promptSessionId,
        text,
        attachmentIds,
        references: submittedReferences,
      })) as { superseded?: boolean };
      for (let index = pendingAttachments.length - 1; index >= 0; index -= 1) {
        if (submittedUiIds.has(pendingAttachments[index].uiId)) {
          pendingAttachments.splice(index, 1);
        }
      }
      renderAttachmentTray();
      if (state.sessionId !== promptSessionId) {
        if (state.pendingUserText === text) {
          state.pendingUserText = "";
        }
        return;
      }
      // Keep text typed while the request was in flight; only clear the
      // submitted value when the composer was not edited concurrently.
      if (prompt.value.trim() === enteredText) {
        prompt.value = "";
        if (promptSessionId) composerDrafts.set(promptSessionId, "");
        rememberComposerDraft();
      }
      state.pendingUserText = "";
      state.running = !started.superseded;
      updateRunningUI();
      await refreshSessions();
      const requestedCursor = state.lastEventId;
      const bundle = (await rpc("task/events", {
        taskId: promptSessionId,
      })) as { events?: ConfuciusEvent[] };
      if (state.sessionId !== promptSessionId) {
        if (state.pendingUserText === text) {
          state.pendingUserText = "";
        }
        return;
      }
      const incoming = bundle.events || [];
      state.events = mergeEvents(state.events, incoming);
      if (incoming.length && state.lastEventId === requestedCursor) {
        state.lastEventId = incoming[incoming.length - 1].id;
      }
      if (state.events.length) {
        state.running = isRunningFromEvents(state.events);
      }
      collectApprovals();
      if (incoming.some((event) => event.type === "artifact_upserted")) {
        await refreshArtifacts(promptSessionId);
      }
      renderLists();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.sendError = message;
      status.style.color = "#b3452f";
      status.textContent = message;
      renderLists();
    } finally {
      state.sending = false;
      updateRunningUI();
    }
  }

  async function resolveApproval(
    id: string,
    verdict: "allow" | "deny",
    scope: "once" | "session",
  ) {
    await rpc("approval/resolve", { id, verdict, scope });
    collectApprovals();
    renderLists();
  }

  async function refreshConfig(): Promise<void> {
    try {
      state.config = (await rpc("config/get", {})) as ModelConfig;
    } catch {
      state.config = null;
    }
  }

  function openSettings(): void {
    const existing = doc.getElementById("confucius-settings-overlay");
    if (existing) {
      existing.remove();
      return;
    }
    const config = state.config;
    const returnFocus = doc.activeElement as HTMLElement | null;
    const overlay = el(doc, "div", undefined, {
      id: "confucius-settings-overlay",
      "aria-labelledby": "confucius-settings-title",
    });
    overlay.className = "confucius-dialog";
    const closeSettings = () => {
      doc.getElementById("confucius-security-profile-menu")?.remove();
      overlay.remove();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    bindDialogNavigation(overlay, closeSettings);
    const panel = el(doc, "div");
    panel.className = "confucius-dialog-panel confucius-settings-shell";
    panel.style.fontFamily =
      UI_FONT_STACKS[
        isUiFont(config?.uiFont) ? config.uiFont : DEFAULT_UI_FONT
      ];
    const header = el(doc, "header");
    header.className = "confucius-settings-header";
    const title = el(doc, "h2", undefined, { id: "confucius-settings-title" });
    title.className = "confucius-settings-title";
    title.textContent = getString("workspace-settings");
    const closeBtn = el(doc, "button", undefined, {
      id: "confucius-cfg-close",
      type: "button",
      title: getString("workspace-settings-cancel"),
      "aria-label": getString("workspace-settings-cancel"),
    });
    closeBtn.className = "confucius-icon-button";
    closeBtn.textContent = "×";
    closeBtn.style.fontSize = "24px";
    closeBtn.addEventListener("click", closeSettings);
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const tabBar = el(doc, "nav", undefined, {
      role: "tablist",
      "aria-label": getString("workspace-settings"),
    });
    tabBar.className = "confucius-settings-tabs";
    bindTabNavigation(tabBar);
    const settingsContent = el(doc, "div");
    settingsContent.className = "confucius-settings-content";
    const tabScrolls = new Map<string, number>();
    let selectedTab = "";
    const modelTab = el(doc, "div", {}, { id: "confucius-cfg-model-tab" });
    const runtimeTab = el(
      doc,
      "div",
      { display: "none" },
      { id: "confucius-cfg-runtime-tab" },
    );
    const memoryTab = el(
      doc,
      "div",
      { display: "none" },
      { id: "confucius-cfg-memory-tab" },
    );
    const securityTab = el(
      doc,
      "div",
      { display: "none" },
      { id: "confucius-cfg-security-tab" },
    );
    const appearanceTab = el(
      doc,
      "div",
      { display: "none" },
      { id: "confucius-cfg-appearance-tab" },
    );
    const updateTab = el(
      doc,
      "div",
      { display: "none" },
      { id: "confucius-cfg-update-tab" },
    );
    const makeTabButton = (id: string, label: string): HTMLElement => {
      const node = el(doc, "button", undefined, {
        id,
        type: "button",
        role: "tab",
      });
      node.textContent = label;
      tabBar.appendChild(node);
      return node;
    };
    const modelTabBtn = makeTabButton(
      "confucius-cfg-tab-model",
      getString("workspace-settings-tab-model"),
    );
    const appearanceTabBtn = makeTabButton(
      "confucius-cfg-tab-appearance",
      getString("workspace-settings-tab-appearance"),
    );
    const runtimeTabBtn = makeTabButton(
      "confucius-cfg-tab-runtime",
      getString("workspace-settings-tab-runtime"),
    );
    const memoryTabBtn = makeTabButton(
      "confucius-cfg-tab-memory",
      getString("workspace-settings-tab-memory"),
    );
    const securityTabBtn = makeTabButton(
      "confucius-cfg-tab-security",
      getString("workspace-settings-tab-security"),
    );
    const updateTabBtn = makeTabButton(
      "confucius-cfg-tab-update",
      getString("workspace-settings-tab-update"),
    );
    const setSettingsTab = (
      tab:
        "model" | "runtime" | "memory" | "security" | "appearance" | "update",
    ): void => {
      if (selectedTab) tabScrolls.set(selectedTab, settingsContent.scrollTop);
      selectedTab = tab;
      lastSettingsTab = tab;
      modelTab.style.display = tab === "model" ? "block" : "none";
      runtimeTab.style.display = tab === "runtime" ? "block" : "none";
      memoryTab.style.display = tab === "memory" ? "block" : "none";
      securityTab.style.display = tab === "security" ? "block" : "none";
      appearanceTab.style.display = tab === "appearance" ? "block" : "none";
      updateTab.style.display = tab === "update" ? "block" : "none";
      const pairs: Array<[HTMLElement, boolean]> = [
        [modelTabBtn, tab === "model"],
        [runtimeTabBtn, tab === "runtime"],
        [memoryTabBtn, tab === "memory"],
        [securityTabBtn, tab === "security"],
        [appearanceTabBtn, tab === "appearance"],
        [updateTabBtn, tab === "update"],
      ];
      for (const [btn, active] of pairs) {
        btn.setAttribute("aria-selected", String(active));
        btn.tabIndex = active ? 0 : -1;
        const targetId = btn.id.replace("-tab-", "-") + "-tab";
        btn.setAttribute("aria-controls", targetId);
        const target = settingsContent.querySelector<HTMLElement>(
          `#${targetId}`,
        );
        target?.setAttribute("role", "tabpanel");
        target?.setAttribute("aria-labelledby", btn.id);
      }
      settingsContent.scrollTop = tabScrolls.get(tab) ?? 0;
    };
    modelTabBtn.addEventListener("click", () => setSettingsTab("model"));
    runtimeTabBtn.addEventListener("click", () => setSettingsTab("runtime"));
    memoryTabBtn.addEventListener("click", () => setSettingsTab("memory"));
    securityTabBtn.addEventListener("click", () => setSettingsTab("security"));
    appearanceTabBtn.addEventListener("click", () =>
      setSettingsTab("appearance"),
    );
    updateTabBtn.addEventListener("click", () => setSettingsTab("update"));
    panel.appendChild(tabBar);
    settingsContent.appendChild(modelTab);
    settingsContent.appendChild(runtimeTab);
    settingsContent.appendChild(memoryTab);
    settingsContent.appendChild(securityTab);
    settingsContent.appendChild(appearanceTab);
    settingsContent.appendChild(updateTab);
    panel.appendChild(settingsContent);
    setSettingsTab(lastSettingsTab);

    let live: ModelConfig = config ?? {
      baseUrl: "",
      apiKey: "",
      model: "",
      maxTokens: 0,
      streamResponses: true,
      memoryAutoExtract: false,
      memoryConsent: "review",
      pluginRuntimeHost: true,
      reasoningEffort: "auto",
      contextWindowTokens: 32768,
      hasApiKey: false,
      configured: false,
      endpoints: [],
      activeEndpointId: "",
    };
    let editingId = live.activeEndpointId ?? "";

    const listLabel = el(doc, "div", {
      fontSize: "11px",
      color: "#6b665c",
      marginBottom: "4px",
    });
    listLabel.textContent = getString("workspace-endpoints");
    modelTab.appendChild(listLabel);
    const listBox = el(doc, "div");
    listBox.className = "confucius-endpoint-list";
    modelTab.appendChild(listBox);
    const addBtn = button(
      doc,
      "confucius-cfg-add",
      getString("workspace-endpoint-add"),
    );

    addBtn.style.marginBottom = "12px";
    modelTab.appendChild(addBtn);

    const field = (label: string, id: string, value: string, type = "text") => {
      const row = el(doc, "div");
      row.className = "confucius-settings-field";
      const name = el(doc, "label", undefined, { for: id });
      name.textContent = label;
      const input = el(
        doc,
        "input",
        { display: "block", width: "100%" },
        { id, type, value },
      ) as HTMLInputElement;
      row.appendChild(name);
      row.appendChild(input);
      modelTab.appendChild(row);
      return input;
    };

    const nameInput = field(
      getString("workspace-endpoint-name"),
      "confucius-cfg-name",
      "",
    );
    const baseUrlInput = field(
      getString("workspace-base-url"),
      "confucius-cfg-baseUrl",
      "",
    );
    const apiKeyInput = field(
      getString("workspace-api-key"),
      "confucius-cfg-apiKey",
      "",
      "password",
    );
    const modelInput = field(
      getString("workspace-model"),
      "confucius-cfg-model",
      "",
    );
    const maxTokensInput = field(
      getString("workspace-max-tokens"),
      "confucius-cfg-maxTokens",
      "0",
      "number",
    );

    const check = (label: string, id: string, checked: boolean) => {
      const row = el(doc, "div", { marginBottom: "8px" });
      const input = el(
        doc,
        "input",
        { marginRight: "6px" },
        { id, type: "checkbox" },
      ) as HTMLInputElement;
      input.checked = checked;
      const text = doc.createElementNS(HTML_NS, "label") as HTMLElement;
      text.textContent = label;
      text.setAttribute("for", id);
      row.appendChild(input);
      row.appendChild(text);
      modelTab.appendChild(row);
      return input;
    };
    const contextInput = field(
      getString("workspace-context-window"),
      "confucius-cfg-contextWindowTokens",
      "32768",
      "number",
    );
    const effortRow = el(doc, "div", { marginBottom: "10px" });
    const effortLabel = el(doc, "label", {
      display: "block",
      fontSize: "11px",
      color: "#6b665c",
      marginBottom: "3px",
    });
    effortLabel.textContent = getString("workspace-thinking");
    const effort = effortPicker(doc, "confucius-cfg-effort", "auto");
    effortRow.appendChild(effortLabel);
    effortRow.appendChild(effort.node);
    modelTab.appendChild(effortRow);
    const advanced = el(doc, "details");
    advanced.className = "confucius-settings-advanced";
    const advancedTitle = el(doc, "summary");
    advancedTitle.textContent = getString("workspace-settings-advanced");
    advanced.append(
      advancedTitle,
      maxTokensInput.parentElement!,
      contextInput.parentElement!,
    );
    modelTab.appendChild(advanced);

    const stream = check(
      getString("workspace-stream-responses"),
      "confucius-cfg-stream",
      live.streamResponses !== false,
    );
    const iterationsInput = field(
      getString("workspace-max-iterations"),
      "confucius-cfg-maxIterations",
      String(live.maxIterations ?? DEFAULT_MAX_ITERATIONS),
      "number",
    );
    const toolCallsInput = field(
      getString("workspace-max-tool-calls"),
      "confucius-cfg-maxToolCalls",
      String(live.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS),
      "number",
    );

    let memoryChoice: MemoryConsent = live.memoryConsent ?? "review";
    const sectionIntro = (target: HTMLElement, text: string): void => {
      const intro = el(doc, "p", {
        margin: "0 0 12px",
        color: "#6b665c",
        lineHeight: "1.5",
      });
      intro.textContent = text;
      target.appendChild(intro);
    };

    sectionIntro(runtimeTab, getString("workspace-runtime-help"));
    const runtimeHostRow = el(doc, "label", {
      display: "grid",
      gridTemplateColumns: "18px minmax(0, 1fr)",
      gap: "8px",
      alignItems: "start",
      marginBottom: "10px",
      cursor: "pointer",
    });
    const runtimeHostToggle = el(doc, "input", undefined, {
      id: "confucius-runtime-host-enabled",
      type: "checkbox",
    }) as HTMLInputElement;
    runtimeHostToggle.checked = live.pluginRuntimeHost !== false;
    const runtimeHostCopy = el(doc, "span");
    runtimeHostCopy.textContent = getString("workspace-runtime-host-toggle");
    runtimeHostRow.appendChild(runtimeHostToggle);
    runtimeHostRow.appendChild(runtimeHostCopy);
    const runtimeHostLine = el(doc, "div", {
      marginBottom: "10px",
      fontWeight: "650",
    });
    const runtimeList = el(doc, "div", {
      marginBottom: "12px",
      borderTop: "0",
    });
    const runtimeActions = el(doc, "div", {
      display: "flex",
      flexWrap: "wrap",
      gap: "8px",
      marginBottom: "14px",
    });
    const runtimeRefresh = button(
      doc,
      "confucius-runtime-refresh",
      getString("workspace-runtime-refresh"),
    );
    const runtimeError = el(doc, "div", {
      minHeight: "18px",
      color: "#b3452f",
    });
    const executableInputs = new Map<
      Exclude<AgentBackendKind, "native">,
      HTMLInputElement
    >();

    const configureExecutable = async (
      backend: Exclude<AgentBackendKind, "native">,
      input: HTMLInputElement,
    ): Promise<void> => {
      runtimeError.textContent = "";
      await rpc("runtime/configure", {
        backend,
        executable: input.value.trim(),
      });
      await refreshRuntimes(true);
      paintRuntimePanel();
    };

    const executableEditor = (
      backend: Exclude<AgentBackendKind, "native">,
    ): HTMLElement => {
      const wrap = el(doc, "div", {
        marginBottom: "12px",
        padding: "10px",
        border: "0",
        borderRadius: "8px",
      });
      const label = el(doc, "label", {
        display: "block",
        color: "#6b665c",
        fontSize: "11px",
        marginBottom: "5px",
      });
      label.textContent = getString(`workspace-runtime-${backend}-label`);
      const input = el(
        doc,
        "input",
        {
          width: "100%",
          height: "32px",
          padding: "0 8px",
          boxSizing: "border-box",
          border: "0",
          borderRadius: "7px",
        },
        {
          id: `confucius-runtime-${backend}-path`,
          type: "text",
          placeholder: getString("workspace-runtime-path-auto"),
        },
      ) as HTMLInputElement;
      const actions = el(doc, "div", {
        display: "flex",
        flexWrap: "wrap",
        gap: "7px",
        marginTop: "7px",
      });
      const browse = button(
        doc,
        `confucius-runtime-${backend}-browse`,
        getString("workspace-runtime-browse"),
      );
      const apply = button(
        doc,
        `confucius-runtime-${backend}-save`,
        getString("workspace-runtime-save"),
      );
      const automatic = button(
        doc,
        `confucius-runtime-${backend}-auto`,
        getString("workspace-runtime-auto"),
      );
      browse.addEventListener("click", () => {
        if (!win) return;
        void pickRuntimeExecutable(
          win,
          getString(`workspace-runtime-${backend}-label`),
        )
          .then(async (path) => {
            if (!path) return;
            input.value = path;
            await configureExecutable(backend, input);
          })
          .catch((error) => {
            runtimeError.textContent =
              error instanceof Error ? error.message : String(error);
          });
      });
      apply.addEventListener("click", () => {
        void configureExecutable(backend, input).catch((error) => {
          runtimeError.textContent =
            error instanceof Error ? error.message : String(error);
        });
      });
      automatic.addEventListener("click", () => {
        input.value = "";
        void configureExecutable(backend, input).catch((error) => {
          runtimeError.textContent =
            error instanceof Error ? error.message : String(error);
        });
      });
      actions.appendChild(browse);
      actions.appendChild(apply);
      actions.appendChild(automatic);
      wrap.appendChild(label);
      wrap.appendChild(input);
      wrap.appendChild(actions);
      executableInputs.set(backend, input);
      return wrap;
    };

    const paintRuntimePanel = (): void => {
      runtimeHostToggle.checked = state.runtimeHostEnabled;
      runtimeHostLine.textContent = state.runtimeHostEnabled
        ? getString("workspace-runtime-host-enabled")
        : getString("workspace-runtime-host-disabled");
      runtimeList.textContent = "";
      const runtimes: RuntimeStatus[] = [
        runtimeStatus("native")!,
        ...(["codex", "kimi"] as const).map(
          (backend) =>
            runtimeStatus(backend) ?? {
              backend,
              state: "unavailable" as const,
              message: getString("workspace-runtime-not-detected"),
              checkedAt: Date.now(),
            },
        ),
      ];
      for (const runtime of runtimes) {
        const row = el(doc, "div", {
          display: "grid",
          gridTemplateColumns: "12px minmax(80px, .45fr) minmax(0, 1fr)",
          gap: "7px",
          alignItems: "start",
          padding: "9px 2px",
          borderBottom: "0",
        });
        const dot = el(doc, "span", { marginTop: "5px" });
        dot.className = "confucius-runtime-dot";
        dot.setAttribute("data-state", runtime.state);
        const identity = el(doc, "div", { fontWeight: "650" });
        identity.textContent = `${runtimeLabel(runtime.backend)}${
          runtime.version ? ` ${runtime.version}` : ""
        }`;
        const detail = el(doc, "div", {
          minWidth: "0px",
          color: runtime.state === "error" ? "#b3452f" : "#6b665c",
          overflowWrap: "anywhere",
        });
        detail.textContent = `${getString(
          `workspace-runtime-state-${runtime.state.replace(/_/g, "-")}`,
        )}${runtime.message ? ` · ${runtime.message}` : ""}${
          runtime.executable
            ? ` · ${getString("workspace-runtime-resolved")}: ${runtime.executable}`
            : ""
        }`;
        row.appendChild(dot);
        row.appendChild(identity);
        row.appendChild(detail);
        runtimeList.appendChild(row);
        if (runtime.backend === "codex" || runtime.backend === "kimi") {
          const input = executableInputs.get(runtime.backend);
          if (input && doc.activeElement !== input) {
            input.value = runtime.configuredExecutable ?? "";
          }
        }
      }
    };
    runtimeHostToggle.addEventListener("change", () => {
      void (async () => {
        runtimeHostToggle.disabled = true;
        runtimeError.textContent = "";
        const listed = (await rpc("runtime/setPluginHost", {
          enabled: runtimeHostToggle.checked,
        })) as RuntimeListResult;
        state.runtimeHostEnabled = listed.runtimeHostEnabled;
        state.runtimeHostConnected = listed.runtimeHostConnected;
        state.runtimes = listed.runtimes;
        live.pluginRuntimeHost = listed.runtimeHostEnabled;
        if (state.config) {
          state.config.pluginRuntimeHost = listed.runtimeHostEnabled;
        }
        paintRuntimePanel();
      })()
        .catch((error) => {
          runtimeHostToggle.checked = !runtimeHostToggle.checked;
          runtimeError.textContent =
            error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          runtimeHostToggle.disabled = false;
        });
    });
    runtimeRefresh.addEventListener("click", () => {
      void (async () => {
        runtimeRefresh.setAttribute("disabled", "true");
        runtimeError.textContent = "";
        await refreshRuntimes(true);
        paintRuntimePanel();
        runtimeRefresh.removeAttribute("disabled");
      })().catch((error) => {
        runtimeError.textContent =
          error instanceof Error ? error.message : String(error);
        runtimeRefresh.removeAttribute("disabled");
      });
    });
    runtimeActions.appendChild(runtimeRefresh);
    runtimeTab.appendChild(runtimeHostRow);
    runtimeTab.appendChild(runtimeHostLine);
    runtimeTab.appendChild(runtimeList);
    runtimeTab.appendChild(runtimeActions);
    runtimeTab.appendChild(executableEditor("codex"));
    runtimeTab.appendChild(executableEditor("kimi"));
    runtimeTab.appendChild(runtimeError);
    paintRuntimePanel();

    sectionIntro(memoryTab, getString("workspace-memory-consent-help"));
    const memoryModes = el(doc, "div", {
      display: "grid",
      gap: "6px",
      marginBottom: "16px",
    });
    for (const choice of ["off", "review", "auto"] as const) {
      const label = el(doc, "label", {
        display: "grid",
        gridTemplateColumns: "18px minmax(0, 1fr)",
        gap: "7px",
        alignItems: "start",
        padding: "8px",
        border: "0",
        borderRadius: "7px",
        cursor: "pointer",
      });
      const input = el(doc, "input", undefined, {
        type: "radio",
        name: "confucius-memory-consent",
        value: choice,
      }) as HTMLInputElement;
      input.checked = memoryChoice === choice;
      input.addEventListener("change", () => {
        if (input.checked) memoryChoice = choice;
      });
      const copy = el(doc, "div");
      const name = el(doc, "div", { fontWeight: "650" });
      name.textContent = getString(`workspace-memory-${choice}`);
      const help = el(doc, "div", { color: "#6b665c", fontSize: ".9em" });
      help.textContent = getString(`workspace-memory-${choice}-help`);
      copy.appendChild(name);
      copy.appendChild(help);
      label.appendChild(input);
      label.appendChild(copy);
      memoryModes.appendChild(label);
    }
    memoryTab.appendChild(memoryModes);
    const proposalHeading = el(doc, "div", {
      marginBottom: "6px",
      fontSize: "11px",
      color: "#6b665c",
      fontWeight: "700",
      letterSpacing: ".07em",
      textTransform: "uppercase",
    });
    proposalHeading.textContent = getString("workspace-memory-proposals");
    const proposalList = el(doc, "div");
    const paintMemoryProposals = (): void => {
      proposalList.textContent = "";
      const pending = state.memoryProposals.filter(
        (proposal) => proposal.status === "pending",
      );
      if (!pending.length) {
        proposalList.appendChild(
          muted(doc, getString("workspace-memory-no-proposals")),
        );
        return;
      }
      for (const proposal of pending) {
        const row = el(doc, "div", {
          padding: "10px 0",
          borderTop: "0",
        });
        const op = el(doc, "div", {
          marginBottom: "5px",
          color: "#8a4b26",
          fontSize: "11px",
          fontWeight: "700",
          textTransform: "uppercase",
        });
        op.textContent = `${proposal.op} · ${proposal.type ?? "memory"}`;
        const titleInput = el(
          doc,
          "input",
          {
            width: "100%",
            height: "31px",
            marginBottom: "5px",
            padding: "0 7px",
            boxSizing: "border-box",
            border: "0",
            borderRadius: "6px",
          },
          { type: "text", value: proposal.title ?? "" },
        ) as HTMLInputElement;
        const contentInput = el(doc, "textarea", {
          width: "100%",
          minHeight: "74px",
          padding: "7px",
          boxSizing: "border-box",
          border: "0",
          borderRadius: "6px",
          resize: "vertical",
        }) as HTMLTextAreaElement;
        contentInput.value = proposal.content ?? "";
        titleInput.disabled = proposal.op === "delete";
        contentInput.disabled = proposal.op === "delete";
        const buttons = el(doc, "div", {
          display: "flex",
          gap: "6px",
          marginTop: "6px",
        });
        const accept = button(
          doc,
          "",
          getString("workspace-memory-accept"),
          "primary",
        );
        const reject = button(doc, "", getString("workspace-memory-reject"));
        const resolve = (verdict: "accept" | "reject"): void => {
          void (async () => {
            await rpc("memory/proposal/resolve", {
              id: proposal.id,
              verdict,
              edited: {
                title: titleInput.value,
                content: contentInput.value,
                tags: proposal.tags,
                type: proposal.type,
              },
            });
            await refreshMemoryProposals();
            await refreshMemories();
            paintMemoryProposals();
          })().catch((error) => {
            runtimeError.textContent =
              error instanceof Error ? error.message : String(error);
          });
        };
        accept.addEventListener("click", () => resolve("accept"));
        reject.addEventListener("click", () => resolve("reject"));
        buttons.appendChild(accept);
        buttons.appendChild(reject);
        row.appendChild(op);
        row.appendChild(titleInput);
        row.appendChild(contentInput);
        row.appendChild(buttons);
        proposalList.appendChild(row);
      }
    };
    memoryTab.appendChild(proposalHeading);
    memoryTab.appendChild(proposalList);
    paintMemoryProposals();

    const settingsTask = currentTask();
    type SecurityProfile = "zotero_only" | "workspace";
    const securityProfileOptions: Array<{
      value: SecurityProfile;
      label: string;
    }> = [
      {
        value: "zotero_only",
        label: getString("workspace-security-zotero-only"),
      },
      {
        value: "workspace",
        label: getString("workspace-security-workspace"),
      },
    ];
    let securityProfile: SecurityProfile =
      settingsTask?.capabilityProfile === "workspace"
        ? "workspace"
        : "zotero_only";
    sectionIntro(securityTab, getString("workspace-security-help"));
    if (!settingsTask) {
      securityTab.appendChild(
        muted(doc, getString("workspace-security-no-task")),
      );
    }
    const profileTrigger = el(doc, "button", undefined, {
      id: "confucius-security-profile",
      type: "button",
      "aria-haspopup": "listbox",
      "aria-controls": "confucius-security-profile-menu",
      "aria-expanded": "false",
    }) as HTMLButtonElement;
    profileTrigger.className = "confucius-settings-select";
    profileTrigger.disabled = !settingsTask;
    const profileValue = el(doc, "span");
    profileValue.className = "confucius-settings-select-value";
    const profileChevron = el(doc, "span", undefined, {
      "aria-hidden": "true",
    });
    profileChevron.className = "confucius-settings-select-chevron";
    profileChevron.textContent = "▾";
    profileTrigger.appendChild(profileValue);
    profileTrigger.appendChild(profileChevron);
    const workingDirectory = el(
      doc,
      "input",
      {
        width: "100%",
        height: "34px",
        marginBottom: "8px",
        padding: "0 8px",
        boxSizing: "border-box",
        border: "0",
        borderRadius: "7px",
      },
      {
        id: "confucius-security-working-directory",
        type: "text",
        value: settingsTask?.workingDirectory ?? "",
        placeholder: getString("workspace-security-directory"),
      },
    ) as HTMLInputElement;
    const confirmDirectory = el(doc, "input", undefined, {
      id: "confucius-security-confirm",
      type: "checkbox",
    }) as HTMLInputElement;
    confirmDirectory.checked = settingsTask?.capabilityProfile === "workspace";
    const confirmLabel = el(doc, "label", {
      display: "flex",
      gap: "6px",
      alignItems: "flex-start",
      marginBottom: "12px",
      color: "#6b665c",
    });
    const confirmCopy = el(doc, "span");
    confirmCopy.textContent = getString("workspace-security-confirm");
    confirmLabel.appendChild(confirmDirectory);
    confirmLabel.appendChild(confirmCopy);
    const securityPathStatus = el(doc, "div", {
      minHeight: "18px",
      margin: "-2px 0 8px",
      color: "#6b665c",
      fontSize: "11px",
      overflowWrap: "anywhere",
    });
    let capabilityPreviewPending: Promise<boolean> | null = null;
    const previewSecurityDirectory = (): Promise<boolean> => {
      if (!settingsTask || securityProfile !== "workspace") {
        return Promise.resolve(true);
      }
      const requested = workingDirectory.value.trim();
      const pending = (async () => {
        const preview = (await rpc("task/previewCapabilities", {
          taskId: settingsTask.id,
          capabilityProfile: "workspace",
          workingDirectory: requested,
        })) as {
          workingDirectory?: string;
          confirmationRequired: boolean;
        };
        if (workingDirectory.value.trim() !== requested) return false;
        const normalized = preview.workingDirectory ?? "";
        if (normalized && normalized !== requested) {
          workingDirectory.value = normalized;
          confirmDirectory.checked = false;
          securityPathStatus.textContent = `${getString(
            "workspace-security-normalized-changed",
          )} ${normalized}`;
          return false;
        }
        securityPathStatus.textContent = `${getString(
          "workspace-security-directory-preview",
        )} ${normalized}`;
        return true;
      })().catch((error) => {
        confirmDirectory.checked = false;
        securityPathStatus.textContent =
          error instanceof Error ? error.message : String(error);
        return false;
      });
      capabilityPreviewPending = pending;
      void pending.finally(() => {
        if (capabilityPreviewPending === pending) {
          capabilityPreviewPending = null;
        }
      });
      return pending;
    };
    const paintSecurity = (): void => {
      const workspace = securityProfile === "workspace";
      workingDirectory.style.display = workspace ? "block" : "none";
      securityPathStatus.style.display = workspace ? "block" : "none";
      confirmLabel.style.display = workspace ? "flex" : "none";
    };
    const syncSecurityProfileTrigger = (): void => {
      const selected =
        securityProfileOptions.find(
          (option) => option.value === securityProfile,
        ) ?? securityProfileOptions[0];
      profileValue.textContent = selected.label;
      profileTrigger.title = selected.label;
      profileTrigger.setAttribute(
        "aria-label",
        `${getString("workspace-settings-tab-security")}: ${selected.label}`,
      );
    };
    const closeSecurityProfileMenu = (restoreFocus = false): void => {
      doc.getElementById("confucius-security-profile-menu")?.remove();
      profileTrigger.setAttribute("aria-expanded", "false");
      if (restoreFocus && profileTrigger.isConnected) profileTrigger.focus();
    };
    const selectSecurityProfile = (value: SecurityProfile): void => {
      securityProfile = value;
      syncSecurityProfileTrigger();
      closeSecurityProfileMenu(true);
      paintSecurity();
      securityPathStatus.textContent = "";
      if (
        securityProfile === "workspace" &&
        settingsTask?.capabilityProfile !== "workspace"
      ) {
        confirmDirectory.checked = false;
      }
    };
    const renderSecurityProfileMenu = (): void => {
      closeSecurityProfileMenu(false);
      const menu = menuPanel("confucius-security-profile-menu", {
        zIndex: "1100",
      });
      menu.classList.add("confucius-settings-choice-menu");
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-labelledby", profileTrigger.id);
      for (const option of securityProfileOptions) {
        const selected = option.value === securityProfile;
        const row = el(doc, "button", undefined, {
          type: "button",
          role: "option",
          "data-security-profile": option.value,
          "data-selected": selected ? "true" : "false",
          "aria-selected": selected ? "true" : "false",
        });
        row.className = "confucius-settings-choice";
        const label = el(doc, "span");
        label.className = "confucius-settings-choice-label";
        label.textContent = option.label;
        const checkmark = el(doc, "span", undefined, {
          "aria-hidden": "true",
        });
        checkmark.className = "confucius-settings-choice-check";
        checkmark.textContent = selected ? "✓" : "";
        row.appendChild(label);
        row.appendChild(checkmark);
        row.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          selectSecurityProfile(option.value);
        });
        menu.appendChild(row);
      }
      menu.addEventListener("keydown", (event) => {
        const key = (event as KeyboardEvent).key;
        if (key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeSecurityProfileMenu(true);
          return;
        }
        if (key === "Tab") {
          closeSecurityProfileMenu(false);
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return;
        event.preventDefault();
        const rows = Array.from(
          menu.querySelectorAll(".confucius-settings-choice"),
        ) as HTMLElement[];
        if (!rows.length) return;
        const current = rows.indexOf(doc.activeElement as HTMLElement);
        const index =
          key === "Home"
            ? 0
            : key === "End"
              ? rows.length - 1
              : key === "ArrowUp"
                ? (current - 1 + rows.length) % rows.length
                : (current + 1) % rows.length;
        rows[index]?.focus();
      });
      profileTrigger.setAttribute("aria-expanded", "true");
      const triggerWidth = profileTrigger.getBoundingClientRect().width;
      placeMenu(
        profileTrigger,
        menu,
        Math.max(180, triggerWidth),
        "auto",
        overlay,
      );
      const selected = menu.querySelector(
        '[data-selected="true"]',
      ) as HTMLElement | null;
      (selected ?? (menu.firstElementChild as HTMLElement | null))?.focus();
    };
    profileTrigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (doc.getElementById("confucius-security-profile-menu")) {
        closeSecurityProfileMenu(true);
      } else {
        renderSecurityProfileMenu();
      }
    });
    profileTrigger.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!doc.getElementById("confucius-security-profile-menu")) {
        renderSecurityProfileMenu();
      }
    });
    overlay.addEventListener("mousedown", (event) => {
      const menu = doc.getElementById("confucius-security-profile-menu");
      const target = event.target as Node | null;
      if (
        menu &&
        (!target ||
          (!profileTrigger.contains(target) && !menu.contains(target)))
      ) {
        closeSecurityProfileMenu(false);
      }
    });
    panel.addEventListener("scroll", () => closeSecurityProfileMenu(false));
    workingDirectory.addEventListener("input", () => {
      confirmDirectory.checked = false;
      securityPathStatus.textContent = "";
    });
    confirmDirectory.addEventListener("change", () => {
      if (confirmDirectory.checked) void previewSecurityDirectory();
    });
    syncSecurityProfileTrigger();
    securityTab.appendChild(profileTrigger);
    securityTab.appendChild(workingDirectory);
    securityTab.appendChild(securityPathStatus);
    securityTab.appendChild(confirmLabel);
    paintSecurity();

    let fontChoice: UiFont = isUiFont(live.uiFont)
      ? live.uiFont
      : DEFAULT_UI_FONT;
    let sizeChoice = clampUiFontSize(live.uiFontSize ?? DEFAULT_UI_FONT_SIZE);
    let languageChoice: UiLanguage = isUiLanguage(live.uiLanguage)
      ? live.uiLanguage
      : "en-US";
    let lineHeightChoice: UiLineHeight = isUiLineHeight(live.uiLineHeight)
      ? live.uiLineHeight
      : DEFAULT_UI_LINE_HEIGHT;

    const appearanceLabel = (text: string): void => {
      const name = el(doc, "label", {
        display: "block",
        fontSize: "11px",
        color: "#6b665c",
        marginBottom: "3px",
        marginTop: "10px",
      });
      name.textContent = text;
      appearanceTab.appendChild(name);
    };

    const segmentedRow = (
      id: string,
    ): { row: HTMLElement; buttons: Map<string, HTMLElement> } => {
      const row = el(
        doc,
        "div",
        { display: "flex", flexWrap: "wrap", gap: "4px" },
        { id, role: "radiogroup" },
      );
      appearanceTab.appendChild(row);
      return { row, buttons: new Map() };
    };
    const paintSegmented = (
      buttons: Map<string, HTMLElement>,
      current: string,
    ): void => {
      for (const [value, btn] of buttons) {
        const active = value === current;
        Object.assign(btn.style, {
          background: active ? "#33302a" : "#ffffff",
          color: active ? "#f5f3ee" : "#33302a",
          border: `1px solid ${active ? "#33302a" : "#ddd8cc"}`,
          fontWeight: active ? "600" : "400",
        });
        btn.setAttribute("aria-checked", active ? "true" : "false");
      }
    };

    appearanceLabel(getString("workspace-ui-language"));
    const languagePicker = segmentedRow("confucius-cfg-language");
    for (const language of ["zh-CN", "en-US"] as UiLanguage[]) {
      const btn = el(
        doc,
        "button",
        {
          appearance: "none",
          padding: "4px 10px",
          borderRadius: "8px",
          cursor: "pointer",
          font: "inherit",
          minHeight: "28px",
          lineHeight: "1.2",
        },
        { type: "button", role: "radio", "data-language": language },
      );
      btn.textContent = getString(
        language === "zh-CN"
          ? "workspace-ui-language-zh"
          : "workspace-ui-language-en",
      );
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        languageChoice = language;
        paintSegmented(languagePicker.buttons, languageChoice);
      });
      languagePicker.buttons.set(language, btn);
      languagePicker.row.appendChild(btn);
    }

    appearanceLabel(getString("workspace-font-family"));
    const fontPicker = segmentedRow("confucius-cfg-font");
    for (const font of ["sans", "serif", "mono"] as UiFont[]) {
      const btn = el(
        doc,
        "button",
        {
          appearance: "none",
          padding: "4px 10px",
          borderRadius: "8px",
          cursor: "pointer",
          font: "inherit",
          fontFamily: UI_FONT_STACKS[font],
          minHeight: "28px",
          lineHeight: "1.2",
        },
        { type: "button", role: "radio", "data-font": font },
      );
      btn.textContent = `${getString(`workspace-font-${font}`)} · Aa永`;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (fontChoice === font) {
          return;
        }
        fontChoice = font;
        paintSegmented(fontPicker.buttons, fontChoice);
        repaintFontPreview();
      });
      fontPicker.buttons.set(font, btn);
      fontPicker.row.appendChild(btn);
    }

    appearanceLabel(getString("workspace-font-size"));
    const sizePicker = segmentedRow("confucius-cfg-font-size");
    for (const size of [12, 13, 14, 16]) {
      const btn = el(
        doc,
        "button",
        {
          appearance: "none",
          padding: "4px 10px",
          borderRadius: "8px",
          cursor: "pointer",
          font: "inherit",
          minHeight: "28px",
          lineHeight: "1.2",
        },
        { type: "button", role: "radio", "data-font-size": String(size) },
      );
      btn.textContent = `${size}px`;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (sizeChoice === size) {
          return;
        }
        sizeChoice = size;
        paintSegmented(sizePicker.buttons, String(sizeChoice));
        repaintFontPreview();
      });
      sizePicker.buttons.set(String(size), btn);
      sizePicker.row.appendChild(btn);
    }

    appearanceLabel(getString("workspace-line-height"));
    const lineHeightPicker = segmentedRow("confucius-cfg-line-height");
    for (const lineHeight of [
      "compact",
      "standard",
      "relaxed",
    ] as UiLineHeight[]) {
      const btn = el(
        doc,
        "button",
        {
          appearance: "none",
          padding: "4px 10px",
          borderRadius: "8px",
          cursor: "pointer",
          font: "inherit",
          minHeight: "28px",
          lineHeight: "1.2",
        },
        { type: "button", role: "radio", "data-line-height": lineHeight },
      );
      btn.textContent = getString(`workspace-line-height-${lineHeight}`);
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        lineHeightChoice = lineHeight;
        paintSegmented(lineHeightPicker.buttons, lineHeightChoice);
        repaintFontPreview();
      });
      lineHeightPicker.buttons.set(lineHeight, btn);
      lineHeightPicker.row.appendChild(btn);
    }

    const fontPreview = el(doc, "div", {
      border: "0",
      borderRadius: "8px",
      background: "#faf9f6",
      padding: "12px",
      marginTop: "12px",
      lineHeight: "1.6",
      color: "#33302a",
    });
    fontPreview.textContent = getString("workspace-font-preview");
    appearanceTab.appendChild(fontPreview);
    const repaintFontPreview = (): void => {
      fontPreview.style.fontFamily = UI_FONT_STACKS[fontChoice];
      fontPreview.style.fontSize = `${sizeChoice}px`;
      fontPreview.style.lineHeight = String(
        UI_LINE_HEIGHT_VALUES[lineHeightChoice],
      );
    };
    paintSegmented(languagePicker.buttons, languageChoice);
    paintSegmented(fontPicker.buttons, fontChoice);
    paintSegmented(sizePicker.buttons, String(sizeChoice));
    paintSegmented(lineHeightPicker.buttons, lineHeightChoice);
    repaintFontPreview();

    const updateHeading = el(doc, "div", {
      fontWeight: "700",
      fontSize: "14px",
      marginBottom: "5px",
    });
    updateHeading.textContent = getString("workspace-update-title");
    const updateHelp = el(doc, "div", {
      color: "#6b665c",
      fontSize: "12px",
      marginBottom: "14px",
    });
    updateHelp.textContent = getString("workspace-update-help");
    const updateVersion = el(doc, "div", {
      padding: "10px 0",
      borderTop: "0",
      borderBottom: "0",
      fontWeight: "600",
    });
    const autoUpdateRow = el(doc, "label", {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "13px 0 8px",
      cursor: "pointer",
    });
    const autoUpdateToggle = el(
      doc,
      "input",
      {},
      { id: "confucius-cfg-auto-update", type: "checkbox" },
    ) as HTMLInputElement;
    const autoUpdateCopy = el(doc, "span");
    autoUpdateCopy.textContent = getString("workspace-update-auto");
    autoUpdateRow.appendChild(autoUpdateToggle);
    autoUpdateRow.appendChild(autoUpdateCopy);
    const updateStateLine = el(doc, "div", {
      minHeight: "20px",
      margin: "5px 0 10px",
      color: "#6b665c",
    });
    const updateButtons = el(doc, "div", {
      display: "flex",
      flexWrap: "wrap",
      gap: "8px",
    });
    const checkUpdate = button(
      doc,
      "confucius-cfg-check-update",
      getString("workspace-update-check"),
    );
    const installUpdate = button(
      doc,
      "confucius-cfg-install-update",
      getString("workspace-update-install"),
      "primary",
    );
    updateButtons.appendChild(checkUpdate);
    updateButtons.appendChild(installUpdate);
    updateTab.appendChild(updateHeading);
    updateTab.appendChild(updateHelp);
    updateTab.appendChild(updateVersion);
    updateTab.appendChild(autoUpdateRow);
    updateTab.appendChild(updateStateLine);
    updateTab.appendChild(updateButtons);

    let updateView: UpdateStatus | null = null;
    let updateBusy = false;
    const paintUpdate = (): void => {
      updateVersion.textContent = `${getString("workspace-update-current")} ${
        updateView?.currentVersion ?? "—"
      }`;
      autoUpdateToggle.checked = updateView?.autoUpdate !== false;
      autoUpdateToggle.disabled = updateBusy || !updateView;
      (checkUpdate as HTMLButtonElement).disabled = updateBusy;
      (installUpdate as HTMLButtonElement).disabled =
        updateBusy || !updateView?.canInstall;
      const stateName = updateView?.state ?? "idle";
      const version = updateView?.availableVersion
        ? ` · v${updateView.availableVersion}`
        : "";
      updateStateLine.textContent = `${getString(
        `workspace-update-state-${stateName}`,
      )}${version}${updateView?.message ? ` · ${updateView.message}` : ""}`;
      updateStateLine.style.color =
        stateName === "error" ? "#b3452f" : "#6b665c";
    };
    const runUpdateAction = async (
      method: "update/status" | "update/check" | "update/install",
    ): Promise<void> => {
      updateBusy = true;
      if (updateView && method === "update/check") {
        updateView = { ...updateView, state: "checking", canInstall: false };
      } else if (updateView && method === "update/install") {
        updateView = { ...updateView, state: "downloading", canInstall: false };
      }
      paintUpdate();
      try {
        updateView = (await rpc(method, {})) as UpdateStatus;
      } catch (error) {
        updateView = {
          currentVersion: updateView?.currentVersion ?? "—",
          autoUpdate: updateView?.autoUpdate !== false,
          state: "error",
          canInstall: false,
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        updateBusy = false;
        paintUpdate();
      }
    };
    checkUpdate.addEventListener("click", () => {
      void runUpdateAction("update/check");
    });
    installUpdate.addEventListener("click", () => {
      void runUpdateAction("update/install");
    });
    autoUpdateToggle.addEventListener("change", () => {
      const enabled = autoUpdateToggle.checked;
      updateBusy = true;
      paintUpdate();
      void rpc("update/setAuto", { enabled })
        .then((next) => {
          updateView = next as UpdateStatus;
        })
        .catch((error) => {
          updateView = {
            currentVersion: updateView?.currentVersion ?? "—",
            autoUpdate: !enabled,
            state: "error",
            canInstall: updateView?.canInstall ?? false,
            message: error instanceof Error ? error.message : String(error),
          };
        })
        .finally(() => {
          updateBusy = false;
          paintUpdate();
        });
    });
    paintUpdate();

    const actions = el(doc, "footer");
    actions.className = "confucius-settings-footer";
    const errorLine = el(doc, "div", undefined, {
      role: "status",
      "aria-live": "polite",
    });
    errorLine.className = "confucius-settings-feedback";
    const save = button(
      doc,
      "confucius-cfg-save",
      getString("workspace-settings-save"),
      "primary",
    );
    const cancel = button(
      doc,
      "confucius-cfg-cancel",
      getString("workspace-settings-cancel"),
    );
    actions.append(errorLine, cancel, save);
    panel.appendChild(actions);

    for (const field of [modelInput, baseUrlInput])
      field.addEventListener("input", () =>
        effort.setModel(modelInput.value, baseUrlInput.value),
      );
    const fillForm = (ep?: ModelEndpoint) => {
      nameInput.value = ep?.name ?? "";
      baseUrlInput.value = ep?.baseUrl ?? "";
      apiKeyInput.value = ep?.apiKey ?? "";
      modelInput.value = ep?.model ?? "";
      maxTokensInput.value = String(ep?.maxTokens ?? 0);
      contextInput.value = String(ep?.contextWindowTokens ?? 32768);
      effort.setModel(
        ep?.model ?? "",
        ep?.baseUrl ?? "",
        ep?.reasoningEffort ?? "auto",
      );
    };

    const paintList = () => {
      listBox.textContent = "";
      for (const ep of live.endpoints ?? []) {
        const row = el(doc, "div", {
          display: "flex",
          minWidth: "0",
          alignItems: "center",
          gap: "8px",
          padding: "6px 8px",
          cursor: "pointer",
          background: ep.id === editingId ? "#f0ece3" : "transparent",
          borderRadius: "8px",
          borderBottom: "0",
        });
        const mark = el(doc, "span", {
          color: "#33302a",
          fontWeight: "700",
          fontSize: "10px",
          flex: "0 0 14px",
        });
        mark.textContent = ep.id === live.activeEndpointId ? "●" : "○";
        const info = el(doc, "div", {
          flex: "1 1 auto",
          minWidth: "0",
          overflow: "hidden",
        });
        const headline = el(doc, "div", {
          fontWeight: "600",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        });
        headline.textContent = ep.name || ep.model || "Untitled";
        const sub = el(doc, "div", {
          fontSize: "11px",
          color: "#6b665c",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        });
        sub.textContent = [ep.model, endpointHost(ep.baseUrl)]
          .filter(Boolean)
          .join(" · ");
        info.appendChild(headline);
        info.appendChild(sub);
        const del = el(
          doc,
          "button",
          {
            appearance: "none",
            background: "transparent",
            border: "none",
            color: "#b3452f",
            cursor: "pointer",
            font: "inherit",
            padding: "0 4px",
          },
          {
            type: "button",
            title: getString("workspace-endpoint-delete"),
          },
        );
        del.textContent = "✕";
        const choose = button(doc, "", "");
        choose.className = "confucius-endpoint-choice";
        choose.setAttribute("aria-label", ep.name || ep.model);
        choose.setAttribute("aria-pressed", String(ep.id === editingId));
        choose.append(mark, info);
        row.append(choose, del);
        choose.addEventListener("click", () => {
          void selectEndpoint(ep.id);
        });
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          void removeEndpoint(ep.id);
        });
        listBox.appendChild(row);
      }
      if (editingId === "") {
        const draft = el(doc, "div", {
          padding: "6px 8px",
          background: "#f0ece3",
          fontWeight: "600",
        });
        draft.textContent = getString("workspace-endpoint-new");
        listBox.appendChild(draft);
      }
    };

    const applyLive = (next: ModelConfig) => {
      live = next;
      state.config = next;
      state.sendError = "";
      modelLists.clear();
      renderLists();
    };

    const selectEndpoint = async (id: string) => {
      editingId = id;
      fillForm((live.endpoints ?? []).find((item) => item.id === id));
      paintList();
      if (id && id !== live.activeEndpointId) {
        try {
          errorLine.textContent = "";
          const next = (await rpc("config/set", {
            activeEndpointId: id,
          })) as ModelConfig;
          applyLive(next);
          fillForm((next.endpoints ?? []).find((item) => item.id === id));
          paintList();
        } catch (error) {
          errorLine.textContent =
            error instanceof Error ? error.message : String(error);
        }
      }
    };

    const removeEndpoint = async (id: string) => {
      try {
        errorLine.textContent = "";
        const next = (await rpc("config/set", {
          deleteEndpointId: id,
        })) as ModelConfig;
        applyLive(next);
        editingId = next.activeEndpointId ?? "";
        fillForm((next.endpoints ?? []).find((item) => item.id === editingId));
        paintList();
      } catch (error) {
        errorLine.textContent =
          error instanceof Error ? error.message : String(error);
      }
    };

    addBtn.addEventListener("click", () => {
      editingId = "";
      fillForm(undefined);
      paintList();
      nameInput.focus();
    });

    fillForm(
      (live.endpoints ?? []).find((item) => item.id === editingId) ??
        (live.baseUrl || live.model
          ? {
              id: live.activeEndpointId ?? "",
              name: live.model,
              baseUrl: live.baseUrl,
              apiKey: live.apiKey,
              model: live.model,
              maxTokens: live.maxTokens,
              reasoningEffort: live.reasoningEffort,
              contextWindowTokens: live.contextWindowTokens,
            }
          : undefined),
    );
    paintList();

    overlay.appendChild(panel);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closeSettings();
      }
    });
    cancel.addEventListener("click", () => overlay.remove());
    save.addEventListener("click", () => {
      if (save.disabled) return;
      save.disabled = true;
      void (async () => {
        errorLine.dataset.state = "";
        errorLine.textContent = "";
        try {
          if (
            settingsTask &&
            securityProfile === "workspace" &&
            (!workingDirectory.value.trim() || !confirmDirectory.checked)
          ) {
            throw new Error(getString("workspace-security-confirm-error"));
          }
          if (settingsTask && securityProfile === "workspace") {
            const previewMatches = await (capabilityPreviewPending ??
              previewSecurityDirectory());
            if (!previewMatches || !confirmDirectory.checked) {
              throw new Error(getString("workspace-security-confirm-error"));
            }
          }
          const endpoint: Record<string, unknown> = {
            name: nameInput.value,
            baseUrl: baseUrlInput.value,
            apiKey: apiKeyInput.value,
            model: modelInput.value,
            maxTokens: Number(maxTokensInput.value) || 0,
            contextWindowTokens: Number(contextInput.value) || 32768,
            reasoningEffort: effort.getValue(),
          };
          if (editingId) {
            endpoint.id = editingId;
          }
          const next = (await rpc("config/set", {
            endpoint,
            streamResponses: stream.checked,
            memoryConsent: memoryChoice,
            maxIterations:
              Number(iterationsInput.value) || DEFAULT_MAX_ITERATIONS,
            maxToolCalls:
              Number(toolCallsInput.value) || DEFAULT_MAX_TOOL_CALLS,
            uiFont: fontChoice,
            uiFontSize: sizeChoice,
            uiLanguage: languageChoice,
            uiLineHeight: lineHeightChoice,
          })) as ModelConfig;
          const languageChanged = live.uiLanguage !== next.uiLanguage;
          applyLive(next);
          editingId = next.activeEndpointId ?? "";
          fillForm(
            (next.endpoints ?? []).find((item) => item.id === editingId),
          );
          iterationsInput.value = String(
            next.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          );
          toolCallsInput.value = String(
            next.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
          );
          if (settingsTask) {
            await rpc("task/setBackend", {
              taskId: settingsTask.id,
              backend: settingsTask.backend,
              capabilityProfile: securityProfile,
              workingDirectory:
                securityProfile === "workspace"
                  ? workingDirectory.value.trim()
                  : undefined,
              confirmed: confirmDirectory.checked,
            });
            await refreshSessions();
            await loadTask(settingsTask.id);
          }
          paintList();
          errorLine.dataset.state = "saved";
          errorLine.textContent = getString("workspace-settings-saved");
          if (languageChanged) {
            closeSettings();
            applyLocalizedChrome();
            renderLists();
          }
        } catch (error) {
          errorLine.textContent =
            error instanceof Error ? error.message : String(error);
        } finally {
          save.disabled = false;
        }
      })();
    });
    root.appendChild(overlay);
    tabBar
      .querySelector<HTMLElement>('[aria-selected="true"]')
      ?.focus({ preventScroll: true });
    void Promise.all([
      refreshRuntimes(true),
      refreshMemoryProposals(),
      runUpdateAction("update/status"),
    ]).then(() => {
      if (!overlay.parentElement) return;
      paintRuntimePanel();
      paintMemoryProposals();
    });
  }

  async function refreshMemories(): Promise<void> {
    try {
      const listed = (await rpc("memory/list", { limit: 8 })) as {
        memories?: MemoryRow[];
      };
      state.memories = listed.memories ?? [];
    } catch {
      state.memories = [];
    }
    try {
      const listed = (await rpc("logs/list", { limit: 1 })) as {
        stats?: { sessions?: number };
      };
      state.logCount = listed.stats?.sessions ?? 0;
    } catch {
      state.logCount = 0;
    }
  }

  interface SlashCommand {
    label: string;
    description: string;
    kind: "command" | "skill" | "template";
    group: "templates" | "skills" | "commands";
    slug?: string;
    templateId?: string;
    searchText?: string;
    run?: () => void | Promise<void>;
  }

  const slashState = {
    open: false,
    items: [] as SlashCommand[],
    index: 0,
  };

  const mentionState = {
    open: false,
    token: null as LibraryMentionToken | null,
    query: "",
    items: [] as MentionChoice[],
    scope: "literature" as "literature" | "tasks",
    index: 0,
    nextOffset: 0 as number | null,
    total: 0,
    libraryID: 0,
    libraryName: "",
    loading: false,
    error: "",
    requestId: 0,
  };
  const MENTION_PAGE_SIZE = 10;

  function closeMentionMenu(): void {
    mentionState.open = false;
    mentionState.token = null;
    mentionState.items = [];
    mentionState.loading = false;
    mentionState.error = "";
    mentionState.requestId += 1;
    if (mentionSearchTimer && win) {
      win.clearTimeout(mentionSearchTimer);
      mentionSearchTimer = null;
    }
    doc.getElementById("confucius-mention-menu")?.remove();
  }

  function updateComposerMenus(): void {
    const token = libraryMentionTokenAtCaret(
      prompt.value,
      prompt.selectionStart ?? prompt.value.length,
    );
    if (!token) {
      closeMentionMenu();
      updateSlashMenu(prompt.value);
      return;
    }
    closeSlashMenu();
    closePlusMenu();
    closeEndpointMenu();
    const queryChanged =
      !mentionState.open || mentionState.query !== token.query;
    mentionState.open = true;
    mentionState.token = token;
    if (!queryChanged) {
      return;
    }
    mentionState.query = token.query;
    mentionState.items = [];
    mentionState.index = 0;
    mentionState.nextOffset = 0;
    mentionState.total = 0;
    mentionState.libraryID = 0;
    mentionState.libraryName = "";
    mentionState.error = "";
    mentionState.loading = true;
    mentionState.requestId += 1;
    const requestId = mentionState.requestId;
    if (mentionSearchTimer && win) win.clearTimeout(mentionSearchTimer);
    renderMentionMenu(false);
    const start = () => {
      mentionSearchTimer = null;
      if (!mentionState.open || requestId !== mentionState.requestId) return;
      mentionState.loading = false;
      void loadMentionItems(true, requestId);
    };
    if (win) {
      mentionSearchTimer = win.setTimeout(start, token.query ? 160 : 0);
    } else {
      start();
    }
  }

  async function loadMentionItems(
    reset: boolean,
    requestId = mentionState.requestId,
  ): Promise<void> {
    if (
      !mentionState.open ||
      mentionState.loading ||
      requestId !== mentionState.requestId
    ) {
      return;
    }
    const offset = reset ? 0 : mentionState.nextOffset;
    if (offset === null) return;
    mentionState.loading = true;
    mentionState.error = "";
    renderMentionMenu(!reset);
    try {
      let result: ContextSearchItemsResult & { items: MentionChoice[] };
      if (mentionState.scope === "tasks") {
        const found = (await rpc("context/search-tasks", {
          query: mentionState.query,
          offset,
          limit: MENTION_PAGE_SIZE,
        })) as {
          tasks: HistoryTask[];
          total: number;
          nextOffset: number | null;
        };
        result = {
          query: mentionState.query,
          libraryID: 0,
          libraryName: getString("workspace-reference-task"),
          items: found.tasks
            .filter((task) => task.id !== state.sessionId)
            .map(taskMentionChoice),
          total: found.total,
          nextOffset: found.nextOffset,
        };
      } else {
        result = (await rpc("context/search-items", {
          query: mentionState.query,
          offset,
          limit: MENTION_PAGE_SIZE,
          libraryID: reset ? undefined : mentionState.libraryID || undefined,
        })) as ContextSearchItemsResult;
      }
      if (!mentionState.open || requestId !== mentionState.requestId) return;
      const combined = reset
        ? result.items
        : [...mentionState.items, ...result.items];
      const unique = new Map<string, MentionChoice>();
      for (const item of combined) unique.set(mentionItemKey(item), item);
      mentionState.items = [...unique.values()];
      mentionState.nextOffset = result.nextOffset;
      mentionState.total = result.total;
      mentionState.libraryID = result.libraryID;
      mentionState.libraryName = result.libraryName;
      mentionState.index = Math.min(
        mentionState.index,
        Math.max(0, mentionState.items.length - 1),
      );
    } catch (error) {
      if (!mentionState.open || requestId !== mentionState.requestId) return;
      mentionState.error =
        error instanceof Error ? error.message : String(error);
    } finally {
      if (mentionState.open && requestId === mentionState.requestId) {
        mentionState.loading = false;
        renderMentionMenu(!reset);
      }
    }
  }

  function renderMentionMenu(preserveScroll = true): void {
    renderSourcePicker(doc, {
      state: mentionState,
      preserveScroll,
      included: (item) =>
        item.taskReference
          ? currentReferences().some(
              (ref) => ref.taskId === item.taskReference!.taskId,
            )
          : taskHasMentionItem(item),
      selectScope: (scope) => {
        if (mentionSearchTimer && win) win.clearTimeout(mentionSearchTimer);
        mentionState.scope = scope;
        mentionState.items = [];
        mentionState.nextOffset = 0;
        mentionState.index = 0;
        mentionState.loading = false;
        mentionState.requestId += 1;
        void loadMentionItems(true);
        prompt.focus();
      },
      hover: (index, menu) => {
        mentionState.index = index;
        highlightMentionRows(menu);
      },
      select: (index) => {
        mentionState.index = index;
        runMentionSelection();
      },
      loadMore: () => {
        void loadMentionItems(false);
      },
      place: placeComposerMenu,
    });
  }

  function highlightMentionRows(menu: Element): void {
    menu.querySelectorAll("[data-mention-index]").forEach((node: Element) => {
      const row = node as HTMLElement;
      const active =
        Number(row.getAttribute("data-mention-index")) === mentionState.index;
      row.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function runMentionSelection(): void {
    const item = mentionState.items[mentionState.index];
    const token = mentionState.token;
    if (!item || !token) return;
    const replacement = item.taskReference
      ? {
          value:
            prompt.value.slice(0, token.start) + prompt.value.slice(token.end),
          caret: token.start,
        }
      : replaceLibraryMention(prompt.value, token, item.title);
    prompt.value = replacement.value;
    closeMentionMenu();
    prompt.focus();
    prompt.setSelectionRange(replacement.caret, replacement.caret);
    if (item.taskReference) {
      referenceDrafts.set(
        state.sessionId ?? "new",
        mergeTaskReferences(currentReferences(), item.taskReference),
      );
      renderSourceTags();
    } else void addMentionContext(item);
    rememberComposerDraft();
  }

  function slashCommands(): SlashCommand[] {
    const commands: SlashCommand[] = FEATURED_TASK_TEMPLATES.map(
      (template) => ({
        label: localizedTemplateTitle(template),
        description: getString(`workspace-template-${template.id}-help`),
        kind: "template" as const,
        group: "templates" as const,
        templateId: template.id,
        searchText: `/${template.id}`,
      }),
    );
    const utilityCommands: SlashCommand[] = [
      {
        label: "/agent",
        description: getString("workspace-cmd-agent"),
        kind: "command",
        group: "commands",
        run: () => applyMode("agent"),
      },
      {
        label: "/plan",
        description: getString("workspace-cmd-plan"),
        kind: "command",
        group: "commands",
        run: () => applyMode("plan"),
      },
      {
        label: "/ask",
        description: getString("workspace-cmd-ask"),
        kind: "command",
        group: "commands",
        run: () => applyPermission("ask"),
      },
      {
        label: "/auto",
        description: getString("workspace-cmd-auto"),
        kind: "command",
        group: "commands",
        run: () => applyPermission("auto_allow"),
      },
      {
        label: "/deny-writes",
        description: getString("workspace-cmd-deny"),
        kind: "command",
        group: "commands",
        run: () => applyPermission("deny"),
      },
      {
        label: "/model",
        description: getString("workspace-cmd-model"),
        kind: "command",
        group: "commands",
        run: () => void refreshConfig().then(() => openSettings()),
      },
      {
        label: "/new-context",
        description: getString("workspace-cmd-compact"),
        kind: "command",
        group: "commands",
        run: () => void compactNow(),
      },
    ];
    for (const skill of state.skills) {
      commands.push({
        label: `/${skill.slug}`,
        description: skill.description || skill.name,
        kind: "skill",
        group: "skills",
        slug: skill.slug,
        searchText: [skill.name, ...skill.triggers].join(" "),
      });
    }
    commands.push(...utilityCommands);
    return commands;
  }

  async function applyMode(mode: "agent" | "plan"): Promise<boolean> {
    if (
      modeUpdatePending ||
      presetUpdatePending ||
      modelUpdatePending ||
      state.running ||
      state.sending
    )
      return false;
    const taskId = state.sessionId;
    if (!taskId) {
      state.mode = mode;
      syncPresetChip();
      return true;
    }
    modeUpdatePending = true;
    updateRunningUI();
    try {
      const updated = (await rpc("task/setMode", {
        taskId,
        mode,
      })) as ResearchTaskRecord;
      const index = state.sessions.findIndex((row) => row.id === taskId);
      if (index >= 0) state.sessions[index] = updated;
      if (state.sessionId === taskId) {
        state.mode = updated.mode;
        state.sendError = "";
      }
      return true;
    } catch (error) {
      if (state.sessionId === taskId)
        state.sendError =
          error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      modeUpdatePending = false;
      updateRunningUI();
      renderLists();
    }
  }

  function applyPermission(mode: "ask" | "auto_allow" | "deny"): void {
    state.permission = mode;
    if (state.sessionId) {
      const sessionId = state.sessionId;
      const update = pendingPermissionUpdate
        .catch(() => undefined)
        .then(() =>
          rpc("task/setPermissions", {
            taskId: sessionId,
            permissionMode: mode,
          }),
        )
        .then(() => undefined);
      pendingPermissionUpdate = update;
      void update.catch((error) => {
        if (state.sessionId !== sessionId) {
          return;
        }
        state.sendError =
          error instanceof Error ? error.message : String(error);
        renderLists();
      });
    }
  }

  async function compactNow(): Promise<void> {
    if (!state.sessionId) {
      return;
    }
    try {
      status.style.color = "#8c6a3f";
      status.textContent = getString("workspace-compacting");
      const stats = (await rpc("task/new-context", {
        taskId: state.sessionId,
      })) as SessionContextStats;
      state.contextStats = stats;
      contextRing.update(
        stats.usageSource === "unknown" || stats.window?.control === "runtime"
          ? Number.NaN
          : stats.percent,
        ringLabel(stats),
      );
    } catch (error) {
      status.style.color = "#b3452f";
      status.textContent =
        error instanceof Error ? error.message : String(error);
    }
  }

  function ringLabel(stats: SessionContextStats): string {
    const label = getString(
      `workspace-usage-${stats.usageSource ?? "estimated"}`,
    );
    const window = stats.window
      ? ` · ${getString("workspace-window-label")} ${stats.window.number}`
      : "";
    if (stats.usageSource === "unknown") return `${label}${window}`;
    if (stats.window?.control === "runtime")
      return `${getString("workspace-context-runtime")}${window} · ${label}${stats.usageSource === "reported" ? ` · ${fmtTokens(stats.tokensEstimate)} tokens` : ""}`;
    return `${label} · ${fmtTokens(stats.tokensEstimate)} / ${fmtTokens(stats.contextWindowTokens)} tokens${window}`;
  }
  function toggleContextDetails(): void {
    const existing = doc.getElementById("confucius-context-details");
    if (existing) {
      existing.remove();
      return;
    }
    closePlusMenu();
    closeEndpointMenu();
    closeMentionMenu();
    closeSlashMenu();
    const panel = createMenuSurface(doc, {
      id: "confucius-context-details",
      role: "dialog",
      "aria-label": getString("workspace-context-details"),
    });
    panel.classList.add("confucius-context-details");
    const info = el(doc, "p");
    info.textContent = state.contextStats
      ? ringLabel(state.contextStats)
      : getString("workspace-usage-unknown");
    const hint = el(doc, "p");
    hint.textContent = getString("workspace-context-hint");
    panel.append(info, hint);
    const footer = el(doc, "div");
    footer.className = "confucius-menu-footer";
    if (currentTask()?.backend === "native") {
      const reset = el(doc, "button", undefined, { type: "button" });
      reset.className = "confucius-menu-row";
      reset.textContent = getString("workspace-context-new-window");
      reset.toggleAttribute("disabled", state.running || state.sending);
      reset.addEventListener("click", () => {
        panel.remove();
        void compactNow();
      });
      footer.append(reset);
    }
    const close = el(doc, "button", undefined, { type: "button" });
    close.className = "confucius-menu-row";
    close.textContent = getString("workspace-context-close");
    close.addEventListener("click", () => panel.remove());
    footer.append(close);
    panel.append(footer);
    placeMenu(contextRing.node, panel, 320);
  }

  function fmtTokens(value: number): string {
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
  }

  async function ensureSkills(): Promise<void> {
    if (state.skills.length) {
      return;
    }
    try {
      const listed = (await rpc("skill/list", {})) as {
        skills?: ConfuciusSkill[];
      };
      state.skills = listed.skills || [];
    } catch {
      state.skills = [];
    }
  }

  function updateSlashMenu(value: string): void {
    const token = slashMenuToken(value);
    if (token === null) {
      closeSlashMenu();
      return;
    }
    if (!state.skills.length) {
      void ensureSkills().then(() => {
        if (prompt.value === value) {
          updateSlashMenu(value);
        }
      });
    }
    const query = token.toLowerCase();
    slashState.items = slashCommands().filter((command) => {
      if (!query) {
        return true;
      }
      const hay = [command.label, command.description, command.searchText ?? ""]
        .join("\n")
        .toLowerCase();
      return hay.includes(query);
    });
    if (slashState.items.length === 0) {
      closeSlashMenu();
      return;
    }
    slashState.open = true;
    slashState.index = 0;
    renderSlashMenu();
  }

  function closeSlashMenu(): void {
    slashState.open = false;
    slashState.items = [];
    doc.getElementById("confucius-slash-menu")?.remove();
  }

  function renderSlashMenu(): void {
    doc.getElementById("confucius-slash-menu")?.remove();
    if (!slashState.open) {
      return;
    }
    const menu = createMenuSurface(
      doc,
      {
        id: "confucius-slash-menu",
        role: "listbox",
        "aria-label": getString("workspace-slash-heading"),
      },
      true,
    );
    const header = createMenuHeader(
      doc,
      getString("workspace-slash-heading"),
      getString("workspace-slash-hint"),
    );
    menu.appendChild(header);

    const list = el(doc, "div", {
      maxHeight: "258px",
      overflowX: "hidden",
      overflowY: "auto",
      overscrollBehavior: "contain",
      padding: "4px 0",
      boxSizing: "border-box",
    });
    list.id = "confucius-slash-results";
    let previousGroup: SlashCommand["group"] | null = null;
    slashState.items.forEach((command, index) => {
      if (command.group !== previousGroup) {
        list.appendChild(
          createMenuHeading(
            doc,
            getString(`workspace-slash-group-${command.group}`),
          ),
        );
        previousGroup = command.group;
      }
      const active = index === slashState.index;
      const row = el(doc, "div");
      row.className = "confucius-composer-menu-row";
      row.setAttribute("role", "option");
      row.setAttribute("data-slash-index", String(index));
      if (command.templateId) row.dataset.templateId = command.templateId;
      row.setAttribute("aria-selected", active ? "true" : "false");
      const glyph = createMenuGlyph(
        doc,
        command.kind === "template" ? "◇" : "/",
      );
      const copy = el(doc, "span", {
        flex: "1 1 auto",
        minWidth: "0",
      });
      const label = el(doc, "span", {
        display: "block",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "#33302a",
        fontWeight: "500",
        fontSize: "1em",
      });
      label.textContent = command.label;
      const hint = el(doc, "span", {
        display: "block",
        marginTop: "2px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "#70695f",
        fontSize: ".86em",
      });
      hint.textContent = command.description;
      copy.appendChild(label);
      copy.appendChild(hint);
      row.appendChild(glyph);
      row.appendChild(copy);
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      row.addEventListener("mouseenter", () => {
        if (slashState.index === index) {
          return;
        }
        slashState.index = index;
        highlightSlashRows(menu);
      });
      row.addEventListener("click", () => {
        slashState.index = index;
        runSlashSelection();
      });
      list.appendChild(row);
    });
    menu.appendChild(list);
    placeComposerMenu(menu, header, list);
    const activeRow = menu.querySelector(
      `[data-slash-index="${slashState.index}"]`,
    ) as HTMLElement | null;
    activeRow?.scrollIntoView({ block: "nearest" });
  }

  function highlightSlashRows(menu: Element): void {
    menu.querySelectorAll("[data-slash-index]").forEach((node: Element) => {
      const row = node as HTMLElement;
      const index = Number(row.getAttribute("data-slash-index"));
      const active = index === slashState.index;
      row.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function runSlashSelection(): void {
    const command = slashState.items[slashState.index];
    if (!command) {
      closeSlashMenu();
      return;
    }
    if (command.kind === "skill" && command.slug) {
      const remainder = prompt.value.replace(/^\/[^\s]*/, "").trim();
      prompt.value = remainder
        ? `/${command.slug} ${remainder}`
        : `/${command.slug} `;
      closeSlashMenu();
      prompt.focus();
      const caret = prompt.value.length;
      prompt.setSelectionRange(caret, caret);
      return;
    }
    if (command.kind === "template") {
      const template = taskTemplate(command.templateId);
      const remainder = prompt.value.replace(/^\/[^\s]*/, "").trim();
      closeSlashMenu();
      if (template) {
        const basePrompt = localizedTemplatePrompt(template);
        const draft = remainder ? `${basePrompt}\n\n${remainder}` : basePrompt;
        void stageTemplate(template, undefined, draft);
      }
      return;
    }
    closeSlashMenu();
    prompt.value = "";
    void command.run?.();
  }

  function closePlusMenu(): void {
    doc.getElementById("confucius-plus-menu")?.remove();
  }

  function closeEndpointMenu(): void {
    endpointMenuOpen = false;
    endpointSelection = null;
    doc.getElementById("confucius-endpoint-menu")?.remove();
    endpointBtn.setAttribute("aria-expanded", "false");
  }

  function menuPanel(id: string, extra?: Styles): HTMLElement {
    const menu = createMenuSurface(doc, { id, role: "menu" });
    if (extra) Object.assign(menu.style, extra);
    return menu;
  }

  function menuRow(
    label: string,
    opts: {
      active?: boolean;
      highlighted?: boolean;
      hint?: string;
      onClick?: () => void;
      onEnter?: () => void;
    } = {},
  ): HTMLElement {
    const row = el(doc, "button", undefined, {
      type: "button",
      role: "menuitem",
    });
    row.className = "confucius-menu-row";
    row.toggleAttribute("disabled", !opts.onClick && !opts.onEnter);
    row.setAttribute("data-active", opts.active ? "true" : "false");
    row.setAttribute("data-highlighted", opts.highlighted ? "true" : "false");
    const text = el(doc, "span", {
      flex: "1 1 auto",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
    text.textContent = label;
    row.appendChild(text);
    if (opts.hint) {
      const hint = el(doc, "span", {
        flex: "0 1 auto",
        maxWidth: "42%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "#6b665c",
        fontSize: ".86em",
      });
      hint.textContent = opts.hint;
      row.appendChild(hint);
    }
    if (opts.active) {
      const mark = el(doc, "span", { color: "#33302a", fontWeight: "700" });
      mark.textContent = "✓";
      row.appendChild(mark);
    }
    if (opts.onClick) {
      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        opts.onClick?.();
      });
    }
    if (opts.onEnter) {
      row.addEventListener("mouseenter", () => opts.onEnter?.());
    }
    return row;
  }

  function placeMenu(
    anchor: HTMLElement,
    menu: HTMLElement,
    preferredWidth = 220,
    placement: "auto" | "left" = "auto",
    portal?: HTMLElement,
  ): void {
    const view = doc.defaultView;
    if (menu.id !== "confucius-source-menu")
      doc.getElementById("confucius-source-menu")?.remove();
    bindMenuNavigation(menu, () => {
      if (menu.id === "confucius-endpoint-menu") closeEndpointMenu();
      else if (menu.id === "confucius-mention-menu") closeMentionMenu();
      else if (menu.id === "confucius-slash-menu") closeSlashMenu();
      else menu.remove();
      anchor.focus({ preventScroll: true });
    });
    const typography = view?.getComputedStyle(root);
    if (typography) {
      menu.style.fontFamily = typography.fontFamily;
      menu.style.fontSize = typography.fontSize;
      menu.style.lineHeight = typography.lineHeight;
    }
    if (menu.id !== "confucius-context-details")
      doc.getElementById("confucius-context-details")?.remove();
    const rect = anchor.getBoundingClientRect();
    const height = view?.innerHeight ?? 800;
    const width = view?.innerWidth ?? 1100;
    const rootRect = root.getBoundingClientRect();
    const leftBound = Math.max(8, rootRect.width ? rootRect.left + 8 : 8);
    const rightBound = Math.min(
      width - 8,
      rootRect.width ? rootRect.right - 8 : width - 8,
    );
    const availableWidth = Math.max(120, rightBound - leftBound);
    const sideRight =
      placement === "left"
        ? Math.min(rightBound, Math.max(leftBound + 120, rect.left - 6))
        : rightBound;
    const placementWidth =
      placement === "left"
        ? Math.max(120, sideRight - leftBound)
        : availableWidth;
    const menuWidth = Math.min(preferredWidth, availableWidth, placementWidth);
    const menuLeft =
      placement === "left"
        ? Math.max(leftBound, sideRight - menuWidth)
        : Math.min(
            Math.max(leftBound, rect.left),
            Math.max(leftBound, rightBound - menuWidth),
          );
    menu.style.position = "fixed";
    menu.style.width = `${menuWidth}px`;
    menu.style.maxWidth = `${availableWidth}px`;
    menu.style.left = `${menuLeft}px`;
    menu.style.right = "auto";
    menu.style.top = "0px";
    menu.style.bottom = "auto";
    menu.style.visibility = "hidden";
    const menuHost = portal ?? doc.body ?? doc.documentElement;
    menuHost?.appendChild(menu);
    const box = menu.getBoundingClientRect();
    if (placement === "left") {
      const topBound = Math.max(8, rootRect.height ? rootRect.top + 8 : 8);
      const bottomBound = Math.min(
        height - 8,
        rootRect.height ? rootRect.bottom - 8 : height - 8,
      );
      const availableHeight = Math.max(80, bottomBound - topBound);
      menu.style.maxHeight = `${Math.min(360, availableHeight)}px`;
      const measuredHeight = Math.min(box.height, availableHeight);
      menu.style.top = `${Math.min(
        Math.max(topBound, rect.top),
        Math.max(topBound, bottomBound - measuredHeight),
      )}px`;
      menu.style.visibility = "visible";
      return;
    }
    const spaceAbove = rect.top - 8;
    const spaceBelow = height - rect.bottom - 8;
    const openAbove =
      spaceAbove >= Math.min(box.height, 160) || spaceAbove >= spaceBelow;
    const availableHeight = Math.max(
      120,
      openAbove ? spaceAbove - 6 : spaceBelow - 6,
    );
    menu.style.maxHeight = `${Math.min(360, availableHeight)}px`;
    const measuredHeight = Math.min(box.height, availableHeight);
    const top = openAbove
      ? Math.max(8, rect.top - measuredHeight - 6)
      : Math.min(height - measuredHeight - 8, rect.bottom + 6);
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
  }

  function placeComposerMenu(
    menu: HTMLElement,
    _header: HTMLElement,
    list: HTMLElement,
  ): void {
    placeMenu(prompt, menu, Math.min(520, Math.max(280, responsiveWidth - 16)));
    const chromeHeight = Array.from(menu.children)
      .filter((child) => child !== list)
      .reduce(
        (height, child) => height + child.getBoundingClientRect().height,
        0,
      );
    const availableListHeight = Math.max(
      0,
      menu.clientHeight - chromeHeight - 16,
    );
    list.style.maxHeight = `${Math.min(258, availableListHeight)}px`;
  }

  async function ensureModels(endpointId: string): Promise<void> {
    const cached = modelLists.get(endpointId);
    if (cached && cached.status !== "idle") return;
    const endpoint = state.config?.endpoints?.find(
      (item) => item.id === endpointId,
    );
    modelLists.set(endpointId, {
      status: "loading",
      models: endpoint?.model ? [endpoint.model] : [],
      error: "",
    });
    try {
      const result = (await rpc("config/listModels", { endpointId })) as {
        models?: string[];
        error?: string;
      };
      modelLists.set(endpointId, {
        status: result.error ? "error" : "ok",
        models: [
          ...new Set([
            ...(endpoint?.model ? [endpoint.model] : []),
            ...(result.models ?? []),
          ]),
        ],
        error: result.error ?? "",
      });
    } catch (error) {
      modelLists.set(endpointId, {
        status: "error",
        models: endpoint?.model ? [endpoint.model] : [],
        error: String(error),
      });
    }
    if (endpointMenuOpen && !endpointSelection) renderEndpointMenu();
  }

  async function applyTaskBackend(backend: AgentBackendKind): Promise<void> {
    const task = currentTask();
    if (!task) {
      const text = prompt.value;
      const references = currentReferences();
      await createTask({
        title: getString("workspace-untitled-task"),
        context: state.live?.lockedSnapshot,
        backend,
        preserveModelMenu: true,
      });
      prompt.value = text;
      referenceDrafts.set(state.sessionId!, references);
      rememberComposerDraft();
    } else if (task.backend !== backend) {
      await rpc("task/setBackend", {
        taskId: task.id,
        backend,
        capabilityProfile: task.capabilityProfile,
        workingDirectory: task.workingDirectory,
      });
      await loadTask(task.id);
    }
  }

  async function selectComposerModel(
    choice: ComposerModelChoice,
  ): Promise<void> {
    if (modelUpdatePending || state.running || state.sending) return;
    const taskId = state.sessionId;
    modelUpdatePending = true;
    modelMenuError = "";
    updateRunningUI();
    renderEndpointMenu();
    try {
      let selected = choice;
      if (choice.backend !== "native" && choice.model.id) {
        const catalog = (await rpc("runtime/listModels", {
          backend: choice.backend,
          modelId: choice.model.id,
        })) as { models: RuntimeModelOption[] };
        const model = catalog.models.find(
          (model) => model.id === choice.model.id,
        );
        if (!model) throw new Error(getString("workspace-model-error"));
        selected = { ...choice, model };
      }
      if (state.sessionId !== taskId) return;
      await applyTaskBackend(choice.backend);
      if (taskId && state.sessionId !== taskId) return;
      if (selected.backend === "native") {
        const endpoint = state.config?.endpoints?.find(
          (ep) => ep.id === selected.endpointId,
        );
        state.config = (await rpc("config/set", {
          activeEndpointId: selected.endpointId,
          model: selected.model.id,
          reasoningEffort: normalizeModelEffort(
            selected.model.id,
            endpoint?.baseUrl ?? "",
            endpoint?.reasoningEffort,
          ),
        })) as ModelConfig;
      } else if (selected.model.id) {
        const previous = currentTask()?.runtimeModel;
        const effort =
          previous?.modelId === selected.model.id &&
          selected.model.reasoningOptions?.some(
            (option) => option.value === previous.reasoningEffort,
          )
            ? previous.reasoningEffort
            : selected.model.defaultReasoningEffort;
        const updated = (await rpc("task/setModel", {
          taskId: state.sessionId,
          modelId: selected.model.id,
          reasoningEffort: effort,
        })) as ResearchTaskRecord;
        state.sessions = state.sessions.map((task) =>
          task.id === updated.id ? updated : task,
        );
      }
      state.sendError = "";
      if (endpointMenuOpen) {
        endpointSelection = selected;
        if (!selected.model.reasoningOptions?.length) closeEndpointMenu();
      }
    } catch (error) {
      modelMenuError = error instanceof Error ? error.message : String(error);
    } finally {
      modelUpdatePending = false;
      updateRunningUI();
      syncEndpointButton();
      renderLists();
      renderEndpointMenu();
      if (endpointMenuOpen && endpointSelection) {
        (
          doc.querySelector(
            "#confucius-endpoint-menu [data-effort][aria-checked='true']",
          ) as HTMLElement | null
        )?.focus({ preventScroll: true });
      }
    }
  }

  async function applyEffort(value: string): Promise<void> {
    const selected = endpointSelection;
    if (!selected || modelUpdatePending || state.running || state.sending)
      return;
    if (
      !selected.model.reasoningOptions?.some((option) => option.value === value)
    )
      return;
    modelUpdatePending = true;
    modelMenuError = "";
    updateRunningUI();
    renderEndpointMenu();
    try {
      if (selected.backend === "native") {
        state.config = (await rpc("config/set", {
          activeEndpointId: selected.endpointId,
          reasoningEffort: value,
        })) as ModelConfig;
      } else {
        const updated = (await rpc("task/setModel", {
          taskId: state.sessionId,
          modelId: selected.model.id,
          reasoningEffort: value,
        })) as ResearchTaskRecord;
        state.sessions = state.sessions.map((task) =>
          task.id === updated.id ? updated : task,
        );
      }
      closeEndpointMenu();
      endpointBtn.focus({ preventScroll: true });
    } catch (error) {
      modelMenuError = error instanceof Error ? error.message : String(error);
    } finally {
      modelUpdatePending = false;
      updateRunningUI();
      syncEndpointButton();
      renderEndpointMenu();
    }
  }

  function renderEndpointMenu(): void {
    const old = doc.getElementById("confucius-endpoint-menu");
    const focusedKey = (doc.activeElement as HTMLElement | null)?.dataset
      .modelKey;
    const scrollTop = old?.scrollTop ?? 0;
    old?.remove();
    if (!endpointMenuOpen) return;
    const menu = menuPanel("confucius-endpoint-menu");
    menu.dataset.step = endpointSelection ? "effort" : "model";
    if (endpointSelection) {
      const selected = endpointSelection;
      const back = menuRow(`‹ ${getString("workspace-model")}`, {
        onClick: modelUpdatePending
          ? undefined
          : () => {
              endpointSelection = null;
              renderEndpointMenu();
              (
                doc.querySelector(
                  "#confucius-endpoint-menu [aria-checked='true']",
                ) as HTMLElement | null
              )?.focus({ preventScroll: true });
            },
      });
      back.classList.add("confucius-menu-back");
      menu.appendChild(back);
      menu.appendChild(
        createMenuHeader(
          doc,
          selected.model.label,
          getString("workspace-thinking"),
        ),
      );
      const effort =
        selected.backend === "native"
          ? (state.config?.reasoningEffort ?? "auto")
          : (currentTask()?.runtimeModel?.reasoningEffort ??
            selected.model.defaultReasoningEffort);
      for (const option of selected.model.reasoningOptions ?? []) {
        const row = menuRow(effortLabel(option.value, option.label), {
          active: effort === option.value,
          onClick: modelUpdatePending
            ? undefined
            : () => void applyEffort(option.value),
        });
        row.dataset.effort = option.value;
        row.setAttribute("role", "menuitemradio");
        row.setAttribute("aria-checked", String(effort === option.value));
        menu.appendChild(row);
      }
    } else {
      const selectedBackend = currentTask()?.backend ?? "native";
      const choices: ComposerModelChoice[] = [];
      for (const endpoint of state.config?.endpoints ?? []) {
        const models =
          modelLists.get(endpoint.id)?.models ??
          (endpoint.model ? [endpoint.model] : []);
        for (const id of models) {
          const capability = modelReasoning(id, endpoint.baseUrl);
          choices.push({
            backend: "native",
            endpointId: endpoint.id,
            model: {
              id,
              label: id,
              reasoningOptions:
                capability.source === "unknown"
                  ? []
                  : capability.efforts.map((value) => ({
                      value,
                      label: effortLabel(value),
                    })),
            },
          });
        }
      }
      for (const backend of ["codex", "kimi"] as const) {
        const runtime = runtimeStatus(backend);
        if (runtime?.models?.length) {
          for (const model of runtime.models) choices.push({ backend, model });
        } else if (runtime?.state === "ready") {
          choices.push({
            backend,
            model: {
              id: "",
              label: `${runtimeLabel(backend)} · ${getString("workspace-model-default")}`,
            },
          });
        }
      }
      for (const choice of choices) {
        const endpoint = state.config?.endpoints?.find(
          (ep) => ep.id === choice.endpointId,
        );
        const active =
          selectedBackend === choice.backend &&
          (choice.backend === "native"
            ? state.config?.activeEndpointId === choice.endpointId &&
              endpoint?.model === choice.model.id
            : currentTask()?.runtimeModel
              ? currentTask()?.runtimeModel?.modelId === choice.model.id
              : choice.model.isDefault || !choice.model.id);
        const row = menuRow(choice.model.label, {
          active,
          hint:
            choice.backend === "native"
              ? endpoint?.name || endpointHost(endpoint?.baseUrl ?? "")
              : runtimeLabel(choice.backend),
          onClick:
            modelUpdatePending || state.running
              ? undefined
              : () => void selectComposerModel(choice),
        });
        row.dataset.model = choice.model.id;
        row.dataset.runtime = choice.backend;
        row.dataset.modelKey = `${choice.backend}:${choice.endpointId ?? ""}:${choice.model.id}`;
        row.setAttribute("role", "menuitemradio");
        row.setAttribute("aria-checked", String(Boolean(active)));
        menu.appendChild(row);
      }
      if (!choices.length)
        menu.appendChild(menuRow(getString("workspace-model-empty")));
    }
    if (modelUpdatePending)
      menu.appendChild(
        createMenuHeading(doc, getString("workspace-model-loading")),
      );
    if (modelMenuError) {
      const error = createMenuHeading(doc, modelMenuError);
      error.style.color = "#a63d28";
      error.setAttribute("role", "alert");
      menu.appendChild(error);
    }
    placeMenu(endpointBtn, menu, 320);
    if (focusedKey) {
      const row = [
        ...menu.querySelectorAll<HTMLElement>("[data-model-key]"),
      ].find((row) => row.dataset.modelKey === focusedKey);
      row?.focus({ preventScroll: true });
    }
    menu.scrollTop = scrollTop;
  }

  function toggleEndpointMenu(): void {
    if (endpointMenuOpen) {
      closeEndpointMenu();
      return;
    }
    closePlusMenu();
    closeSlashMenu();
    closeMentionMenu();
    endpointMenuOpen = true;
    endpointSelection = null;
    modelMenuError = "";
    renderEndpointMenu();
    syncEndpointButton();
    for (const endpoint of state.config?.endpoints ?? []) {
      if (modelLists.get(endpoint.id)?.status === "error")
        modelLists.delete(endpoint.id);
      void ensureModels(endpoint.id);
    }
    void refreshRuntimes(false).then(() => {
      if (endpointMenuOpen && !endpointSelection) renderEndpointMenu();
    });
  }

  function togglePlusMenu(): void {
    const existing = doc.getElementById("confucius-plus-menu");
    if (existing) {
      existing.remove();
      return;
    }
    closeEndpointMenu();
    closeSlashMenu();
    closeMentionMenu();
    const menu = menuPanel("confucius-plus-menu");
    const section = (title: string) =>
      menu.appendChild(createMenuHeading(doc, title));
    const option = (label: string, active: boolean, onClick: () => void) => {
      menu.appendChild(menuRow(label, { active, onClick }));
    };

    section(getString("workspace-mode"));
    const modeDisabled =
      modeUpdatePending ||
      presetUpdatePending ||
      modelUpdatePending ||
      state.running ||
      state.sending;
    for (const mode of ["agent", "plan"] as const) {
      menu.appendChild(
        menuRow(getString(`workspace-mode-${mode}`), {
          active: state.mode === mode,
          onClick: modeDisabled
            ? undefined
            : () => {
                void applyMode(mode);
                closePlusMenu();
              },
        }),
      );
    }

    section(getString("workspace-permissions"));
    option(getString("workspace-perm-ask"), state.permission === "ask", () => {
      applyPermission("ask");
      closePlusMenu();
    });
    option(
      getString("workspace-perm-auto"),
      state.permission === "auto_allow",
      () => {
        applyPermission("auto_allow");
        closePlusMenu();
      },
    );
    option(
      getString("workspace-perm-deny"),
      state.permission === "deny",
      () => {
        applyPermission("deny");
        closePlusMenu();
      },
    );

    placeMenu(plusBtn, menu, 300);
  }

  function turnAwaitingReply(events: ConfuciusEvent[]): boolean {
    let awaiting = false;
    let latestTurnId: string | undefined;
    for (const event of events) {
      if (event.type === "turn_started") {
        latestTurnId = event.turnId;
        awaiting = true;
      } else if (event.turnId === latestTurnId) {
        if (event.type === "tool_result") {
          // The provider is done and the next model round has started. This
          // was the invisible gap after inspect_pdf_page in long deep reads.
          awaiting = true;
        } else if (
          event.type === "text_delta" ||
          event.type === "reasoning_delta" ||
          event.type === "tool_requested" ||
          event.type === "approval_required" ||
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_aborted"
        ) {
          awaiting = false;
        }
      }
    }
    return awaiting;
  }

  function runningStageText(events: ConfuciusEvent[]): string {
    let activeTurnId: string | undefined;
    let startedAt = Date.now();
    let workflowStatus = "";
    let workflowStartedAt = startedAt;
    let stage:
      | Extract<
          ConfuciusEvent,
          {
            type:
              | "turn_started"
              | "tool_requested"
              | "tool_result"
              | "approval_required"
              | "approval_resolved"
              | "reasoning_delta"
              | "text_delta";
          }
        >
      | undefined;
    for (const event of events) {
      if (event.type === "turn_started") {
        activeTurnId = event.turnId;
        startedAt = event.ts;
        workflowStatus = "";
        workflowStartedAt = event.ts;
        stage = event;
        continue;
      }
      if (!activeTurnId || event.turnId !== activeTurnId) continue;
      if (
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_aborted"
      ) {
        activeTurnId = undefined;
        workflowStatus = "";
        stage = undefined;
        continue;
      }
      if (
        event.type === "reasoning_delta" &&
        event.payload.statusText &&
        event.payload.statusText !== workflowStatus
      ) {
        workflowStatus = event.payload.statusText;
        workflowStartedAt = event.ts;
      }
      if (
        event.type === "tool_requested" ||
        event.type === "tool_result" ||
        event.type === "approval_required" ||
        event.type === "approval_resolved" ||
        event.type === "reasoning_delta" ||
        event.type === "text_delta"
      ) {
        stage = event;
      }
    }

    if (!activeTurnId || !stage) {
      return getString("workspace-waiting-model");
    }
    let label = getString("workspace-working-model");
    if (stage.type === "tool_requested") {
      label = `${getString("workspace-working-tool")} · ${stage.payload.toolName}`;
    } else if (stage.type === "tool_result") {
      if (stage.payload.result.toolName === "inspect_pdf_page") {
        const data =
          stage.payload.result.ok &&
          stage.payload.result.data &&
          typeof stage.payload.result.data === "object"
            ? (stage.payload.result.data as Record<string, unknown>)
            : undefined;
        label =
          data?.visualAvailable === true
            ? getString("workspace-working-pdf-vision")
            : getString("workspace-working-pdf-anchors");
      } else {
        label = getString("workspace-working-tool-results");
      }
    } else if (stage.type === "approval_required") {
      label = getString("workspace-awaiting-approval");
    } else if (stage.type === "approval_resolved") {
      label = getString("workspace-working-approved-tool");
    } else if (stage.type === "reasoning_delta") {
      label = getString("workspace-working-reasoning");
    } else if (stage.type === "text_delta") {
      label = getString("workspace-working-response");
    }
    if (workflowStatus) {
      label =
        stage.type === "tool_requested" ||
        stage.type === "tool_result" ||
        stage.type === "approval_required" ||
        stage.type === "approval_resolved"
          ? `${workflowStatus} · ${label}`
          : workflowStatus;
    }
    const seconds = Math.max(
      0,
      Math.floor(
        (Date.now() -
          (workflowStatus
            ? workflowStartedAt
            : Math.max(startedAt, stage.ts))) /
          1000,
      ),
    );
    const minutes = Math.floor(seconds / 60);
    const remainder = String(seconds % 60).padStart(2, "0");
    return `${label} · ${String(minutes).padStart(2, "0")}:${remainder}`;
  }

  function isRunningFromEvents(events: ConfuciusEvent[]): boolean {
    let running = false;
    let latestTurnId: string | undefined;
    for (const event of events) {
      if (event.type === "turn_started") {
        latestTurnId = event.turnId;
        running = true;
      } else if (
        event.turnId === latestTurnId &&
        (event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_aborted")
      ) {
        running = false;
      }
    }
    return running;
  }

  function updateRunningUI(): void {
    endpointBtn.toggleAttribute(
      "disabled",
      modelUpdatePending || modeUpdatePending || state.running || state.sending,
    );
    syncPresetChip();
    const working = state.running || state.sending;
    sendBtn.style.display = working ? "none" : "";
    stopBtn.style.display = working ? "" : "none";
    if (
      state.sending ||
      presetUpdatePending ||
      modeUpdatePending ||
      modelUpdatePending ||
      pendingAttachments.some((item) => item.status === "preparing")
    ) {
      sendBtn.setAttribute("disabled", "true");
    } else {
      sendBtn.removeAttribute("disabled");
    }
  }

  let pollInFlight = false;

  async function poll(): Promise<void> {
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;
    try {
      if (!state.config) {
        await refreshConfig();
        renderLists();
      }
      await ensureSkills();
      await refreshSessions();
      await refreshMemories();
      if (!state.runtimes.length) await refreshRuntimes(false);
      if (!state.memoryProposals.length) await refreshMemoryProposals();
      try {
        const live = (await rpc("context/live", {})) as LiveContextResult;
        state.live = live;
      } catch {
        /* live context is cosmetic */
      }
      try {
        // Item and reader entry points carry a click-time context snapshot.
        const launch = (await rpc(
          "workspace/launch-consume",
          {},
        )) as LaunchConsumeResult;
        if (launch.intent) {
          await consumeLaunchIntent(launch.intent);
        } else if (launch.skillSlug) {
          prompt.value = `/${launch.skillSlug} `;
          prompt.focus();
        }
      } catch {
        /* launch queue is cosmetic */
      }
      if (state.sessionId) {
        const polledSessionId = state.sessionId;
        const requestedCursor = state.lastEventId;
        const bundle = (await rpc("task/events", {
          taskId: polledSessionId,
          afterId: requestedCursor,
        })) as { events?: ConfuciusEvent[]; cursorFound?: boolean };
        if (state.sessionId !== polledSessionId) {
          return;
        }
        const incoming = bundle.events || [];
        const cursorMoved = state.lastEventId !== requestedCursor;
        state.events = mergeEvents(
          state.events,
          incoming,
          !cursorMoved && (!requestedCursor || bundle.cursorFound === false),
        );
        if (incoming.length && !cursorMoved) {
          // The response is ordered by the host and is the authoritative
          // cursor even if a different request rendered an overlapping batch.
          state.lastEventId = incoming[incoming.length - 1].id;
        }
        collectApprovals();
        if (incoming.some((event) => event.type === "memory_updated")) {
          await refreshMemories();
        }
        if (incoming.some((event) => event.type === "memory_proposed")) {
          await refreshMemoryProposals();
        }
        if (
          !state.selectedArtifactId ||
          incoming.some((event) => event.type === "artifact_upserted")
        ) {
          await refreshArtifacts(polledSessionId);
        }
        const wasRunning = state.running;
        state.running = isRunningFromEvents(state.events);
        if (wasRunning !== state.running) {
          updateRunningUI();
        }
        try {
          const stats = (await rpc("task/context", {
            taskId: state.sessionId,
          })) as SessionContextStats;
          state.contextStats = stats;
          contextRing.update(
            stats.usageSource === "unknown" ||
              stats.window?.control === "runtime"
              ? Number.NaN
              : stats.percent,
            ringLabel(stats),
          );
        } catch {
          /* stats are cosmetic */
        }
      }
      if (listSignature() !== lastListSignature) {
        renderLists();
      } else {
        applyAppearance();
        syncEndpointButton();
      }
      if (state.sending) {
        status.style.color = "#8c6a3f";
        status.textContent = getString("workspace-sending");
      } else if (state.running) {
        status.style.color = "#8c6a3f";
        const workText = runningStageText(state.events);
        status.textContent = workText;
        const waitingText = timelinePane.querySelector(
          ".tui-waiting-text",
        ) as HTMLElement | null;
        if (waitingText) waitingText.textContent = workText;
      } else {
        status.style.color = "#33302a";
        status.textContent = getString("workspace-host-zotero");
      }
    } catch (error) {
      status.style.color = "#b3452f";
      status.textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      pollInFlight = false;
    }
  }

  newSessionBtn.addEventListener("click", () => {
    void (async () => {
      await createTask({
        title: getString("workspace-untitled-task"),
      });
      await refreshSessions();
      renderLists();
    })();
  });
  settingsBtn.addEventListener("click", () => {
    void refreshConfig().then(() => openSettings());
  });
  knowledgeBtn.addEventListener("click", () => {
    void openKnowledgeWindow();
  });
  function onAttachmentDragEnter(event: Event): void {
    const drag = event as DragEvent;
    if (!hasDroppedFiles(drag.dataTransfer) || !canAcceptFileDrop()) {
      showAttachmentDrop(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    attachmentDragDepth += 1;
    showAttachmentDrop(true);
  }
  function onAttachmentDragOver(event: Event): void {
    const drag = event as DragEvent;
    if (!hasDroppedFiles(drag.dataTransfer) || !canAcceptFileDrop()) {
      resetAttachmentDrop();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (drag.dataTransfer) drag.dataTransfer.dropEffect = "copy";
    showAttachmentDrop(true);
  }
  function onAttachmentDragLeave(event: Event): void {
    const drag = event as DragEvent;
    if (
      !hasDroppedFiles(drag.dataTransfer) &&
      root.getAttribute("data-file-drop-active") !== "true"
    ) {
      return;
    }
    event.preventDefault();
    attachmentDragDepth = Math.max(0, attachmentDragDepth - 1);
    if (attachmentDragDepth === 0) showAttachmentDrop(false);
  }
  function onAttachmentDrop(event: Event): void {
    const drag = event as DragEvent;
    if (!hasDroppedFiles(drag.dataTransfer)) return;
    if (!canAcceptFileDrop()) {
      resetAttachmentDrop();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    resetAttachmentDrop();
    closeMentionMenu();
    closeSlashMenu();
    void prepareDroppedFiles(droppedFilePaths(drag.dataTransfer));
  }
  root.addEventListener("dragenter", onAttachmentDragEnter);
  root.addEventListener("dragover", onAttachmentDragOver);
  root.addEventListener("dragleave", onAttachmentDragLeave);
  root.addEventListener("drop", onAttachmentDrop);
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (mentionState.open) {
      runMentionSelection();
      return;
    }
    if (slashState.open) {
      runSlashSelection();
      return;
    }
    void sendPrompt();
  });
  sendBtn.addEventListener("click", (event) => {
    event.preventDefault();
    if (mentionState.open) {
      runMentionSelection();
      return;
    }
    if (slashState.open) {
      runSlashSelection();
      return;
    }
    void sendPrompt();
  });
  stopBtn.addEventListener("click", () => {
    if (state.sessionId) {
      void rpc("task/abort", { taskId: state.sessionId }).then(() => {
        state.running = false;
        updateRunningUI();
      });
    }
  });
  plusBtn.addEventListener("click", () => togglePlusMenu());
  layoutBtn.addEventListener("click", () => {
    rememberComposerDraft();
    rememberTimelineViewport();
    workspaceViewState = {
      taskId: state.sessionId,
      drafts: composerDrafts,
      references: referenceDrafts,
      viewports: timelineViewports,
    };
    options.onLayoutChange?.(compact ? "window" : "sidebar");
  });
  sessionsToggle.addEventListener("click", () => {
    showSessions = !showSessions;
    syncAuxiliaryPanes();
  });
  endpointBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleEndpointMenu();
  });
  doc.addEventListener("mousedown", (event) => {
    const target = event.target as Node | null;
    const contextDetails = doc.getElementById("confucius-context-details");
    if (
      contextDetails &&
      (!target ||
        (!contextRing.node.contains(target) &&
          !contextDetails.contains(target)))
    )
      contextDetails.remove();
    if (artifactChoiceMenu) {
      const artifactMenu = doc.getElementById("confucius-artifact-choice-menu");
      if (
        !target ||
        (!artifactChoiceMenu.anchor.contains(target) &&
          !artifactMenu?.contains(target))
      ) {
        closeArtifactChoiceMenu(false);
      }
    }
    const plusMenu = doc.getElementById("confucius-plus-menu");
    if (
      plusMenu &&
      (!target || (!plusBtn.contains(target) && !plusMenu.contains(target)))
    ) {
      closePlusMenu();
    }
    const slashMenu = doc.getElementById("confucius-slash-menu");
    if (
      slashState.open &&
      (!target || (!prompt.contains(target) && !slashMenu?.contains(target)))
    ) {
      closeSlashMenu();
    }
    const mentionMenu = doc.getElementById("confucius-mention-menu");
    if (
      mentionState.open &&
      (!target || (!prompt.contains(target) && !mentionMenu?.contains(target)))
    ) {
      closeMentionMenu();
    }
    const sourceMenu = doc.getElementById("confucius-source-menu");
    if (
      sourceMenu &&
      target &&
      !sourceMenu.contains(target) &&
      !doc.getElementById("confucius-task-sources")?.contains(target)
    )
      sourceMenu.remove();
    if (!endpointMenuOpen) return;
    const menu = doc.getElementById("confucius-endpoint-menu");
    if (
      (target && endpointBtn.contains(target)) ||
      (target && menu?.contains(target))
    ) {
      return;
    }
    closeEndpointMenu();
  });
  contextRing.node.addEventListener("click", toggleContextDetails);
  contextRing.node.addEventListener("keydown", (event) => {
    if (["Enter", " "].includes((event as KeyboardEvent).key)) {
      event.preventDefault();
      toggleContextDetails();
    }
  });
  for (const [trigger, menuId, dismiss] of [
    [plusBtn, "confucius-plus-menu", closePlusMenu],
    [endpointBtn, "confucius-endpoint-menu", closeEndpointMenu],
    [
      contextRing.node,
      "confucius-context-details",
      () => doc.getElementById("confucius-context-details")?.remove(),
    ],
  ] as const) {
    trigger.addEventListener("keydown", (event) => {
      if (
        (event as KeyboardEvent).key !== "Escape" ||
        !doc.getElementById(menuId)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
  }
  prompt.addEventListener("compositionstart", () => {
    composing = true;
  });
  prompt.addEventListener("compositionend", () => {
    composing = false;
    updateComposerMenus();
  });
  prompt.addEventListener("input", () => {
    rememberComposerDraft();
    if (composing) return;
    updateComposerMenus();
  });
  prompt.addEventListener("click", updateComposerMenus);
  prompt.addEventListener("keydown", (event) => {
    const action = composerKeyAction(event as KeyboardEvent, composing);
    if (action === "ignore" || action === "newline") return;
    const key = (event as KeyboardEvent).key;
    if (
      mentionState.open &&
      mentionState.items.length > 0 &&
      (key === "ArrowDown" || key === "ArrowUp")
    ) {
      event.preventDefault();
      mentionState.index +=
        key === "ArrowDown" ? 1 : -1 + mentionState.items.length * 2;
      mentionState.index %= mentionState.items.length;
      const menu = doc.getElementById("confucius-mention-menu");
      if (menu) {
        highlightMentionRows(menu);
        const activeRow = menu.querySelector(
          `[data-mention-index="${mentionState.index}"]`,
        ) as HTMLElement | null;
        activeRow?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (slashState.open && (key === "ArrowDown" || key === "ArrowUp")) {
      event.preventDefault();
      slashState.index +=
        key === "ArrowDown" ? 1 : -1 + slashState.items.length * 2;
      slashState.index %= slashState.items.length;
      const menu = doc.getElementById("confucius-slash-menu");
      if (menu) {
        highlightSlashRows(menu);
        const activeRow = menu.querySelector(
          `[data-slash-index="${slashState.index}"]`,
        ) as HTMLElement | null;
        activeRow?.scrollIntoView({ block: "nearest" });
      } else {
        renderSlashMenu();
      }
      return;
    }
    if (slashState.open && key === "Tab") {
      event.preventDefault();
      runSlashSelection();
      return;
    }
    if (mentionState.open && key === "Tab") {
      event.preventDefault();
      runMentionSelection();
      return;
    }
    if (key === "Escape" && mentionState.open) {
      event.preventDefault();
      closeMentionMenu();
      return;
    }
    if (key === "Escape" && endpointMenuOpen) {
      event.preventDefault();
      closeEndpointMenu();
      return;
    }
    if (key === "Escape" && slashState.open) {
      event.preventDefault();
      closeSlashMenu();
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      if (mentionState.open) {
        runMentionSelection();
        return;
      }
      if (slashState.open) {
        runSlashSelection();
        return;
      }
      void sendPrompt();
    }
  });

  renderLists();
  syncEndpointButton();
  if (host) {
    void poll();
    const timer = win?.setInterval(() => {
      void poll();
    }, 800);
    if (timer) {
      pollTimers.set(root, timer);
    }
    win?.addEventListener("unload", () => {
      if (timer) {
        win.clearInterval(timer);
        pollTimers.delete(root);
      }
    });
  }
}
