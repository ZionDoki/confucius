import type {
  ModelAdapter,
  ModelRequest,
  ModelTurn,
  ModelToolCall,
  ModelUsage,
} from "./ModelAdapter";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  /** Stream tokens as they arrive instead of waiting for the full response. */
  stream?: boolean;
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

export class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelTurn> {
    const response = await this.fetchWithRetry(request, signal);
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Model HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
      );
    }
    const contentType = headerValue(response, "content-type");
    if (
      this.config.stream !== false &&
      contentType.includes("text/event-stream") &&
      response.body
    ) {
      return this.readStream(response, signal);
    }
    return this.parseJsonResponse(await response.text());
  }

  private async fetchWithRetry(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const url = joinUrl(this.config.baseUrl, "/chat/completions");
    const stream = this.config.stream !== false;
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
      if (response.ok || !RETRYABLE_STATUS.has(response.status)) {
        return response;
      }
      await response.text().catch(() => "");
      if (attempt < MAX_ATTEMPTS && !signal?.aborted) {
        await delay(800 * attempt, signal);
      }
    }
    throw new Error("Model request failed after retries");
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
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let usage: ModelUsage | undefined;
    let sawData = false;

    const handleChunk = (payloadText: string) => {
      if (payloadText === "[DONE]") {
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
        usage = payload.usage;
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
        text += delta.content;
        this.config.onTextDelta?.(delta.content);
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
          throw new DOMException("Aborted", "AbortError");
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

  private parseJsonResponse(text: string): ModelTurn {
    const payload = JSON.parse(text) as {
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
      this.config.onUsage?.(payload.usage);
    }

    return {
      text: message.content ?? undefined,
      reasoning: message.reasoning_content ?? message.reasoning ?? undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: payload.usage ?? undefined,
    };
  }
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
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

function toOpenAIMessage(message: ModelRequest["messages"][number]) {
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
  return {
    role: message.role,
    content: message.content,
  };
}
