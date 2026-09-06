import { abortError } from "./abort";

export interface ModelToolCall {
  /** A malformed JSON proposal remains visible for correction but cannot execute. */
  argumentsError?: string;
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type ModelEnd =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "incomplete"
  | "aborted";

/** Provider-owned replay data must stay attached to its assistant/tool group. */
export interface ModelReplayState {
  provider: string;
  version: 1;
  data: { reasoning?: string };
}

export type ModelErrorCode =
  | "transport"
  | "timeout"
  | "rate_limit"
  | "server"
  | "auth"
  | "context_overflow"
  | "invalid_request"
  | "protocol";

export class ModelError extends Error {
  constructor(
    message: string,
    readonly code: ModelErrorCode,
    readonly options: {
      retryable?: boolean;
      retryAfterMs?: number;
      partial?: ModelTurn;
    } = {},
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export interface ModelTurn {
  /** Optional only for legacy in-process adapters; network adapters always provide it. */
  end?: ModelEnd;
  replayState?: ModelReplayState;
  text?: string;
  reasoning?: string;
  toolCalls?: ModelToolCall[];
  usage?: ModelUsage;
  /** True when the adapter already delivered text/reasoning incrementally. */
  streamed?: boolean;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
  replayState?: ModelReplayState;
  /** Model-only images. They must be removed before checkpoint/persistence. */
  images?: Array<{
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    data: string;
    description?: string;
  }>;
  /** Entire message is valid for only the immediately following model call. */
  transient?: boolean;
}

export interface ModelRequest {
  /** Host accounting/checkpoint hook, awaited before each transport attempt. */
  onAttempt?: () => Promise<void>;
  deadlineMs?: number;
  messages: ModelMessage[];
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  }>;
}

export interface ModelAdapter {
  readonly accountsAttempts?: boolean;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelTurn>;
}

export class ScriptedModel implements ModelAdapter {
  private index = 0;

  constructor(private readonly script: ModelTurn[]) {}

  complete(_request: ModelRequest, signal?: AbortSignal): Promise<ModelTurn> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    const turn = this.script[this.index] ?? { text: "" };
    this.index += 1;
    return Promise.resolve({
      ...turn,
      end: turn.end ?? (turn.toolCalls?.length ? "tool_calls" : "stop"),
    });
  }
}
