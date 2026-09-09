import { retryModelRequest } from "./ModelRetry";
import type { WindowContext } from "./WindowContext";
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
import {
  ModelError,
  type ModelAdapter,
  type ModelMessage,
  type ModelToolCall,
  type ModelTurn,
} from "./ModelAdapter";
import type { PermissionGate } from "./PermissionGate";
import { validateArgs, validateArgumentShape } from "./SchemaValidate";
import type { ToolProvider } from "./ToolProvider";
import { abortError, errorMessage, isAbortError } from "./abort";
import { budgetToolResult } from "./truncate";

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
  /** Resume a verified checkpoint without resetting budgets or write records. */
  resume?: TurnCheckpoint;
  signal?: AbortSignal;
}

export type TurnStopReason =
  | "model_retries_exhausted"
  | "completed"
  | "iteration_budget"
  | "tool_budget"
  | "token_budget"
  | "time_budget"
  | "length"
  | "content_filter"
  | "incomplete"
  | "stalled"
  | "guard_rejected"
  | "aborted"
  | "error";

export interface TurnLoopResult {
  stopReason: TurnStopReason;
  phase: "done" | "failed" | "aborted";
  text: string;
  /** Final conversation of this turn (system prompt excluded) for persistence. */
  messages: ModelMessage[];
  /** Host-only failure detail used to retry an isolated workflow phase. */
  failureMessage?: string;
}

export interface TurnLoopDeps {
  maxModelRecoveries?: number;
  maxLengthContinuations?: number;
  stallLimit?: number;
  context?: WindowContext;
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
  private modelRequest?: import("@confucius/protocol").ModelRequestProgress;
  constructor(private readonly deps: TurnLoopDeps) {}

  async run(input: TurnLoopInput): Promise<TurnLoopResult> {
    // The host execution journal protects unresolved writes while allowing read-only reconciliation.
    if (input.resume)
      this.deps.budget.restoreMax(
        input.resume.budget ?? {
          iterationsUsed: input.resume.iteration,
          toolCallsUsed:
            input.resume.toolCallsUsed ??
            input.resume.toolExecutions.filter(
              (call) => !this.deps.completionToolNames?.has(call.toolName),
            ).length,
        },
      );
    const messages: ModelMessage[] = [
      {
        role: "system",
        content:
          this.deps.systemPrompt ?? "You are Confucius, a research agent.",
      },
      ...(input.resume
        ? (cloneValue(input.resume.messages.slice(1)) as ModelMessage[])
        : (input.history ?? [])),
      { role: "user", content: input.modelUserText ?? input.userText },
    ];

    closeToolGroups(messages, input.resume?.toolExecutions ?? []);
    this.deps.context?.start(input, messages);
    const toolExecutions: ToolExecutionCheckpoint[] = cloneValue(
      input.resume?.toolExecutions ?? [],
    );

    this.emit(input, "turn_started", { userText: input.userText });
    await this.checkpoint(
      input.turnId,
      this.deps.budget.iterationsUsed,
      messages,
      toolExecutions,
    );

    let delivered = "";
    let completionGuardReminders = 0;
    let modelRecoveries = 0;
    let lengthContinuations = 0;
    let toolLimited = false;
    let lastFingerprint = "";
    let repeated = 0;
    let stopReason: TurnStopReason = "completed";

    const resultOf = (
      phase: TurnLoopResult["phase"],
      failureMessage?: string,
    ): TurnLoopResult => {
      closeToolGroups(messages, toolExecutions);
      return {
        phase,
        stopReason:
          phase === "aborted"
            ? "aborted"
            : phase === "failed" && stopReason === "completed"
              ? "error"
              : stopReason,
        text: delivered,
        messages: durableMessages(messages.slice(1)),
        ...(failureMessage ? { failureMessage } : {}),
      };
    };

    try {
      while (this.deps.budget.canStartIteration()) {
        if (input.signal?.aborted) {
          this.emit(input, "turn_aborted", { reason: "signal" });
          return resultOf("aborted");
        }

        await this.deps.context?.prepare(
          messages,
          this.deps.tools.listTools(),
          input.signal,
        );
        if (input.signal?.aborted) {
          this.emit(input, "turn_aborted", { reason: "signal" });
          return resultOf("aborted");
        }
        // Persist the charged iteration before sending a request so stopping
        // or restarting during that request does not replenish its budget.
        await this.checkpoint(
          input.turnId,
          this.deps.budget.iterationsUsed,
          messages,
          toolExecutions,
        );
        const onAttempt = async () => {
          const reason = this.deps.budget.exhaustedReason();
          if (reason)
            throw new TurnStopError(
              reason,
              `Run ${reason.replaceAll("_", " ")} exhausted`,
            );
          this.deps.budget.recordIteration();
          this.deps.budget.recordModelAttempt();
          await this.checkpoint(
            input.turnId,
            this.deps.budget.iterationsUsed,
            messages,
            toolExecutions,
          );
        };
        let modelTurn: ModelTurn;
        try {
          modelTurn = await this.completeModelTurn(input, messages, onAttempt);
        } catch (error) {
          if (error instanceof ModelError) {
            this.deps.budget.recordUsage(error.options.partial?.usage);
            if (error.options.exhausted) stopReason = "model_retries_exhausted";
            if (
              error.code === "context_overflow" &&
              this.deps.context &&
              !input.signal?.aborted &&
              modelRecoveries < (this.deps.maxModelRecoveries ?? 2)
            ) {
              modelRecoveries++;
              this.deps.context.request();
              continue;
            }
            if (
              !error.options.exhausted &&
              (error.options.partial !== undefined || error.code === "protocol")
            )
              stopReason = "incomplete";
          }
          throw error;
        }
        modelRecoveries = 0;
        this.deps.budget.recordUsage(modelTurn.usage);
        await this.deps.context?.provided();
        this.deps.context?.usage(modelTurn.usage);
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

        const end =
          modelTurn.end ??
          (modelTurn.toolCalls?.length ? "tool_calls" : "stop");
        if (
          end === "stop" &&
          !modelTurn.text?.trim() &&
          !modelTurn.toolCalls?.length
        )
          throw new TurnStopError(
            "incomplete",
            "Model returned no answer or tool call",
          );
        const toolCalls =
          end === "tool_calls" || end === "stop"
            ? (modelTurn.toolCalls ?? [])
            : [];
        messages.push({
          role: "assistant",
          content: modelTurn.text ?? "",
          toolCalls,
          replayState: modelTurn.replayState,
        });
        const pressure = this.deps.budget.exhaustedReason();
        if (pressure === "token_budget" || pressure === "time_budget")
          throw new TurnStopError(
            pressure,
            `Run ${pressure.replaceAll("_", " ")} exhausted`,
          );

        if (end === "aborted") {
          stopReason = "aborted";
          this.emit(input, "turn_aborted", { reason: "model" });
          return resultOf("aborted");
        }
        if (
          end === "length" &&
          !modelTurn.toolCalls?.length &&
          modelTurn.text &&
          lengthContinuations < (this.deps.maxLengthContinuations ?? 1)
        ) {
          lengthContinuations++;
          messages.push({
            role: "system",
            content:
              "The previous answer reached its output limit. Continue from its end and finish the remaining work. Do not repeat previous content.",
          });
          await this.checkpoint(
            input.turnId,
            this.deps.budget.iterationsUsed,
            messages,
            toolExecutions,
          );
          continue;
        }
        if (
          end === "length" ||
          end === "content_filter" ||
          end === "incomplete"
        )
          throw new TurnStopError(end, `Model response ended with ${end}`);
        if (end === "tool_calls" && toolCalls.length === 0)
          throw new TurnStopError(
            "incomplete",
            "Model declared tool calls without complete calls",
          );
        if (toolCalls.length === 0) {
          const guarded = this.deps.completionGuard?.(toolExecutions, messages);
          if (
            guarded &&
            completionGuardReminders >=
              (this.deps.completionGuardMaxReminders ?? 1)
          )
            throw new TurnStopError(
              "guard_rejected",
              "Completion evidence is still missing after bounded correction",
            );
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
          if (toolLimited)
            throw new TurnStopError(
              "tool_budget",
              "Required tool work exceeded the run tool budget",
            );
          this.emit(input, "turn_completed", { phase: "done" });
          await this.checkpoint(
            input.turnId,
            this.deps.budget.iterationsUsed,
            messages,
            toolExecutions,
          );
          return resultOf("done");
        }

        const beforeTools = messages.length;
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
        toolLimited ||= executed === "tool_budget";
        const fingerprint =
          canonicalArguments(
            toolCalls
              .map((call) => ({ name: call.name, args: call.args }))
              .sort((a, b) =>
                canonicalArguments(a).localeCompare(canonicalArguments(b)),
              ),
          ) +
          canonicalArguments(
            messages
              .slice(beforeTools)
              .filter((message) => message.role === "tool")
              .map((message) => message.content)
              .sort(),
          );
        repeated = fingerprint === lastFingerprint ? repeated + 1 : 1;
        lastFingerprint = fingerprint;
        if (repeated >= Math.max(2, this.deps.stallLimit ?? 4))
          throw new TurnStopError(
            "stalled",
            "Repeated tool calls returned unchanged results; a different approach or user input is needed",
          );
        if (repeated === 2)
          messages.push({
            role: "system",
            content:
              "These tool calls returned unchanged results twice. Change your approach, inspect the reported problem, or report the concrete blocker; do not repeat the same calls.",
          });
        await this.checkpoint(
          input.turnId,
          this.deps.budget.iterationsUsed,
          messages,
          toolExecutions,
        );
      }
      throw new TurnStopError(
        this.deps.budget.exhaustedReason() ?? "iteration_budget",
        "Run budget exhausted before completion",
      );
    } catch (error) {
      try {
        await this.checkpoint(
          input.turnId,
          this.deps.budget.iterationsUsed,
          messages,
          toolExecutions,
        );
      } catch (storageError) {
        if (errorMessage(storageError) !== errorMessage(error))
          error = new Error(
            `${errorMessage(error)}; checkpoint could not be saved: ${errorMessage(storageError)}`,
          );
      }
      if (input.signal?.aborted || isAbortError(error)) {
        this.emit(input, "turn_aborted", { reason: "signal" });
        return resultOf("aborted");
      }
      if (error instanceof TurnStopError) stopReason = error.stopReason;
      const failureMessage = errorMessage(error);
      this.emit(input, "turn_failed", { message: failureMessage });
      return resultOf("failed", failureMessage);
    }
  }

  private async completeModelTurn(
    input: TurnLoopInput,
    messages: ModelMessage[],
    onAttempt: () => Promise<void>,
  ) {
    const tools = this.deps.tools.listTools();
    const hasTransientMedia = messages.some(
      (message) => message.transient && Boolean(message.images?.length),
    );
    const onRequestProgress = async (
      progress: import("@confucius/protocol").ModelRequestProgress,
    ) => {
      this.modelRequest = progress;
      this.emit(input, "model_request_progress", progress);
    };
    const makeRequest = () => ({
      ...(this.deps.model.handlesRetries ? { onRequestProgress } : {}),
      messages,
      tools,
      ...(this.deps.model.accountsAttempts ? { onAttempt } : {}),
      deadlineMs: this.deps.budget.remainingElapsedMs(),
    });
    try {
      if (!this.deps.model.handlesRetries) {
        return await retryModelRequest(
          async () => {
            if (!this.deps.model.accountsAttempts) await onAttempt();
            return hasTransientMedia
              ? this.completeWithTransientMediaDeadline(
                  makeRequest(),
                  input.signal,
                )
              : this.deps.model.complete(makeRequest(), input.signal);
          },
          { ...this.deps, signal: input.signal, onProgress: onRequestProgress },
        );
      }
      return hasTransientMedia
        ? await this.completeWithTransientMediaDeadline(
            makeRequest(),
            input.signal,
          )
        : await this.deps.model.complete(makeRequest(), input.signal);
    } catch (error) {
      // A user Stop owns the turn boundary. Never turn it into an automatic
      // text-only retry after the caller has explicitly cancelled the work.
      if (
        !hasTransientMedia ||
        input.signal?.aborted ||
        error instanceof TurnStopError ||
        (error instanceof ModelError &&
          (error.code === "auth" || error.options.partial?.text))
      )
        throw error;

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
      if (!this.deps.model.accountsAttempts) await onAttempt();
      return this.deps.model.complete(makeRequest(), input.signal);
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

  private checkEffectBudget(): void {
    const reason = this.deps.budget.exhaustedReason();
    if (reason === "token_budget" || reason === "time_budget")
      throw new TurnStopError(
        reason,
        `Run ${reason.replaceAll("_", " ")} exhausted before tool execution`,
      );
  }

  private async executeTools(
    input: TurnLoopInput,
    toolCalls: ModelToolCall[],
    messages: ModelMessage[],
    toolExecutions: ToolExecutionCheckpoint[],
  ): Promise<"ok" | "aborted" | "tool_budget"> {
    const allowed: ScheduledCall[] = [];
    let toolBudgetExhausted = false;
    const availableToolNames = new Set(
      this.deps.tools.listTools().map((tool) => tool.name),
    );
    // A model may request several pages in one tool turn. Sending all rendered
    // pages in the next request can wedge otherwise healthy compatible APIs,
    // so keep exactly one visual page and preserve text anchors for the rest.
    let transientImageAttached = false;

    for (const requestedCall of toolCalls) {
      // Preparation may expand a proposal ID into an approved concrete batch.
      // Keep that execution payload out of the model's original conversation.
      const call = cloneValue(requestedCall);
      if (input.signal?.aborted) return "aborted";
      this.checkEffectBudget();
      // Model backends such as Ollama restart tool-call ids every round
      // (call_1, call_2, call_1, ...), which would collide across rounds and
      // fold several calls into one timeline entry. Emit host-unique event
      // ids; the model-facing message pairing below keeps the original id.
      const eventId = this.deps.ids();
      this.emit(input, "tool_requested", {
        callId: eventId,
        toolName: call.name,
        args: cloneValue(requestedCall.args),
      });

      if (!availableToolNames.has(call.name)) {
        const result: ToolResult = {
          ok: false,
          toolName: call.name,
          code: "not_found",
          message:
            "Tool is not available to this task. Use an advertised tool that can perform the remaining work.",
        };
        this.emit(input, "tool_result", { callId: eventId, result });
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: call.id,
        });
        continue;
      }

      const shapeError: ToolResult | null = call.argumentsError
        ? {
            ok: false,
            toolName: call.name,
            code: "invalid_args",
            effect: "none",
            retryable: false,
            message: call.argumentsError,
          }
        : validateArgumentShape(call.name, call.args);
      if (shapeError) {
        this.emit(input, "tool_result", {
          callId: eventId,
          result: shapeError,
        });
        messages.push({
          role: "tool",
          content: JSON.stringify(shapeError),
          toolCallId: call.id,
        });
        continue;
      }

      // A continuation can recover a completed write's recorded response.
      // It must not execute that same write again merely to reconstruct context.
      const priorWrite = this.deps.tools.getMeta(call.name)?.mutatesState
        ? input.resume?.toolExecutions.find(
            (entry) =>
              entry.toolName === call.name &&
              entry.status === "completed" &&
              entry.result &&
              entry.modelCallId === call.id &&
              (entry.result as ToolResult).effect !== "unknown" &&
              canonicalArguments(entry.requestedArgs ?? entry.args) ===
                canonicalArguments(call.args),
          )
        : undefined;
      if (priorWrite) {
        const result = priorWrite.result as ToolResult;
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

      const prepareContext: import("@confucius/protocol").ToolExecutionContext =
        {
          taskId: input.session.id,
          signal: input.signal,
          turnId: input.turnId,
          operationId: `${input.session.id}:${input.turnId}:${eventId}`,
          onProgress: (progress) =>
            this.emit(input, "tool_progress", {
              callId: eventId,
              message: `${progress.stage} · ${Math.floor(progress.elapsedMs / 1000)}s`,
            }),
        };
      const beforeApproval =
        (await this.deps.tools.prepare?.(
          call.name,
          call.args,
          prepareContext,
        )) ??
        validateArgs(
          call.name,
          this.deps.tools.getSchema(call.name),
          call.args,
        );
      if (beforeApproval) {
        this.emit(input, "tool_result", {
          callId: eventId,
          result: beforeApproval,
        });
        messages.push({
          role: "tool",
          content: JSON.stringify(beforeApproval),
          toolCallId: call.id,
        });
        continue;
      }
      if (prepareContext.replayResult) {
        this.emit(input, "tool_result", {
          callId: eventId,
          result: prepareContext.replayResult,
        });
        messages.push({
          role: "tool",
          content: JSON.stringify(prepareContext.replayResult),
          toolCallId: call.id,
        });
        continue;
      }
      if (input.signal?.aborted) return "aborted";
      let decision: Awaited<ReturnType<PermissionGate["decide"]>>;
      prepareContext.executionScope?.pause?.();
      try {
        decision = await this.deps.permissions.decide({
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
      } finally {
        prepareContext.executionScope?.resume?.();
      }

      if (decision.resolution) {
        this.emit(input, "approval_resolved", {
          resolution: decision.resolution,
        });
      }
      if (decision.verdict === "deny") {
        await this.deps.tools.recordDenied?.(
          call.name,
          call.args,
          prepareContext,
        );
        const result: ToolResult = {
          ok: false,
          toolName: call.name,
          code: "permission_denied",
          effect: "none",
          retryable: false,
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
        requestedArgs: cloneValue(requestedCall.args),
      });
    }

    const batches = splitBatches(allowed, (name) =>
      this.deps.tools.getMeta(name),
    );
    for (const batch of batches) {
      this.checkEffectBudget();
      if (input.signal?.aborted) {
        return "aborted";
      }
      for (const call of batch) {
        toolExecutions.push({
          callId: call.callId,
          modelCallId: call.modelCallId,
          toolName: call.toolName,
          args: cloneValue(call.args),
          requestedArgs: cloneValue(call.requestedArgs),
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
      const outputBudgetTokens = this.deps.context?.readBudget(
        messages,
        batch.length,
      );
      const rawResults = await Promise.all(
        batch.map(async (call) => {
          let result: ToolResult;
          let transientMedia: ToolTransientMedia[] = [];
          let observedWriteFailure = false;
          try {
            const raw = await this.deps.tools.call(
              call.toolName,
              call.args,
              input.signal,
              {
                outputBudgetTokens,
                taskId: input.session.id,
                turnId: input.turnId,
                operationId: `${input.session.id}:${input.turnId}:${call.callId}`,
                onProgress: (progress) =>
                  this.emit(input, "tool_progress", {
                    callId: call.callId,
                    message: `${progress.stage} · ${Math.floor(progress.elapsedMs / 1000)}s`,
                  }),
              },
            );
            if (
              !raw.ok &&
              raw.effect === undefined &&
              raw.code === "internal" &&
              this.deps.tools.getMeta(call.toolName)?.mutatesState
            ) {
              observedWriteFailure = true;
              await this.deps.context?.toolResult(
                call.callId,
                call.toolName,
                JSON.stringify(raw),
                call.args,
                call.modelCallId,
              );
              throw new Error(
                `The outcome of ${call.toolName} is unknown: ${raw.message}. Verify the write before retrying.`,
              );
            }
            transientMedia = raw.ok ? (raw.transientMedia ?? []) : [];
            result = durableToolResult(raw);
          } catch (error) {
            if (this.deps.tools.getMeta(call.toolName)?.mutatesState) {
              if (!observedWriteFailure)
                await this.deps.context?.toolResult(
                  call.callId,
                  call.toolName,
                  JSON.stringify({
                    outcome: "unknown",
                    error: errorMessage(error),
                  }),
                  call.args,
                  call.modelCallId,
                );
              throw error;
            }
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
      // Persist complete results before truncating model input. A failed journal write
      // leaves the last checkpoint's started call unresolved, preventing blind replay.
      const archived = new Map<
        string,
        import("@confucius/protocol").HistoryItemRef
      >();
      for (const { call, result } of rawResults) {
        const ref = await this.deps.context?.toolResult(
          call.callId,
          call.toolName,
          JSON.stringify(result),
          call.args,
          call.modelCallId,
        );
        if (ref) archived.set(call.callId, ref);
      }
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
          result: budgetToolResult(
            durable,
            outputBudgetTokens,
            archived.get(call.callId),
          ),
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
      for (const { call, transientMedia } of results) {
        for (const media of transientMedia) {
          messages.push({
            role: "user",
            content:
              media.description ??
              "Transient tool image. Ground visual claims in this image.",
            images: [media],
            sourceToolCallId: call.modelCallId ?? call.callId,
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

    return toolBudgetExhausted && !this.deps.completionToolNames?.size
      ? "tool_budget"
      : "ok";
  }

  private async checkpoint(
    turnId: string,
    iteration: number,
    messages: ModelMessage[],
    toolExecutions: ToolExecutionCheckpoint[],
  ): Promise<void> {
    await this.deps.context?.record({
      turnId,
      iteration,
      budget: this.deps.budget.snapshot(),
      toolCallsUsed: this.deps.budget.toolCallsUsed,
      modelRequest: this.modelRequest,
      savedAt: this.deps.now(),
      messages,
      toolExecutions,
    });
    await this.deps.checkpoints.save({
      sourceReads: this.deps.context?.sourceReadSnapshot(),
      window: this.deps.context?.window,
      turnId,
      iteration,
      budget: this.deps.budget.snapshot(),
      toolCallsUsed: this.deps.budget.toolCallsUsed,
      modelRequest: this.modelRequest,
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

function canonicalArguments(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalArguments).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalArguments(item)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
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

class TurnStopError extends ModelError {
  constructor(
    readonly stopReason: TurnStopReason,
    message: string,
  ) {
    super(message, "invalid_request");
  }
}
/** Keep model history protocol-valid after cancellation or a failed tool batch.
 * This only repairs the conversation; it never resolves an execution journal.
 */
function closeToolGroups(
  messages: ModelMessage[],
  executions: readonly ToolExecutionCheckpoint[],
): void {
  const repaired: ModelMessage[] = [];
  let pending: ModelToolCall[] = [];
  const flush = () => {
    for (const call of pending) {
      const execution = [...executions]
        .reverse()
        .find(
          (entry) =>
            entry.modelCallId === call.id &&
            entry.toolName === call.name &&
            canonicalArguments(entry.requestedArgs ?? entry.args) ===
              canonicalArguments(call.args),
        );
      repaired.push({
        role: "tool",
        toolCallId: call.id,
        // Call ids may be reused by compatible models across rounds. A
        // matching old receipt is not proof this pending proposal executed.
        content: JSON.stringify({
          ok: false,
          toolName: call.name,
          code: "internal",
          effect: execution ? "unknown" : "none",
          retryable: false,
          message: execution
            ? "Execution was interrupted; reconcile its journal before retrying."
            : "The turn stopped before this tool was executed.",
        }),
      });
    }
    pending = [];
  };
  for (const message of messages) {
    if (message.role === "tool")
      pending = pending.filter((call) => call.id !== message.toolCallId);
    else flush();
    repaired.push(message);
    if (message.role === "assistant") pending = [...(message.toolCalls ?? [])];
  }
  flush();
  messages.splice(0, messages.length, ...repaired);
}
