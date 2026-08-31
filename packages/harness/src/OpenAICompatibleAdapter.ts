import type { ModelAdapter, ModelRequest, ModelTurn, ModelToolCall } from "./ModelAdapter";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelTurn> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const url = joinUrl(this.config.baseUrl, "/chat/completions");
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages.map(toOpenAIMessage),
      stream: false,
    };
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

    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Model HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const payload = JSON.parse(text) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
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

    return {
      text: message.content ?? undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
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
