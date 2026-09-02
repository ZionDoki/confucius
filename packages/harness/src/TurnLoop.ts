import type {
  ConfuciusEvent,
  SessionRecord,
  ToolResult,
} from "@confucius/protocol";
import { BudgetAccountant } from "./BudgetAccountant";
import type { TurnCheckpoint } from "./CheckpointStore";
import { cloneValue } from "./clone";
import { splitBatches, type ScheduledCall } from "./ConcurrencyScheduler";
import type { MemoryEventLog } from "./EventLog";
import type { Clock, IdFactory } from "./ids";
import type { ModelAdapter, ModelMessage, ModelToolCall } from "./ModelAdapter";
import type { PermissionGate } from "./PermissionGate";
import { validateArgs } from "./SchemaValidate";
import type { ToolProvider } from "./ToolProvider";
import { errorMessage, isAbortError } from "./abort";
import { truncateToolResult } from "./truncate";

export interface CheckpointStore {
  save(checkpoint: TurnCheckpoint): void;
}

export interface TurnLoopInput {
  session: SessionRecord;
  turnId: string;
  userText: string;
  /**
   * Prior conversation for this session, WITHOUT the system message.
   * Replayed before the new user text so turns build on each other.
   */
  history?: ModelMessage[];
  signal?: AbortSignal;
}

export interface TurnLoopResult {
  phase: "done" | "failed" | "aborted";
  text: string;
  /** Final conversation of this turn (system prompt excluded) for persistence. */
  messages: ModelMessage[];
}

export interface TurnLoopDeps {
  model: ModelAdapter;
  tools: ToolProvider;
  permissions: PermissionGate;
  budget: BudgetAccountant;
  events: MemoryEventLog;
  checkpoints: CheckpointStore;
  ids: IdFactory;
  now: Clock;
  systemPrompt?: string;
}

export class TurnLoop {
  constructor(private readonly deps: TurnLoopDeps) {}

  async run(input: TurnLoopInput): Promise<TurnLoopResult> {
    const messages: ModelMessage[] = [
      {
        role: "system",
        content:
          this.deps.systemPrompt ?? "You are Confucius, a research agent.",
      },
      ...(input.history ?? []),
      { role: "user", content: input.userText },
    ];

    this.emit(input, "turn_started", { userText: input.userText });
    this.checkpoint(input.turnId, 0, messages);

    let delivered = "";

    const resultOf = (phase: TurnLoopResult["phase"]): TurnLoopResult => ({
      phase,
      text: delivered,
      messages: messages.slice(1),
    });

    try {
      while (this.deps.budget.canStartIteration()) {
        if (input.signal?.aborted) {
          this.emit(input, "turn_aborted", { reason: "signal" });
          return resultOf("aborted");
        }

        this.deps.budget.recordIteration();
        const modelTurn = await this.deps.model.complete(
          { messages, tools: this.deps.tools.listTools() },
          input.signal,
        );
        // Some adapters return a partial turn when a streaming request is
        // aborted after data has arrived. Do not deliver that stale response
        // or execute its tool calls after the caller has superseded it.
        if (input.signal?.aborted) {
          this.emit(input, "turn_aborted", { reason: "signal" });
          return resultOf("aborted");
        }

        if (modelTurn.reasoning && !modelTurn.streamed) {
          this.emit(input, "reasoning_delta", { text: modelTurn.reasoning });
        }
        if (modelTurn.text) {
          delivered += modelTurn.text;
          if (!modelTurn.streamed) {
            this.emit(input, "text_delta", { text: modelTurn.text });
          }
        }

        const toolCalls = modelTurn.toolCalls ?? [];
        messages.push({
          role: "assistant",
          content: modelTurn.text ?? "",
          toolCalls,
        });

        if (toolCalls.length === 0) {
          this.emit(input, "turn_completed", { phase: "done" });
          this.checkpoint(
            input.turnId,
            this.deps.budget.iterationsUsed,
            messages,
          );
          return resultOf("done");
        }

        const executed = await this.executeTools(input, toolCalls, messages);
        if (executed === "aborted") {
          this.emit(input, "turn_aborted", { reason: "signal" });
          return resultOf("aborted");
        }
        this.checkpoint(
          input.turnId,
          this.deps.budget.iterationsUsed,
          messages,
        );
      }

      this.emit(input, "turn_completed", { phase: "done" });
      return resultOf("done");
    } catch (error) {
      if (isAbortError(error)) {
        this.emit(input, "turn_aborted", { reason: "signal" });
        return resultOf("aborted");
      }
      this.emit(input, "turn_failed", { message: errorMessage(error) });
      return resultOf("failed");
    }
  }

  private async executeTools(
    input: TurnLoopInput,
    toolCalls: ModelToolCall[],
    messages: ModelMessage[],
  ): Promise<"ok" | "aborted"> {
    const allowed: ScheduledCall[] = [];

    for (const call of toolCalls) {
      // Model backends such as Ollama restart tool-call ids every round
      // (call_1, call_2, call_1, ...), which would collide across rounds and
      // fold several calls into one timeline entry. Emit host-unique event
      // ids; the model-facing message pairing below keeps the original id.
      const eventId = this.deps.ids();
      this.emit(input, "tool_requested", {
        callId: eventId,
        toolName: call.name,
        args: call.args,
      });

      if (!this.deps.budget.canRunTools(1)) {
        const result: ToolResult = {
          ok: false,
          toolName: call.name,
          code: "unavailable",
          message: "Tool budget exhausted",
        };
        this.emit(input, "tool_result", { callId: eventId, result });
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: call.id,
        });
        continue;
      }

      const decision = await this.deps.permissions.decide({
        sessionId: input.session.id,
        turnId: input.turnId,
        toolName: call.name,
        args: call.args,
        onRequest: (request) => {
          this.emit(input, "approval_required", { request });
        },
      });

      if (decision.resolution) {
        this.emit(input, "approval_resolved", {
          resolution: decision.resolution,
        });
      }
      if (decision.verdict === "deny") {
        const result: ToolResult = {
          ok: false,
          toolName: call.name,
          code: "permission_denied",
          message: "Tool call denied",
        };
        this.emit(input, "tool_result", { callId: eventId, result });
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: call.id,
        });
        continue;
      }

      const schema = this.deps.tools.getSchema(call.name);
      const invalid = validateArgs(call.name, schema, call.args);
      if (invalid) {
        this.emit(input, "tool_result", { callId: eventId, result: invalid });
        messages.push({
          role: "tool",
          content: JSON.stringify(invalid),
          toolCallId: call.id,
        });
        continue;
      }

      this.deps.budget.recordToolCalls(1);
      allowed.push({
        callId: eventId,
        modelCallId: call.id,
        toolName: call.name,
        args: call.args,
      });
    }

    const batches = splitBatches(allowed, (name) =>
      this.deps.tools.getMeta(name),
    );
    for (const batch of batches) {
      if (input.signal?.aborted) {
        return "aborted";
      }
      const results = await Promise.all(
        batch.map(async (call) => {
          const result = truncateToolResult(
            await this.deps.tools.call(call.toolName, call.args, input.signal),
          );
          return { call, result };
        }),
      );
      for (const { call, result } of results) {
        this.emit(input, "tool_result", { callId: call.callId, result });
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: call.modelCallId ?? call.callId,
        });
      }
    }

    return "ok";
  }

  private checkpoint(
    turnId: string,
    iteration: number,
    messages: ModelMessage[],
  ) {
    this.deps.checkpoints.save({
      turnId,
      iteration,
      messages: cloneValue(messages),
    });
  }

  private emit<T extends ConfuciusEvent["type"]>(
    input: TurnLoopInput,
    type: T,
    payload: Extract<ConfuciusEvent, { type: T }>["payload"],
  ): void {
    const event = {
      id: this.deps.ids(),
      sessionId: input.session.id,
      turnId: input.turnId,
      type,
      ts: this.deps.now(),
      payload,
    } as ConfuciusEvent;
    this.deps.events.append(event);
  }
}
