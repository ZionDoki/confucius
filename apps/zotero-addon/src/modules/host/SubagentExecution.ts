import {
  MemoryEventLog,
  PermissionGate,
  TurnLoop,
  WindowContext,
  type ModelAdapter,
} from "@confucius/harness";
import { contextTextSlice } from "@confucius/protocol";
import type { AgentBackend } from "./AgentBackend";
import { SUBAGENT_INSTRUCTIONS } from "@confucius/protocol";
import type { SubagentRun } from "./SubagentManager";
import { createAbortController } from "../../utils/webPlatform";

export async function executeNativeSubagent(
  run: SubagentRun,
  model: ModelAdapter,
) {
  let next = 0;
  const ids = () => `${run.task.run!.id}_${run.task.run!.generation}_${++next}`;
  const events = new MemoryEventLog();
  events.append = (event) => run.event(event);
  const context = new WindowContext({
    window: run.task.contextWindow!,
    contextWindowTokens: run.capacity,
    maxOutputTokens: run.maxOutput,
    nextId: ids,
    archive: async ({ id, windowId, message }) => {
      const ref = { taskId: run.task.id, windowId, itemId: id };
      run.document.archive[`h:${ref.taskId}:${windowId}:${id}`] =
        JSON.stringify(message, (key, value) =>
          key === "images" || key === "transient" ? undefined : value,
        );
      return ref;
    },
    switchWindow: async (window, checkpoint) => {
      run.task.contextWindow = window;
      run.document.checkpoint = checkpoint;
      await run.save();
    },
    hint: async () =>
      contextTextSlice(
        `Goal: ${run.document.record.goal}\nSources: ${JSON.stringify(run.task.lockedContext)}\nCurrent result: ${run.document.record.result}`,
        2000,
      ).content,
  });
  const delivered = new Set<string>();
  const observedModel: ModelAdapter = {
    complete: async (request, signal) => {
      for (const message of request.messages)
        if (
          message.role === "tool" &&
          message.toolCallId &&
          !delivered.has(message.toolCallId)
        ) {
          delivered.add(message.toolCallId);
          let value: import("@confucius/protocol").ToolResult | undefined;
          try {
            value = JSON.parse(message.content);
          } catch {
            /* Non-structured excerpts are not evidence receipts. */
          }
          if (value) await run.delivered?.(value);
        }
      return model.complete(request, signal);
    },
  };
  const loop = new TurnLoop({
    context,
    model: observedModel,
    tools: run.tools,
    budget: run.budget,
    events,
    ids,
    now: Date.now,
    systemPrompt: SUBAGENT_INSTRUCTIONS,
    permissions: new PermissionGate({
      ids,
      now: Date.now,
      modeFor: (name) =>
        run.tools.getMeta(name)?.mutatesState === false ? "auto_allow" : "deny",
      riskFor: () => "read",
    }),
    checkpoints: {
      save: async (checkpoint) => {
        run.document.checkpoint = checkpoint;
        await run.save();
      },
    },
    createAbortController,
  });
  const result = await loop.run({
    session: run.task,
    turnId: run.task.run!.id,
    userText: run.document.record.goal,
    modelUserText: run.prompt,
    resume: run.document.checkpoint,
    signal: run.abort.signal,
  });
  await run.save();
  return {
    text: result.text,
    error:
      result.stopReason === "completed"
        ? undefined
        : (result.failureMessage ??
          `Research subagent stopped: ${result.stopReason}`),
  };
}

export async function executeExternalSubagent(
  run: SubagentRun,
  backend: AgentBackend,
): Promise<{ text: string; error?: string }> {
  let finish!: (value: { text: string; error?: string }) => void;
  const result = new Promise<{ text: string; error?: string }>((resolve) => {
    finish = resolve;
  });
  const cancel = () =>
    finish({
      text: run.document.record.result,
      error: "Research subagent interrupted",
    });
  run.abort.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    run.abort.abort();
  }, 10 * 60_000);
  try {
    if (run.abort.signal.aborted)
      return { text: "", error: "Research subagent interrupted" };
    const start = backend
      .startTurn(
        {
          task: run.task,
          turnId: run.task.run!.id,
          prompt: run.prompt,
          mode: "plan",
          capabilityProfile: "zotero_only",
          workflowInstruction: SUBAGENT_INSTRUCTIONS,
          includeArtifactGuidance: false,
        },
        {
          handle: () => {},
          disconnected: (error) =>
            finish({ text: run.document.record.result, error: error.message }),
          event: (event) => {
            if (event.turnId !== run.task.run!.id) return;
            run.event(event);
            // These events stay in this manager and never reach AgentHost listeners.
            if (event.type === "turn_completed")
              finish({ text: run.document.record.result });
            else if (event.type === "turn_failed")
              finish({
                text: run.document.record.result,
                error: event.payload.message,
              });
            else if (event.type === "turn_aborted") cancel();
          },
        },
      )
      .then((handle) => {
        if (handle.superseded) cancel();
      })
      .catch((error) => {
        finish({ text: run.document.record.result, error: String(error) });
      });
    // Startup may itself wait for a provider. Cancellation must also end that wait.
    const completed = await result;
    void start;
    return completed;
  } finally {
    clearTimeout(timer);
    run.abort.signal.removeEventListener("abort", cancel);
    await backend.dispose(run.task.id).catch(() => undefined);
  }
}
