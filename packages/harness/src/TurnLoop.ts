import type {
  ConfuciusEvent,
  SessionRecord,
  ToolResult,
  ToolTransientMedia,
} from "@confucius/protocol";
import { BudgetAccountant } from "./BudgetAccountant";
import type {
  ToolExecutionCheckpoint,
  TurnCheckpoint,
} from "./CheckpointStore";
import { cloneValue } from "./clone";
import { splitBatches, type ScheduledCall } from "./ConcurrencyScheduler";
import type { MemoryEventLog } from "./EventLog";
import type { Clock, IdFactory } from "./ids";
import type { ModelAdapter, ModelMessage, ModelToolCall } from "./ModelAdapter";
import type { PermissionGate } from "./PermissionGate";
import { validateArgs } from "./SchemaValidate";
import type { ToolProvider } from "./ToolProvider";
import { abortError, errorMessage, isAbortError } from "./abort";
import { truncateToolResult } from "./truncate";

const DEFAULT_TRANSIENT_MEDIA_TIMEOUT_MS = 45_000;

export interface CheckpointStore {
  save(checkpoint: TurnCheckpoint): Promise<void> | void;
}

export interface TurnLoopInput {
  session: SessionRecord;
  turnId: string;
  /** User-authored text shown in the activity stream and durable logs. */
  userText: string;
  /**
   * Optional model-only form of the same turn (for example, with extracted
   * read-only attachments). It is checkpointed, but never emitted as UI text.
   */
  modelUserText?: string;
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
  /** Host-only failure detail used to retry an isolated workflow phase. */
  failureMessage?: string;
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
  /**
   * Optional host-side one-liner naming the object a tool call acts on;
   * stamped onto approval_required requests for the UI's default view.
   */
  describeCall?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => string | undefined;
  /** Deadline for the one model request that receives transient tool media. */
  transientMediaTimeoutMs?: number;
  /** Host-safe AbortController factory (Zotero sandboxes inject their own). */
  createAbortController?: () => AbortController;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
  transientMediaFallbackMessage?: (reason: "timeout" | "unavailable") => string;
  completionGuard?: (
    toolExecutions: readonly ToolExecutionCheckpoint[],
    messages: readonly ModelMessage[],
  ) => string | { instruction: string; statusText?: string } | undefined;
  completionGuardMaxReminders?: number;
  /**
   * Workflow completion calls must remain available after the exploratory
   * tool budget is spent. They are still bounded by the iteration budget.
   */
  completionToolNames?: ReadonlySet<string>;
  /** Injected once after exploratory calls hit their configured budget. */
  toolBudgetExhaustedMessage?: string;
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
      { role: "user", content: input.modelUserText ?? input.userText },
    ];

    const toolExecutions: ToolExecutionCheckpoint[] = [];

    this.emit(input, "turn_started", { userText: input.userText });
    await this.checkpoint(input.turnId, 0, messages, toolExecutions);

    let delivered = "";
    let completionGuardReminders = 0;

    const resultOf = (
      phase: TurnLoopResult["phase"],
      failureMessage?: string,
    ): TurnLoopResult => ({
      phase,
      text: delivered,
      messages: durableMessages(messages.slice(1)),
      ...(failureMessage ? { failureMessage } : {}),
    });

    try {
      while (this.deps.budget.canStartIteration()) {
        if (input.signal?.aborted) {
          this.emit(input, "turn_aborted", { reason: "signal" });
          return resultOf("aborted");
        }

        this.deps.budget.recordIteration();
        const modelTurn = await this.completeModelTurn(input, messages);
        removeTransientMessages(messages);
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
          const guarded =
            completionGuardReminders <
            (this.deps.completionGuardMaxReminders ?? 1)
              ? this.deps.completionGuard?.(toolExecutions, messages)
              : undefined;
          if (guarded) {
            completionGuardReminders += 1;
            const instruction =
              typeof guarded === "string" ? guarded : guarded.instruction;
            const statusText =
              typeof guarded === "string" ? undefined : guarded.statusText;
            messages.push({ role: "system", content: instruction });
            if (statusText) {
              this.emit(input, "reasoning_delta", { text: statusText });
            }
            await this.checkpoint(
              input.turnId,
              this.deps.budget.iterationsUsed,
              messages,
              toolExecutions,
            );
            continue;
          }
          this.emit(input, "turn_completed", { phase: "done" });
          await this.checkpoint(
            input.turnId,
            this.deps.budget.iterationsUsed,
            messages,
            toolExecutions,
          );
          return resultOf("done");
        }

        const executed = await this.executeTools(
          input,
          toolCalls,
          messages,
          toolExecutions,
        );
        if (executed === "aborted") {
          this.emit(input, "turn_aborted", { reason: "signal" });
          return resultOf("aborted");
        }
        await this.checkpoint(
          input.turnId,
          this.deps.budget.iterationsUsed,
          messages,
          toolExecutions,
        );
      }

      this.emit(input, "turn_completed", { phase: "done" });
      return resultOf("done");
    } catch (error) {
      if (isAbortError(error)) {
        this.emit(input, "turn_aborted", { reason: "signal" });
        return resultOf("aborted");
      }
      const failureMessage = errorMessage(error);
      this.emit(input, "turn_failed", { message: failureMessage });
      return resultOf("failed", failureMessage);
    }
  }

  private async completeModelTurn(
    input: TurnLoopInput,
    messages: ModelMessage[],
  ) {
    const tools = this.deps.tools.listTools();
    const hasTransientMedia = messages.some(
      (message) => message.transient && Boolean(message.images?.length),
    );
    try {
      return hasTransientMedia
        ? await this.completeWithTransientMediaDeadline(
            { messages, tools },
            input.signal,
          )
        : await this.deps.model.complete({ messages, tools }, input.signal);
    } catch (error) {
      // A user Stop owns the turn boundary. Never turn it into an automatic
      // text-only retry after the caller has explicitly cancelled the work.
      if (!hasTransientMedia || input.signal?.aborted) throw error;

      // Vision support varies across OpenAI-compatible and Ollama endpoints,
      // and a gateway can accept an image request without ever answering it.
      // Text anchors remain in the tool messages, so retry without the image.
      removeTransientMessages(messages);
      const fallbackReason =
        error instanceof TransientMediaTimeoutError
          ? ("timeout" as const)
          : ("unavailable" as const);
      this.emit(input, "reasoning_delta", {
        text:
          this.deps.transientMediaFallbackMessage?.(fallbackReason) ??
          (fallbackReason === "timeout"
            ? "Page-image analysis timed out. Retrying with the page text."
            : "Page-image analysis was unavailable. Retrying with the page text."),
      });
      return this.deps.model.complete({ messages, tools }, input.signal);
    }
  }

  private async completeWithTransientMediaDeadline(
    request: Parameters<ModelAdapter["complete"]>[0],
    callerSignal?: AbortSignal,
  ) {
    const controller =
      this.deps.createAbortController?.() ?? new AbortController();
    const timeoutMs = Math.max(
      1,
      this.deps.transientMediaTimeoutMs ?? DEFAULT_TRANSIENT_MEDIA_TIMEOUT_MS,
    );
    const schedule =
      this.deps.scheduleTimeout ??
      ((callback: () => void, delayMs: number) =>
        globalThis.setTimeout(callback, delayMs));
    const cancel =
      this.deps.cancelTimeout ??
      ((handle: unknown) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

    let rejectDeadline: (reason: unknown) => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const onCallerAbort = () => {
      controller.abort(abortError());
      rejectDeadline(abortError());
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = schedule(() => {
      rejectDeadline(new TransientMediaTimeoutError());
      controller.abort(abortError("Transient page image request timed out"));
    }, timeoutMs);

    try {
      if (callerSignal?.aborted) onCallerAbort();
      return await Promise.race([
        this.deps.model.complete(request, controller.signal),
        deadline,
      ]);
    } finally {
      cancel(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async executeTools(
    input: TurnLoopInput,
    toolCalls: ModelToolCall[],
    messages: ModelMessage[],
    toolExecutions: ToolExecutionCheckpoint[],
  ): Promise<"ok" | "aborted"> {
    const allowed: ScheduledCall[] = [];
    let toolBudgetExhausted = false;
    const availableToolNames = new Set(
      this.deps.tools.listTools().map((tool) => tool.name),
    );
    // A model may request several pages in one tool turn. Sending all rendered
    // pages in the next request can wedge otherwise healthy compatible APIs,
    // so keep exactly one visual page and preserve text anchors for the rest.
    let transientImageAttached = false;

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

      if (!availableToolNames.has(call.name)) {
        const result: ToolResult = {
          ok: false,
          toolName: call.name,
          code: "not_found",
          message:
            "Tool is not available in the active workflow stage. Follow the current stage instruction and use only the advertised tools.",
        };
        this.emit(input, "tool_result", { callId: eventId, result });
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: call.id,
        });
        continue;
      }

      const completionTool =
        this.deps.completionToolNames?.has(call.name) === true;
      if (!completionTool && !this.deps.budget.canRunTools(1)) {
        toolBudgetExhausted = true;
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
          request.summary =
            this.deps.describeCall?.(request.toolName, request.args) ??
            request.summary;
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

      const approvedArgs = decision.resolution?.editedArgs ?? call.args;
      const schema = this.deps.tools.getSchema(call.name);
      const invalid = validateArgs(call.name, schema, approvedArgs);
      if (invalid) {
        this.emit(input, "tool_result", { callId: eventId, result: invalid });
        messages.push({
          role: "tool",
          content: JSON.stringify(invalid),
          toolCallId: call.id,
        });
        continue;
      }

      if (!completionTool) {
        this.deps.budget.recordToolCalls(1);
      }
      allowed.push({
        callId: eventId,
        modelCallId: call.id,
        toolName: call.name,
        args: approvedArgs,
      });
    }

    const batches = splitBatches(allowed, (name) =>
      this.deps.tools.getMeta(name),
    );
    for (const batch of batches) {
      if (input.signal?.aborted) {
        return "aborted";
      }
      for (const call of batch) {
        toolExecutions.push({
          callId: call.callId,
          modelCallId: call.modelCallId,
          toolName: call.toolName,
          args: cloneValue(call.args),
          status: "started",
        });
      }
      // This write is deliberately awaited before touching the provider. If
      // the host dies after this point, restore can surface the call as
      // unknown instead of silently replaying a potentially mutating action.
      await this.checkpoint(
        input.turnId,
        this.deps.budget.iterationsUsed,
        messages,
        toolExecutions,
      );
      const rawResults = await Promise.all(
        batch.map(async (call) => {
          let result: ToolResult;
          let transientMedia: ToolTransientMedia[] = [];
          try {
            const raw = await this.deps.tools.call(
              call.toolName,
              call.args,
              input.signal,
            );
            transientMedia = raw.ok ? (raw.transientMedia ?? []) : [];
            result = durableToolResult(raw);
          } catch (error) {
            result = {
              ok: false,
              toolName: call.toolName,
              code: "internal",
              message: errorMessage(error),
            };
          }
          return { call, result, transientMedia };
        }),
      );
      const results = rawResults.map(({ call, result, transientMedia }) => {
        const acceptedMedia: ToolTransientMedia[] = [];
        let omittedMedia = false;
        for (const media of transientMedia) {
          if (!transientImageAttached) {
            transientImageAttached = true;
            acceptedMedia.push(media);
          } else {
            omittedMedia = true;
          }
        }
        const durable =
          omittedMedia && call.toolName === "inspect_pdf_page"
            ? markPageVisualOmitted(result)
            : result;
        return {
          call,
          result: truncateToolResult(durable),
          transientMedia: acceptedMedia,
        };
      });
      for (const { call, result } of results) {
        const execution = [...toolExecutions]
          .reverse()
          .find(
            (entry) =>
              entry.callId === call.callId && entry.status === "started",
          );
        if (execution) {
          execution.status = result.ok ? "completed" : "failed";
          execution.result = cloneValue(result);
        }
        this.emit(input, "tool_result", { callId: call.callId, result });
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: call.modelCallId ?? call.callId,
        });
      }
      for (const { transientMedia } of results) {
        for (const media of transientMedia) {
          messages.push({
            role: "user",
            content:
              media.description ??
              "Transient tool image. Ground visual claims in this image.",
            images: [media],
            transient: true,
          });
        }
      }
      await this.checkpoint(
        input.turnId,
        this.deps.budget.iterationsUsed,
        messages,
        toolExecutions,
      );
    }

    const budgetMessage = this.deps.toolBudgetExhaustedMessage?.trim();
    if (
      toolBudgetExhausted &&
      budgetMessage &&
      !messages.some(
        (message) =>
          message.role === "system" && message.content === budgetMessage,
      )
    ) {
      messages.push({ role: "system", content: budgetMessage });
    }

    return "ok";
  }

  private async checkpoint(
    turnId: string,
    iteration: number,
    messages: ModelMessage[],
    toolExecutions: ToolExecutionCheckpoint[],
  ): Promise<void> {
    await this.deps.checkpoints.save({
      turnId,
      iteration,
      savedAt: this.deps.now(),
      messages: cloneValue(durableMessages(messages)),
      toolExecutions: cloneValue(toolExecutions),
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

class TransientMediaTimeoutError extends Error {
  constructor() {
    super("Transient page image request timed out");
    this.name = "TransientMediaTimeoutError";
  }
}

function markPageVisualOmitted(result: ToolResult): ToolResult {
  if (!result.ok || !result.data || typeof result.data !== "object") {
    return result;
  }
  return {
    ...result,
    data: {
      ...(result.data as Record<string, unknown>),
      visualAvailable: false,
      visualOmitted: true,
      regionGuidance:
        "Only one PDF page image is sent per model round, so this page includes text anchors only. Do not guess image-region coordinates. Inspect this page in a later round if its image is needed.",
    },
  };
}

function durableToolResult(result: ToolResult): ToolResult {
  if (!result.ok || !result.transientMedia) return result;
  const { transientMedia: _transientMedia, ...durable } = result;
  return durable;
}

function durableMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages
    .filter((message) => !message.transient)
    .map((message) => {
      if (!message.images) return message;
      const { images: _images, transient: _transient, ...durable } = message;
      return durable;
    });
}

function removeTransientMessages(messages: ModelMessage[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].transient) messages.splice(index, 1);
    else if (messages[index].images) delete messages[index].images;
  }
}
