import type { ConfuciusEvent } from "@confucius/protocol";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_UI_FONT,
  DEFAULT_UI_FONT_SIZE,
  clampUiFontSize,
  coalesceTimeline,
  isUiFont,
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
  type LiveContextResult,
} from "@confucius/protocol";
import { durableExcerpt } from "@confucius/memory";
import { slashMenuToken, type ConfuciusSkill } from "@confucius/skill-format";
import { renderToString as katexRender } from "katex";
import { getString } from "../../utils/locale";

const HTML_NS = "http://www.w3.org/1999/xhtml";

const linkHosts = new WeakMap<HTMLElement, WorkspaceHost | null>();
const linkListeners = new WeakSet<HTMLElement>();

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

type SessionRow = { id: string; title?: string };

type ApprovalRow = {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
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
  reasoningEffort: "auto" | "off" | "low" | "medium" | "high";
  contextWindowTokens: number;
};

type ModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  streamResponses: boolean;
  memoryAutoExtract: boolean;
  reasoningEffort: "auto" | "off" | "low" | "medium" | "high";
  contextWindowTokens: number;
  hasApiKey: boolean;
  configured?: boolean;
  endpoints?: ModelEndpoint[];
  activeEndpointId?: string;
  maxIterations?: number;
  maxToolCalls?: number;
  uiFont?: UiFont;
  uiFontSize?: number;
};

/** Local font stacks for the three UI font presets (no web fonts, offline-safe). */
const UI_FONT_STACKS: Record<UiFont, string> = {
  sans: '"Segoe UI", "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  mono: '"Cascadia Mono", ui-monospace, Consolas, "Courier New", monospace',
};

const DEFAULT_REVIEW_WIDTH = 260;

/** Review pane width survives sidebar/window switches within the same run. */
let rememberedReviewWidth = DEFAULT_REVIEW_WIDTH;

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
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
  }
  return node;
}

const TUI_CSS = `
@keyframes confucius-shimmer {
  0% { background-position: 200% 50%; }
  100% { background-position: -200% 50%; }
}
.tui-waiting {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  background-image: linear-gradient(90deg, #a19c92 0%, #33302a 35%, #8a857c 50%, #33302a 65%, #a19c92 100%);
  background-size: 220% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: confucius-shimmer 1.5s linear infinite;
}
.tui-waiting-bar {
  height: 2px;
  margin-top: 6px;
  border-radius: 1px;
  background-image: linear-gradient(90deg, transparent 0%, #33302a 50%, transparent 100%);
  background-size: 220% 100%;
  animation: confucius-shimmer 1.5s linear infinite;
}
.tui-answer table { border-collapse: collapse; margin: 8px 0; width: auto; }
.tui-answer {
  min-width: 0;
  overflow-wrap: anywhere;
}
.tui-answer table {
  display: block;
  max-width: 100%;
  overflow-x: auto;
}
.tui-answer th, .tui-answer td {
  border: 1px solid #ddd8cc;
  padding: 4px 8px;
  font-size: 13px;
}
.tui-answer th { background: #f0ece3; }
.tui-answer pre {
  background: #f0ece3;
  padding: 8px 10px;
  overflow: auto;
  max-width: 100%;
  box-sizing: border-box;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.tui-answer code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.92em;
}
.tui-answer h1, .tui-answer h2, .tui-answer h3 { margin: 10px 0 6px; }
.tui-answer p { margin: 0 0 8px; }
.tui-answer math { font-size: 1.05em; }
.confucius-icon-button {
  width: 34px !important;
  height: 34px !important;
  min-width: 34px !important;
  min-height: 34px !important;
  flex: 0 0 34px;
  padding: 0 !important;
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
  justify-self: center;
  border: 0 !important;
  border-radius: 8px !important;
  background: transparent !important;
  color: #33302a !important;
  box-sizing: border-box;
  cursor: pointer;
  line-height: 1;
  transition: background 120ms ease, color 120ms ease;
}
.confucius-icon-button:hover {
  background: #f0ece3 !important;
  color: #33302a !important;
}
.confucius-icon-button:focus-visible {
  outline: 2px solid #33302a;
  outline-offset: 2px;
}
.confucius-icon-button svg {
  width: 20px;
  height: 20px;
  display: block;
}
.confucius-knowledge-overlay {
  position: absolute;
  inset: 0;
  z-index: 1200;
  display: flex;
  padding: 12px;
  box-sizing: border-box;
  background: rgba(90, 80, 60, 0.35);
  backdrop-filter: blur(2px);
}
.confucius-knowledge-shell {
  width: min(1180px, 100%);
  height: 100%;
  min-width: 0;
  min-height: 0;
  margin: auto;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid #ddd8cc;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 18px 50px rgba(90, 80, 60, 0.16);
}
.confucius-knowledge-header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e1d8;
  background: #f5f3ee;
}
.confucius-knowledge-header-copy { min-width: 0; flex: 1; }
.confucius-knowledge-eyebrow {
  color: #8a857c;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.confucius-knowledge-heading {
  overflow: hidden;
  color: #33302a;
  font: 700 17px/1.25 Inter, "Segoe UI", system-ui, sans-serif;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-knowledge-body {
  display: grid;
  grid-template-columns: minmax(170px, 220px) minmax(220px, .85fr) minmax(280px, 1.15fr);
  min-width: 0;
  min-height: 0;
}
.confucius-knowledge-pane {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  box-sizing: border-box;
}
.confucius-knowledge-topics {
  padding: 14px 10px;
  border-right: 1px solid #e5e1d8;
  background: #f5f3ee;
}
.confucius-knowledge-entries {
  padding: 14px;
  border-right: 1px solid #e5e1d8;
  background: #ffffff;
}
.confucius-knowledge-editor { padding: 16px; background: #ffffff; }
.confucius-kb-row, .confucius-kb-entry-row {
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #33302a;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
}
.confucius-kb-row:hover, .confucius-kb-entry-row:hover { background: #efece4; }
.confucius-kb-row.active, .confucius-kb-entry-row.active {
  background: #33302a;
  color: #ffffff;
  box-shadow: inset 3px 0 #b05c2e;
}
.confucius-kb-meta { margin-top: 2px; color: #8a857c; font-size: 11px; }
.confucius-kb-section-label {
  margin: 0 0 8px;
  color: #8a857c;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.confucius-kb-toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
.confucius-kb-toolbar input { flex: 1; min-width: 0; }
.confucius-kb-filters { display: flex; flex-wrap: wrap; gap: 4px; overflow-x: auto; padding-bottom: 8px; }
.confucius-kb-filter {
  flex: 0 0 auto;
  padding: 4px 8px;
  border: 1px solid #e5e1d8;
  border-radius: 8px;
  background: #f0ece3;
  color: #6b665c;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}
.confucius-kb-filter.active { background: #33302a; border-color: #33302a; color: #ffffff; }
.confucius-kb-field { display: grid; gap: 5px; margin-bottom: 12px; color: #555046; font-size: 11px; }
.confucius-kb-field input, .confucius-kb-field textarea, .confucius-kb-field select,
.confucius-kb-toolbar input {
  min-width: 0;
  width: 100%;
  padding: 8px 9px;
  border: 1px solid #ddd8cc;
  border-radius: 8px;
  background: #ffffff;
  color: #33302a;
  box-sizing: border-box;
  font: inherit;
}
.confucius-kb-field input:focus, .confucius-kb-field textarea:focus, .confucius-kb-field select:focus,
.confucius-kb-toolbar input:focus {
  outline: none;
  border-color: #33302a;
}
.confucius-kb-field textarea { min-height: 180px; resize: vertical; line-height: 1.5; }
.confucius-mindmap-workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.confucius-mindmap-preview {
  min-height: 220px;
  overflow: auto;
  padding: 12px;
  border: 1px solid #e5e1d8;
  border-radius: 8px;
  background: #f5f3ee;
}
.confucius-mindmap-preview ul { margin: 4px 0 4px 14px; padding-left: 12px; border-left: 1px solid #ddd8cc; }
.confucius-mindmap-preview > ul { margin-left: 0; padding-left: 0; border-left: 0; }
.confucius-mindmap-preview li { margin: 5px 0; color: #33302a; }
.confucius-kb-actions { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
.confucius-kb-danger { margin-left: auto; color: #b3452f !important; background: transparent !important; border-color: #e3c0b6 !important; }
.confucius-kb-empty { display: grid; place-items: center; min-height: 180px; padding: 18px; color: #8a857c; text-align: center; }
.confucius-kb-error { margin: 8px 0; color: #b3452f; font-size: 12px; white-space: pre-wrap; }
@media (max-width: 760px) {
  .confucius-knowledge-overlay { padding: 0; }
  .confucius-knowledge-shell { border: 0; border-radius: 0; }
  .confucius-knowledge-body { grid-template-columns: 132px minmax(0, 1fr); }
  .confucius-knowledge-editor { grid-column: 1 / -1; border-top: 1px solid #e5e1d8; }
  .confucius-knowledge-entries { border-right: 0; }
  .confucius-mindmap-workspace { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 430px) {
  .confucius-knowledge-header { padding: 9px 10px; }
  .confucius-knowledge-body { display: block; overflow: auto; }
  .confucius-knowledge-pane { overflow: visible; }
  .confucius-knowledge-topics { border-right: 0; border-bottom: 1px solid #e5e1d8; }
  .confucius-knowledge-entries { border-right: 0; border-bottom: 1px solid #e5e1d8; }
  .confucius-kb-topic-list { display: flex; gap: 6px; overflow-x: auto; }
  .confucius-kb-row { flex: 0 0 140px; }
  .confucius-kb-field textarea { min-height: 150px; }
}
.confucius-workspace-root a {
  color: #8a5a2b;
  text-decoration: underline;
  text-decoration-color: #cbb890;
  text-underline-offset: 2px;
  cursor: pointer;
}
`;

function ensureTuiStyles(doc: Document): void {
  if (doc.getElementById("confucius-tui-css")) {
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

function fillAnswerHtml(node: HTMLElement, text: string): void {
  node.innerHTML = renderMarkdownHtml(text);
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
  if (toolName !== "commit_annotations" && toolName !== "propose_highlights") {
    return null;
  }
  const key = typeof args.key === "string" ? args.key.trim() : "";
  if (!key) {
    return null;
  }
  const highlights = Array.isArray(args.highlights)
    ? (args.highlights as Array<{ page?: unknown }>)
    : [];
  const firstPage = highlights
    .map((highlight) => Number(highlight?.page))
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
    width: compact ? "100%" : "auto",
    height: compact ? "100%" : "auto",
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

function button(
  doc: Document,
  id: string,
  label: string,
  variant: "primary" | "outline" = "outline",
): HTMLElement {
  const solid = variant === "primary";
  const node = el(
    doc,
    "button",
    {
      background: solid ? "#33302a" : "#ffffff",
      color: solid ? "#ffffff" : "#33302a",
      border: "1px solid #ddd8cc",
      borderRadius: "8px",
      padding: "6px 12px",
      cursor: "pointer",
      minHeight: "32px",
      font: "inherit",
      fontWeight: "600",
    },
    { id, type: "button" },
  );
  node.textContent = label;
  return node;
}

function brandMark(doc: Document): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const plate = doc.createElementNS(SVG_NS, "rect");
  plate.setAttribute("width", "32");
  plate.setAttribute("height", "32");
  plate.setAttribute("rx", "7");
  plate.setAttribute("fill", "#8a5a3b");
  const arc = doc.createElementNS(SVG_NS, "path");
  arc.setAttribute("d", "M25 10.5 A11.5 11.5 0 1 0 25 21.5");
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", "#ffffff");
  arc.setAttribute("stroke-width", "3.4");
  const tick = doc.createElementNS(SVG_NS, "rect");
  tick.setAttribute("x", "22");
  tick.setAttribute("y", "14.6");
  tick.setAttribute("width", "6");
  tick.setAttribute("height", "2.8");
  tick.setAttribute("fill", "#33302a");
  svg.appendChild(plate);
  svg.appendChild(arc);
  svg.appendChild(tick);
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

const EFFORT_OPTIONS = ["auto", "off", "low", "medium", "high"] as const;
type EffortOption = (typeof EFFORT_OPTIONS)[number];

/**
 * Native HTML select popups do not paint or receive clicks in Zotero chrome
 * windows. A button group is the same control, but actually usable.
 */
function effortPicker(
  doc: Document,
  id: string,
  value: string,
  onChange?: (value: EffortOption) => void,
): {
  node: HTMLElement;
  getValue: () => EffortOption;
  setValue: (value: string) => void;
} {
  let current: EffortOption = EFFORT_OPTIONS.includes(value as EffortOption)
    ? (value as EffortOption)
    : "auto";
  const node = el(
    doc,
    "div",
    {
      display: "flex",
      flexWrap: "wrap",
      gap: "4px",
    },
    { id, role: "radiogroup" },
  );
  const buttons = new Map<EffortOption, HTMLElement>();
  const paint = () => {
    for (const [effort, btn] of buttons) {
      const active = effort === current;
      Object.assign(btn.style, {
        background: active ? "#33302a" : "#ffffff",
        color: active ? "#f5f3ee" : "#33302a",
        border: `1px solid ${active ? "#33302a" : "#ddd8cc"}`,
        fontWeight: active ? "600" : "400",
      });
      btn.setAttribute("aria-checked", active ? "true" : "false");
    }
  };
  for (const effort of EFFORT_OPTIONS) {
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
      {
        type: "button",
        role: "radio",
        "data-effort": effort,
      },
    );
    btn.textContent = effort;
    btn.addEventListener("mouseenter", () => {
      if (effort !== current) {
        btn.style.background = "#f0ece3";
      }
    });
    btn.addEventListener("mouseleave", () => paint());
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (current === effort) {
        return;
      }
      current = effort;
      paint();
      onChange?.(effort);
    });
    buttons.set(effort, btn);
    node.appendChild(btn);
  }
  paint();
  return {
    node,
    getValue: () => current,
    setValue: (value: string) => {
      current = EFFORT_OPTIONS.includes(value as EffortOption)
        ? (value as EffortOption)
        : "auto";
      paint();
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
    { id: "confucius-context-ring", title: "Context usage — click to compact" },
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
  text.textContent = "0%";
  svg.appendChild(bg);
  svg.appendChild(fg);
  svg.appendChild(text);
  node.appendChild(svg);

  const update = (percent: number, label: string) => {
    const clamped = Math.max(0, Math.min(100, percent));
    fg.setAttribute(
      "stroke-dasharray",
      `${(clamped / 100) * circumference} ${circumference}`,
    );
    fg.setAttribute(
      "stroke",
      clamped >= 90 ? "#b3452f" : clamped >= 70 ? "#8c6a3f" : "#33302a",
    );
    text.textContent = `${Math.round(clamped)}%`;
    node.setAttribute("title", `${label} — click to compact`);
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
  title.textContent = "Confucius workspace failed to mount.";
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
    "confucius-slash-menu",
    "confucius-plus-menu",
    "confucius-endpoint-menu",
    "confucius-endpoint-submenu",
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
    root.addEventListener("click", (event) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      const href = anchor?.getAttribute("href") || "";
      const boundHost = linkHosts.get(root);
      if (!href || href.startsWith("#") || !boundHost?.openLink) {
        return;
      }
      event.preventDefault();
      void boundHost.openLink(href).then((result) => {
        if (!result.ok && result.message) {
          status.style.color = "#b3452f";
          status.textContent = result.message;
        }
      });
    });
  }

  const state = {
    sessions: [] as SessionRow[],
    sessionId: null as string | null,
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
    contextStats: null as {
      tokensEstimate: number;
      contextWindowTokens: number;
      percent: number;
    } | null,
    live: null as LiveContextResult | null,
    suppressedSelectionKey: null as string | null,
  };
  let pendingPermissionUpdate: Promise<void> = Promise.resolve();

  type ModelListCache = {
    status: "idle" | "loading" | "ok" | "error";
    models: string[];
    error: string;
  };
  const modelLists = new Map<string, ModelListCache>();
  const reasoningFold = new Map<string, ReasoningFold>();
  const toolsOpen = new Set<string>();
  const toolOpen = new Set<string>();
  let endpointMenuOpen = false;
  type EndpointSubmenu =
    { kind: "models"; endpointId: string } | { kind: "effort" };
  let endpointSubmenu: EndpointSubmenu | null = null;

  const topbar = el(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 14px",
    borderBottom: "1px solid #ddd8cc",
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
    : "host missing";
  brandGroup.appendChild(brandMark(doc));
  brandGroup.appendChild(brand);
  brandGroup.appendChild(status);
  const newSessionLabel = getString("workspace-new-session");
  const newSessionBtn = button(doc, "confucius-new-session", newSessionLabel);
  newSessionBtn.setAttribute("aria-label", newSessionLabel);
  newSessionBtn.setAttribute("title", newSessionLabel);
  const modeBtn = button(doc, "confucius-mode", "Agent");
  modeBtn.style.display = "none";
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
      background: "#f0ece3",
      color: "#33302a",
      border: "1px solid #ddd8cc",
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
  const reviewToggle = el(
    doc,
    "button",
    {
      background: "#f0ece3",
      color: "#33302a",
      border: "1px solid #ddd8cc",
      borderRadius: "8px",
      padding: "6px 10px",
      cursor: "pointer",
      minHeight: "32px",
      font: "inherit",
      display: compact ? "inline-flex" : "none",
    },
    { id: "confucius-toggle-review", type: "button" },
  );
  reviewToggle.textContent = getString("workspace-toggle-review");
  reviewToggle.setAttribute("aria-label", reviewToggle.textContent);
  reviewToggle.setAttribute("aria-pressed", "false");
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
  topbarActions.appendChild(reviewToggle);
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
  let showReview = !compact;
  const sessionPane = el(doc, "div", {
    width: compact ? "160px" : "220px",
    minWidth: compact ? "140px" : "180px",
    padding: "14px",
    overflow: "auto",
    borderRight: "1px solid #e5e1d8",
    background: "#faf9f6",
    boxSizing: "border-box",
    display: showSessions ? "block" : "none",
  });
  sessionPane.className = "confucius-pane confucius-session-pane";
  const timelinePane = el(doc, "div", {
    flex: "1 1 auto",
    minWidth: compact ? "0px" : "280px",
    padding: "14px",
    overflow: "auto",
    background: "#f5f3ee",
    boxSizing: "border-box",
  });
  timelinePane.className = "confucius-pane confucius-timeline-pane";
  const reviewPane = el(doc, "div", {
    width: compact ? "180px" : `${rememberedReviewWidth}px`,
    minWidth: compact ? "140px" : "200px",
    padding: "14px",
    overflow: "auto",
    borderLeft: "1px solid #e5e1d8",
    background: "#faf9f6",
    boxSizing: "border-box",
    display: showReview ? "block" : "none",
  });
  reviewPane.className = "confucius-pane confucius-review-pane";
  const reviewGrip = el(
    doc,
    "div",
    {
      width: "6px",
      minWidth: "6px",
      flex: "0 0 auto",
      cursor: "col-resize",
      background: "transparent",
      display: showReview && !compact ? "block" : "none",
      transition: "background 120ms ease",
    },
    {
      id: "confucius-review-grip",
      role: "separator",
      title: getString("workspace-review-grip"),
    },
  );
  reviewGrip.setAttribute("aria-orientation", "vertical");
  reviewGrip.addEventListener("mouseenter", () => {
    reviewGrip.style.background = "#e5e1d8";
  });
  reviewGrip.addEventListener("mouseleave", () => {
    reviewGrip.style.background = "transparent";
  });
  reviewGrip.addEventListener("dblclick", () => {
    rememberedReviewWidth = DEFAULT_REVIEW_WIDTH;
    reviewPane.style.width = `${DEFAULT_REVIEW_WIDTH}px`;
  });
  reviewGrip.addEventListener("pointerdown", (event) => {
    if (auxiliaryOverlay) {
      return;
    }
    event.preventDefault();
    const dragWin = doc.defaultView;
    const startX = (event as PointerEvent).clientX;
    const startWidth = reviewPane.getBoundingClientRect().width;
    const onMove = (move: PointerEvent) => {
      const maxW = Math.max(240, Math.floor((responsiveWidth || 800) * 0.6));
      const next = Math.min(
        maxW,
        Math.max(200, startWidth + (startX - move.clientX)),
      );
      rememberedReviewWidth = next;
      reviewPane.style.width = `${next}px`;
    };
    const onUp = () => {
      dragWin?.removeEventListener("pointermove", onMove);
      dragWin?.removeEventListener("pointerup", onUp);
    };
    dragWin?.addEventListener("pointermove", onMove);
    dragWin?.addEventListener("pointerup", onUp);
  });
  columns.appendChild(sessionPane);
  columns.appendChild(timelinePane);
  columns.appendChild(reviewGrip);
  columns.appendChild(reviewPane);

  const composer = el(doc, "form", {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "12px 14px",
    borderTop: "1px solid #ddd8cc",
    background: "#faf9f6",
    minHeight: "64px",
    boxSizing: "border-box",
    flex: "0 0 auto",
  });
  composer.className = "confucius-composer";
  const prompt = el(
    doc,
    "input",
    {
      flex: "1 1 auto",
      display: "block",
      height: "40px",
      minHeight: "40px",
      minWidth: compact ? "80px" : "240px",
      border: "1px solid #ddd8cc",
      borderRadius: "8px",
      background: "#ffffff",
      color: "#33302a",
      padding: "0 12px",
      font: "inherit",
    },
    {
      id: "confucius-prompt",
      type: "text",
      placeholder: getString("workspace-composer-placeholder"),
    },
  ) as HTMLInputElement;
  prompt.style.boxSizing = "border-box";
  const sendBtn = button(
    doc,
    "confucius-send",
    getString("workspace-send"),
    "primary",
  );
  sendBtn.setAttribute("type", "submit");
  sendBtn.setAttribute("aria-label", getString("workspace-send"));
  const stopBtn = button(doc, "confucius-stop", getString("workspace-stop"));
  stopBtn.setAttribute("aria-label", getString("workspace-stop"));
  stopBtn.style.display = "none";
  stopBtn.style.background = "#ffffff";
  stopBtn.style.border = "1px solid #8c6a3f";
  stopBtn.style.color = "#8c6a3f";

  const plusBtn = el(
    doc,
    "button",
    {
      flex: "0 0 auto",
      background: "#33302a",
      color: "#ffffff",
      border: "1px solid #ddd8cc",
      borderRadius: "8px",
      width: "40px",
      height: "40px",
      cursor: "pointer",
      font: "inherit",
      fontSize: "18px",
    },
    {
      id: "confucius-plus",
      type: "button",
      title: getString("workspace-plus"),
    },
  );
  plusBtn.textContent = "+";
  plusBtn.setAttribute("aria-label", getString("workspace-plus"));

  const endpointBtn = el(
    doc,
    "button",
    {
      flex: "0 1 auto",
      display: "flex",
      alignItems: "center",
      gap: "6px",
      maxWidth: "180px",
      minWidth: "108px",
      height: "40px",
      minHeight: "40px",
      margin: "0",
      padding: "0 10px",
      border: "1px solid #ddd8cc",
      borderRadius: "8px",
      background: "#ffffff",
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
  const endpointChevron = el(doc, "span", {
    flex: "0 0 auto",
    color: "#6b665c",
  });
  endpointChevron.textContent = "▾";
  endpointBtn.appendChild(endpointName);
  endpointBtn.appendChild(endpointChevron);

  const contextRing = buildContextRing(doc);

  composer.appendChild(plusBtn);
  composer.appendChild(prompt);
  composer.appendChild(endpointBtn);
  composer.appendChild(contextRing.node);
  composer.appendChild(sendBtn);
  composer.appendChild(stopBtn);

  const contextBar = el(
    doc,
    "div",
    {
      display: "none",
      flexWrap: "wrap",
      gap: "6px",
      alignItems: "center",
      padding: "8px 14px 0",
    },
    { id: "confucius-context-bar" },
  );

  root.appendChild(topbar);
  root.appendChild(columns);
  root.appendChild(contextBar);
  root.appendChild(composer);

  const sessionsLabel = getString("workspace-toggle-sessions");
  const reviewLabel = getString("workspace-toggle-review");
  const sendLabel = getString("workspace-send");
  const stopLabel = getString("workspace-stop");
  let auxiliaryOverlay = compact;
  let responsiveWidth = 0;
  let density: "wide" | "compact" | "narrow" = compact ? "compact" : "wide";

  function paintToggle(node: HTMLElement, active: boolean): void {
    node.setAttribute("aria-pressed", active ? "true" : "false");
    node.style.background = active ? "#33302a" : "#f0ece3";
    node.style.color = active ? "#ffffff" : "#33302a";
    node.style.borderColor = active ? "#33302a" : "#ddd8cc";
  }

  function syncAuxiliaryPanes(): void {
    sessionsToggle.style.display = auxiliaryOverlay ? "inline-flex" : "none";
    reviewToggle.style.display = auxiliaryOverlay ? "inline-flex" : "none";
    paintToggle(sessionsToggle, auxiliaryOverlay && showSessions);
    paintToggle(reviewToggle, auxiliaryOverlay && showReview);

    if (!auxiliaryOverlay) {
      for (const pane of [sessionPane, reviewPane]) {
        pane.style.position = "static";
        pane.style.top = "";
        pane.style.right = "";
        pane.style.bottom = "";
        pane.style.left = "";
        pane.style.zIndex = "";
        pane.style.maxWidth = "";
        pane.style.boxShadow = "none";
        pane.style.display = "block";
      }
      sessionPane.style.width = "220px";
      sessionPane.style.minWidth = "180px";
      reviewPane.style.width = `${rememberedReviewWidth}px`;
      reviewPane.style.minWidth = "200px";
      reviewGrip.style.display = showReview ? "block" : "none";
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
      boxShadow: "8px 0 24px rgba(28, 25, 23, 0.18)",
      display: showSessions ? "block" : "none",
    });
    Object.assign(reviewPane.style, {
      position: "absolute",
      top: "0px",
      right: "0px",
      bottom: "0px",
      left: "auto",
      zIndex: "20",
      width: `${drawerWidth}px`,
      minWidth: "0px",
      maxWidth: "100%",
      boxShadow: "-8px 0 24px rgba(28, 25, 23, 0.18)",
      display: showReview ? "block" : "none",
    });
    reviewGrip.style.display = "none";
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
      showReview = false;
    }
    root.setAttribute("data-confucius-density", density);

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
      gridTemplateColumns: stacked ? "repeat(6, minmax(0, 1fr))" : "",
      width: stacked ? "100%" : "auto",
      marginLeft: stacked ? "0px" : "auto",
      gap: stacked ? "4px" : "8px",
    });
    for (const action of [newSessionBtn, sessionsToggle, reviewToggle]) {
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
    reviewToggle.textContent = narrow ? "✓" : reviewLabel;

    const stackedComposer = measured < 620;
    const tinyComposer = measured < 250;
    if (stackedComposer) {
      Object.assign(composer.style, {
        display: "grid",
        gridTemplateAreas: tinyComposer
          ? '"prompt prompt prompt" "plus endpoint action"'
          : '"prompt prompt prompt prompt" "plus endpoint context action"',
        gridTemplateColumns: tinyComposer
          ? "34px minmax(0, 1fr) 34px"
          : "40px minmax(0, 1fr) 30px 40px",
        alignItems: "center",
        gap: "6px",
        padding: "8px",
        minHeight: "0px",
      });
      Object.assign(prompt.style, {
        gridArea: "prompt",
        width: "100%",
        minWidth: "0px",
      });
      Object.assign(plusBtn.style, {
        gridArea: "plus",
        width: tinyComposer ? "34px" : "40px",
        height: tinyComposer ? "34px" : "40px",
      });
      Object.assign(endpointBtn.style, {
        gridArea: "endpoint",
        width: "100%",
        minWidth: "0px",
        maxWidth: "none",
      });
      Object.assign(contextRing.node.style, {
        gridArea: "context",
        display: tinyComposer ? "none" : "block",
        margin: "0px",
      });
      for (const action of [sendBtn, stopBtn]) {
        Object.assign(action.style, {
          gridArea: "action",
          minWidth: "0px",
          width: tinyComposer ? "34px" : "40px",
          height: tinyComposer ? "34px" : "40px",
          padding: "4px",
        });
      }
    } else {
      Object.assign(composer.style, {
        display: "flex",
        gridTemplateAreas: "",
        gridTemplateColumns: "",
        gap: "8px",
        padding: "12px 14px",
        minHeight: "64px",
      });
      Object.assign(prompt.style, {
        gridArea: "",
        width: "auto",
        minWidth: compact ? "0px" : "240px",
      });
      Object.assign(plusBtn.style, {
        gridArea: "",
        width: "40px",
        height: "40px",
      });
      Object.assign(endpointBtn.style, {
        gridArea: "",
        width: "auto",
        minWidth: "108px",
        maxWidth: "180px",
      });
      Object.assign(contextRing.node.style, {
        gridArea: "",
        display: "block",
        margin: "0 2px",
      });
      for (const action of [sendBtn, stopBtn]) {
        Object.assign(action.style, {
          gridArea: "",
          width: "auto",
          height: "auto",
          padding: "6px 12px",
        });
      }
    }
    sendBtn.textContent = stackedComposer ? "↑" : sendLabel;
    stopBtn.textContent = stackedComposer ? "■" : stopLabel;
    timelinePane.style.padding = stacked ? "10px" : "14px";
    sessionPane.style.padding = stacked ? "10px" : "14px";
    reviewPane.style.padding = stacked ? "10px" : "14px";
    syncAuxiliaryPanes();
  }

  const onWindowResize = () => applyResponsiveLayout();
  const ResizeObserverCtor = win?.ResizeObserver;
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(() => applyResponsiveLayout())
    : null;
  resizeObserver?.observe(root);
  win?.addEventListener("resize", onWindowResize);
  layoutCleanups.set(root, () => {
    resizeObserver?.disconnect();
    win?.removeEventListener("resize", onWindowResize);
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
    error: "",
  };

  const knowledgeKindLabel = (kind: KnowledgeEntryKind): string =>
    getString(`workspace-knowledge-kind-${kind}`);

  async function openKnowledgeWindow(): Promise<void> {
    knowledgeUi.open = true;
    knowledgeUi.loading = true;
    knowledgeUi.error = "";
    renderKnowledgeWindow();
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
    knowledgeUi.baseId = id;
    knowledgeUi.entryId = "";
    knowledgeUi.error = "";
    const result = (await rpc("knowledge/get", { id, limit: 2_000 })) as {
      knowledgeBase?: KnowledgeBaseDetail;
    };
    knowledgeUi.base = result.knowledgeBase ?? null;
    knowledgeUi.editor = knowledgeUi.base ? "base" : "empty";
    if (repaint) renderKnowledgeWindow();
  }

  function closeKnowledgeWindow(): void {
    knowledgeUi.open = false;
    doc.getElementById("confucius-knowledge-overlay")?.remove();
  }

  function renderKnowledgeWindow(): void {
    doc.getElementById("confucius-knowledge-overlay")?.remove();
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
    overlay.appendChild(shell);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeKnowledgeWindow();
    });

    const header = el(doc, "header");
    header.className = "confucius-knowledge-header";
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
    const focusTarget = knowledgeUi.creatingBase
      ? (doc.getElementById(
          "confucius-kb-base-title",
        ) as HTMLInputElement | null)
      : knowledgeUi.editor === "entry"
        ? (doc.getElementById(
            "confucius-kb-entry-title",
          ) as HTMLInputElement | null)
        : (doc.getElementById(
            "confucius-kb-topic-search",
          ) as HTMLInputElement | null);
    focusTarget?.focus();
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
      knowledgeUi.creatingBase = true;
      knowledgeUi.editor = "base";
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
    search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      for (const row of Array.from(
        list.querySelectorAll("[data-search]"),
      ) as HTMLElement[]) {
        row.style.display =
          !query || (row.dataset.search ?? "").includes(query) ? "" : "none";
      }
    });
    pane.appendChild(list);
    return pane;
  }

  function renderKnowledgeEntries(): HTMLElement {
    const pane = el(doc, "main");
    pane.className = "confucius-knowledge-pane confucius-knowledge-entries";
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
      knowledgeUi.creatingBase = false;
      knowledgeUi.editor = "base";
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
      knowledgeUi.entryId = "";
      knowledgeUi.editor = "entry";
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
      excerpt.textContent = entry.content.replace(/\s+/g, " ").slice(0, 90);
      row.appendChild(kind);
      row.appendChild(entryTitle);
      row.appendChild(excerpt);
      row.addEventListener("click", () => {
        knowledgeUi.entryId = entry.id;
        knowledgeUi.editor = "entry";
        renderKnowledgeWindow();
      });
      list.appendChild(row);
    }
    search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      for (const row of Array.from(
        list.querySelectorAll("[data-search]"),
      ) as HTMLElement[]) {
        row.style.display =
          !query || (row.dataset.search ?? "").includes(query) ? "" : "none";
      }
    });
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
      placeholder: "libraryID",
      "aria-label": "Zotero libraryID",
    }) as HTMLInputElement;
    const key = el(doc, "input", undefined, {
      type: "text",
      value: current?.source?.key ?? "",
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
    wrap.appendChild(previewCaption);
    wrap.appendChild(mdPreview);
    syncKind();

    const actions = el(doc, "div");
    actions.className = "confucius-kb-actions";
    const save = button(
      doc,
      "confucius-kb-save-entry",
      getString("workspace-knowledge-save"),
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
        await loadKnowledgeBase(knowledgeUi.baseId, false);
        knowledgeUi.entryId = result.entry?.id ?? "";
        knowledgeUi.editor = "entry";
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
    const row = tuiBlock(targetDoc, {
      color: "#3c3831",
      fontSize: "1em",
      fontWeight: "500",
      margin: "14px 0 10px",
      background: "#ffffff",
      border: "1px solid #e7e3da",
      borderRadius: "8px",
      padding: "8px 12px",
      boxShadow: "0 1px 2px rgba(90, 80, 60, 0.05)",
    });
    row.textContent = text;
    return row;
  }

  function renderAnswer(targetDoc: Document, text: string): HTMLElement {
    const row = tuiBlock(targetDoc, {
      color: "#33302a",
      fontSize: "1.08em",
      lineHeight: "1.7",
      margin: "6px 0 14px",
      padding: "2px 4px",
      maxWidth: "78ch",
    });
    row.classList.add("tui-answer");
    fillAnswerHtml(row, text);
    return row;
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
      color: "#8a857c",
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

  function renderWaiting(targetDoc: Document): HTMLElement {
    const wrap = tuiBlock(targetDoc, { margin: "10px 0 4px" });
    const label = el(targetDoc, "div");
    label.className = "tui-waiting";
    label.textContent = getString("workspace-waiting-model");
    const bar = el(targetDoc, "div");
    bar.className = "tui-waiting-bar";
    wrap.appendChild(label);
    wrap.appendChild(bar);
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

  function renderTimelineBlock(
    targetDoc: Document,
    block: TimelineBlock,
    index: number,
  ): HTMLElement | null {
    if (block.kind === "user") {
      return renderUserLine(targetDoc, block.text);
    }
    if (block.kind === "text") {
      return renderAnswer(targetDoc, block.text);
    }
    if (block.kind === "reasoning") {
      return renderReasoning(targetDoc, block.text, `reasoning:${index}`);
    }
    if (block.kind === "tools") {
      const key = `tools:${block.calls[0]?.callId || index}`;
      return renderTools(targetDoc, block.calls, key);
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
    root.style.fontFamily = UI_FONT_STACKS[font];
    root.style.fontSize = `${size}px`;
  }

  function selectionKey(sel: {
    text: string;
    pageIndex: number | null;
  }): string {
    return `${sel.pageIndex ?? -1}|${sel.text}`;
  }

  function isSelectionSuppressed(): boolean {
    const sel = state.live?.selection;
    return Boolean(sel && state.suppressedSelectionKey === selectionKey(sel));
  }

  function renderContextBar(): void {
    contextBar.textContent = "";
    const reader = state.live?.reader ?? null;
    const sel = state.live?.selection ?? null;
    const items = state.live?.items ?? [];
    const collection = state.live?.collection ?? null;
    type Chip = {
      text: string;
      title?: string;
      onClick?: () => void;
      onRemove?: () => void;
    };
    const chips: Chip[] = [];
    if (reader) {
      chips.push({
        text: `📖 ${reader.title}${reader.pageLabel ? ` · p${reader.pageLabel}` : ""}`,
        title: getString("workspace-ctx-open"),
        onClick: () => {
          void rpc("reader/open", {
            libraryID: reader.libraryID,
            key: reader.attachmentKey,
            pageIndex: reader.pageIndex ?? undefined,
          }).catch(() => undefined);
        },
      });
    }
    if (sel && !isSelectionSuppressed()) {
      chips.push({
        text: `✍️ ${sel.preview}`,
        title: getString("workspace-ctx-open"),
        onClick: reader
          ? () => {
              void rpc("reader/open", {
                libraryID: reader.libraryID,
                key: reader.attachmentKey,
                pageIndex: sel.pageIndex ?? undefined,
              }).catch(() => undefined);
            }
          : undefined,
        onRemove: () => {
          state.suppressedSelectionKey = selectionKey(sel);
          renderContextBar();
        },
      });
    }
    if (items.length) {
      chips.push({
        text: `🗂 ${items.length} ${getString("workspace-ctx-items")}`,
      });
    } else if (collection) {
      chips.push({ text: `🗂 ${collection}` });
    }
    contextBar.style.display = chips.length ? "flex" : "none";
    for (const chip of chips) {
      const node = el(doc, "div", {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        maxWidth: "280px",
        padding: "3px 10px",
        borderRadius: "8px",
        background: "#f0ece3",
        border: "1px solid #e5e1d8",
        color: "#6b665c",
        fontSize: "0.85em",
        boxSizing: "border-box",
      });
      const label = el(doc, "span", {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      });
      label.textContent = chip.text;
      if (chip.title) {
        node.title = chip.title;
      }
      if (chip.onClick) {
        node.style.cursor = "pointer";
      }
      node.appendChild(label);
      if (chip.onRemove) {
        const remove = el(doc, "span", {
          cursor: "pointer",
          color: "#8a857c",
          fontWeight: "700",
        });
        remove.textContent = "×";
        remove.title = getString("workspace-ctx-remove");
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          chip.onRemove?.();
        });
        node.appendChild(remove);
      }
      if (chip.onClick) {
        node.addEventListener("click", () => chip.onClick?.());
      }
      contextBar.appendChild(node);
    }
  }

  function renderLists(): void {
    applyAppearance();
    renderContextBar();
    syncEndpointButton();
    sessionPane.textContent = "";
    sessionPane.appendChild(paneLabel(doc, getString("workspace-sessions")));
    if (!state.sessions.length) {
      sessionPane.appendChild(muted(doc, getString("workspace-no-sessions")));
    } else {
      for (const item of state.sessions) {
        const row = el(doc, "div", {
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: "8px",
          borderRadius: "8px",
          cursor: "pointer",
          background: item.id === state.sessionId ? "#f0ece3" : "transparent",
        });
        const label = el(doc, "div", {
          flex: "1 1 auto",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        });
        label.textContent = item.title || item.id;
        const del = el(
          doc,
          "button",
          {
            flex: "0 0 auto",
            border: "none",
            background: "transparent",
            color: "#b3452f",
            cursor: "pointer",
            font: "inherit",
            padding: "0 4px",
          },
          { type: "button", title: "Delete session" },
        );
        del.textContent = "✕";
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          void (async () => {
            await rpc("session/delete", { sessionId: item.id });
            if (state.sessionId === item.id) {
              state.sessionId = null;
              state.events = [];
              state.lastEventId = null;
              state.running = false;
              state.pendingUserText = "";
            }
            await refreshSessions();
            renderLists();
          })();
        });
        row.addEventListener("click", () => {
          void (async () => {
            const selectedSessionId = item.id;
            state.sessionId = selectedSessionId;
            state.lastEventId = null;
            state.running = false;
            const loaded = (await rpc("session/load", {
              sessionId: selectedSessionId,
            })) as { mode?: string };
            if (state.sessionId !== selectedSessionId) {
              return;
            }
            state.mode = loaded.mode === "plan" ? "plan" : "agent";
            state.permission =
              (loaded as { permissionMode?: string }).permissionMode ===
              "auto_allow"
                ? "auto_allow"
                : (loaded as { permissionMode?: string }).permissionMode ===
                    "deny"
                  ? "deny"
                  : "ask";
            syncModeButton();
            const bundle = (await rpc("session/events", {
              sessionId: selectedSessionId,
            })) as { events?: ConfuciusEvent[] };
            if (state.sessionId !== selectedSessionId) {
              return;
            }
            state.events = mergeEvents([], bundle.events || [], true);
            if (state.events.length) {
              state.lastEventId = state.events[state.events.length - 1].id;
            }
            collectApprovals();
            state.running = isRunningFromEvents(state.events);
            updateRunningUI();
            if (auxiliaryOverlay) {
              showSessions = false;
              syncAuxiliaryPanes();
            }
            renderLists();
          })();
        });
        row.appendChild(label);
        row.appendChild(del);
        sessionPane.appendChild(row);
      }
    }

    const followTimeline =
      Boolean(state.sending || state.running || state.pendingUserText) ||
      timelinePane.scrollHeight -
        timelinePane.scrollTop -
        timelinePane.clientHeight <
        96;
    const savedTimelineScroll = timelinePane.scrollTop;
    timelinePane.textContent = "";
    const session = state.sessions.find((item) => item.id === state.sessionId);
    timelinePane.appendChild(
      paneLabel(
        doc,
        session
          ? `${getString("workspace-timeline")} · ${session.title || session.id}`
          : getString("workspace-timeline"),
      ),
    );
    if (state.config && !configReady(state.config)) {
      const banner = el(doc, "div", {
        border: "1px solid #d9b36a",
        borderRadius: "8px",
        padding: "10px 12px",
        marginBottom: "8px",
        background: "#f5f3ee",
        color: "#8c6a3f",
      });
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
      timelinePane.appendChild(banner);
    }
    if (state.pendingUserText) {
      timelinePane.appendChild(renderUserLine(doc, state.pendingUserText));
    }
    if (state.sendError) {
      const err = tuiBlock(doc, { color: "#8a2e1d" });
      err.textContent = state.sendError;
      timelinePane.appendChild(err);
    }
    if (!state.events.length && !state.pendingUserText && !state.sendError) {
      timelinePane.appendChild(
        muted(doc, getString("workspace-empty-timeline")),
      );
    } else {
      coalesceTimeline(state.events).forEach((block, index) => {
        const node = renderTimelineBlock(doc, block, index);
        if (node) {
          timelinePane.appendChild(node);
        }
      });
    }
    if (state.sending || turnAwaitingReply(state.events)) {
      timelinePane.appendChild(renderWaiting(doc));
    }
    timelinePane.scrollTop = followTimeline
      ? timelinePane.scrollHeight
      : savedTimelineScroll;

    reviewPane.textContent = "";
    reviewPane.appendChild(paneLabel(doc, getString("workspace-review")));
    if (!state.approvals.length) {
      reviewPane.appendChild(muted(doc, getString("workspace-empty-review")));
    } else {
      for (const item of state.approvals) {
        const card = el(doc, "div", {
          border: "1px solid #b05c2e",
          borderRadius: "8px",
          padding: "8px 10px",
          marginBottom: "8px",
          background: "#f5f3ee",
        });
        const name = el(doc, "div", {
          fontFamily: "ui-monospace, Consolas, monospace",
          fontSize: "11px",
          fontWeight: "600",
          letterSpacing: "0.04em",
          color: "#b05c2e",
        });
        name.textContent = item.toolName;
        const pre = el(doc, "pre", {
          whiteSpace: "pre-wrap",
          fontSize: "11px",
        });
        pre.textContent = JSON.stringify(item.args, null, 2);
        const actions = el(doc, "div", {
          display: "flex",
          gap: "6px",
          marginTop: "6px",
        });
        const allow = button(doc, "", "Allow", "primary");
        const always = button(doc, "", "Always");
        const deny = button(doc, "", "Deny");
        deny.style.background = "#ffffff";
        deny.style.border = "1px solid #b3452f";
        deny.style.color = "#b3452f";
        allow.addEventListener("click", () => {
          void resolveApproval(item.id, "allow", "once");
        });
        always.addEventListener("click", () => {
          void resolveApproval(item.id, "allow", "always");
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
            locateLink(doc, approvalLocate, {
              display: "block",
              margin: "4px 0 0",
            }),
          );
        }
        card.appendChild(pre);
        card.appendChild(actions);
        reviewPane.appendChild(card);
      }
    }

    reviewPane.appendChild(paneLabel(doc, getString("workspace-memory")));
    if (state.logCount > 0) {
      reviewPane.appendChild(
        muted(doc, `${state.logCount} ${getString("workspace-session-logs")}`),
      );
    }
    if (!state.memories.length) {
      reviewPane.appendChild(muted(doc, getString("workspace-no-memory")));
    } else {
      for (const memory of state.memories) {
        const card = el(doc, "div", {
          border: "1px solid #e5e1d8",
          borderRadius: "8px",
          padding: "6px 8px",
          marginBottom: "6px",
          background: "#ffffff",
        });
        const title = el(doc, "div", {
          fontSize: "11px",
          color: "#33302a",
          fontWeight: "700",
        });
        const tags = memory.tags ?? [];
        const pinned = tags.includes("confucius:pinned");
        const fromLog = tags.includes("promoted-from-log");
        title.textContent = `${pinned ? "★ " : ""}[${memory.type}] ${durableExcerpt(memory.title)}${
          fromLog ? ` · ${getString("workspace-memory-from-log")}` : ""
        }`;
        const body = el(doc, "div", { fontSize: "12px" });
        fillAnswerHtml(body, durableExcerpt(memory.content));
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
        del.textContent = "forget";
        del.addEventListener("click", () => {
          void (async () => {
            await rpc("memory/delete", { id: memory.id });
            await refreshMemories();
            renderLists();
          })();
        });
        card.appendChild(title);
        card.appendChild(body);
        card.appendChild(del);
        reviewPane.appendChild(card);
      }
    }
  }

  function syncModeButton(): void {
    modeBtn.textContent = state.mode === "plan" ? "Plan" : "Agent";
  }

  function syncEndpointButton(): void {
    const active = state.config?.endpoints?.find(
      (endpoint) => endpoint.id === state.config?.activeEndpointId,
    );
    const label =
      active?.model ||
      endpointLabel(active) ||
      getString("workspace-no-endpoint");
    endpointName.textContent = label;
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
    const hadPendingApprovals = state.approvals.length > 0;
    const open = new Map<string, ApprovalRow>();
    for (const event of state.events) {
      if (event.type === "approval_required") {
        const request = event.payload.request;
        open.set(request.id, {
          id: request.id,
          toolName: request.toolName,
          args: request.args,
        });
      }
      if (event.type === "approval_resolved") {
        open.delete(event.payload.resolution.id);
      }
    }
    state.approvals = [...open.values()];
    if (!hadPendingApprovals && state.approvals.length > 0) {
      showReview = true;
      if (auxiliaryOverlay) {
        showSessions = false;
      }
      syncAuxiliaryPanes();
    }
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
    const listed = (await rpc("session/list", {})) as {
      sessions?: SessionRow[];
    };
    state.sessions = listed.sessions || [];
    if (!state.sessionId && state.sessions[0]) {
      state.sessionId = state.sessions[0].id;
    }
  }

  async function sendPrompt(): Promise<void> {
    const text = prompt.value.trim();
    if (!text || state.sending || state.running) {
      return;
    }
    if (state.config && !configReady(state.config)) {
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
        const created = (await rpc("session/new", {
          title: text.slice(0, 72),
        })) as SessionRow;
        state.sessionId = created.id;
        state.events = [];
        state.lastEventId = null;
        state.running = false;
      }
      // A user can select a permission mode and immediately press Send. Wait
      // for the queued session update so the visible mode is the mode used by
      // the turn that follows.
      await pendingPermissionUpdate;
      const promptSessionId = state.sessionId;
      await refreshSessions();
      renderLists();
      const started = (await rpc("session/prompt", {
        sessionId: promptSessionId,
        text,
        context: { suppressSelection: isSelectionSuppressed() },
      })) as { superseded?: boolean };
      if (state.sessionId !== promptSessionId) {
        if (state.pendingUserText === text) {
          state.pendingUserText = "";
        }
        return;
      }
      // Keep text typed while the request was in flight; only clear the
      // submitted value when the composer was not edited concurrently.
      if (prompt.value.trim() === text) {
        prompt.value = "";
      }
      state.pendingUserText = "";
      state.running = !started.superseded;
      updateRunningUI();
      await refreshSessions();
      const requestedCursor = state.lastEventId;
      const bundle = (await rpc("session/events", {
        sessionId: promptSessionId,
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
      renderLists();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.sendError = message;
      status.style.color = "#b3452f";
      status.textContent = message;
      renderLists();
    } finally {
      state.sending = false;
      sendBtn.removeAttribute("disabled");
      updateRunningUI();
    }
  }

  async function resolveApproval(
    id: string,
    verdict: "allow" | "deny",
    scope: "once" | "always",
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
    const overlay = el(
      doc,
      "div",
      {
        position: "absolute",
        inset: "0px",
        background: "rgba(28, 25, 23, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: "1000",
      },
      { id: "confucius-settings-overlay" },
    );
    const panel = el(doc, "div", {
      background: "#ffffff",
      borderRadius: "8px",
      padding: responsiveWidth < 360 ? "14px" : "18px 20px",
      width: "480px",
      maxWidth: "calc(100% - 16px)",
      maxHeight: "calc(100% - 16px)",
      overflow: "auto",
      boxSizing: "border-box",
      font: `13px/1.5 ${UI_FONT_STACKS[isUiFont(config?.uiFont) ? config.uiFont : DEFAULT_UI_FONT]}`,
      color: "#33302a",
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });
    const header = el(doc, "div", {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      marginBottom: "12px",
      position: "sticky",
      top: "0px",
      background: "#ffffff",
      zIndex: "1",
    });
    const title = el(doc, "div", {
      fontWeight: "700",
      fontSize: "15px",
    });
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
    closeBtn.addEventListener("click", () => overlay.remove());
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const tabBar = el(
      doc,
      "div",
      {
        display: "flex",
        gap: "4px",
        borderBottom: "1px solid #e5e1d8",
        marginBottom: "14px",
      },
      { role: "tablist" },
    );
    const modelTab = el(doc, "div", {}, { id: "confucius-cfg-model-tab" });
    const appearanceTab = el(
      doc,
      "div",
      { display: "none" },
      { id: "confucius-cfg-appearance-tab" },
    );
    const makeTabButton = (id: string, label: string): HTMLElement => {
      const node = el(
        doc,
        "button",
        {
          appearance: "none",
          border: "none",
          borderBottom: "2px solid transparent",
          background: "transparent",
          color: "#6b665c",
          padding: "6px 12px",
          marginBottom: "-1px",
          cursor: "pointer",
          font: "inherit",
          fontWeight: "600",
        },
        { id, type: "button", role: "tab" },
      );
      node.textContent = label;
      node.addEventListener("mouseenter", () => {
        if (node.getAttribute("aria-selected") !== "true") {
          node.style.background = "#f0ece3";
        }
      });
      node.addEventListener("mouseleave", () => {
        node.style.background = "transparent";
      });
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
    const setSettingsTab = (tab: "model" | "appearance"): void => {
      modelTab.style.display = tab === "model" ? "block" : "none";
      appearanceTab.style.display = tab === "appearance" ? "block" : "none";
      const pairs: Array<[HTMLElement, boolean]> = [
        [modelTabBtn, tab === "model"],
        [appearanceTabBtn, tab === "appearance"],
      ];
      for (const [btn, active] of pairs) {
        btn.style.color = active ? "#33302a" : "#6b665c";
        btn.style.borderBottomColor = active ? "#b3452f" : "transparent";
        btn.setAttribute("aria-selected", active ? "true" : "false");
      }
    };
    modelTabBtn.addEventListener("click", () => setSettingsTab("model"));
    appearanceTabBtn.addEventListener("click", () =>
      setSettingsTab("appearance"),
    );
    panel.appendChild(tabBar);
    panel.appendChild(modelTab);
    panel.appendChild(appearanceTab);
    setSettingsTab("model");

    let live: ModelConfig = config ?? {
      baseUrl: "",
      apiKey: "",
      model: "",
      maxTokens: 0,
      streamResponses: true,
      memoryAutoExtract: true,
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
    const listBox = el(doc, "div", {
      border: "1px solid #ddd8cc",
      borderRadius: "8px",
      marginBottom: "8px",
      overflow: "hidden",
    });
    modelTab.appendChild(listBox);
    const addBtn = button(
      doc,
      "confucius-cfg-add",
      getString("workspace-endpoint-add"),
    );
    addBtn.style.background = "#ffffff";
    addBtn.style.border = "1px solid #ddd8cc";
    addBtn.style.marginBottom = "12px";
    modelTab.appendChild(addBtn);

    const field = (label: string, id: string, value: string, type = "text") => {
      const row = el(doc, "div", { marginBottom: "10px" });
      const name = el(doc, "label", {
        display: "block",
        fontSize: "11px",
        color: "#6b665c",
        marginBottom: "3px",
      });
      name.textContent = label;
      const input = el(
        doc,
        "input",
        {
          display: "block",
          width: "100%",
          boxSizing: "border-box",
          height: "32px",
          border: "1px solid #ddd8cc",
          borderRadius: "8px",
          padding: "0 8px",
          font: "inherit",
        },
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
      "Base URL (OpenAI-compatible /chat/completions, or Ollama /api/chat)",
      "confucius-cfg-baseUrl",
      "",
    );
    const apiKeyInput = field(
      "API key (ignored by local Ollama)",
      "confucius-cfg-apiKey",
      "",
      "password",
    );
    const modelInput = field("Model", "confucius-cfg-model", "");
    const maxTokensInput = field(
      "Max tokens (0 = provider default)",
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
      row.appendChild(input);
      row.appendChild(text);
      modelTab.appendChild(row);
      return input;
    };
    const contextInput = field(
      "Context window (tokens, for the usage ring and compaction)",
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
    effortLabel.textContent = "Thinking effort";
    const effort = effortPicker(doc, "confucius-cfg-effort", "auto");
    effortRow.appendChild(effortLabel);
    effortRow.appendChild(effort.node);
    modelTab.appendChild(effortRow);
    const stream = check(
      "Stream model output live",
      "confucius-cfg-stream",
      live.streamResponses !== false,
    );
    const extract = check(
      "Extract memories after each turn",
      "confucius-cfg-memory",
      live.memoryAutoExtract !== false,
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

    let fontChoice: UiFont = isUiFont(live.uiFont)
      ? live.uiFont
      : DEFAULT_UI_FONT;
    let sizeChoice = clampUiFontSize(live.uiFontSize ?? DEFAULT_UI_FONT_SIZE);

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

    const fontPreview = el(doc, "div", {
      border: "1px solid #e5e1d8",
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
    };
    paintSegmented(fontPicker.buttons, fontChoice);
    paintSegmented(sizePicker.buttons, String(sizeChoice));
    repaintFontPreview();

    const errorLine = el(doc, "div", {
      color: "#b3452f",
      minHeight: "18px",
      marginBottom: "8px",
    });
    panel.appendChild(errorLine);

    const actions = el(doc, "div", {
      display: "flex",
      flexWrap: "wrap",
      gap: "8px",
    });
    const save = button(
      doc,
      "confucius-cfg-save",
      getString("workspace-settings-save"),
    );
    const cancel = button(
      doc,
      "confucius-cfg-cancel",
      getString("workspace-settings-cancel"),
    );
    cancel.style.background = "#ffffff";
    cancel.style.border = "1px solid #ddd8cc";
    actions.appendChild(save);
    actions.appendChild(cancel);
    panel.appendChild(actions);

    const fillForm = (ep?: ModelEndpoint) => {
      nameInput.value = ep?.name ?? "";
      baseUrlInput.value = ep?.baseUrl ?? "";
      apiKeyInput.value = ep?.apiKey ?? "";
      modelInput.value = ep?.model ?? "";
      maxTokensInput.value = String(ep?.maxTokens ?? 0);
      contextInput.value = String(ep?.contextWindowTokens ?? 32768);
      effort.setValue(ep?.reasoningEffort ?? "auto");
    };

    const paintList = () => {
      listBox.textContent = "";
      for (const ep of live.endpoints ?? []) {
        const row = el(doc, "div", {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "6px 8px",
          cursor: "pointer",
          background: ep.id === editingId ? "#f0ece3" : "#ffffff",
          borderBottom: "1px solid #f0ece3",
        });
        const mark = el(doc, "span", {
          color: "#33302a",
          fontWeight: "700",
          width: "14px",
        });
        mark.textContent = ep.id === live.activeEndpointId ? "●" : "○";
        const info = el(doc, "div", {
          flex: "1 1 auto",
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
        row.appendChild(mark);
        row.appendChild(info);
        row.appendChild(del);
        row.addEventListener("click", () => {
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
        overlay.remove();
      }
    });
    cancel.addEventListener("click", () => overlay.remove());
    save.addEventListener("click", () => {
      void (async () => {
        errorLine.textContent = "";
        try {
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
            memoryAutoExtract: extract.checked,
            maxIterations:
              Number(iterationsInput.value) || DEFAULT_MAX_ITERATIONS,
            maxToolCalls:
              Number(toolCallsInput.value) || DEFAULT_MAX_TOOL_CALLS,
            uiFont: fontChoice,
            uiFontSize: sizeChoice,
          })) as ModelConfig;
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
          paintList();
        } catch (error) {
          errorLine.textContent =
            error instanceof Error ? error.message : String(error);
        }
      })();
    });
    root.appendChild(overlay);
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
    kind: "command" | "skill";
    slug?: string;
    searchText?: string;
    run?: () => void | Promise<void>;
  }

  const slashState = {
    open: false,
    items: [] as SlashCommand[],
    index: 0,
  };

  function slashCommands(): SlashCommand[] {
    const commands: SlashCommand[] = [
      {
        label: "/agent",
        description: getString("workspace-cmd-agent"),
        kind: "command",
        run: () => applyMode("agent"),
      },
      {
        label: "/plan",
        description: getString("workspace-cmd-plan"),
        kind: "command",
        run: () => applyMode("plan"),
      },
      {
        label: "/ask",
        description: getString("workspace-cmd-ask"),
        kind: "command",
        run: () => applyPermission("ask"),
      },
      {
        label: "/auto",
        description: getString("workspace-cmd-auto"),
        kind: "command",
        run: () => applyPermission("auto_allow"),
      },
      {
        label: "/deny-writes",
        description: getString("workspace-cmd-deny"),
        kind: "command",
        run: () => applyPermission("deny"),
      },
      {
        label: "/model",
        description: getString("workspace-cmd-model"),
        kind: "command",
        run: () => void refreshConfig().then(() => openSettings()),
      },
      {
        label: "/compact",
        description: getString("workspace-cmd-compact"),
        kind: "command",
        run: () => void compactNow(),
      },
    ];
    for (const skill of state.skills) {
      commands.push({
        label: `/${skill.slug}`,
        description: skill.description || skill.name,
        kind: "skill",
        slug: skill.slug,
        searchText: [skill.name, ...skill.triggers].join(" "),
      });
    }
    return commands;
  }

  function applyMode(mode: "agent" | "plan"): void {
    state.mode = mode;
    syncModeButton();
    if (state.sessionId) {
      void rpc("session/setMode", { sessionId: state.sessionId, mode });
    }
  }

  function applyPermission(mode: "ask" | "auto_allow" | "deny"): void {
    state.permission = mode;
    if (state.sessionId) {
      const sessionId = state.sessionId;
      const update = pendingPermissionUpdate
        .catch(() => undefined)
        .then(() =>
          rpc("session/setPermissions", {
            sessionId,
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
      const stats = (await rpc("session/compact", {
        sessionId: state.sessionId,
      })) as {
        percent: number;
        tokensEstimate: number;
        contextWindowTokens: number;
      };
      state.contextStats = stats;
      contextRing.update(stats.percent, ringLabel(stats));
    } catch (error) {
      status.style.color = "#b3452f";
      status.textContent =
        error instanceof Error ? error.message : String(error);
    }
  }

  function ringLabel(stats: {
    tokensEstimate: number;
    contextWindowTokens: number;
  }): string {
    return `${fmtTokens(stats.tokensEstimate)} / ${fmtTokens(stats.contextWindowTokens)} tokens`;
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
    const menu = el(
      doc,
      "div",
      {
        position: "fixed",
        background: "#ffffff",
        border: "1px solid #ddd8cc",
        borderRadius: "8px",
        boxShadow: "0 6px 18px rgba(28,25,23,0.18)",
        maxHeight: "260px",
        overflow: "auto",
        zIndex: "900",
        boxSizing: "border-box",
      },
      {
        id: "confucius-slash-menu",
        role: "listbox",
        "aria-label": "Commands and skills",
      },
    );
    slashState.items.forEach((command, index) => {
      const active = index === slashState.index;
      const row = el(doc, "div", {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "12px",
        padding: "7px 10px",
        cursor: "pointer",
        background: active ? "#f0ece3" : "transparent",
      });
      row.setAttribute("role", "option");
      row.setAttribute("data-slash-index", String(index));
      row.setAttribute("aria-selected", active ? "true" : "false");
      const label = el(doc, "span", {
        fontWeight: "600",
        flex: "0 0 auto",
      });
      label.textContent = command.label;
      const hint = el(doc, "span", {
        color: "#6b665c",
        fontSize: "12px",
        flex: "1 1 auto",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        textAlign: "right",
      });
      hint.textContent = command.description;
      row.appendChild(label);
      row.appendChild(hint);
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
      menu.appendChild(row);
    });
    placeMenu(prompt, menu, Math.min(560, Math.max(220, responsiveWidth - 16)));
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
      row.style.background = active ? "#f0ece3" : "transparent";
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
    closeSlashMenu();
    prompt.value = "";
    void command.run?.();
  }

  function closePlusMenu(): void {
    doc.getElementById("confucius-plus-menu")?.remove();
  }

  function closeEndpointMenu(): void {
    endpointMenuOpen = false;
    endpointSubmenu = null;
    doc.getElementById("confucius-endpoint-menu")?.remove();
    doc.getElementById("confucius-endpoint-submenu")?.remove();
    endpointBtn.setAttribute("aria-expanded", "false");
  }

  function menuPanel(id: string, extra?: Styles): HTMLElement {
    return el(
      doc,
      "div",
      {
        position: "fixed",
        background: "#ffffff",
        border: "1px solid #ddd8cc",
        borderRadius: "8px",
        boxShadow: "0 6px 18px rgba(28,25,23,0.18)",
        padding: "6px",
        zIndex: "920",
        minWidth: "0px",
        maxHeight: "360px",
        overflow: "auto",
        boxSizing: "border-box",
        ...extra,
      },
      { id, role: "menu" },
    );
  }

  function menuRow(
    label: string,
    opts: {
      active?: boolean;
      hint?: string;
      onClick?: () => void;
      onEnter?: () => void;
    } = {},
  ): HTMLElement {
    const row = el(doc, "div", {
      padding: "6px 8px",
      borderRadius: "8px",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      background: opts.active ? "#f0ece3" : "transparent",
    });
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
        flex: "0 0 auto",
        color: "#6b665c",
        fontSize: "12px",
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
  ): void {
    const view = doc.defaultView;
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
    const menuWidth = Math.min(preferredWidth, availableWidth);
    menu.style.position = "fixed";
    menu.style.width = `${menuWidth}px`;
    menu.style.maxWidth = `${availableWidth}px`;
    menu.style.left = `${Math.min(
      Math.max(leftBound, rect.left),
      Math.max(leftBound, rightBound - menuWidth),
    )}px`;
    menu.style.right = "auto";
    menu.style.top = "0px";
    menu.style.bottom = "auto";
    menu.style.visibility = "hidden";
    const host = doc.body ?? doc.documentElement;
    host?.appendChild(menu);
    const box = menu.getBoundingClientRect();
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

  function placeSubmenu(
    anchor: HTMLElement,
    submenu: HTMLElement,
    menu: HTMLElement,
  ): void {
    const view = doc.defaultView;
    const rowRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const width = view?.innerWidth ?? 1100;
    const height = view?.innerHeight ?? 800;
    const rootRect = root.getBoundingClientRect();
    const narrowRoot =
      rootRect.width > 0 && rootRect.width < 500 && width < 500;
    const subWidth = narrowRoot
      ? Math.max(120, menuRect.width)
      : Math.min(240, width - 16);
    if (narrowRoot) {
      submenu.style.position = "fixed";
      submenu.style.width = `${subWidth}px`;
      submenu.style.maxWidth = `${Math.max(120, rootRect.width - 16)}px`;
      submenu.style.top = `${menuRect.top}px`;
      submenu.style.bottom = "auto";
      submenu.style.left = `${menuRect.left}px`;
      submenu.style.zIndex = "930";
      (doc.body ?? doc.documentElement)?.appendChild(submenu);
      return;
    }
    const openLeft = width - menuRect.right < subWidth + 12;
    submenu.style.position = "fixed";
    submenu.style.width = `${subWidth}px`;
    submenu.style.top = `${rowRect.top}px`;
    submenu.style.bottom = "auto";
    submenu.style.left = openLeft
      ? `${Math.max(8, menuRect.left - subWidth - 4)}px`
      : `${menuRect.right + 4}px`;
    const host = doc.body ?? doc.documentElement;
    host?.appendChild(submenu);
    const box = submenu.getBoundingClientRect();
    if (box.bottom > height - 8) {
      submenu.style.top = `${Math.max(8, height - box.height - 8)}px`;
    }
  }

  async function ensureModels(endpointId: string): Promise<void> {
    const cached = modelLists.get(endpointId);
    if (cached && (cached.status === "loading" || cached.status === "ok")) {
      return;
    }
    const endpoint = state.config?.endpoints?.find(
      (item) => item.id === endpointId,
    );
    modelLists.set(endpointId, {
      status: "loading",
      models: endpoint?.model ? [endpoint.model] : [],
      error: "",
    });
    if (endpointMenuOpen) {
      renderEndpointMenu();
    }
    try {
      const result = (await rpc("config/listModels", { endpointId })) as {
        models?: string[];
        error?: string;
      };
      modelLists.set(endpointId, {
        status: result.error ? "error" : "ok",
        models:
          result.models && result.models.length
            ? result.models
            : endpoint?.model
              ? [endpoint.model]
              : [],
        error: result.error || "",
      });
    } catch (error) {
      modelLists.set(endpointId, {
        status: "error",
        models: endpoint?.model ? [endpoint.model] : [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (
      endpointMenuOpen &&
      endpointSubmenu?.kind === "models" &&
      endpointSubmenu.endpointId === endpointId
    ) {
      renderEndpointMenu();
    }
  }

  async function applyEndpointSwitch(endpointId: string): Promise<void> {
    endpointSubmenu = { kind: "models", endpointId };
    if (endpointId !== state.config?.activeEndpointId) {
      try {
        state.config = (await rpc("config/set", {
          activeEndpointId: endpointId,
        })) as ModelConfig;
      } catch {
        /* keep old value */
      }
      syncEndpointButton();
    }
    renderEndpointMenu();
    void ensureModels(endpointId);
  }

  async function applyModelSelection(
    endpointId: string,
    model: string,
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (endpointId !== state.config?.activeEndpointId) {
      patch.activeEndpointId = endpointId;
    }
    const target = state.config?.endpoints?.find(
      (item) => item.id === endpointId,
    );
    if (model && model !== target?.model) {
      patch.model = model;
    }
    if (Object.keys(patch).length > 0) {
      try {
        state.config = (await rpc("config/set", patch)) as ModelConfig;
      } catch (error) {
        status.style.color = "#b3452f";
        status.textContent =
          error instanceof Error ? error.message : String(error);
      }
    }
    closeEndpointMenu();
    syncEndpointButton();
  }

  async function applyEffort(value: EffortOption): Promise<void> {
    try {
      state.config = (await rpc("config/set", {
        reasoningEffort: value,
      })) as ModelConfig;
    } catch {
      /* keep old value */
    }
    renderEndpointMenu();
  }

  function openModelsSubmenu(endpointId: string): void {
    if (
      endpointSubmenu?.kind === "models" &&
      endpointSubmenu.endpointId === endpointId
    ) {
      return;
    }
    endpointSubmenu = { kind: "models", endpointId };
    renderEndpointMenu();
    void ensureModels(endpointId);
  }

  function renderEndpointMenu(): void {
    doc.getElementById("confucius-endpoint-menu")?.remove();
    doc.getElementById("confucius-endpoint-submenu")?.remove();
    if (!endpointMenuOpen) {
      return;
    }
    const endpoints = state.config?.endpoints ?? [];
    const menu = menuPanel("confucius-endpoint-menu");
    const section = (title: string) => {
      const label = el(doc, "div", {
        fontSize: "11px",
        color: "#6b665c",
        margin: "6px 8px 4px",
        textTransform: "uppercase" as const,
        letterSpacing: "0.08em",
      });
      label.textContent = title;
      menu.appendChild(label);
    };

    section(getString("workspace-endpoints"));
    const endpointRows = new Map<string, HTMLElement>();
    for (const ep of endpoints) {
      const active = ep.id === state.config?.activeEndpointId;
      const open =
        endpointSubmenu?.kind === "models" &&
        endpointSubmenu.endpointId === ep.id;
      const row = menuRow(
        ep.name || ep.model || endpointHost(ep.baseUrl) || ep.id,
        {
          active: active || open,
          hint: "›",
          onClick: () => {
            void applyEndpointSwitch(ep.id);
          },
          onEnter: () => openModelsSubmenu(ep.id),
        },
      );
      row.setAttribute("data-endpoint-id", ep.id);
      row.setAttribute("role", "menuitem");
      endpointRows.set(ep.id, row);
      menu.appendChild(row);
    }
    if (!endpoints.length) {
      menu.appendChild(
        menuRow(getString("workspace-no-endpoint"), { active: false }),
      );
    }

    const thinkingOpen = endpointSubmenu?.kind === "effort";
    const thinkingRow = menuRow(getString("workspace-thinking"), {
      active: thinkingOpen,
      hint: `${state.config?.reasoningEffort ?? "auto"} ›`,
      onClick: () => {
        endpointSubmenu = { kind: "effort" };
        renderEndpointMenu();
      },
      onEnter: () => {
        if (endpointSubmenu?.kind !== "effort") {
          endpointSubmenu = { kind: "effort" };
          renderEndpointMenu();
        }
      },
    });
    thinkingRow.setAttribute("data-submenu", "effort");
    thinkingRow.setAttribute("role", "menuitem");
    menu.appendChild(thinkingRow);

    const manage = menuRow(getString("workspace-endpoint-manage"), {
      onClick: () => {
        closeEndpointMenu();
        void refreshConfig().then(() => openSettings());
      },
    });
    manage.setAttribute("data-submenu", "manage");
    manage.setAttribute("role", "menuitem");
    menu.appendChild(manage);

    placeMenu(endpointBtn, menu);

    const submenu = menuPanel("confucius-endpoint-submenu");
    let submenuAnchor: HTMLElement | null;
    if (endpointSubmenu?.kind === "effort") {
      submenuAnchor = thinkingRow;
      for (const effort of EFFORT_OPTIONS) {
        const row = menuRow(effort, {
          active: (state.config?.reasoningEffort ?? "auto") === effort,
          onClick: () => {
            void applyEffort(effort);
          },
        });
        row.setAttribute("data-effort", effort);
        row.setAttribute("role", "menuitem");
        submenu.appendChild(row);
      }
    } else {
      const endpointId =
        endpointSubmenu?.kind === "models"
          ? endpointSubmenu.endpointId
          : state.config?.activeEndpointId || endpoints[0]?.id || "";
      submenuAnchor = endpointId ? endpointRows.get(endpointId) || null : null;
      const endpoint = endpoints.find((item) => item.id === endpointId);
      const cached = endpointId ? modelLists.get(endpointId) : undefined;
      const models = cached?.models?.length
        ? cached.models
        : endpoint?.model
          ? [endpoint.model]
          : [];
      if (cached?.status === "loading" && !models.length) {
        submenu.appendChild(menuRow(getString("workspace-model-loading")));
      }
      if (!models.length && cached?.status !== "loading") {
        submenu.appendChild(
          menuRow(
            cached?.error
              ? getString("workspace-model-error")
              : getString("workspace-model-empty"),
          ),
        );
      }
      for (const model of models) {
        const row = menuRow(model, {
          active: endpoint?.model === model,
          onClick: () => {
            void applyModelSelection(endpointId, model);
          },
        });
        row.setAttribute("data-model", model);
        row.setAttribute("role", "menuitem");
        submenu.appendChild(row);
      }
      if (cached?.status === "loading" && models.length) {
        submenu.appendChild(menuRow(getString("workspace-model-loading")));
      }
      if (cached?.error && models.length) {
        const err = el(doc, "div", {
          padding: "6px 8px",
          color: "#b3452f",
          fontSize: "11px",
        });
        err.textContent = cached.error;
        submenu.appendChild(err);
      }
    }
    if (submenuAnchor) {
      placeSubmenu(submenuAnchor, submenu, menu);
    } else {
      submenu.remove();
    }
  }

  function toggleEndpointMenu(): void {
    if (endpointMenuOpen) {
      closeEndpointMenu();
      return;
    }
    closePlusMenu();
    closeSlashMenu();
    endpointMenuOpen = true;
    const activeId = state.config?.activeEndpointId || "";
    endpointSubmenu = activeId
      ? { kind: "models", endpointId: activeId }
      : { kind: "effort" };
    renderEndpointMenu();
    syncEndpointButton();
    if (activeId) {
      void ensureModels(activeId);
    }
  }

  function togglePlusMenu(): void {
    const existing = doc.getElementById("confucius-plus-menu");
    if (existing) {
      existing.remove();
      return;
    }
    closeEndpointMenu();
    closeSlashMenu();
    const menu = el(
      doc,
      "div",
      {
        position: "fixed",
        background: "#ffffff",
        border: "1px solid #ddd8cc",
        borderRadius: "8px",
        boxShadow: "0 6px 18px rgba(28,25,23,0.18)",
        padding: "10px 12px",
        zIndex: "900",
        maxHeight: "min(420px, calc(100vh - 16px))",
        overflow: "auto",
        boxSizing: "border-box",
      },
      { id: "confucius-plus-menu" },
    );

    const section = (title: string) => {
      const label = el(doc, "div", {
        fontSize: "11px",
        color: "#6b665c",
        margin: "8px 0 4px",
        textTransform: "uppercase" as const,
        letterSpacing: "0.08em",
      });
      label.textContent = title;
      menu.appendChild(label);
    };
    const option = (label: string, active: boolean, onClick: () => void) => {
      const row = el(doc, "div", {
        padding: "5px 8px",
        borderRadius: "8px",
        cursor: "pointer",
        display: "flex",
        justifyContent: "space-between",
        background: active ? "#f0ece3" : "transparent",
      });
      const text = el(doc, "span");
      text.textContent = label;
      row.appendChild(text);
      if (active) {
        const mark = el(doc, "span", { color: "#33302a", fontWeight: "700" });
        mark.textContent = "✓";
        row.appendChild(mark);
      }
      row.addEventListener("click", onClick);
      menu.appendChild(row);
    };

    section(getString("workspace-mode"));
    option("Agent", state.mode === "agent", () => {
      applyMode("agent");
      closePlusMenu();
    });
    option("Plan (read-only)", state.mode === "plan", () => {
      applyMode("plan");
      closePlusMenu();
    });

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
      } else if (
        event.turnId === latestTurnId &&
        (event.type === "text_delta" ||
          event.type === "reasoning_delta" ||
          event.type === "tool_requested" ||
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_aborted")
      ) {
        awaiting = false;
      }
    }
    return awaiting;
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
    const working = state.running || state.sending;
    sendBtn.style.display = working ? "none" : "";
    stopBtn.style.display = working ? "" : "none";
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
      try {
        const live = (await rpc("context/live", {})) as LiveContextResult;
        if (
          state.suppressedSelectionKey &&
          live.selection &&
          selectionKey(live.selection) !== state.suppressedSelectionKey
        ) {
          state.suppressedSelectionKey = null;
        }
        state.live = live;
      } catch {
        /* live context is cosmetic */
      }
      if (state.sessionId) {
        const polledSessionId = state.sessionId;
        const requestedCursor = state.lastEventId;
        const bundle = (await rpc("session/events", {
          sessionId: polledSessionId,
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
        const wasRunning = state.running;
        state.running = isRunningFromEvents(state.events);
        if (wasRunning !== state.running) {
          updateRunningUI();
        }
        try {
          const stats = (await rpc("session/context", {
            sessionId: state.sessionId,
          })) as {
            tokensEstimate: number;
            contextWindowTokens: number;
            percent: number;
          };
          state.contextStats = stats;
          contextRing.update(stats.percent, ringLabel(stats));
        } catch {
          /* stats are cosmetic */
        }
      }
      renderLists();
      if (state.sending) {
        status.style.color = "#8c6a3f";
        status.textContent = getString("workspace-sending");
      } else if (state.running) {
        status.style.color = "#8c6a3f";
        status.textContent = getString("workspace-waiting-model");
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
      const created = (await rpc("session/new", {
        title: "Untitled",
      })) as SessionRow;
      state.sessionId = created.id;
      state.events = [];
      state.lastEventId = null;
      state.mode = "agent";
      state.running = false;
      state.pendingUserText = "";
      state.approvals = [];
      syncModeButton();
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
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (slashState.open) {
      runSlashSelection();
      return;
    }
    void sendPrompt();
  });
  sendBtn.addEventListener("click", (event) => {
    event.preventDefault();
    if (slashState.open) {
      runSlashSelection();
      return;
    }
    void sendPrompt();
  });
  stopBtn.addEventListener("click", () => {
    if (state.sessionId) {
      void rpc("session/abort", { sessionId: state.sessionId }).then(() => {
        state.running = false;
        updateRunningUI();
      });
    }
  });
  plusBtn.addEventListener("click", () => togglePlusMenu());
  layoutBtn.addEventListener("click", () => {
    options.onLayoutChange?.(compact ? "window" : "sidebar");
  });
  sessionsToggle.addEventListener("click", () => {
    showSessions = !showSessions;
    if (showSessions) {
      showReview = false;
    }
    syncAuxiliaryPanes();
  });
  reviewToggle.addEventListener("click", () => {
    showReview = !showReview;
    if (showReview) {
      showSessions = false;
    }
    syncAuxiliaryPanes();
  });
  endpointBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleEndpointMenu();
  });
  doc.addEventListener("mousedown", (event) => {
    if (!endpointMenuOpen) {
      return;
    }
    const target = event.target as Node | null;
    const menu = doc.getElementById("confucius-endpoint-menu");
    const submenu = doc.getElementById("confucius-endpoint-submenu");
    if (
      (target && endpointBtn.contains(target)) ||
      (target && menu?.contains(target)) ||
      (target && submenu?.contains(target))
    ) {
      return;
    }
    closeEndpointMenu();
  });
  contextRing.node.addEventListener("click", () => void compactNow());
  prompt.addEventListener("input", () => updateSlashMenu(prompt.value));
  prompt.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
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
