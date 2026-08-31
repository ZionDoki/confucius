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
