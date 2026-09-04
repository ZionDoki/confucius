import type {
  ResearchTaskRecord,
  SessionContext,
  SessionMode,
  SessionRecord,
} from "./session";
import type { ModelEndpoint } from "./endpoints";
import type {
  AgentBackendKind,
  ArtifactRecord,
  ArtifactUpsertInput,
  CapabilityProfile,
  LockedContextSnapshot,
  MemoryConsent,
  MemoryProposal,
  RuntimeStatus,
  TaskAttachment,
} from "./research";
import { isMemoryConsent } from "./research";
import type { TaskTemplateId } from "./templates";

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: T;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result: T;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

export const RPC_METHODS = {
  health: "health",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionList: "session/list",
  sessionPrompt: "session/prompt",
  sessionAbort: "session/abort",
  sessionDelete: "session/delete",
  sessionSetMode: "session/setMode",
  sessionSetContext: "session/setContext",
  sessionEvents: "session/events",
  approvalResolve: "approval/resolve",
  skillList: "skill/list",
  skillActivate: "skill/activate",
  memoryList: "memory/list",
  memorySearch: "memory/search",
  memorySave: "memory/save",
  memoryDelete: "memory/delete",
  knowledgeList: "knowledge/list",
  knowledgeGet: "knowledge/get",
  knowledgeSearch: "knowledge/search",
  knowledgeCreate: "knowledge/create",
  knowledgeUpdate: "knowledge/update",
  knowledgeDelete: "knowledge/delete",
  knowledgeSaveEntry: "knowledge/saveEntry",
  knowledgeDeleteEntry: "knowledge/deleteEntry",
  configGet: "config/get",
  configSet: "config/set",
  configListModels: "config/listModels",
  sessionSetPermissions: "session/setPermissions",
  sessionCompact: "session/compact",
  sessionContext: "session/context",
  contextLive: "context/live",
  contextSearchItems: "context/search-items",
  attachmentPrepare: "attachment/prepare",
  attachmentRelease: "attachment/release",
  readerOpen: "reader/open",
  launchConsume: "workspace/launch-consume",
  noteProposeFromSession: "note/propose-from-session",
  noteProposeFromReply: "note/propose-from-reply",
  logsList: "logs/list",
  logsSearch: "logs/search",
  logsRead: "logs/read",
  taskNew: "task/new",
  taskBranch: "task/branch",
  taskLoad: "task/load",
  taskList: "task/list",
  taskPrompt: "task/prompt",
  taskAbort: "task/abort",
  taskDelete: "task/delete",
  taskContinue: "task/continue",
  taskEvents: "task/events",
  taskSetMode: "task/setMode",
  taskSetPermissions: "task/setPermissions",
  taskContext: "task/context",
  taskCompact: "task/compact",
  taskSetContext: "task/setContext",
  taskSetBackend: "task/setBackend",
  taskStageTemplate: "task/stageTemplate",
  taskPreviewCapabilities: "task/previewCapabilities",
  taskToolList: "task/toolList",
  taskToolCall: "task/toolCall",
  artifactList: "artifact/list",
  artifactGet: "artifact/get",
  artifactUpsert: "artifact/upsert",
  artifactWritebackPreview: "artifact/writebackPreview",
  artifactWritebackCommit: "artifact/writebackCommit",
  runtimeList: "runtime/list",
  runtimeRefresh: "runtime/refresh",
  runtimeConfigure: "runtime/configure",
  runtimeSetPluginHost: "runtime/setPluginHost",
  memoryProposalList: "memory/proposal/list",
  memoryProposalResolve: "memory/proposal/resolve",
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

export interface SessionNewParams {
  title?: string;
  mode?: SessionMode;
  context?: SessionContext;
}

export interface TaskNewParams {
  title?: string;
  mode?: SessionMode;
  backend?: AgentBackendKind;
  lockedContext?: LockedContextSnapshot;
  activeKnowledgeBaseId?: string;
  capabilityProfile?: CapabilityProfile;
  workingDirectory?: string;
  confirmed?: boolean;
  templateId?: TaskTemplateId;
  autoStart?: boolean;
  prompt?: string;
}

export interface TaskPromptParams {
  taskId: string;
  text: string;
  attachmentIds?: string[];
}

export interface TaskStageTemplateParams {
  taskId: string;
  templateId: TaskTemplateId;
}

export interface AttachmentPrepareParams {
  /** Absolute local path captured from an explicit file drop. */
  path: string;
}

export interface AttachmentPrepareResult {
  attachment: TaskAttachment;
}

export interface AttachmentReleaseParams {
  id: string;
}

export interface TaskBranchParams {
  taskId: string;
  throughTurnId: string;
  title?: string;
}

export interface TaskSetContextParams {
  taskId: string;
  mode: "add" | "replace";
  /** Omit to capture the current Zotero selection at click time. */
  context?: LockedContextSnapshot;
}

export interface TaskSetBackendParams {
  taskId: string;
  backend: AgentBackendKind;
  capabilityProfile?: CapabilityProfile;
  workingDirectory?: string;
  confirmed?: boolean;
}

export interface TaskPreviewCapabilitiesParams {
  taskId: string;
  capabilityProfile?: CapabilityProfile;
  workingDirectory?: string;
}

export interface TaskPreviewCapabilitiesResult {
  capabilityProfile: CapabilityProfile;
  workingDirectory?: string;
  confirmationRequired: boolean;
}

export interface TaskListResult {
  tasks: ResearchTaskRecord[];
}

export interface ArtifactListParams {
  taskId: string;
}

export interface ArtifactListResult {
  artifacts: ArtifactRecord[];
}

export type ArtifactUpsertParams = ArtifactUpsertInput;

export interface ArtifactGetParams {
  id: string;
}

export interface ArtifactWritebackParams {
  id: string;
  revision?: number;
  target?:
    | "zotero_note"
    | "zotero_annotations"
    | "zotero_collection"
    | "zotero_tags"
    | "knowledge_base";
  knowledgeBaseId?: string;
}

export interface RuntimeListResult {
  /** @deprecated Compatibility alias; true means the selected runtime host is usable. */
  sidecarConnected: boolean;
  runtimeHost: "plugin" | "disabled" | "sidecar";
  runtimeHostEnabled: boolean;
  runtimeHostConnected: boolean;
  runtimes: RuntimeStatus[];
}

export interface RuntimeConfigureParams {
  backend: Exclude<AgentBackendKind, "native">;
  executable?: string;
}

export interface RuntimeSetPluginHostParams {
  enabled: boolean;
}

export interface MemoryProposalListResult {
  proposals: MemoryProposal[];
}

export interface MemoryProposalResolveParams {
  id: string;
  verdict: "accept" | "reject";
  edited?: Partial<Pick<MemoryProposal, "type" | "title" | "content" | "tags">>;
}

export interface SessionPromptParams {
  sessionId: string;
  text: string;
  context?: PromptContextOptions;
  attachmentIds?: string[];
}

export interface PromptContextOptions {
  suppressSelection?: boolean;
}

export interface LiveContextReader {
  libraryID: number;
  attachmentKey: string;
  parentKey: string | null;
  title: string;
  pageLabel: string | null;
  pageIndex: number | null;
}

export interface LiveContextSelection {
  text: string;
  preview: string;
  pageLabel: string | null;
  pageIndex: number | null;
}

export interface LiveContextItem {
  libraryID: number;
  key: string;
  title: string;
}

export interface LiveContextResult {
  reader: LiveContextReader | null;
  selection: LiveContextSelection | null;
  items: LiveContextItem[];
  collection: string | null;
  fingerprint?: string;
  lockedSnapshot?: LockedContextSnapshot;
}

export interface ContextSearchItem {
  libraryID: number;
  key: string;
  title: string;
  itemType: string;
  creators: string[];
  year: string;
}

export interface ContextSearchItemsParams {
  query?: string;
  offset?: number;
  limit?: number;
  libraryID?: number;
}

export interface ContextSearchItemsResult {
  query: string;
  libraryID: number;
  libraryName: string;
  items: ContextSearchItem[];
  total: number;
  nextOffset: number | null;
}

export interface ReaderOpenParams {
  libraryID: number;
  key: string;
  pageIndex?: number;
  annotationKey?: string;
}

/** One-shot queue from entry points (item menu) consumed by the workspace poll. */
export interface LaunchConsumeResult {
  skillSlug: string | null;
  intent?: LaunchIntent | null;
}

export interface LaunchIntent {
  templateId?: TaskTemplateId;
  skillSlug?: string;
  context?: LockedContextSnapshot;
  autoStart: boolean;
  prompt?: string;
}

export interface NoteProposeFromSessionParams {
  sessionId: string;
}

export interface NoteProposeFromReplyParams {
  taskId: string;
  turnId: string;
  text: string;
}

export interface SessionIdParams {
  sessionId: string;
}

export interface SessionSetModeParams {
  sessionId: string;
  mode: SessionMode;
}

export interface SessionSetContextParams {
  sessionId: string;
  context: SessionContext;
}

export interface SessionListResult {
  sessions: SessionRecord[];
}

export interface SessionEventsParams {
  sessionId: string;
  afterId?: string;
}

export interface SkillActivateParams {
  sessionId: string;
  slug: string | null;
}

export interface MemoryListParams {
  type?: string;
  limit?: number;
}

export interface MemorySearchParams {
  query: string;
  type?: string;
  tags?: string[];
  limit?: number;
}

export interface MemorySaveParams {
  content: string;
  type?: string;
  title?: string;
  tags?: string[];
}

export interface MemoryDeleteParams {
  id: string;
}

export type KnowledgeEntryKind =
  "paper" | "note" | "insight" | "method" | "discussion" | "mindmap";

export interface KnowledgeListParams {
  query?: string;
  limit?: number;
}

export interface KnowledgeGetParams {
  id: string;
  kind?: KnowledgeEntryKind;
  limit?: number;
}

export interface KnowledgeSearchParams {
  query: string;
  knowledgeBaseId?: string;
  kind?: KnowledgeEntryKind;
  limit?: number;
}

export interface KnowledgeCreateParams {
  title: string;
  description?: string;
  tags?: string[];
}

export interface KnowledgeUpdateParams extends KnowledgeCreateParams {
  id: string;
}

export interface KnowledgeSaveEntryParams {
  id?: string;
  knowledgeBaseId: string;
  kind: KnowledgeEntryKind;
  title: string;
  content: string;
  tags?: string[];
  libraryID?: number;
  key?: string;
  clearSource?: boolean;
}

export interface KnowledgeDeleteEntryParams {
  knowledgeBaseId: string;
  id: string;
}

export type ReasoningEffort = "auto" | "off" | "low" | "medium" | "high";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "auto",
  "off",
  "low",
  "medium",
  "high",
];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

export const DEFAULT_MAX_ITERATIONS = 128;
export const DEFAULT_MAX_TOOL_CALLS = 96;
export const MAX_MAX_ITERATIONS = 200;
export const MAX_MAX_TOOL_CALLS = 500;

export function clampMaxIterations(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_MAX_ITERATIONS;
  }
  return Math.min(parsed, MAX_MAX_ITERATIONS);
}

export function clampMaxToolCalls(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_MAX_TOOL_CALLS;
  }
  return Math.min(parsed, MAX_MAX_TOOL_CALLS);
}

export type UiFont = "sans" | "serif" | "mono";

export type UiLanguage = "en-US" | "zh-CN";

export const UI_LANGUAGES: readonly UiLanguage[] = ["zh-CN", "en-US"];

export function isUiLanguage(value: unknown): value is UiLanguage {
  return (
    typeof value === "string" &&
    (UI_LANGUAGES as readonly string[]).includes(value)
  );
}

export type UiLineHeight = "compact" | "standard" | "relaxed";

export const UI_LINE_HEIGHTS: readonly UiLineHeight[] = [
  "compact",
  "standard",
  "relaxed",
];

export const UI_LINE_HEIGHT_VALUES: Readonly<Record<UiLineHeight, number>> = {
  compact: 1.45,
  standard: 1.6,
  relaxed: 1.75,
};

export function isUiLineHeight(value: unknown): value is UiLineHeight {
  return (
    typeof value === "string" &&
    (UI_LINE_HEIGHTS as readonly string[]).includes(value)
  );
}

export const UI_FONTS: readonly UiFont[] = ["sans", "serif", "mono"];

export function isUiFont(value: unknown): value is UiFont {
  return (
    typeof value === "string" && (UI_FONTS as readonly string[]).includes(value)
  );
}

export const DEFAULT_UI_FONT: UiFont = "sans";
export const DEFAULT_UI_FONT_SIZE = 13;
export const DEFAULT_UI_LINE_HEIGHT: UiLineHeight = "standard";
export const MIN_UI_FONT_SIZE = 12;
export const MAX_UI_FONT_SIZE = 18;

export function clampUiFontSize(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_UI_FONT_SIZE;
  }
  return Math.min(
    MAX_UI_FONT_SIZE,
    Math.max(MIN_UI_FONT_SIZE, Math.round(parsed)),
  );
}

export interface ModelConfigView {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  streamResponses: boolean;
  memoryAutoExtract: boolean;
  memoryConsent: MemoryConsent;
  /** Run Codex/Kimi directly inside the Zotero add-on. */
  pluginRuntimeHost: boolean;
  /** "auto" leaves the server default; "off" disables thinking where the API allows it. */
  reasoningEffort: ReasoningEffort;
  /** Context window in tokens, used for the composer usage ring and compaction target. */
  contextWindowTokens: number;
  /** Convenience flag for UIs: true when a non-empty API key is set. */
  hasApiKey: boolean;
  /** True when the active endpoint has a Base URL and model. */
  configured: boolean;
  endpoints: ModelEndpoint[];
  activeEndpointId: string;
  /** Model loop rounds per user prompt. Global, not per endpoint. */
  maxIterations: number;
  /** Tool calls per user prompt. Global, not per endpoint. */
  maxToolCalls: number;
  /** Workspace UI font family preset. */
  uiFont?: UiFont;
  /** Workspace UI base font size in px (12-18). */
  uiFontSize?: number;
  /** Explicit workspace interface language. */
  uiLanguage?: UiLanguage;
  /** Reading-text line-height preset. */
  uiLineHeight?: UiLineHeight;
}

export interface ConfigSetParams {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  name?: string;
  maxTokens?: number;
  streamResponses?: boolean;
  memoryAutoExtract?: boolean;
  memoryConsent?: MemoryConsent;
  reasoningEffort?: ReasoningEffort;
  contextWindowTokens?: number;
  /** Switch the active endpoint. */
  activeEndpointId?: string;
  /** Upsert one endpoint. Omit `id` to add; the upserted row becomes active. */
  endpoint?: Partial<ModelEndpoint> & { id?: string };
  deleteEndpointId?: string;
  /** Model loop rounds per user prompt. Applies to every endpoint. */
  maxIterations?: number;
  /** Tool calls per user prompt. Applies to every endpoint. */
  maxToolCalls?: number;
  /** Workspace UI font family preset. */
  uiFont?: UiFont;
  /** Workspace UI base font size in px (12-18). */
  uiFontSize?: number;
  /** Explicit workspace interface language. */
  uiLanguage?: UiLanguage;
  /** Reading-text line-height preset. */
  uiLineHeight?: UiLineHeight;
}

export interface ConfigListModelsParams {
  /** Defaults to the active endpoint. */
  endpointId?: string;
}

export interface ConfigListModelsResult {
  endpointId: string;
  models: string[];
  error?: string;
}

export interface SessionContextStats {
  sessionId: string;
  /** Characters of persisted conversation history. */
  chars: number;
  messages: number;
  /** Token estimate from the shared chars-per-token ratio. */
  tokensEstimate: number;
  /** Compaction threshold in chars actually used by the host. */
  maxChars: number;
  contextWindowTokens: number;
  percent: number;
}

export interface LogsListParams {
  limit?: number;
}

export interface LogsSearchParams {
  query: string;
  limit?: number;
}

export interface LogsReadParams {
  sessionId: string;
  query?: string;
  maxChars?: number;
}

export interface SessionSetPermissionsParams {
  sessionId: string;
  permissionMode: "ask" | "auto_allow" | "deny";
}

export type ConfigValidation =
  | {
      ok: true;
      value: Required<
        Pick<ConfigSetParams, "baseUrl" | "apiKey" | "model" | "maxTokens">
      >;
    }
  | { ok: false; errors: string[] };

/**
 * Validate a config patch before it reaches prefs. Pure so UIs can reuse it
 * client-side and tests can pin it without a Zotero runtime.
 */
export function validateConfigPatch(
  patch: Record<string, unknown>,
): ConfigValidation {
  const errors: string[] = [];
  const baseUrl =
    patch.baseUrl === undefined ? undefined : String(patch.baseUrl).trim();
  if (baseUrl !== undefined) {
    if (!/^https?:\/\//i.test(baseUrl)) {
      errors.push("Base URL must start with http:// or https://");
    } else {
      try {
        new URL(baseUrl);
      } catch {
        errors.push("Base URL is not a valid URL");
      }
    }
  }
  const model =
    patch.model === undefined ? undefined : String(patch.model).trim();
  if (model !== undefined && model === "") {
    errors.push("Model must not be empty");
  }
  const apiKey =
    patch.apiKey === undefined ? undefined : String(patch.apiKey).trim();
  let maxTokensRaw = patch.maxTokens;
  if (maxTokensRaw !== undefined) {
    const parsed = Number(maxTokensRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      errors.push("Max tokens must be an integer >= 0");
      maxTokensRaw = undefined;
    }
  }
  const maxTokens =
    maxTokensRaw === undefined ? undefined : (Number(maxTokensRaw) as number);
  const contextWindowRaw = patch.contextWindowTokens;
  let contextWindowTokens: number | undefined;
  if (contextWindowRaw !== undefined) {
    contextWindowTokens = Number(contextWindowRaw);
    if (
      !Number.isInteger(contextWindowTokens) ||
      contextWindowTokens < 1000 ||
      contextWindowTokens > 10_000_000
    ) {
      errors.push(
        "Context window must be an integer between 1000 and 10000000 tokens",
      );
      contextWindowTokens = undefined;
    }
  }
  const reasoningEffortRaw = patch.reasoningEffort;
  if (
    reasoningEffortRaw !== undefined &&
    !isReasoningEffort(reasoningEffortRaw)
  ) {
    errors.push("Reasoning effort must be one of auto, off, low, medium, high");
  }
  if (
    patch.memoryConsent !== undefined &&
    !isMemoryConsent(patch.memoryConsent)
  ) {
    errors.push("Memory consent must be one of off, review, auto");
  }
  if (patch.maxIterations !== undefined) {
    const parsed = Number(patch.maxIterations);
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > MAX_MAX_ITERATIONS
    ) {
      errors.push(
        `Max model rounds must be an integer from 1 to ${MAX_MAX_ITERATIONS}`,
      );
    }
  }
  if (patch.maxToolCalls !== undefined) {
    const parsed = Number(patch.maxToolCalls);
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > MAX_MAX_TOOL_CALLS
    ) {
      errors.push(
        `Max tool calls must be an integer from 1 to ${MAX_MAX_TOOL_CALLS}`,
      );
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      baseUrl: baseUrl ?? "",
      apiKey: apiKey ?? "",
      model: model ?? "",
      maxTokens: maxTokens ?? 0,
    },
  };
}
