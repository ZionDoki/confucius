import type {
  AgentBackendKind,
  ArtifactBody,
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
} from "@confucius/protocol";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_UI_FONT,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_UI_LINE_HEIGHT,
  DEFAULT_ANNOTATION_COLORS,
  FEATURED_TASK_TEMPLATES,
  UI_LINE_HEIGHT_VALUES,
  annotationsFromBody,
  clampUiFontSize,
  coalesceTimeline,
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
  memoryConsent: MemoryConsent;
  pluginRuntimeHost: boolean;
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
  uiLanguage?: UiLanguage;
  uiLineHeight?: UiLineHeight;
};

/** Local font stacks for the three UI font presets (no web fonts, offline-safe). */
const UI_FONT_STACKS: Record<UiFont, string> = {
  sans: '"Segoe UI", "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  mono: '"Cascadia Mono", ui-monospace, Consolas, "Courier New", monospace',
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
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
  }
  return node;
}

const TUI_CSS = `
@keyframes confucius-waiting-turn {
  0% { transform: rotate(0deg); opacity: 0.85; }
  50% { opacity: 0.4; }
  100% { transform: rotate(360deg); opacity: 0.85; }
}
.confucius-workspace-root {
  min-width: 0;
  max-width: 100%;
}
.confucius-workspace-root > .confucius-topbar,
.confucius-workspace-root > .confucius-columns,
.confucius-workspace-root > .confucius-composer {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-activity-shell,
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-task-overview,
.confucius-workspace-root[data-confucius-layout="sidebar"] .tui-answer {
  min-width: 0;
  max-width: 100%;
}
.tui-waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: #8a857c;
}
.tui-waiting-mark {
  width: 11px;
  height: 11px;
  flex: none;
  color: #55504a;
  transform-origin: 50% 50%;
  animation: confucius-waiting-turn 5.6s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}
.tui-answer table { border-collapse: collapse; margin: 8px 0; width: auto; }
.tui-answer {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  font-size: var(--confucius-markdown-font-size, 13px);
  line-height: var(--confucius-reading-line-height, 1.6);
}
.tui-answer table {
  display: block;
  max-width: 100%;
  overflow-x: auto;
}
.tui-answer th, .tui-answer td {
  border: 1px solid #ddd8cc;
  padding: 4px 8px;
  font-size: 1em;
}
.tui-answer th { background: #f0ece3; }
.tui-answer pre {
  background: #f0ece3;
  padding: 8px 10px;
  overflow: auto;
  max-width: 100%;
  box-sizing: border-box;
  overflow-wrap: anywhere;
  font-size: 0.92em;
}
.tui-answer code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.92em;
}
.tui-answer img { max-width: 100%; height: auto; }
.tui-answer .katex-display { max-width: 100%; overflow-x: auto; overflow-y: hidden; }
.tui-answer h1, .tui-answer h2, .tui-answer h3 { margin: 10px 0 6px; }
.tui-answer p { margin: 0 0 8px; }
.tui-answer math { font-size: 1.05em; }
.confucius-answer-shell { position: relative; }
.confucius-answer-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 26px;
  margin: 1px 0 0 -3px;
  opacity: .62;
  transition: opacity 120ms ease;
}
.confucius-answer-shell:hover .confucius-answer-actions,
.confucius-answer-shell:focus-within .confucius-answer-actions { opacity: 1; }
.confucius-answer-action {
  appearance: none;
  width: 26px;
  height: 26px;
  min-width: 26px;
  min-height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #777166;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, transform 120ms ease;
}
.confucius-answer-action:hover:not(:disabled) {
  background: #eee9df;
  color: #33302a;
}
.confucius-answer-action:active:not(:disabled) { transform: translateY(1px); }
.confucius-answer-action:focus-visible {
  outline: 2px solid #9a6842;
  outline-offset: 1px;
}
.confucius-answer-action:disabled { cursor: default; opacity: .38; }
.confucius-answer-action[data-state="success"] {
  background: #e5eee5;
  color: #3f6d49;
}
.confucius-answer-action svg { width: 15px; height: 15px; display: block; }
.confucius-menu-row {
  transition: background 90ms ease, box-shadow 90ms ease, color 90ms ease;
}
.confucius-menu-row:hover,
.confucius-menu-row[data-highlighted="true"] { background: #fff1ed; }
.confucius-menu-row[data-active="true"] {
  background: #fff1ed;
  box-shadow: inset 2px 0 #b44732;
  color: #8f2f20;
  font-weight: 600;
}
.confucius-composer-menu-row {
  transition: background 90ms ease, box-shadow 90ms ease;
}
.confucius-composer-menu-row[aria-selected="true"] {
  background: #fff1ed;
  box-shadow: inset 2px 0 #b44732;
}
.confucius-composer-row { width: 100%; min-width: 0; }
.confucius-attachment-tray {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.confucius-attachment-chip {
  max-width: min(310px, 100%);
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 5px 6px 5px 8px;
  border: 1px solid #d8d2c6;
  border-radius: 8px;
  background: #fffefa;
  color: #33302a;
  box-sizing: border-box;
  box-shadow: 0 2px 8px rgba(70, 59, 43, .045);
}
.confucius-attachment-chip[data-status="preparing"] { color: #7a684e; }
.confucius-attachment-chip[data-status="error"] {
  border-color: #dfb3a6;
  background: #fff8f5;
  color: #9c3f2b;
}
.confucius-attachment-kind {
  min-width: 30px;
  padding: 3px 5px;
  border-radius: 5px;
  background: #eee8dc;
  color: #795b36;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .06em;
  text-align: center;
}
.confucius-attachment-chip[data-status="error"] .confucius-attachment-kind {
  background: #f4dfd8;
  color: #9c3f2b;
}
.confucius-attachment-copy { min-width: 0; }
.confucius-attachment-name {
  display: block;
  overflow: hidden;
  font-size: 11px;
  font-weight: 650;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-attachment-meta {
  display: block;
  overflow: hidden;
  margin-top: 1px;
  color: #8a857c;
  font-size: 9px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-attachment-remove {
  appearance: none;
  width: 24px;
  height: 24px;
  min-width: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #8a857c;
  cursor: pointer;
  font: 600 16px/1 system-ui, sans-serif;
}
.confucius-attachment-remove:hover { background: #eee9df; color: #33302a; }
.confucius-drop-hint {
  position: absolute;
  inset: 6px;
  z-index: 950;
  display: grid;
  place-items: center;
  padding: 24px;
  border: 1px dashed rgba(138, 90, 43, .72);
  border-radius: 12px;
  background: rgba(250, 248, 242, .91);
  backdrop-filter: blur(4px);
  color: #795b36;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .01em;
  text-align: center;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 120ms ease, visibility 0s linear 120ms;
}
.confucius-workspace-root[data-file-drop-active="true"] .confucius-drop-hint {
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}
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
.confucius-task-row {
  border-left: 2px solid transparent;
  transition: background 120ms ease, border-color 120ms ease;
}
.confucius-task-row:hover { background: #f0ece3 !important; }
.confucius-task-row[data-active="true"] { border-left-color: #a45a2a; }
.confucius-activity-shell {
  width: min(900px, 100%);
  min-width: 0;
  max-width: 100%;
  margin: 0 auto;
  padding-bottom: 28px;
  box-sizing: border-box;
}
.confucius-activity-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 14px;
}
.confucius-task-overview {
  margin-bottom: 18px;
  padding: 4px 0 18px;
  border-bottom: 1px solid #ddd8cc;
}
.confucius-task-overview-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.confucius-task-overview h1 {
  margin: 5px 0 4px;
  overflow-wrap: anywhere;
  font-size: clamp(21px, 3.2vw, 27px);
  line-height: 1.2;
  letter-spacing: -.02em;
}
.confucius-task-empty {
  margin: 4px 0 18px;
  padding: 18px 0 20px;
  border-bottom: 1px solid #ddd8cc;
}
.confucius-artifact-file {
  appearance: none;
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  margin: 10px 0;
  padding: 13px 14px;
  border: 1px solid #d8d2c6;
  border-radius: 9px;
  background: #fffefa;
  color: #33302a;
  box-sizing: border-box;
  box-shadow: 0 4px 16px rgba(70, 59, 43, .055);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}
.confucius-artifact-file:hover {
  border-color: #b8ad9d;
  box-shadow: 0 8px 22px rgba(70, 59, 43, .09);
  transform: translateY(-1px);
}
.confucius-artifact-file:focus-visible {
  outline: 2px solid #8a5a2b;
  outline-offset: 2px;
}
.confucius-artifact-file-icon {
  width: 34px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 1px solid #baa98e;
  border-radius: 4px;
  background: #f4eee3;
  color: #8a5a2b;
  font: 700 17px/1 Georgia, serif;
  box-shadow: inset 0 -3px rgba(138, 90, 43, .06);
}
.confucius-artifact-file[data-update="true"] .confucius-artifact-file-icon {
  border-color: #9db09f;
  background: #edf3ed;
  color: #4f7657;
}
.confucius-artifact-file-copy { min-width: 0; }
.confucius-artifact-file-kind {
  display: block;
  margin-bottom: 2px;
  color: #8a857c;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.confucius-artifact-file-title {
  display: block;
  overflow: hidden;
  color: #33302a;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-artifact-file-meta {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  color: #777166;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-artifact-file-open {
  color: #8a5a2b;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file {
  height: auto;
  min-height: 50px;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: 9px;
  margin: 8px 0;
  padding: 8px 9px;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-icon {
  width: 28px;
  height: 34px;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-copy {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 45%);
  grid-template-areas:
    "title title"
    "kind meta";
  align-items: center;
  column-gap: 8px;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-kind {
  grid-area: kind;
  min-width: 0;
  margin: 1px 0 0;
  overflow: hidden;
  font-size: 9px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-title {
  grid-area: title;
  line-height: 1.3;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-meta {
  grid-area: meta;
  min-width: 0;
  margin: 1px 0 0;
  font-size: 10px;
  line-height: 1.25;
  text-align: right;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-file-open {
  display: none;
}
.confucius-artifact-overlay {
  position: absolute;
  inset: 0;
  z-index: 1000;
  display: block;
  padding: 0;
  box-sizing: border-box;
  background:
    radial-gradient(130% 100% at 50% 0%, rgba(252, 250, 245, 0.84) 0%, rgba(245, 242, 235, 0.72) 55%, rgba(238, 234, 225, 0.78) 100%);
  backdrop-filter: blur(22px) saturate(1.06);
  animation: confucius-artifact-overlay-in 150ms ease-out;
}
.confucius-artifact-overlay[data-refresh="true"] { animation: none; }
.confucius-artifact-overlay[data-mount="window"] { position: fixed; }
.confucius-artifact-overlay a {
  color: #8a5a2b;
  text-decoration: underline;
  text-decoration-color: #cbb890;
  text-underline-offset: 2px;
  cursor: pointer;
}
.confucius-artifact-dialog {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.confucius-artifact-action-rail {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 12px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  width: 40px;
  min-width: 0;
  min-height: 0;
  padding: 14px 0;
  border: 0;
  background: transparent;
  box-sizing: border-box;
  pointer-events: none;
}
.confucius-artifact-rail-spacer { flex: 1 1 auto; }
.confucius-artifact-rail-divider {
  width: 16px;
  height: 1px;
  flex: 0 0 1px;
  margin: 1px 0 3px;
  background: rgba(51, 48, 42, 0.18);
}
.confucius-artifact-rail-button,
.confucius-artifact-menu-trigger {
  appearance: none;
  position: relative;
  width: 40px;
  height: 40px;
  min-width: 40px;
  min-height: 40px;
  flex: 0 0 40px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  overflow: hidden;
  border: 1px solid rgba(215, 208, 196, 0.95);
  border-radius: 50%;
  background: rgba(255, 254, 250, 0.78);
  backdrop-filter: blur(10px);
  color: #5d574d;
  box-sizing: border-box;
  box-shadow: 0 2px 10px rgba(70, 59, 43, 0.1);
  font: inherit;
  cursor: pointer;
  pointer-events: auto;
  transition: background 110ms ease, border-color 110ms ease, color 110ms ease, transform 110ms ease, box-shadow 110ms ease;
}
.confucius-artifact-rail-button:hover,
.confucius-artifact-menu-trigger:hover {
  border-color: #c5b9a8;
  background: rgba(255, 254, 250, 0.96);
  color: #33302a;
  transform: translateY(-1px);
  box-shadow: 0 5px 16px rgba(70, 59, 43, 0.16);
}
.confucius-artifact-menu-trigger[aria-expanded="true"] {
  border-color: #c5b9a8;
  background: #fffefa;
  color: #8a5a2b;
}
.confucius-artifact-rail-button:focus-visible,
.confucius-artifact-menu-trigger:focus-visible {
  outline: 2px solid #8a5a2b;
  outline-offset: 1px;
}
.confucius-artifact-rail-button svg,
.confucius-artifact-menu-trigger svg { width: 18px; height: 18px; display: block; }
.confucius-artifact-menu-trigger-value {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: -.02em;
  white-space: nowrap;
}
.confucius-artifact-menu-trigger-chevron {
  position: absolute;
  right: 4px;
  bottom: 2px;
  color: #9a9387;
  font-size: 11px;
  line-height: 1;
  transition: transform 100ms ease;
}
.confucius-artifact-revision-badge {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid rgba(215, 208, 196, 0.7);
  border-radius: 50%;
  background: rgba(255, 254, 250, 0.55);
  backdrop-filter: blur(10px);
  color: #6f695f;
  box-sizing: border-box;
  font-size: 11px;
  font-weight: 700;
  pointer-events: auto;
}
#confucius-artifact-writeback {
  color: #8a5a2b;
}
#confucius-artifact-writeback:hover {
  border-color: #cabca9;
  background: #fffefa;
}
.confucius-artifact-rail-button:disabled {
  opacity: .38;
  cursor: default;
  transform: none;
}
.confucius-artifact-choice-menu {
  animation: confucius-artifact-menu-in 110ms ease-out;
}
.confucius-settings-choice-menu {
  animation: confucius-settings-menu-in 110ms ease-out;
}
.confucius-settings-select {
  appearance: none;
  width: 100%;
  height: 34px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 18px;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 0 9px 0 10px;
  border: 1px solid #ddd8cc;
  border-radius: 7px;
  background: #fff;
  color: #33302a;
  box-sizing: border-box;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 100ms ease, background 100ms ease,
    box-shadow 100ms ease;
}
.confucius-settings-select:hover:not(:disabled) {
  border-color: #c4bbad;
  background: #fffefa;
}
.confucius-settings-select:focus-visible,
.confucius-settings-select[aria-expanded="true"] {
  outline: none;
  border-color: #9a6430;
  box-shadow: 0 0 0 2px rgba(154, 100, 48, 0.14);
}
.confucius-settings-select:disabled {
  opacity: .48;
  cursor: default;
}
.confucius-settings-select-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-settings-select-chevron {
  color: #8a857c;
  font-size: 12px;
  line-height: 1;
  text-align: center;
  transition: transform 100ms ease;
}
.confucius-settings-select[aria-expanded="true"]
  .confucius-settings-select-chevron {
  transform: rotate(180deg);
}
.confucius-artifact-choice,
.confucius-settings-choice {
  appearance: none;
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 18px;
  align-items: center;
  gap: 10px;
  padding: 8px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #33302a;
  box-sizing: border-box;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.confucius-artifact-choice:hover,
.confucius-artifact-choice:focus-visible,
.confucius-settings-choice:hover,
.confucius-settings-choice:focus-visible {
  outline: none;
  background: #fff1ed;
}
.confucius-artifact-choice[data-selected="true"],
.confucius-settings-choice[data-selected="true"] {
  background: #fff1ed;
  box-shadow: inset 2px 0 #b44732;
}
.confucius-settings-choice-label {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-settings-choice-check {
  color: #a43b29;
  font-weight: 700;
  text-align: center;
}
.confucius-artifact-choice-copy { min-width: 0; }
.confucius-artifact-choice-title {
  display: block;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.confucius-artifact-choice-meta {
  display: block;
  margin-top: 1px;
  color: #8a857c;
  font-size: 10px;
}
.confucius-artifact-choice-check {
  color: #8a5a2b;
  font-weight: 700;
  text-align: center;
}
.confucius-artifact-dialog-body {
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: clamp(26px, 5vh, 54px) max(clamp(18px, 5vw, 68px), 68px) 64px clamp(18px, 5vw, 68px);
  background: transparent;
  box-sizing: border-box;
}
.confucius-artifact-shell {
  width: min(780px, 100%);
  min-width: 0;
  min-height: calc(100% - 50px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
}
.confucius-artifact-paper {
  min-width: 0;
  flex: 1 0 auto;
  margin: 20px 0 30px;
  padding: clamp(26px, 4vw, 44px) clamp(22px, 4.5vw, 52px) 56px;
  border: 1px solid rgba(215, 208, 196, 0.9);
  border-radius: 10px;
  background: rgba(255, 254, 250, 0.96);
  box-shadow:
    0 12px 36px rgba(70, 59, 43, 0.12),
    0 1px 3px rgba(70, 59, 43, 0.06);
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-action-rail {
  right: 6px;
  width: 36px;
  padding: 10px 0;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-rail-button,
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-menu-trigger,
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-revision-badge {
  width: 36px;
  height: 36px;
  min-width: 36px;
  min-height: 36px;
  flex-basis: 36px;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-dialog-body {
  padding: 18px 48px 40px 10px;
}
.confucius-workspace-root[data-confucius-layout="sidebar"] .confucius-artifact-paper {
  margin: 10px 0 18px;
  padding: 18px 16px 34px;
  border-radius: 8px;
}
.confucius-artifact-paper .tui-answer {
  font-size: 1.02em;
  line-height: var(--confucius-reading-line-height, 1.6);
}
.confucius-artifact-paper table {
  width: 100%;
  border-collapse: collapse;
  font-size: .92em;
}
.confucius-artifact-paper th,
.confucius-artifact-paper td {
  padding: 8px 10px;
  border-bottom: 1px solid #e5e1d8;
  text-align: left;
  vertical-align: top;
}
.confucius-artifact-paper th { color: #6b665c; font-size: .82em; letter-spacing: .05em; text-transform: uppercase; }
.confucius-template-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: minmax(86px, auto);
  gap: 0 18px;
  margin-top: 18px;
  border-top: 1px solid #ddd8cc;
}
.confucius-template-button {
  appearance: none;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  min-width: 0;
  min-height: 86px;
  padding: 15px 2px;
  border: 0;
  border-bottom: 1px solid #e5e1d8;
  background: transparent;
  color: #33302a;
  box-sizing: border-box;
  white-space: normal;
  text-align: left;
  cursor: pointer;
}
.confucius-template-button:hover { color: #9a4f25; }
.confucius-template-title { display: block; margin-bottom: 3px; font-weight: 700; }
.confucius-template-copy { display: block; color: #777166; font-size: .9em; line-height: 1.4; }
.confucius-runtime-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: #9b968b;
}
.confucius-runtime-dot[data-state="ready"] { background: #4f7657; }
.confucius-runtime-dot[data-state="auth_required"] { background: #bf762f; }
.confucius-runtime-dot[data-state="error"] { background: #b3452f; }
.confucius-before-after {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 8px;
}
.confucius-before-after pre {
  max-height: 180px;
  margin: 3px 0 0;
  padding: 8px;
  overflow: auto;
  border: 1px solid #e5e1d8;
  border-radius: 6px;
  background: #fff;
  white-space: pre-wrap;
  font: 11px/1.45 ui-monospace, Consolas, monospace;
}
@media (max-width: 620px) {
  .confucius-template-grid,
  .confucius-before-after { grid-template-columns: minmax(0, 1fr); }
  .confucius-template-grid { grid-auto-rows: minmax(70px, auto); }
  .confucius-template-button { min-height: 70px; }
  .confucius-artifact-action-rail { right: 6px; width: 36px; padding: 10px 0; }
  .confucius-artifact-rail-button,
  .confucius-artifact-menu-trigger,
  .confucius-artifact-revision-badge {
    width: 36px;
    height: 36px;
    min-width: 36px;
    min-height: 36px;
    flex-basis: 36px;
  }
  .confucius-artifact-dialog-body { padding: 18px 48px 40px 10px; }
  .confucius-artifact-file { grid-template-columns: 38px minmax(0, 1fr); gap: 9px; padding: 11px; }
  .confucius-artifact-file-open { display: none; }
  .confucius-artifact-paper { margin: 8px 0 14px; padding: 16px 12px 30px; border-radius: 8px; }
}
@keyframes confucius-artifact-overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes confucius-artifact-menu-in {
  from { opacity: 0; transform: translateX(4px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes confucius-settings-menu-in {
  from { opacity: 0; transform: scale(.985); }
  to { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .confucius-artifact-overlay,
  .confucius-artifact-choice-menu,
  .confucius-settings-choice-menu { animation: none; }
  .confucius-artifact-menu-trigger-chevron,
  .confucius-settings-select-chevron,
  .confucius-drop-hint { transition: none; }
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
    "confucius-artifact-overlay",
    "confucius-artifact-choice-menu",
    "confucius-security-profile-menu",
    "confucius-writeback-overlay",
    "confucius-slash-menu",
    "confucius-mention-menu",
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
    artifacts: [] as ArtifactRecord[],
    selectedArtifactId: null as string | null,
    selectedArtifactRevision: null as number | null,
    memoryProposals: [] as MemoryProposal[],
    runtimes: [] as RuntimeStatus[],
    runtimeHostEnabled: true,
    runtimeHostConnected: false,
  };
  const composerDrafts = new Map<string, string>();
  const timelineViewports = new Map<
    string,
    { scrollTop: number; followsBottom: boolean }
  >();
  let renderedTimelineTaskId: string | null = null;
  let taskLoadGeneration = 0;
  let pendingPermissionUpdate: Promise<void> = Promise.resolve();
  let pendingContextUpdate: Promise<void> = Promise.resolve();
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
  let artifactViewerReturnFocus: HTMLElement | null = null;
  let lastArtifactViewerSignature = "";
  let artifactChoiceMenu: {
    kind: "artifact" | "revision";
    anchor: HTMLElement;
  } | null = null;
  let endpointMenuOpen = false;
  let newApprovalsArrived = false;
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
  let newSessionLabel = getString("workspace-new-session");
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
    borderRight: "1px solid #e5e1d8",
    background: "#faf9f6",
    boxSizing: "border-box",
    display: showSessions ? "block" : "none",
  });
  sessionPane.className = "confucius-pane confucius-session-pane";
  sessionPane.setAttribute("aria-label", "Research tasks");
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

  const composer = el(doc, "form", {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "8px",
    padding: "12px 14px",
    borderTop: "1px solid #ddd8cc",
    background: "#faf9f6",
    minHeight: "64px",
    boxSizing: "border-box",
    flex: "0 0 auto",
    position: "relative",
  });
  composer.className = "confucius-composer";
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
  const composerRow = el(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  });
  composerRow.className = "confucius-composer-row";
  const dropHint = el(doc, "div", undefined, {
    id: "confucius-drop-hint",
    "aria-hidden": "true",
  });
  dropHint.className = "confucius-drop-hint";
  dropHint.textContent = getString("workspace-attachment-drop");
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

  composerRow.appendChild(plusBtn);
  composerRow.appendChild(prompt);
  composerRow.appendChild(endpointBtn);
  composerRow.appendChild(contextRing.node);
  composerRow.appendChild(sendBtn);
  composerRow.appendChild(stopBtn);
  composer.appendChild(attachmentTray);
  composer.appendChild(composerRow);

  root.appendChild(topbar);
  root.appendChild(columns);
  root.appendChild(composer);
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
    const nextPlusLabel = getString("workspace-plus");
    plusBtn.setAttribute("aria-label", nextPlusLabel);
    plusBtn.setAttribute("title", nextPlusLabel);
    endpointBtn.setAttribute("title", getString("workspace-model"));
    applyResponsiveLayout();
  }

  function paintToggle(node: HTMLElement, active: boolean): void {
    node.setAttribute("aria-pressed", active ? "true" : "false");
    node.style.background = active ? "#33302a" : "#f0ece3";
    node.style.color = active ? "#ffffff" : "#33302a";
    node.style.borderColor = active ? "#33302a" : "#ddd8cc";
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
      boxShadow: "8px 0 24px rgba(28, 25, 23, 0.18)",
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
      gridTemplateColumns: stacked
        ? `repeat(${narrow ? 3 : 5}, minmax(0, 1fr))`
        : "",
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

    const stackedComposer = measured < 620;
    const tinyComposer = measured < 250;
    if (stackedComposer) {
      Object.assign(composer.style, {
        gap: "6px",
        padding: "8px",
        minHeight: "0px",
      });
      Object.assign(composerRow.style, {
        display: "grid",
        gridTemplateAreas: tinyComposer
          ? '"prompt prompt prompt" "plus endpoint action"'
          : '"prompt prompt prompt prompt" "plus endpoint context action"',
        gridTemplateColumns: tinyComposer
          ? "34px minmax(0, 1fr) 34px"
          : "40px minmax(0, 1fr) 30px 40px",
        alignItems: "center",
        gap: "6px",
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
        gap: "8px",
        padding: "12px 14px",
        minHeight: "64px",
      });
      Object.assign(composerRow.style, {
        display: "flex",
        gridTemplateAreas: "",
        gridTemplateColumns: "",
        alignItems: "center",
        gap: "8px",
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
    error: "",
  };

  const knowledgeKindLabel = (kind: KnowledgeEntryKind): string =>
    getString(`workspace-knowledge-kind-${kind}`);

  async function openKnowledgeWindow(): Promise<void> {
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

    pane.appendChild(sectionLabel(getString("workspace-memory")));
    if (state.logCount > 0) {
      pane.appendChild(
        muted(doc, `${state.logCount} ${getString("workspace-session-logs")}`),
      );
    }
    if (!state.memories.length) {
      pane.appendChild(muted(doc, getString("workspace-no-memory")));
    }
    for (const memory of state.memories) {
      const card = el(doc, "div", {
        border: "1px solid #e5e1d8",
        borderRadius: "8px",
        padding: "6px 8px",
        marginBottom: "6px",
        background: "#ffffff",
      });
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
      del.textContent = "forget";
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
      pane.appendChild(card);
    }
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
      const plan = tuiBlock(targetDoc, {
        margin: "0 0 8px",
        padding: "7px 10px",
        borderLeft: "2px solid #ba8b56",
        background: "#f2eee6",
      });
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
      const action = tuiBlock(targetDoc, {
        margin: "0 0 8px",
        padding: "7px 10px",
        border: "1px solid #ddd8cc",
        borderRadius: "7px",
        background: "#f2eee6",
        fontFamily: UI_FONT_STACKS.mono,
        fontSize: ".88em",
      });
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
          overflow: "auto",
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
    const card = el(targetDoc, "div", {
      border: "1px solid #b05c2e",
      borderRadius: "8px",
      padding: "8px 10px",
      marginBottom: "8px",
      background: "#f5f3ee",
    });
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
    paramsToggle.style.color = "#8a857c";
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
    if (taskId) composerDrafts.set(taskId, prompt.value);
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

  async function loadTask(taskId: string): Promise<void> {
    const generation = ++taskLoadGeneration;
    const previousTaskId = state.sessionId;
    const switching = previousTaskId !== taskId;
    if (switching) {
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
    state.sessionId = taskId;
    state.lastEventId = null;
    state.running = false;
    state.pendingUserText = "";
    state.sendError = "";
    state.selectedArtifactId = null;
    state.selectedArtifactRevision = null;
    if (switching) {
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
    await loadTask(created.id);
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

  async function stageTemplate(
    template: TaskTemplate,
    context?: LockedContextSnapshot,
    promptOverride?: string,
  ): Promise<void> {
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
      closeSlashMenu();
      closeMentionMenu();
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      await refreshArtifacts();
      renderLists();
    } catch (error) {
      state.sendError = error instanceof Error ? error.message : String(error);
      renderLists();
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
    const generation = ++contextFlashGeneration;
    const label = getString("workspace-context-updated");
    plusBtn.textContent = "✓";
    plusBtn.setAttribute("data-state", "success");
    plusBtn.setAttribute("title", label);
    plusBtn.setAttribute("aria-label", label);
    doc.defaultView?.setTimeout(() => {
      if (generation !== contextFlashGeneration || !plusBtn.isConnected) {
        return;
      }
      plusBtn.textContent = "+";
      plusBtn.removeAttribute("data-state");
      plusBtn.setAttribute("title", getString("workspace-plus"));
      plusBtn.setAttribute("aria-label", getString("workspace-plus"));
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
      color: "#8a857c",
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

  function renderArtifactBodyNode(body: ArtifactBody): HTMLElement {
    const container = el(doc, "div");
    if (body.type === "markdown") {
      container.className = "tui-answer";
      fillAnswerHtml(container, body.markdown);
      return container;
    }
    const table = (
      headers: string[],
      rows: Array<Array<string | HTMLElement>>,
    ): HTMLElement => {
      const node = el(doc, "table");
      const head = el(doc, "thead");
      const headRow = el(doc, "tr");
      for (const label of headers) {
        const cell = el(doc, "th");
        cell.textContent = label;
        headRow.appendChild(cell);
      }
      head.appendChild(headRow);
      node.appendChild(head);
      const tbody = el(doc, "tbody");
      for (const values of rows) {
        const row = el(doc, "tr");
        for (const value of values) {
          const cell = el(doc, "td");
          if (typeof value === "string") cell.textContent = value;
          else cell.appendChild(value);
          row.appendChild(cell);
        }
        tbody.appendChild(row);
      }
      node.appendChild(tbody);
      return node;
    };
    if (body.type === "evidence_audit") {
      const fourColumn = body.claims.some(
        (claim) => claim.evidence !== undefined || claim.risk !== undefined,
      );
      container.appendChild(
        fourColumn
          ? table(
              [
                getString("workspace-artifact-claim"),
                getString("workspace-artifact-evidence"),
                getString("workspace-artifact-verdict"),
                getString("workspace-artifact-risk"),
              ],
              body.claims.map((claim) => [
                claim.claim,
                claim.evidence ?? claim.rationale ?? "",
                claim.verdict,
                claim.risk ?? "",
              ]),
            )
          : table(
              [
                getString("workspace-artifact-claim"),
                getString("workspace-artifact-verdict"),
                getString("workspace-artifact-rationale"),
              ],
              body.claims.map((claim) => [
                claim.claim,
                claim.verdict,
                claim.rationale ?? "",
              ]),
            ),
      );
    } else if (body.type === "literature_map") {
      const nodes = el(doc, "div", { marginBottom: "18px" });
      for (const node of body.nodes) {
        const row = el(doc, "div", {
          padding: "8px 0",
          borderBottom: "1px solid #ece8df",
        });
        const name = el(doc, "strong");
        name.textContent = node.label;
        row.appendChild(name);
        if (node.summary) {
          const summary = el(doc, "div", { color: "#6b665c" });
          summary.textContent = node.summary;
          row.appendChild(summary);
        }
        if (node.item) {
          row.appendChild(
            locateLink(doc, { ...node.item, pageIndex: undefined }),
          );
        }
        nodes.appendChild(row);
      }
      container.appendChild(nodes);
      container.appendChild(
        table(
          [
            getString("workspace-artifact-from"),
            getString("workspace-artifact-relation"),
            getString("workspace-artifact-to"),
          ],
          body.edges.map((edge) => [edge.source, edge.relation, edge.target]),
        ),
      );
    } else if (body.type === "triage_table") {
      container.appendChild(
        table(
          [
            getString("workspace-artifact-source"),
            getString("workspace-artifact-decision"),
            getString("workspace-artifact-reason"),
          ],
          body.rows.map((row) => {
            const source = el(doc, "div");
            const title = el(doc, "div", { fontWeight: "600" });
            title.textContent = row.title;
            source.appendChild(title);
            source.appendChild(locateLink(doc, row.item));
            return [source, row.decision, row.reason];
          }),
        ),
      );
    } else if (body.type === "annotation_set") {
      const legend = body.legend?.length
        ? body.legend
        : [
            {
              type: "highlight" as const,
              color: DEFAULT_ANNOTATION_COLORS.highlight,
              meaning: getString(
                "workspace-artifact-annotation-highlight-default",
              ),
            },
            {
              type: "underline" as const,
              color: DEFAULT_ANNOTATION_COLORS.underline,
              meaning: getString(
                "workspace-artifact-annotation-underline-default",
              ),
            },
            {
              type: "image" as const,
              color: DEFAULT_ANNOTATION_COLORS.image,
              meaning: getString("workspace-artifact-annotation-image-default"),
            },
          ];
      const legendHeading = el(doc, "div", {
        marginBottom: "7px",
        color: "#6b665c",
        fontSize: "11px",
        fontWeight: "700",
        letterSpacing: ".06em",
        textTransform: "uppercase",
      });
      legendHeading.textContent = getString(
        "workspace-artifact-annotation-legend",
      );
      container.appendChild(legendHeading);
      const legendList = el(doc, "div", {
        marginBottom: "18px",
        borderTop: "1px solid #e5e1d8",
      });
      for (const entry of legend) {
        const row = el(doc, "div", {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "7px 0",
          borderBottom: "1px solid #eeeae2",
          color: "#575249",
          fontSize: ".9em",
        });
        const swatch = el(doc, "span", {
          width: "10px",
          height: "10px",
          flex: "0 0 10px",
          borderRadius: "3px",
          background: entry.color ?? DEFAULT_ANNOTATION_COLORS[entry.type],
          boxShadow: "inset 0 0 0 1px rgba(28,25,23,.12)",
        });
        const label = el(doc, "strong", { color: "#33302a" });
        label.textContent = getString(
          `workspace-artifact-annotation-${entry.type}`,
        );
        row.appendChild(swatch);
        row.appendChild(label);
        row.appendChild(doc.createTextNode(entry.meaning));
        legendList.appendChild(row);
      }
      container.appendChild(legendList);

      for (const annotation of annotationsFromBody(body)) {
        const color =
          annotation.color ?? DEFAULT_ANNOTATION_COLORS[annotation.type];
        const annotationNode = el(doc, "section", {
          marginBottom: "16px",
          padding: "0 0 16px 14px",
          borderLeft: `3px solid ${color}`,
          borderBottom: "1px solid #eeeae2",
        });
        const meta = el(doc, "div", {
          display: "flex",
          alignItems: "center",
          gap: "7px",
          marginBottom: "7px",
          color: "#777166",
          fontSize: ".82em",
        });
        const type = el(doc, "strong", { color: "#4b4740" });
        type.textContent = getString(
          `workspace-artifact-annotation-${annotation.type}`,
        );
        meta.appendChild(type);
        meta.appendChild(doc.createTextNode(`p. ${annotation.page}`));
        annotationNode.appendChild(meta);
        if (annotation.type === "image") {
          const region = el(doc, "div", {
            position: "relative",
            width: "112px",
            height: "148px",
            margin: "4px 0 9px",
            overflow: "hidden",
            border: "1px solid #d8d1c4",
            borderRadius: "4px",
            background:
              "repeating-linear-gradient(0deg,#faf9f6,#faf9f6 11px,#f0ece3 12px)",
          });
          const [x, y, width, height] = annotation.rect;
          const crop = el(doc, "span", {
            position: "absolute",
            left: `${x / 10}%`,
            top: `${y / 10}%`,
            width: `${width / 10}%`,
            height: `${height / 10}%`,
            boxSizing: "border-box",
            border: `2px solid ${color}`,
            background: `${color}2b`,
          });
          region.appendChild(crop);
          region.setAttribute(
            "title",
            `${getString("workspace-artifact-annotation-region")}: ${annotation.rect.join(", ")}`,
          );
          annotationNode.appendChild(region);
        } else {
          const quote = el(doc, "div", {
            marginBottom: annotation.comment ? "7px" : "0",
            padding: annotation.type === "highlight" ? "2px 4px" : "2px 0",
            background:
              annotation.type === "highlight" ? `${color}38` : "transparent",
            textDecoration:
              annotation.type === "underline" ? "underline" : "none",
            textDecorationColor: color,
            textDecorationThickness: "2px",
            textUnderlineOffset: "3px",
          });
          quote.textContent = `“${annotation.quote}”`;
          annotationNode.appendChild(quote);
        }
        if (annotation.comment) {
          const comment = el(doc, "div", {
            color: "#575249",
            lineHeight: "1.5",
          });
          comment.textContent = annotation.comment;
          annotationNode.appendChild(comment);
        }
        container.appendChild(annotationNode);
      }
    } else if (body.type === "collection_diff") {
      container.appendChild(
        table(
          [
            getString("workspace-artifact-operation"),
            getString("workspace-artifact-target"),
          ],
          body.operations.map((operation) => [
            operation.op,
            operation.item
              ? `${operation.item.libraryID}:${operation.item.key}`
              : (operation.value ?? ""),
          ]),
        ),
      );
    } else if (body.type === "citation_list") {
      const list = el(doc, "ol", { paddingLeft: "24px" });
      for (const entry of body.entries) {
        const item = el(doc, "li", { marginBottom: "10px" });
        item.textContent = entry.rendered;
        list.appendChild(item);
      }
      container.appendChild(list);
    }
    return container;
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
    const overlay = el(
      doc,
      "div",
      {
        position: "absolute",
        inset: "0px",
        zIndex: "1100",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "10px",
        boxSizing: "border-box",
        background: "rgba(28,25,23,.45)",
      },
      { id: "confucius-writeback-overlay" },
    );
    const panel = el(doc, "div", {
      width: "min(760px, 100%)",
      maxHeight: "100%",
      overflow: "auto",
      padding: "18px",
      boxSizing: "border-box",
      borderRadius: "9px",
      background: "#faf9f6",
      color: "#33302a",
      boxShadow: "0 18px 50px rgba(28,25,23,.2)",
    });
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
    cancel.addEventListener("click", () => overlay.remove());
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
          overlay.remove();
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
    root.appendChild(overlay);
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
      color: "#8a857c",
      fontSize: "11px",
      fontWeight: "700",
      letterSpacing: ".08em",
      textTransform: "uppercase",
    });
    meta.textContent = `${runtimeLabel(task.backend)} · ${taskStatusLabel(task)}`;
    const title = el(doc, "h1");
    title.textContent = task.title || getString("workspace-untitled-task");
    const source = el(doc, "div", { color: "#6b665c", fontSize: ".9em" });
    source.textContent = contextSummary(task.lockedContext);
    headerCopy.appendChild(meta);
    headerCopy.appendChild(title);
    headerCopy.appendChild(source);

    header.appendChild(headerCopy);
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

    if (!state.artifacts.length) {
      const empty = el(doc, "div", {
        marginTop: "16px",
        paddingTop: "14px",
        borderTop: "1px solid #e5e1d8",
      });
      const emptyTitle = el(doc, "div", {
        marginBottom: "4px",
        fontWeight: "700",
      });
      emptyTitle.textContent =
        task.status === "running" || task.status === "awaiting_approval"
          ? getString("workspace-artifact-building")
          : getString("workspace-no-artifacts");
      const emptyCopy = el(doc, "div", {
        maxWidth: "620px",
        color: "#6b665c",
        lineHeight: "1.5",
      });
      emptyCopy.textContent = getString("workspace-no-artifacts-help");
      empty.appendChild(emptyTitle);
      empty.appendChild(emptyCopy);
      overview.appendChild(empty);
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
    const menu = el(
      doc,
      "div",
      {
        position: "fixed",
        zIndex: "1300",
        minWidth: "0px",
        maxHeight: "340px",
        padding: "5px",
        overflow: "auto",
        border: "1px solid #d7d1c5",
        borderRadius: "9px",
        background: "#fffefa",
        boxSizing: "border-box",
        boxShadow: "0 12px 34px rgba(45,40,34,.18)",
      },
      {
        id: "confucius-artifact-choice-menu",
        role: "listbox",
        "data-placement": "left",
        "aria-label": getString(
          kind === "artifact"
            ? "workspace-artifact-switch"
            : "workspace-artifact-revision",
        ),
      },
    );
    menu.className = "confucius-artifact-choice-menu";
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
    const previousScroll = resetScroll ? 0 : (previousBody?.scrollTop ?? 0);
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
    if (wasOpen) overlay.setAttribute("data-refresh", "true");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeArtifactViewer();
    });
    overlay.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeArtifactViewer();
      }
    });

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
      color: "#8a857c",
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
    paper.appendChild(renderArtifactBodyNode(revision.body));
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
            `${item.id}:${item.title ?? ""}:${item.status}:${item.backend}:${item.lockedContext.fingerprint}`,
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
    lastListSignature = listSignature();
    sessionPane.textContent = "";
    sessionPane.appendChild(paneLabel(doc, getString("workspace-tasks")));
    if (!state.sessions.length) {
      sessionPane.appendChild(muted(doc, getString("workspace-no-tasks")));
    } else {
      for (const item of state.sessions) {
        const row = el(doc, "div", {
          display: "flex",
          alignItems: "flex-start",
          gap: "7px",
          padding: "9px 7px",
          cursor: "pointer",
          background: item.id === state.sessionId ? "#f0ece3" : "transparent",
        });
        row.className = "confucius-task-row";
        row.setAttribute(
          "data-active",
          item.id === state.sessionId ? "true" : "false",
        );
        row.setAttribute("data-task-status", item.status);
        const dot = el(doc, "span", {
          width: "7px",
          height: "7px",
          flex: "0 0 7px",
          marginTop: "6px",
          borderRadius: "50%",
          background:
            item.status === "completed"
              ? "#4f7657"
              : item.status === "failed"
                ? "#b3452f"
                : item.status === "running" ||
                    item.status === "awaiting_approval"
                  ? "#b97837"
                  : item.status === "interrupted"
                    ? "#8561a5"
                    : "#aaa49a",
        });
        const label = el(doc, "div", {
          flex: "1 1 auto",
          minWidth: "0px",
        });
        const labelTitle = el(doc, "div", {
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: item.id === state.sessionId ? "650" : "500",
        });
        labelTitle.textContent = item.title || item.id;
        const labelMeta = el(doc, "div", {
          marginTop: "2px",
          overflow: "hidden",
          color: "#8a857c",
          fontSize: "10px",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        });
        labelMeta.textContent = `${runtimeLabel(item.backend)} · ${taskStatusLabel(item)}`;
        label.appendChild(labelTitle);
        label.appendChild(labelMeta);
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
          { type: "button", title: getString("workspace-delete-task") },
        );
        del.textContent = "✕";
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          void (async () => {
            await rpc("task/delete", { taskId: item.id });
            composerDrafts.delete(item.id);
            timelineViewports.delete(item.id);
            if (state.sessionId === item.id) {
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
          })();
        });
        row.addEventListener("click", () => {
          void (async () => {
            const selectedSessionId = item.id;
            await loadTask(selectedSessionId);
            if (auxiliaryOverlay) {
              showSessions = false;
              syncAuxiliaryPanes();
            }
            renderLists();
          })();
        });
        row.appendChild(dot);
        row.appendChild(label);
        row.appendChild(del);
        sessionPane.appendChild(row);
      }
    }

    const timelineTaskId = state.sessionId;
    const taskChanged = renderedTimelineTaskId !== timelineTaskId;
    rememberTimelineViewport();
    const savedViewport = timelineTaskId
      ? timelineViewports.get(timelineTaskId)
      : undefined;
    const followTimeline = taskChanged
      ? (savedViewport?.followsBottom ?? true)
      : Boolean(state.sending || state.running || state.pendingUserText) ||
        timelinePane.scrollHeight -
          timelinePane.scrollTop -
          timelinePane.clientHeight <
          96;
    const savedTimelineScroll = taskChanged
      ? (savedViewport?.scrollTop ?? 0)
      : timelinePane.scrollTop;
    timelinePane.textContent = "";
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
    activityStream.appendChild(renderActivityOverview());
    if (
      session?.backend === "native" &&
      state.config &&
      !configReady(state.config)
    ) {
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
    const timelineBlocks = coalesceTimeline(state.events);
    if (
      !state.events.length &&
      !state.artifacts.length &&
      !state.pendingUserText &&
      !state.sendError
    ) {
      activityStream.appendChild(
        muted(doc, getString("workspace-empty-timeline")),
      );
    } else {
      timelineBlocks.forEach((block, index) => {
        const node = renderTimelineBlock(doc, block, index);
        if (node) {
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
      activityStream.appendChild(renderApprovalCard(doc, item));
    }
    if (state.sending || turnAwaitingReply(state.events)) {
      activityStream.appendChild(renderWaiting(doc, state.events));
    }
    timelinePane.appendChild(activityStream);
    renderedTimelineTaskId = timelineTaskId;
    timelinePane.scrollTop =
      followTimeline || newApprovalsArrived
        ? timelinePane.scrollHeight
        : savedTimelineScroll;
    rememberTimelineViewport();
    newApprovalsArrived = false;
    renderArtifactViewer();
  }

  function syncModeButton(): void {
    modeBtn.textContent = state.mode === "plan" ? "Plan" : "Agent";
  }

  function syncEndpointButton(): void {
    const task = currentTask();
    if (task && task.backend !== "native") {
      const runtime = runtimeStatus(task.backend);
      endpointName.textContent = runtimeLabel(task.backend);
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
    if (!hadPendingApprovals && state.approvals.length > 0) {
      newApprovalsArrived = true;
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
    const listed = (await rpc("task/list", {})) as {
      tasks?: SessionRow[];
    };
    state.sessions = listed.tasks || [];
    if (!state.sessionId && state.sessions[0]) {
      state.sessionId = state.sessions[0].id;
      prompt.value = composerDrafts.get(state.sessionId) ?? "";
    }
  }

  async function sendPrompt(): Promise<void> {
    const enteredText = prompt.value.trim();
    if (state.sending || state.running) {
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
        })) as SessionRow;
        state.sessionId = created.id;
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
        flexWrap: "wrap",
        gap: "4px",
        borderBottom: "1px solid #e5e1d8",
        marginBottom: "14px",
      },
      { role: "tablist" },
    );
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
        btn.style.color = active ? "#33302a" : "#6b665c";
        btn.style.borderBottomColor = active ? "#b3452f" : "transparent";
        btn.setAttribute("aria-selected", active ? "true" : "false");
      }
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
    panel.appendChild(modelTab);
    panel.appendChild(runtimeTab);
    panel.appendChild(memoryTab);
    panel.appendChild(securityTab);
    panel.appendChild(appearanceTab);
    panel.appendChild(updateTab);
    setSettingsTab("model");

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
      borderTop: "1px solid #e5e1d8",
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
        border: "1px solid #e5e1d8",
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
          border: "1px solid #ddd8cc",
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
          borderBottom: "1px solid #e5e1d8",
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
        border: "1px solid #e5e1d8",
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
          borderTop: "1px solid #e5e1d8",
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
            border: "1px solid #ddd8cc",
            borderRadius: "6px",
          },
          { type: "text", value: proposal.title ?? "" },
        ) as HTMLInputElement;
        const contentInput = el(doc, "textarea", {
          width: "100%",
          minHeight: "74px",
          padding: "7px",
          boxSizing: "border-box",
          border: "1px solid #ddd8cc",
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
        border: "1px solid #ddd8cc",
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
        padding: "5px",
        borderRadius: "9px",
        background: "#fffefa",
        boxShadow: "0 12px 34px rgba(45,40,34,.18)",
      });
      menu.className = "confucius-settings-choice-menu";
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
      borderTop: "1px solid #eee9df",
      borderBottom: "1px solid #eee9df",
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
          if (languageChanged) {
            overlay.remove();
            applyLocalizedChrome();
            renderLists();
          }
        } catch (error) {
          errorLine.textContent =
            error instanceof Error ? error.message : String(error);
        }
      })();
    });
    root.appendChild(overlay);
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
    items: [] as ContextSearchItem[],
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
      const result = (await rpc("context/search-items", {
        query: mentionState.query,
        offset,
        limit: MENTION_PAGE_SIZE,
        libraryID: reset ? undefined : mentionState.libraryID || undefined,
      })) as ContextSearchItemsResult;
      if (!mentionState.open || requestId !== mentionState.requestId) return;
      const combined = reset
        ? result.items
        : [...mentionState.items, ...result.items];
      const unique = new Map<string, ContextSearchItem>();
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
    const previousList = doc.getElementById(
      "confucius-mention-results",
    ) as HTMLElement | null;
    const previousScrollTop = preserveScroll ? previousList?.scrollTop || 0 : 0;
    doc.getElementById("confucius-mention-menu")?.remove();
    if (!mentionState.open) return;
    const menu = el(
      doc,
      "div",
      {
        position: "fixed",
        background: "#ffffff",
        border: "1px solid #d8d1c4",
        borderRadius: "12px",
        boxShadow: "0 12px 32px rgba(28,25,23,0.2)",
        padding: "8px",
        overflow: "hidden",
        zIndex: "930",
        boxSizing: "border-box",
      },
      {
        id: "confucius-mention-menu",
        role: "listbox",
        "aria-label": getString("workspace-mention-heading"),
      },
    );
    const header = el(doc, "div", {
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: "10px",
      padding: "5px 7px 8px",
      borderBottom: "1px solid #eee9df",
    });
    const heading = el(doc, "strong", {
      color: "#33302a",
      fontSize: "12px",
      letterSpacing: ".01em",
    });
    heading.textContent = getString("workspace-mention-heading");
    const scope = el(doc, "span", {
      minWidth: "0",
      color: "#8a857c",
      fontSize: "11px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
    scope.textContent = mentionState.libraryName
      ? `${mentionState.libraryName} · ${mentionState.items.length}/${mentionState.total}`
      : getString("workspace-mention-hint");
    header.appendChild(heading);
    header.appendChild(scope);
    menu.appendChild(header);

    const list = el(doc, "div", {
      maxHeight: "258px",
      overflowY: "auto",
      overscrollBehavior: "contain",
      padding: "4px 0",
      boxSizing: "border-box",
    });
    list.id = "confucius-mention-results";
    for (const [index, item] of mentionState.items.entries()) {
      const active = index === mentionState.index;
      const included = taskHasMentionItem(item);
      const row = el(doc, "div", {
        display: "flex",
        alignItems: "center",
        gap: "9px",
        minHeight: "50px",
        padding: "5px 8px",
        borderRadius: "8px",
        cursor: "pointer",
        boxSizing: "border-box",
      });
      row.className = "confucius-composer-menu-row";
      row.setAttribute("role", "option");
      row.setAttribute("data-mention-index", String(index));
      row.setAttribute("aria-selected", active ? "true" : "false");
      const glyph = el(doc, "span", {
        flex: "0 0 auto",
        width: "25px",
        height: "31px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid #d8d1c4",
        borderRadius: "5px",
        background: "#faf8f3",
        color: "#8c6a3f",
        fontSize: "13px",
      });
      glyph.textContent = "▤";
      const copy = el(doc, "span", {
        flex: "1 1 auto",
        minWidth: "0",
      });
      const title = el(doc, "span", {
        display: "block",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "#33302a",
        fontWeight: "600",
        fontSize: "12px",
      });
      title.textContent = item.title || getString("workspace-mention-untitled");
      const meta = el(doc, "span", {
        display: "block",
        marginTop: "2px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "#8a857c",
        fontSize: "11px",
      });
      meta.textContent = [
        item.creators.slice(0, 2).join(", "),
        item.year,
        item.itemType,
      ]
        .filter(Boolean)
        .join(" · ");
      copy.appendChild(title);
      copy.appendChild(meta);
      row.appendChild(glyph);
      row.appendChild(copy);
      if (included) {
        const mark = el(doc, "span", {
          flex: "0 0 auto",
          color: "#6b665c",
          fontSize: "11px",
        });
        mark.textContent = `✓ ${getString("workspace-mention-added")}`;
        row.appendChild(mark);
      }
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("mouseenter", () => {
        mentionState.index = index;
        highlightMentionRows(menu);
      });
      row.addEventListener("click", () => {
        mentionState.index = index;
        runMentionSelection();
      });
      list.appendChild(row);
    }
    if (mentionState.error) {
      const error = el(doc, "div", {
        padding: "12px 9px",
        color: "#b3452f",
        fontSize: "12px",
      });
      error.textContent = mentionState.error;
      list.appendChild(error);
    } else if (!mentionState.loading && mentionState.items.length === 0) {
      const empty = el(doc, "div", {
        padding: "14px 9px",
        color: "#8a857c",
        fontSize: "12px",
      });
      empty.textContent = getString("workspace-mention-empty");
      list.appendChild(empty);
    }
    if (mentionState.loading) {
      const loading = el(doc, "div", {
        padding: "9px",
        color: "#8a857c",
        fontSize: "11px",
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
        void loadMentionItems(false);
      }
    });
    menu.appendChild(list);
    placeComposerMenu(menu, header, list);
    list.scrollTop = previousScrollTop;
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
    const replacement = replaceLibraryMention(prompt.value, token, item.title);
    prompt.value = replacement.value;
    closeMentionMenu();
    prompt.focus();
    prompt.setSelectionRange(replacement.caret, replacement.caret);
    void addMentionContext(item);
  }

  function slashCommands(): SlashCommand[] {
    const commands: SlashCommand[] = FEATURED_TASK_TEMPLATES.map(
      (template) => ({
        label: `/${template.id}`,
        description: getString(`workspace-template-${template.id}-help`),
        kind: "template" as const,
        group: "templates" as const,
        templateId: template.id,
        searchText: localizedTemplateTitle(template),
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
        label: "/compact",
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

  function applyMode(mode: "agent" | "plan"): void {
    state.mode = mode;
    syncModeButton();
    if (state.sessionId) {
      void rpc("task/setMode", { taskId: state.sessionId, mode });
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
      const stats = (await rpc("task/compact", {
        taskId: state.sessionId,
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
        border: "1px solid #d8d1c4",
        borderRadius: "12px",
        boxShadow: "0 12px 32px rgba(28,25,23,0.2)",
        padding: "8px",
        overflow: "hidden",
        zIndex: "930",
        boxSizing: "border-box",
      },
      {
        id: "confucius-slash-menu",
        role: "listbox",
        "aria-label": getString("workspace-slash-heading"),
      },
    );
    const header = el(doc, "div", {
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: "10px",
      padding: "5px 7px 8px",
      borderBottom: "1px solid #eee9df",
    });
    const heading = el(doc, "strong", {
      color: "#33302a",
      fontSize: "12px",
      letterSpacing: ".01em",
    });
    heading.textContent = getString("workspace-slash-heading");
    const scope = el(doc, "span", {
      minWidth: "0",
      color: "#8a857c",
      fontSize: "11px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
    scope.textContent = getString("workspace-slash-hint");
    header.appendChild(heading);
    header.appendChild(scope);
    menu.appendChild(header);

    const list = el(doc, "div", {
      maxHeight: "258px",
      overflowY: "auto",
      overscrollBehavior: "contain",
      padding: "4px 0",
      boxSizing: "border-box",
    });
    list.id = "confucius-slash-results";
    let previousGroup: SlashCommand["group"] | null = null;
    slashState.items.forEach((command, index) => {
      if (command.group !== previousGroup) {
        const group = el(doc, "div", {
          padding: previousGroup ? "9px 8px 4px" : "4px 8px",
          color: "#8a857c",
          fontSize: "10px",
          fontWeight: "700",
          letterSpacing: ".08em",
          textTransform: "uppercase",
        });
        group.textContent = getString(`workspace-slash-group-${command.group}`);
        list.appendChild(group);
        previousGroup = command.group;
      }
      const active = index === slashState.index;
      const row = el(doc, "div", {
        display: "flex",
        alignItems: "center",
        gap: "9px",
        minHeight: "50px",
        padding: "5px 8px",
        borderRadius: "8px",
        cursor: "pointer",
        boxSizing: "border-box",
      });
      row.className = "confucius-composer-menu-row";
      row.setAttribute("role", "option");
      row.setAttribute("data-slash-index", String(index));
      row.setAttribute("aria-selected", active ? "true" : "false");
      const glyph = el(doc, "span", {
        flex: "0 0 auto",
        width: "25px",
        height: "31px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid #d8d1c4",
        borderRadius: "5px",
        background: "#faf8f3",
        color: "#8c6a3f",
        fontSize: "13px",
      });
      glyph.textContent = command.kind === "template" ? "◇" : "/";
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
        fontWeight: "600",
        fontSize: "12px",
      });
      label.textContent = command.label;
      const hint = el(doc, "span", {
        display: "block",
        marginTop: "2px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "#8a857c",
        fontSize: "11px",
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
    endpointSubmenu = null;
    doc.getElementById("confucius-endpoint-menu")?.remove();
    doc.getElementById("confucius-endpoint-submenu")?.remove();
    endpointBtn.setAttribute("aria-expanded", "false");
  }

  function clearEndpointSubmenuHighlight(): void {
    if (!endpointSubmenu) return;
    endpointSubmenu = null;
    doc.getElementById("confucius-endpoint-submenu")?.remove();
    doc
      .querySelectorAll(
        "#confucius-endpoint-menu .confucius-menu-row[data-highlighted='true']",
      )
      .forEach((row: Element) => row.setAttribute("data-highlighted", "false"));
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
      highlighted?: boolean;
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
    });
    row.className = "confucius-menu-row";
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
    placement: "auto" | "left" = "auto",
    portal?: HTMLElement,
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
    header: HTMLElement,
    list: HTMLElement,
  ): void {
    placeMenu(prompt, menu, Math.min(520, Math.max(280, responsiveWidth - 16)));
    const availableListHeight = Math.max(
      86,
      menu.clientHeight - header.offsetHeight - 16,
    );
    list.style.maxHeight = `${Math.min(258, availableListHeight)}px`;
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

  async function applyTaskBackend(backend: AgentBackendKind): Promise<void> {
    const task = currentTask();
    try {
      if (!task) {
        await createTask({
          title: getString("workspace-untitled-task"),
          context: state.live?.lockedSnapshot,
          backend,
        });
      } else {
        await rpc("task/setBackend", {
          taskId: task.id,
          backend,
          capabilityProfile: task.capabilityProfile,
          workingDirectory: task.workingDirectory,
        });
        await refreshSessions();
        await loadTask(task.id);
      }
      state.sendError = "";
    } catch (error) {
      state.sendError = error instanceof Error ? error.message : String(error);
    }
    closeEndpointMenu();
    renderLists();
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

    section(getString("workspace-runtime"));
    const selectedBackend = currentTask()?.backend ?? "native";
    for (const backend of ["native", "codex", "kimi"] as const) {
      const runtime = runtimeStatus(backend);
      const row = menuRow(runtimeLabel(backend), {
        active: selectedBackend === backend,
        hint:
          runtime?.state === "ready"
            ? getString("workspace-runtime-ready")
            : runtime?.state === "auth_required"
              ? getString("workspace-runtime-auth-required")
              : backend === "native"
                ? ""
                : getString("workspace-runtime-unavailable"),
        onClick: () => void applyTaskBackend(backend),
        onEnter: clearEndpointSubmenuHighlight,
      });
      row.setAttribute("data-runtime", backend);
      row.setAttribute("role", "menuitem");
      menu.appendChild(row);
    }

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
          active,
          highlighted: open,
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
      highlighted: thinkingOpen,
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
      onEnter: clearEndpointSubmenuHighlight,
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
    closeMentionMenu();
    endpointMenuOpen = true;
    const activeId = state.config?.activeEndpointId || "";
    endpointSubmenu = activeId
      ? { kind: "models", endpointId: activeId }
      : { kind: "effort" };
    renderEndpointMenu();
    syncEndpointButton();
    void refreshRuntimes(true).then(() => {
      if (endpointMenuOpen) renderEndpointMenu();
    });
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
    closeMentionMenu();
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

    const task = currentTask();
    if (task) {
      section(getString("workspace-context-heading"));
      const summary = el(doc, "div", {
        margin: "2px 8px 6px",
        color: "#6b665c",
        fontSize: "12px",
        lineHeight: "1.4",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      });
      summary.textContent = contextSummary(task.lockedContext);
      const detail = contextDetail(task.lockedContext);
      if (detail) summary.title = detail;
      menu.appendChild(summary);
      if (
        state.live?.lockedSnapshot &&
        state.live.lockedSnapshot.fingerprint !== task.lockedContext.fingerprint
      ) {
        const changed = el(doc, "div", {
          margin: "0 8px 5px",
          color: "#8a4b26",
          fontSize: "11px",
        });
        changed.textContent = getString("workspace-context-changed");
        menu.appendChild(changed);
      }
      option(getString("workspace-context-add"), false, () => {
        void updateTaskContext("add");
      });
      option(getString("workspace-context-replace"), false, () => {
        void updateTaskContext("replace");
      });
    }

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
    const working = state.running || state.sending;
    sendBtn.style.display = working ? "none" : "";
    stopBtn.style.display = working ? "" : "none";
    if (
      state.sending ||
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
    if (!endpointMenuOpen) {
      return;
    }
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
  prompt.addEventListener("input", () => {
    rememberComposerDraft();
    updateComposerMenus();
  });
  prompt.addEventListener("click", updateComposerMenus);
  prompt.addEventListener("keydown", (event) => {
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
