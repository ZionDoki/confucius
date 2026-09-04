import { abortError } from "./abort";
import type {
  ModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelTurn,
  ModelToolCall,
  ModelUsage,
} from "./ModelAdapter";

import type { ReasoningEffort } from "@confucius/protocol";
import {
  splitThinkTaggedContent,
  ThinkTagStreamParser,
  type ThinkTaggedContent,
} from "./ThinkTagParser";

export type ApiStyle = "openai" | "ollama";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  /** Stream tokens as they arrive instead of waiting for the full response. */
  stream?: boolean;
  /**
   * Wire format. "openai" POSTs {baseUrl}/chat/completions with SSE
   * streaming; "ollama" speaks Ollama's native /api/chat (NDJSON streaming,
   * message.thinking, object-valued tool arguments). Auto-detected from a
   * baseUrl whose path ends with /api/chat.
   */
  apiStyle?: ApiStyle;
  /**
   * Thinking budget. "auto" sends nothing (server default); "off" maps to
   * Ollama think:false (OpenAI has no off switch, so it is omitted there);
   * low/medium/high map to reasoning_effort / think respectively.
   */
  reasoningEffort?: ReasoningEffort;
  /** Called incrementally while streaming (also works for reasoning). */
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onUsage?: (usage: ModelUsage) => void;
  fetchImpl?: typeof fetch;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2;

export function detectApiStyle(baseUrl: string): ApiStyle {
  try {
    const path = new URL(baseUrl).pathname.replace(/\/+$/, "");
    return path.endsWith("/api/chat") ? "ollama" : "openai";
  } catch {
    return "openai";
  }
}

/**
 * OpenAI-compatible gateways (New-API, vLLM, university mirrors) serve
 * /v1/models and /v1/chat/completions. Users often paste the host only;
 * some paste the full /chat/completions URL. Ollama native /api/chat is
 * left alone.
 */
export function normalizeOpenAICompatibleBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (detectApiStyle(trimmed) === "ollama") {
    return trimmed.replace(/\/+$/, "");
  }
  try {
    const url = new URL(trimmed);
    let path = url.pathname.replace(/\/+$/, "") || "/";
    if (/\/chat\/completions$/i.test(path)) {
      path = path.slice(0, -"/chat/completions".length) || "/";
    }
    if (path === "/") {
      path = "/v1";
    }
    url.pathname = path;
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    const stripped = trimmed
      .replace(/\/+$/, "")
      .replace(/\/chat\/completions$/i, "");
    const afterScheme = stripped.replace(/^[a-z]+:\/\//i, "");
    if (!afterScheme.includes("/")) {
      return `${stripped}/v1`;
    }
    return stripped;
  }
}

export function describeNonJsonModelBody(
  kind: "list" | "response",
  text: string,
): string {
  const html = /<!doctype html|<html[\s>]|<script[\s>]/i.test(text);
  if (kind === "list") {
    return html
      ? "Model list returned HTML instead of JSON. For OpenAI-compatible gateways, the Base URL should end with /v1."
      : "Model list is not JSON";
  }
  return html
    ? "Model returned HTML instead of JSON. For OpenAI-compatible gateways, the Base URL should end with /v1."
    : `Model response is not JSON: ${text.trim().slice(0, 180)}`;
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  private readonly style: ApiStyle;
  private readonly baseUrl: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.style = config.apiStyle ?? detectApiStyle(config.baseUrl);
    this.baseUrl =
      this.style === "ollama"
        ? config.baseUrl.replace(/\/+$/, "")
        : normalizeOpenAICompatibleBaseUrl(config.baseUrl);
  }

  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelTurn> {
    const response = await this.fetchWithRetry(request, signal);
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Model HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
      );
    }
    const contentType = headerValue(response, "content-type");
    const liveBody = readableBody(response);
    if (this.config.stream !== false && liveBody) {
      if (this.style === "ollama" && isOllamaStreamType(contentType)) {
        return this.readOllamaStream(response, signal);
      }
      if (
        this.style === "openai" &&
        contentType.includes("text/event-stream")
      ) {
        return this.readStream(response, signal);
      }
    }
    const text = await response.text();
    if (this.config.stream !== false) {
      // Zotero.HTTP buffers the whole body and has no ReadableStream.
      // Parse the buffered SSE/NDJSON so a completed stream still yields a turn.
      if (
        this.style === "ollama" &&
        (isOllamaStreamType(contentType) || looksLikeNdjson(text))
      ) {
        return this.readOllamaStream(bufferedResponse(text), signal);
      }
      if (
        this.style === "openai" &&
        (contentType.includes("text/event-stream") || looksLikeSse(text))
      ) {
        return this.readStream(bufferedResponse(text), signal);
      }
    }
    return this.style === "ollama"
      ? this.parseOllamaResponse(text)
      : this.parseJsonResponse(text);
  }

  private async fetchWithRetry(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const url =
      this.style === "ollama"
        ? this.baseUrl
        : joinUrl(this.baseUrl, "/chat/completions");
    const stream = this.config.stream !== false;
    const body: Record<string, unknown> =
      this.style === "ollama"
        ? this.buildOllamaBody(request, stream)
        : this.buildOpenAIBody(request, stream);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (
        response.ok ||
        !RETRYABLE_STATUS.has(response.status) ||
        attempt === MAX_ATTEMPTS
      ) {
        return response;
      }
      await response.text().catch(() => "");
      if (attempt < MAX_ATTEMPTS && !signal?.aborted) {
        await delay(800 * attempt, signal);
      }
    }
    throw new Error("Model request retry loop exited unexpectedly");
  }

  private buildOpenAIBody(
    request: ModelRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages.map(toOpenAIMessage),
      stream,
    };
    if (stream) {
      body.stream_options = { include_usage: true };
    }
    if (this.config.maxTokens && this.config.maxTokens > 0) {
      body.max_tokens = this.config.maxTokens;
    }
    const effort = this.config.reasoningEffort;
    if (effort && effort !== "auto" && effort !== "off") {
      body.reasoning_effort = effort;
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }
    return body;
  }

  private buildOllamaBody(
    request: ModelRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toOllamaMessages(request.messages),
      stream,
    };
    if (this.config.maxTokens && this.config.maxTokens > 0) {
      body.options = { num_predict: this.config.maxTokens };
    }
    const effort = this.config.reasoningEffort;
    if (effort && effort !== "auto") {
      body.think = effort === "off" ? false : effort;
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }
    return body;
  }

  private async readStream(
    response: Response,
    signal?: AbortSignal,
  ): Promise<ModelTurn> {
    const reader = response.body!.getReader() as unknown as ByteReader;
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let reasoning = "";
    const thinkTags = new ThinkTagStreamParser();
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let usage: ModelUsage | undefined;
    let sawData = false;
    let ended = false;

    const handleChunk = (payloadText: string) => {
      if (payloadText === "[DONE]") {
        ended = true;
        return;
      }
      let payload: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: ModelUsage | null;
      };
      try {
        payload = JSON.parse(payloadText);
      } catch {
        return;
      }
      sawData = true;
      if (payload.usage) {
        usage = normalizeUsage(payload.usage);
      }
      const delta = payload.choices?.[0]?.delta;
      if (!delta) {
        return;
      }
      const reasoningPiece = delta.reasoning_content ?? delta.reasoning;
      if (reasoningPiece) {
        reasoning += reasoningPiece;
        this.config.onReasoningDelta?.(reasoningPiece);
      }
      if (delta.content) {
        const parsed = thinkTags.push(delta.content);
        text += parsed.text;
        reasoning += parsed.reasoning;
        emitThinkTaggedContent(this.config, parsed);
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const entry = toolCalls.get(index) ?? { id: "", name: "", args: "" };
        if (call.id) {
          entry.id = call.id;
        }
        if (call.function?.name) {
          entry.name += call.function.name;
        }
        if (call.function?.arguments) {
          entry.args += call.function.arguments;
        }
        toolCalls.set(index, entry);
      }
    };

    try {
      for (;;) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          throw abortError();
        }
        if (ended) {
          await reader.cancel().catch(() => undefined);
          break;
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) {
            handleChunk(trimmed.slice(5).trim());
          }
        }
        const pending = buffer.trim();
        if (pending === "data: [DONE]") {
          handleChunk("[DONE]");
          buffer = "";
        }
      }
      const remainder = buffer.trim();
      if (remainder.startsWith("data:")) {
        handleChunk(remainder.slice(5).trim());
      }
    } catch (error) {
      // Some endpoints close the stream without a terminal newline but have
      // already delivered a usable payload; fall back to what we have.
      if (!sawData) {
        throw error;
      }
    }

    const tail = thinkTags.finish();
    text += tail.text;
    reasoning += tail.reasoning;
    emitThinkTaggedContent(this.config, tail);

    if (usage) {
      this.config.onUsage?.(usage);
    }
    return {
      text: text || undefined,
      reasoning: reasoning || undefined,
      toolCalls: materializeToolCalls(toolCalls),
      usage,
      streamed: true,
    };
  }

  /**
   * Ollama native streaming: newline-delimited JSON where every chunk
   * carries an incremental message piece and the final chunk sets done.
   */
  private async readOllamaStream(
    response: Response,
    signal?: AbortSignal,
  ): Promise<ModelTurn> {
    const reader = response.body!.getReader() as unknown as ByteReader;
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let thinking = "";
    const thinkTags = new ThinkTagStreamParser();
    let toolCalls: ModelToolCall[] | undefined;
    let usage: ModelUsage | undefined;
    let sawData = false;
    let ended = false;

    const handleLine = (line: string) => {
      if (!line.trim()) {
        return;
      }
      let chunk: {
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: Array<{
            function?: { name?: string; arguments?: unknown };
          }>;
        };
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
      };
      try {
        chunk = JSON.parse(line);
      } catch {
        return;
      }
      sawData = true;
      if (chunk.message?.thinking) {
        thinking += chunk.message.thinking;
        this.config.onReasoningDelta?.(chunk.message.thinking);
      }
      if (chunk.message?.content) {
        const parsed = thinkTags.push(chunk.message.content);
        text += parsed.text;
        thinking += parsed.reasoning;
        emitThinkTaggedContent(this.config, parsed);
      }
      if (chunk.message?.tool_calls?.length) {
        toolCalls = mapOllamaToolCalls(chunk.message.tool_calls);
      }
      if (chunk.done) {
        ended = true;
        usage = {
          promptTokens: chunk.prompt_eval_count,
          completionTokens: chunk.eval_count,
          totalTokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
        };
      }
    };

    try {
      for (;;) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          throw abortError();
        }
        if (ended) {
          await reader.cancel().catch(() => undefined);
          break;
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line);
        }
        if (!ended && buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer.trim()) as { done?: unknown };
            if (parsed && typeof parsed === "object" && parsed.done === true) {
              handleLine(buffer);
              buffer = "";
            }
          } catch {
            // Incomplete JSON still arriving.
          }
        }
      }
      handleLine(buffer);
    } catch (error) {
      if (!sawData) {
        throw error;
      }
    }

    const tail = thinkTags.finish();
    text += tail.text;
    thinking += tail.reasoning;
    emitThinkTaggedContent(this.config, tail);

    if (usage) {
      this.config.onUsage?.(usage);
    }
    return {
      text: text || undefined,
      reasoning: thinking || undefined,
      toolCalls,
      usage,
      streamed: true,
    };
  }

  private parseJsonResponse(text: string): ModelTurn {
    let payload: {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: ModelUsage | null;
    };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      throw new Error(describeNonJsonModelBody("response", text));
    }
    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new Error("Model response missing choices[0].message");
    }

    const toolCalls: ModelToolCall[] = [];
    for (const call of message.tool_calls ?? []) {
      if (!call.function?.name) {
        continue;
      }
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments
          ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
          : {};
      } catch {
        args = { _raw: call.function.arguments };
      }
      toolCalls.push({
        id: call.id || `call_${toolCalls.length + 1}`,
        name: call.function.name,
        args,
      });
    }
    if (payload.usage) {
      this.config.onUsage?.(normalizeUsage(payload.usage));
    }

    const tagged = splitThinkTaggedContent(message.content ?? "");
    const explicitReasoning =
      message.reasoning_content ?? message.reasoning ?? "";

    return {
      text: tagged.text || undefined,
      reasoning: joinReasoning(explicitReasoning, tagged.reasoning),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: payload.usage ? normalizeUsage(payload.usage) : undefined,
    };
  }

  /** Ollama native non-streaming: {message: {content, thinking, tool_calls}}. */
  private parseOllamaResponse(text: string): ModelTurn {
    const payload = JSON.parse(text) as {
      message?: {
        content?: string;
        thinking?: string;
        tool_calls?: Array<{
          function?: { name?: string; arguments?: unknown };
        }>;
      };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const message = payload.message;
    if (!message) {
      throw new Error("Ollama response missing message");
    }
    const usage: ModelUsage | undefined = payload.eval_count
      ? {
          promptTokens: payload.prompt_eval_count,
          completionTokens: payload.eval_count,
          totalTokens:
            (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0),
        }
      : undefined;
    if (usage) {
      this.config.onUsage?.(usage);
    }
    const tagged = splitThinkTaggedContent(message.content || "");
    return {
      text: tagged.text || undefined,
      reasoning: joinReasoning(message.thinking || "", tagged.reasoning),
      toolCalls: message.tool_calls?.length
        ? mapOllamaToolCalls(message.tool_calls)
        : undefined,
      usage,
    };
  }
}

function emitThinkTaggedContent(
  config: OpenAICompatibleConfig,
  content: ThinkTaggedContent,
): void {
  if (content.reasoning) config.onReasoningDelta?.(content.reasoning);
  if (content.text) config.onTextDelta?.(content.text);
}

function joinReasoning(explicit: string, tagged: string): string | undefined {
  if (!explicit) return tagged || undefined;
  if (!tagged || tagged === explicit) return explicit;
  return `${explicit}${tagged}`;
}

/** Map usage from OpenAI snake_case, camelCase, or Ollama eval counters. */
function normalizeUsage(raw: ModelUsage | Record<string, unknown>): ModelUsage {
  const source = raw as Record<string, unknown>;
  const read = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = Number(source[key]);
      if (Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
    return undefined;
  };
  const promptTokens = read(
    "prompt_tokens",
    "promptTokens",
    "prompt_eval_count",
  );
  const completionTokens = read(
    "completion_tokens",
    "completionTokens",
    "eval_count",
  );
  const totalTokens =
    read("total_tokens", "totalTokens") ??
    (promptTokens ?? 0) + (completionTokens ?? 0);
  return { promptTokens, completionTokens, totalTokens };
}

function mapOllamaToolCalls(
  calls: Array<{ function?: { name?: string; arguments?: unknown } }>,
): ModelToolCall[] {
  const mapped: ModelToolCall[] = [];
  let index = 0;
  for (const call of calls) {
    if (!call.function?.name) {
      continue;
    }
    let args: Record<string, unknown> = {};
    if (typeof call.function.arguments === "string") {
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        args = { _raw: call.function.arguments };
      }
    } else if (
      call.function.arguments &&
      typeof call.function.arguments === "object"
    ) {
      args = call.function.arguments as Record<string, unknown>;
    }
    mapped.push({
      id: `call_${index + 1}`,
      name: call.function.name,
      args,
    });
    index += 1;
  }
  return mapped;
}

function materializeToolCalls(
  accumulated: Map<number, ToolCallAccumulator>,
): ModelToolCall[] | undefined {
  const calls: ModelToolCall[] = [];
  let index = 0;
  for (const entry of accumulated.values()) {
    if (!entry.name) {
      continue;
    }
    let args: Record<string, unknown> = {};
    try {
      args = entry.args
        ? (JSON.parse(entry.args) as Record<string, unknown>)
        : {};
    } catch {
      args = { _raw: entry.args };
    }
    calls.push({
      id: entry.id || `call_${index + 1}`,
      name: entry.name,
      args,
    });
    index += 1;
  }
  return calls.length > 0 ? calls : undefined;
}

function readableBody(response: Response): boolean {
  try {
    return Boolean(
      response.body && typeof response.body.getReader === "function",
    );
  } catch {
    return false;
  }
}

function isOllamaStreamType(contentType: string): boolean {
  return (
    contentType.includes("application/x-ndjson") ||
    contentType.includes("application/json")
  );
}

function looksLikeSse(text: string): boolean {
  return /^\s*data:/m.test(text);
}

function looksLikeNdjson(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  try {
    const first = JSON.parse(lines[0]) as { done?: unknown };
    if (lines.length > 1) {
      return true;
    }
    return first && typeof first === "object" && first.done === false;
  } catch {
    return false;
  }
}

function bufferedResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  const reader: ByteReader = {
    async read() {
      if (sent) {
        return { done: true };
      }
      sent = true;
      return { done: false, value: bytes };
    },
    async cancel() {
      sent = true;
    },
  };
  return { body: { getReader: () => reader } } as unknown as Response;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function headerValue(response: Response, name: string): string {
  try {
    return response.headers?.get?.(name) ?? "";
  } catch {
    return "";
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function toOpenAIMessage(message: ModelMessage) {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        },
      })),
    };
  }
  if (message.images?.length) {
    return {
      role: message.role,
      content: [
        { type: "text", text: message.content },
        ...message.images.map((image) => ({
          type: "image_url",
          image_url: {
            url: `data:${image.mimeType};base64,${image.data}`,
          },
        })),
      ],
    };
  }
  return {
    role: message.role,
    content: message.content,
  };
}

/**
 * Ollama native messages: tool results are role:"tool" with a tool_name, so
 * resolve each toolCallId against the preceding assistant message's calls.
 */
function toOllamaMessages(
  messages: ModelMessage[],
): Array<Record<string, unknown>> {
  const callNames = new Map<string, string>();
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        callNames.set(call.id, call.name);
      }
      return {
        role: "assistant",
        content: message.content || "",
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          function: {
            name: call.name,
            // Ollama native expects arguments as a JSON object, not a string.
            arguments: call.args ?? {},
          },
        })),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
        tool_name: callNames.get(message.toolCallId ?? "") ?? "tool",
      };
    }
    if (message.images?.length) {
      return {
        role: message.role,
        content: message.content,
        images: message.images.map((image) => image.data),
      };
    }
    return { role: message.role, content: message.content };
  });
}
