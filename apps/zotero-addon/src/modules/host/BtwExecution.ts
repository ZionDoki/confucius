import {
  MemoryEventLog,
  PermissionGate,
  TurnLoop,
  WindowContext,
  type ModelAdapter,
} from "@confucius/harness";
import { contextTextSlice } from "@confucius/protocol";
import type { AgentBackend } from "./AgentBackend";
import { BTW_INSTRUCTIONS, type BtwRun } from "./BtwManager";
import { createAbortController } from "../../utils/webPlatform";

export async function executeNativeBtw(run: BtwRun, model: ModelAdapter) {
  let next = 0;
  const ids = () => `${run.turn.id}_${++next}`;
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
        `This is an isolated read-only btw question. Selected source: ${JSON.stringify(run.turn.selection)}\nCurrent answer: ${run.turn.answer}`,
        2000,
      ).content,
  });
  const loop = new TurnLoop({
    context,
    model,
    tools: run.tools,
    budget: run.budget,
    events,
    ids,
    now: Date.now,
    systemPrompt: BTW_INSTRUCTIONS,
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
    turnId: run.turn.id,
    userText: run.turn.prompt,
    modelUserText: run.prompt,
    signal: run.abort.signal,
  });
  return {
    text: result.text,
    error:
      result.stopReason === "completed"
        ? undefined
        : (result.failureMessage ?? `Btw stopped: ${result.stopReason}`),
  };
}

export async function executeExternalBtw(
  run: BtwRun,
  backend: AgentBackend,
): Promise<{ text: string; error?: string }> {
  let finish!: (value: { text: string; error?: string }) => void;
  const result = new Promise<{ text: string; error?: string }>((resolve) => {
    finish = resolve;
  });
  const cancel = () =>
    finish({ text: run.turn.answer, error: "Btw interrupted" });
  run.abort.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    run.abort.abort();
  }, 10 * 60_000);
  try {
    if (run.abort.signal.aborted) return { text: "", error: "Btw interrupted" };
    const start = backend
      .startTurn(
        {
          task: run.task,
          turnId: run.turn.id,
          prompt: run.prompt,
          mode: "plan",
          capabilityProfile: "zotero_only",
          workflowInstruction: BTW_INSTRUCTIONS,
          includeArtifactGuidance: false,
        },
        {
          handle: () => {},
          disconnected: (error) =>
            finish({ text: run.turn.answer, error: error.message }),
          event: (event) => {
            if (event.turnId !== run.turn.id) return;
            run.event(event);
            // These events stay in this manager and never reach AgentHost listeners.
            if (event.type === "turn_completed")
              finish({ text: run.turn.answer });
            else if (event.type === "turn_failed")
              finish({ text: run.turn.answer, error: event.payload.message });
            else if (event.type === "turn_aborted") cancel();
          },
        },
      )
      .then((handle) => {
        if (handle.superseded) cancel();
      })
      .catch((error) => {
        finish({ text: run.turn.answer, error: String(error) });
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
