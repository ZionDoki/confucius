export interface ModelToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ModelTurn {
  text?: string;
  reasoning?: string;
  toolCalls?: ModelToolCall[];
  usage?: ModelUsage;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelRequest {
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
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelTurn>;
}

export class ScriptedModel implements ModelAdapter {
  private index = 0;

  constructor(private readonly script: ModelTurn[]) {}

  complete(_request: ModelRequest, signal?: AbortSignal): Promise<ModelTurn> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    const turn = this.script[this.index] ?? { text: "" };
    this.index += 1;
    return Promise.resolve(turn);
  }
}
