import {
  modelApiRoot,
  modelApiUrl,
  normalizeModelEffort,
} from "@confucius/protocol";
import {
  ModelError,
  type ModelEnd,
  type ModelMessage,
  type ModelRequest,
  type ModelToolCall,
  type ModelTurn,
  type ModelUsage,
} from "./ModelAdapter";
import { providerErrorEnvelope } from "./OpenAICompatibleAdapter";
import type { NativeModelConfig } from "./NativeModelAdapter";

// Provider JSON is validated at the boundary; opaque signed blocks stay intact.
type Wire = Record<string, any>;
export type NativeWireProtocol = "responses" | "anthropic" | "gemini";
const object = (value: unknown): Wire =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value: unknown): Wire[] =>
  Array.isArray(value) ? value.map(object) : [];
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function createWireCodec(
  protocol: NativeWireProtocol,
  config: NativeModelConfig,
): WireCodec {
  return protocol === "responses"
    ? new ResponsesCodec(config, protocol)
    : protocol === "anthropic"
      ? new AnthropicCodec(config, protocol)
      : new GeminiCodec(config, protocol);
}

abstract class WireCodec {
  terminal = false;
  protected text = "";
  protected reasoning = "";
  protected end: ModelEnd = "incomplete";
  protected usage?: ModelUsage;
  protected items: Wire[] = [];
  protected calls: ModelToolCall[] = [];
  private toolNames = new Map<string, string>();
  protected route: string;
  constructor(
    protected config: NativeModelConfig,
    protected protocol: NativeWireProtocol,
  ) {
    this.route = `${protocol}:${modelApiRoot(config.baseUrl, protocol)}:${config.model}:${config.profile?.id ?? "default"}`;
  }
  abstract request(request: ModelRequest, stream: boolean): Wire;
  abstract accept(payload: unknown, streamed: boolean): void;
  url(_stream: boolean): string {
    return modelApiUrl(
      this.config.baseUrl,
      this.protocol,
      this.protocol === "responses" ? "/responses" : "/messages",
    );
  }
  protected replay(message: ModelMessage): Wire[] | undefined {
    const state = message.replayState;
    return state?.version === 1 &&
      state.provider === this.route &&
      state.data.items
      ? copy(state.data.items)
      : undefined;
  }
  protected delta(text: string, reasoning = false): void {
    if (!text) return;
    if (reasoning) {
      this.reasoning += text;
      this.config.onReasoningDelta?.(text);
    } else {
      this.text += text;
      this.config.onTextDelta?.(text);
    }
  }
  protected finalText(
    text: string,
    reasoning: string,
    streamed: boolean,
  ): void {
    if (streamed) {
      if (text.startsWith(this.text)) this.delta(text.slice(this.text.length));
      if (reasoning.startsWith(this.reasoning))
        this.delta(reasoning.slice(this.reasoning.length), true);
    }
    this.text = text;
    this.reasoning = reasoning;
  }
  protected fail(payload: Wire): void {
    const error = providerErrorEnvelope(payload.error);
    if (error) throw error;
  }
  protected effort(): string {
    return normalizeModelEffort(
      this.config.model,
      this.config.baseUrl,
      this.config.reasoningEffort,
      this.config.reasoning?.[this.config.model],
      this.protocol,
    );
  }
  protected name(original: string): string {
    let wire = original;
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(original)) {
      let hash = 2166136261;
      for (const char of original)
        hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
      wire = `tool_${original.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}_${(hash >>> 0).toString(16)}`;
    }
    const previous = this.toolNames.get(wire);
    if (previous && previous !== original)
      throw new ModelError(
        "Tool names collide after protocol normalization",
        "invalid_request",
      );
    this.toolNames.set(wire, original);
    return wire;
  }
  partial(): ModelTurn {
    return {
      text: this.text || undefined,
      reasoning: this.reasoning || undefined,
      usage: this.usage,
      end: "incomplete",
      streamed: true,
    };
  }
  result(streamed: boolean): ModelTurn {
    if (!this.terminal)
      throw new ModelError(
        "Model stream ended before a terminal event",
        "transport",
        { retryable: true },
      );
    return {
      end: this.end,
      text: this.text || undefined,
      reasoning: this.reasoning || undefined,
      toolCalls: this.calls.length
        ? this.calls.map((call) => ({
            ...call,
            name: this.toolNames.get(call.name) ?? call.name,
          }))
        : undefined,
      usage: this.usage,
      streamed,
      replayState: this.items.length
        ? {
            provider: this.route,
            version: 1,
            data: { items: copy(this.items) },
          }
        : undefined,
    };
  }
}

function toolCall(id: unknown, name: unknown, args: unknown): ModelToolCall {
  if (!string(id) || !string(name))
    throw new ModelError(
      "Model tool call is missing its ID or name",
      "protocol",
    );
  let parsed: unknown = args;
  try {
    if (typeof args === "string") parsed = JSON.parse(args || "{}");
  } catch {
    return {
      id: string(id),
      name: string(name),
      args: { _raw: args },
      argumentsError: "Tool arguments are not valid JSON",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return {
      id: string(id),
      name: string(name),
      args: { _raw: parsed },
      argumentsError: "Tool arguments must be a JSON object",
    };
  return {
    id: string(id),
    name: string(name),
    args: parsed as Record<string, unknown>,
  };
}

function joinMessages(
  messages: Wire[],
  role: string,
  content: Wire[],
  field = "content",
): void {
  if (!content.length) return;
  const last = messages.at(-1);
  if (last?.role === role) last[field].push(...content);
  else messages.push({ role, [field]: content });
}

class ResponsesCodec extends WireCodec {
  private output = new Map<number, Wire>();
  request(request: ModelRequest, stream: boolean): Wire {
    const input: Wire[] = [];
    for (const message of request.messages) {
      if (message.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content,
        });
        continue;
      }
      const replay =
        message.role === "assistant" ? this.replay(message) : undefined;
      if (replay) {
        input.push(...replay);
        continue;
      }
      if (message.content || message.images?.length)
        input.push({
          role: message.role,
          content: [
            ...(message.content
              ? [
                  {
                    type:
                      message.role === "assistant"
                        ? "output_text"
                        : "input_text",
                    text: message.content,
                  },
                ]
              : []),
            ...(message.images ?? []).map((image) => ({
              type: "input_image",
              image_url: `data:${image.mimeType};base64,${image.data}`,
            })),
          ],
        });
      for (const call of message.toolCalls ?? [])
        input.push({
          type: "function_call",
          call_id: call.id,
          name: this.name(call.name),
          arguments: JSON.stringify(call.args),
        });
    }
    const body: Wire = {
      model: this.config.model,
      input,
      stream,
      store: false,
      include: ["reasoning.encrypted_content"],
    };
    if (this.config.maxTokens) body.max_output_tokens = this.config.maxTokens;
    const effort = this.effort();
    if (effort !== "auto")
      body.reasoning = { effort: effort === "off" ? "none" : effort };
    if (request.tools?.length)
      body.tools = request.tools.map((tool) => ({
        type: "function",
        name: this.name(tool.name),
        description: tool.description,
        parameters: tool.inputSchema,
        strict: false,
      }));
    return body;
  }
  accept(raw: unknown, streamed: boolean): void {
    const event = object(raw);
    this.fail(event);
    if (!streamed) {
      this.complete(event, false);
      return;
    }
    if (event.type === "error")
      throw (
        providerErrorEnvelope(event) ??
        new ModelError("Responses stream failed", "server", { retryable: true })
      );
    if (event.type === "response.output_text.delta")
      this.delta(string(event.delta));
    if (
      event.type === "response.reasoning_summary_text.delta" ||
      event.type === "response.reasoning_text.delta"
    )
      this.delta(string(event.delta), true);
    if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done"
    )
      this.output.set(Number(event.output_index), copy(object(event.item)));
    if (event.type === "response.function_call_arguments.delta") {
      const item = this.output.get(Number(event.output_index));
      if (item) item.arguments = string(item.arguments) + string(event.delta);
    }
    if (event.type === "response.function_call_arguments.done") {
      const item = this.output.get(Number(event.output_index));
      if (item) item.arguments = event.arguments;
    }
    if (
      ["response.completed", "response.incomplete", "response.failed"].includes(
        event.type,
      )
    )
      this.complete(object(event.response), true);
  }
  private complete(response: Wire, streamed: boolean): void {
    this.fail(response);
    if (!["completed", "incomplete"].includes(response.status))
      throw new ModelError(
        `Responses request did not complete (${string(response.status) || "missing status"})`,
        "protocol",
      );
    const items = Array.isArray(response.output)
      ? array(response.output)
      : [...this.output.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, item]) => item);
    this.items = items.filter((item) =>
      ["message", "function_call", "reasoning"].includes(item.type),
    );
    const text = this.items
      .filter((item) => item.type === "message")
      .flatMap((item) => array(item.content))
      .filter((part) => part.type === "output_text")
      .map((part) => string(part.text))
      .join("");
    const reasoning = this.items
      .filter((item) => item.type === "reasoning")
      .flatMap((item) => array(item.summary))
      .map((part) => string(part.text))
      .join("");
    this.finalText(text, reasoning || this.reasoning, streamed);
    this.calls = this.items
      .filter((item) => item.type === "function_call")
      .map((item) => toolCall(item.call_id, item.name, item.arguments));
    const refused = this.items.some((item) =>
      array(item.content).some((part) => part.type === "refusal"),
    );
    this.end =
      response.status === "incomplete"
        ? response.incomplete_details?.reason === "max_output_tokens"
          ? "length"
          : response.incomplete_details?.reason === "content_filter"
            ? "content_filter"
            : "incomplete"
        : refused
          ? "content_filter"
          : this.calls.length
            ? "tool_calls"
            : "stop";
    const u = object(response.usage);
    if (Object.keys(u).length)
      this.usage = {
        promptTokens: u.input_tokens,
        completionTokens: u.output_tokens,
        totalTokens: u.total_tokens,
      };
    this.terminal = true;
  }
}

class AnthropicCodec extends WireCodec {
  private blocks = new Map<number, Wire>();
  private arguments = new Map<number, string>();
  private stopReason = "";
  private counts: Wire = {};
  request(request: ModelRequest, stream: boolean): Wire {
    const messages: Wire[] = [];
    const system: string[] = [];
    for (const message of request.messages) {
      if (message.role === "system") {
        system.push(message.content);
        continue;
      }
      if (message.role === "tool") {
        joinMessages(messages, "user", [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
          },
        ]);
        continue;
      }
      const replay =
        message.role === "assistant" ? this.replay(message) : undefined;
      const content: Wire[] = replay ?? [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...(message.images ?? []).map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: image.data,
          },
        })),
        ...(message.toolCalls ?? []).map((call) => ({
          type: "tool_use",
          id: call.id,
          name: this.name(call.name),
          input: call.args,
        })),
      ];
      joinMessages(messages, message.role, content);
    }
    const body: Wire = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens || 4096,
      stream,
    };
    if (system.length) body.system = system.join("\n\n");
    if (request.tools?.length)
      body.tools = request.tools.map((tool) => ({
        name: this.name(tool.name),
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    const effort = this.effort();
    if (effort === "off") body.thinking = { type: "disabled" };
    else if (
      effort === "on" &&
      /^claude-(?:3[.-]7|(?:opus|sonnet)-4(?:[.-][05])?(?:-|$))/.test(
        this.config.model,
      )
    ) {
      if (body.max_tokens <= 1024)
        throw new ModelError(
          "Anthropic thinking requires an output limit above 1024 tokens",
          "invalid_request",
        );
      body.thinking = {
        type: "enabled",
        budget_tokens: Math.min(8192, body.max_tokens - 1),
      };
    } else if (effort !== "auto") {
      body.thinking = { type: "adaptive" };
      if (effort !== "on") body.output_config = { effort };
    }
    return body;
  }
  accept(raw: unknown, streamed: boolean): void {
    const event = object(raw);
    this.fail(event);
    if (!streamed) {
      if (event.type !== "message" || !Array.isArray(event.content))
        throw new ModelError(
          "Anthropic response missing message content",
          "protocol",
        );
      this.items = array(event.content);
      this.stopReason = string(event.stop_reason);
      this.counts = object(event.usage);
      this.complete(false);
      return;
    }
    if (event.type === "message_start")
      Object.assign(this.counts, object(event.message?.usage));
    if (event.type === "content_block_start") {
      const block = copy(object(event.content_block));
      this.blocks.set(Number(event.index), block);
      if (block.type === "text") this.delta(string(block.text));
      if (block.type === "thinking") this.delta(string(block.thinking), true);
    }
    if (event.type === "content_block_delta") {
      const index = Number(event.index),
        block = this.blocks.get(index),
        delta = object(event.delta);
      if (!block)
        throw new ModelError(
          "Anthropic delta has no content block",
          "protocol",
        );
      if (delta.type === "text_delta") {
        block.text = string(block.text) + string(delta.text);
        this.delta(string(delta.text));
      }
      if (delta.type === "thinking_delta") {
        block.thinking = string(block.thinking) + string(delta.thinking);
        this.delta(string(delta.thinking), true);
      }
      if (delta.type === "signature_delta")
        block.signature = string(block.signature) + string(delta.signature);
      if (delta.type === "input_json_delta")
        this.arguments.set(
          index,
          (this.arguments.get(index) ?? "") + string(delta.partial_json),
        );
    }
    if (event.type === "message_delta") {
      this.stopReason = string(event.delta?.stop_reason) || this.stopReason;
      Object.assign(this.counts, object(event.usage));
    }
    if (event.type === "message_stop") {
      this.items = [...this.blocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, block]) => {
          if (this.arguments.has(index)) {
            const parsed = toolCall(
              block.id,
              block.name,
              this.arguments.get(index),
            );
            block.input = parsed.args;
            if (parsed.argumentsError)
              block.argumentsError = parsed.argumentsError;
          }
          return block;
        });
      this.complete(true);
    }
  }
  private complete(streamed: boolean): void {
    if (!this.stopReason)
      throw new ModelError(
        "Anthropic response missing stop reason",
        "protocol",
      );
    this.finalText(
      this.items
        .filter((b) => b.type === "text")
        .map((b) => string(b.text))
        .join(""),
      this.items
        .filter((b) => b.type === "thinking")
        .map((b) => string(b.thinking))
        .join(""),
      streamed,
    );
    this.calls = this.items
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        ...toolCall(b.id, b.name, b.input),
        ...(b.argumentsError ? { argumentsError: b.argumentsError } : {}),
      }));
    this.items = this.items.map(
      ({ argumentsError: _error, ...block }) => block,
    );
    this.end =
      this.stopReason === "max_tokens"
        ? "length"
        : this.stopReason === "refusal"
          ? "content_filter"
          : this.stopReason === "tool_use"
            ? "tool_calls"
            : ["end_turn", "stop_sequence"].includes(this.stopReason)
              ? "stop"
              : "incomplete";
    const input =
      (this.counts.input_tokens ?? 0) +
      (this.counts.cache_creation_input_tokens ?? 0) +
      (this.counts.cache_read_input_tokens ?? 0);
    if (Object.keys(this.counts).length)
      this.usage = {
        promptTokens: input,
        completionTokens: this.counts.output_tokens,
        totalTokens: input + (this.counts.output_tokens ?? 0),
      };
    this.terminal = true;
  }
}

class GeminiCodec extends WireCodec {
  url(stream: boolean): string {
    const model = encodeURIComponent(
      this.config.model.replace(/^models\//, ""),
    );
    const url = new URL(
      modelApiUrl(
        this.config.baseUrl,
        "gemini",
        `/models/${model}:${stream ? "streamGenerateContent" : "generateContent"}`,
      ),
    );
    if (stream) url.searchParams.set("alt", "sse");
    else url.searchParams.delete("alt");
    return url.toString();
  }
  request(request: ModelRequest, _stream: boolean): Wire {
    const contents: Wire[] = [],
      system: Wire[] = [];
    const names = new Map<string, { name: string; id?: string }>();
    for (const message of request.messages) {
      if (message.role === "system") {
        system.push({ text: message.content });
        continue;
      }
      if (message.role === "tool") {
        let response: unknown;
        try {
          response = JSON.parse(message.content);
        } catch {
          response = { result: message.content };
        }
        const reference = names.get(message.toolCallId ?? "");
        if (!reference)
          throw new ModelError(
            "Gemini tool result has no matching function call",
            "invalid_request",
          );
        joinMessages(
          contents,
          "user",
          [
            {
              functionResponse: {
                ...reference,
                response:
                  response &&
                  typeof response === "object" &&
                  !Array.isArray(response)
                    ? response
                    : { result: response },
              },
            },
          ],
          "parts",
        );
        continue;
      }
      const replay =
        message.role === "assistant" ? this.replay(message) : undefined;
      const replayCalls = replay?.filter((part) => part.functionCall);
      for (const [index, call] of (message.toolCalls ?? []).entries()) {
        const id = replayCalls
          ? string(replayCalls[index]?.functionCall?.id)
          : call.id;
        names.set(call.id, {
          name: this.name(call.name),
          ...(id ? { id } : {}),
        });
      }
      joinMessages(
        contents,
        message.role === "assistant" ? "model" : "user",
        replay ?? [
          ...(message.content ? [{ text: message.content }] : []),
          ...(message.images ?? []).map((image) => ({
            inlineData: { mimeType: image.mimeType, data: image.data },
          })),
          ...(message.toolCalls ?? []).map((call) => ({
            functionCall: {
              id: call.id,
              name: this.name(call.name),
              args: call.args,
            },
          })),
        ],
        "parts",
      );
    }
    const body: Wire = { contents };
    if (system.length) body.systemInstruction = { parts: system };
    if (request.tools?.length)
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: this.name(tool.name),
            description: tool.description,
            parametersJsonSchema: tool.inputSchema,
          })),
        },
      ];
    const generation: Wire = {};
    if (this.config.maxTokens)
      generation.maxOutputTokens = this.config.maxTokens;
    const effort = this.effort();
    if (effort !== "auto") {
      if (/gemini-2\.5/.test(this.config.model))
        generation.thinkingConfig = {
          thinkingBudget:
            effort === "off"
              ? 0
              : effort === "on"
                ? -1
                : ({ low: 2048, medium: 8192, high: 16384 } as Wire)[effort],
        };
      else generation.thinkingConfig = { thinkingLevel: effort };
    }
    if (Object.keys(generation).length) body.generationConfig = generation;
    return body;
  }
  accept(raw: unknown, streamed: boolean): void {
    const response = object(raw);
    this.fail(response);
    const candidate = array(response.candidates)[0];
    if (response.promptFeedback?.blockReason) {
      this.end = "content_filter";
      this.terminal = true;
      return;
    }
    if (candidate) {
      const parts = array(candidate.content?.parts);
      // Keep the exact part boundaries, including signature-only parts.
      this.items.push(...copy(parts));
      for (const part of parts) {
        if (streamed) this.delta(string(part.text), part.thought === true);
        if (part.functionCall) {
          const call = object(part.functionCall);
          this.calls.push(
            toolCall(
              call.id || `gemini_call_${this.calls.length + 1}`,
              call.name,
              call.args ?? {},
            ),
          );
        }
      }
      if (candidate.finishReason) {
        const reason = candidate.finishReason;
        this.end =
          reason === "STOP"
            ? this.calls.length
              ? "tool_calls"
              : "stop"
            : reason === "MAX_TOKENS"
              ? "length"
              : [
                    "SAFETY",
                    "RECITATION",
                    "BLOCKLIST",
                    "PROHIBITED_CONTENT",
                    "SPII",
                    "IMAGE_SAFETY",
                  ].includes(reason)
                ? "content_filter"
                : "incomplete";
        this.terminal = true;
      }
    }
    const u = object(response.usageMetadata);
    if (Object.keys(u).length)
      this.usage = {
        promptTokens: u.promptTokenCount,
        completionTokens:
          (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        totalTokens: u.totalTokenCount,
      };
    if (!streamed) {
      if (!this.terminal)
        throw new ModelError(
          "Gemini response missing finish reason",
          "protocol",
        );
      this.finalText(
        this.items
          .filter((p) => !p.thought)
          .map((p) => string(p.text))
          .join(""),
        this.items
          .filter((p) => p.thought)
          .map((p) => string(p.text))
          .join(""),
        false,
      );
    }
  }
}
