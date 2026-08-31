import type { SessionContext, SessionMode, SessionRecord } from "./session";

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
  configGet: "config/get",
  configSet: "config/set",
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

export interface SessionNewParams {
  title?: string;
  mode?: SessionMode;
  context?: SessionContext;
}

export interface SessionPromptParams {
  sessionId: string;
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

export interface ModelConfigView {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  streamResponses: boolean;
  memoryAutoExtract: boolean;
  /** Convenience flag for UIs: true when a non-empty API key is set. */
  hasApiKey: boolean;
}

export interface ConfigSetParams {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  streamResponses?: boolean;
  memoryAutoExtract?: boolean;
}

export type ConfigValidation =
  | { ok: true; value: Required<Pick<ConfigSetParams, "baseUrl" | "apiKey" | "model" | "maxTokens">> }
  | { ok: false; errors: string[] };

/**
 * Validate a config patch before it reaches prefs. Pure so UIs can reuse it
 * client-side and tests can pin it without a Zotero runtime.
 */
export function validateConfigPatch(
  patch: Record<string, unknown>,
): ConfigValidation {
  const errors: string[] = [];
  const baseUrl = patch.baseUrl === undefined ? undefined : String(patch.baseUrl).trim();
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
  const model = patch.model === undefined ? undefined : String(patch.model).trim();
  if (model !== undefined && model === "") {
    errors.push("Model must not be empty");
  }
  const apiKey = patch.apiKey === undefined ? undefined : String(patch.apiKey).trim();
  const maxTokensRaw = patch.maxTokens;
  let maxTokens: number | undefined;
  if (maxTokensRaw !== undefined) {
    maxTokens = Number(maxTokensRaw);
    if (!Number.isInteger(maxTokens) || maxTokens < 0) {
      errors.push("Max tokens must be an integer >= 0");
      maxTokens = undefined;
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
