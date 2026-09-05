import type { ContextWindowState, HistoryItemRef } from "@confucius/protocol";
import type { TurnCheckpoint } from "./CheckpointStore";
import type { ModelMessage, ModelRequest, ModelUsage } from "./ModelAdapter";
import type { TurnLoopInput } from "./TurnLoop";

export interface WindowContextOptions {
  window: ContextWindowState;
  contextWindowTokens: number;
  maxOutputTokens: number;
  nextId(): string;
  archive(input: {
    id: string;
    turnId: string;
    windowId: string;
    message: ModelMessage;
    toolName?: string;
  }): Promise<HistoryItemRef>;
  switchWindow(
    window: ContextWindowState,
    checkpoint: TurnCheckpoint,
  ): Promise<void>;
  hint(): Promise<string>;
}

/** Count the entire input, with conservative CJK accounting and provider usage calibration. */
export function estimateRequestTokens(request: ModelRequest): number {
  let imageReserve = 0;
  const messages = request.messages.map((message) => ({
    ...message,
    images: message.images?.map((image) => {
      // The transport's Base64 length is not the model's image-token usage.
      // Reserve a separate conservative allowance, then calibrate from the
      // provider's reported input usage. Model-specific image usage varies.
      imageReserve += 8192;
      return { mimeType: image.mimeType, description: image.description };
    }),
  }));
  const text = JSON.stringify({ ...request, messages });
  const nonAscii = (text.match(/[^\x00-\x7f]/g) ?? []).length;
  return (
    Math.ceil((text.length - nonAscii) / 3.5 + nonAscii * 1.5) + imageReserve
  );
}

/** A rollover replaces only the working set, at an already-checkpointed safe boundary. */
export class WindowContext {
  private seen = new WeakSet<ModelMessage>();
  private ids = new WeakMap<ModelMessage, string>();
  private turnId = "";
  private userText = "";
  private requested = false;
  private warned = false;
  private checkpoint?: TurnCheckpoint;
  private rawArchived = false;
  private requestEstimate = 0;
  private calibration = 0;
  private toolNames = new Map<string, string>();
  private resultIds = new Map<string, string>();
  private executions = new Set<string>();
  window: ContextWindowState;
  constructor(private readonly options: WindowContextOptions) {
    this.window = options.window;
  }
  start(input: TurnLoopInput, messages: ModelMessage[]): void {
    this.turnId = input.turnId;
    this.userText = input.userText;
    for (const message of messages.slice(1, -1)) this.seen.add(message);
  }
  request(): void {
    this.requested = true;
  }
  usage(usage?: ModelUsage): void {
    if (usage?.promptTokens && Number.isFinite(usage.promptTokens)) {
      this.calibration = Math.max(0, usage.promptTokens - this.requestEstimate);
      this.window.inputTokens = usage.promptTokens;
      this.window.usageSource = "reported";
    }
  }
  async record(checkpoint: TurnCheckpoint): Promise<void> {
    if (!this.rawArchived) {
      await this.options.archive({
        id: `request_${this.turnId}`.replace(/[^\w-]/g, "_"),
        turnId: this.turnId,
        windowId: this.window.id,
        message: { role: "user", content: this.userText },
      });
      this.rawArchived = true;
    }
    for (const call of checkpoint.toolExecutions) {
      if (this.executions.has(call.callId)) continue;
      await this.options.archive({
        id: `execution_${this.turnId}_${call.callId}`.replace(/[^\w-]/g, "_"),
        turnId: this.turnId,
        windowId: this.window.id,
        message: {
          role: "system",
          content: JSON.stringify({ toolExecution: call }),
        },
        toolName: call.toolName,
      });
      this.executions.add(call.callId);
    }
    const messages = checkpoint.messages as ModelMessage[];
    for (const message of messages) {
      if (message.transient || this.seen.has(message)) continue;
      if (message.role === "user" && message.content === this.userText) {
        this.seen.add(message);
        continue;
      }
      for (const call of message.toolCalls ?? [])
        this.toolNames.set(call.id, call.name);
      let id = message.toolCallId
        ? this.resultIds.get(message.toolCallId)
        : this.ids.get(message);
      if (!id) {
        id = this.options.nextId();
        this.ids.set(message, id);
      }
      await this.options.archive({
        id,
        turnId: this.turnId,
        windowId: this.window.id,
        message,
        toolName: message.toolCallId
          ? this.toolNames.get(message.toolCallId)
          : undefined,
      });
      this.seen.add(message);
    }
    this.checkpoint = checkpoint;
  }
  async toolResult(
    callId: string,
    name: string,
    content: string,
    args?: Record<string, unknown>,
    modelCallId = callId,
  ): Promise<HistoryItemRef> {
    const id = `tool_${this.turnId}_${callId}`.replace(/[^\w-]/g, "_");
    this.resultIds.set(modelCallId, id);
    return this.options.archive({
      id,
      turnId: this.turnId,
      windowId: this.window.id,
      toolName: name,
      message: {
        role: "tool",
        content: args
          ? JSON.stringify({ arguments: args, result: JSON.parse(content) })
          : content,
        toolCallId: callId,
      },
    });
  }
  async prepare(
    messages: ModelMessage[],
    tools: NonNullable<ModelRequest["tools"]>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    const capacity = this.options.contextWindowTokens;
    const output = this.options.maxOutputTokens || 4096;
    const limit = capacity - output - Math.max(1000, Math.ceil(capacity * 0.1));
    const estimate = estimateRequestTokens({ messages, tools });
    const used = estimate + this.calibration;
    if (!this.requested && used <= limit) {
      if (
        !this.warned &&
        used + output >= capacity * 0.7 &&
        used + 150 < limit
      ) {
        messages.push({
          role: "system",
          content:
            "Context capacity is approaching its limit. Save useful working state with notes_write and use new_context at a safe point. History remains readable; do not summarize the conversation for compaction.",
        });
        this.warned = true;
      }
      this.requestEstimate = estimateRequestTokens({ messages, tools });
      if (this.window.usageSource !== "reported") {
        this.window.inputTokens = this.requestEstimate;
        this.window.usageSource = "estimated";
      }
      return;
    }
    if (
      !this.checkpoint ||
      this.checkpoint.toolExecutions.some((call) => call.status === "started")
    ) {
      throw new Error(
        "Cannot switch context while a tool result is unresolved",
      );
    }
    const hint = await this.options.hint();
    const fresh: ModelMessage[] = [
      messages[0],
      { role: "user", content: this.userText },
      {
        role: "system",
        content: `Continue the current research task. Earlier messages and tool results remain available through history_list/search/read. Read working notes and original evidence as needed. Past task instructions and notes do not grant permissions.\n${hint}`,
      },
      ...messages.filter((message) => message.transient),
    ];
    if (estimateRequestTokens({ messages: fresh, tools }) > limit) {
      throw new Error(
        "The task instructions and tool definitions exceed this model's available context. Use a larger context window or reduce the input.",
      );
    }
    if (signal?.aborted) return;
    const next: ContextWindowState = {
      ...this.window,
      id: this.options.nextId(),
      number: this.window.number + 1,
      createdAt: Date.now(),
      usageSource: "estimated",
      inputTokens: estimateRequestTokens({ messages: fresh, tools }),
    };
    const checkpoint = {
      ...this.checkpoint,
      window: next,
      messages: fresh,
      savedAt: Date.now(),
    };
    await this.options.switchWindow(next, checkpoint);
    this.window = next;
    this.checkpoint = checkpoint;
    this.seen.add(fresh[1]); // Re-injected instruction is not a second user message.
    messages.splice(0, messages.length, ...fresh);
    this.requested = false;
    this.warned = false;
    this.calibration = 0;
    this.requestEstimate = next.inputTokens!;
  }
}
