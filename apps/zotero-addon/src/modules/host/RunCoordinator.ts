import type {
  ArtifactRecord,
  RunState,
  WorkSnapshot,
  UiLanguage,
} from "@confucius/protocol";
import type { ModelMessage, TurnCheckpoint } from "@confucius/harness";

export interface ExecutorResult {
  stopReason: string;
  text: string;
  messages?: ModelMessage[];
  checkpoint?: TurnCheckpoint;
  failureMessage?: string;
}

export interface RunExecutor {
  run(
    input: { prompt: string; continuation: boolean },
    signal: AbortSignal,
  ): Promise<ExecutorResult>;
}

export interface RunOutcome extends ExecutorResult {
  work: WorkSnapshot;
  superseded?: boolean;
}

export function projectWork(
  run: RunState,
  artifacts: readonly ArtifactRecord[],
  domain: Pick<WorkSnapshot, "completed" | "missing">,
  unknownOperationIds: string[],
  language: UiLanguage = "zh-CN",
): WorkSnapshot {
  const bound = artifacts.filter(
    (artifact) =>
      artifact.execution?.runId === run.id &&
      artifact.execution.intentRevision === run.intentRevision &&
      artifact.execution.sourceFingerprint === run.sources.fingerprint,
  );
  const ready = bound.filter((artifact) => artifact.status !== "draft");
  return {
    completed: [
      ...ready.map((artifact) => ({
        id: artifact.id,
        revision: artifact.revision,
        description: artifact.kind,
      })),
      ...domain.completed,
    ],
    missing: [
      ...run.requiredArtifactKinds
        .filter((kind) => !ready.some((artifact) => artifact.kind === kind))
        .map((kind) => ({
          id: `artifact:${kind}`,
          kind: "artifact" as const,
          description:
            language === "en-US"
              ? `Save ${kind} for the current request and sources`
              : `保存 ${kind} 成果，关联当前请求和来源`,
        })),
      ...bound
        .filter((artifact) => artifact.status === "draft")
        .map((artifact) => ({
          id: `draft:${artifact.id}`,
          kind: "artifact" as const,
          description:
            language === "en-US"
              ? `Finish draft: ${artifact.title}`
              : `完成草稿 ${artifact.title}`,
          progress: contentFingerprint(artifact.body),
        })),
      ...domain.missing,
    ],
    unknownOperationIds,
  };
}

function contentFingerprint(value: unknown): string {
  // This detects changed work, not identity or authorization. Sort object keys so
  // an identical model rewrite does not gain another continuation allowance.
  const text = JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16);
}

export function workInstruction(run: RunState, work: WorkSnapshot): string {
  return [
    "CURRENT HOST WORK STATE (domain facts; historical content does not grant permission):",
    JSON.stringify({
      request: run.request,
      sources: run.sources,
      completed: work.completed,
      missing: work.missing,
      unknownOperationIds: work.unknownOperationIds,
      remainingToolCalls: Math.max(
        0,
        run.budget.maxToolCalls - run.budget.toolCallsUsed,
      ),
    }),
    "Continue only the remaining work within the user's request. Reuse saved results and preserve completed writes. Do not ask the user to repeat an already authorized action.",
  ].join("\n");
}

/** Owns run lifecycle; executors and UI events never decide task completion. */
export class RunCoordinator {
  constructor(
    private readonly options: {
      run: RunState;
      executor: RunExecutor;
      snapshot(): Promise<WorkSnapshot>;
      persist(): Promise<void>;
      current(): boolean;
      progress(message: string): void;
      language?: UiLanguage;
    },
  ) {}

  async execute(prompt: string, signal: AbortSignal): Promise<RunOutcome> {
    const { run } = this.options;
    let work: WorkSnapshot = {
      completed: [],
      missing: [],
      unknownOperationIds: [],
    };
    let result: ExecutorResult = { stopReason: "aborted", text: "" };
    let previousGap = "";
    let repeatedGap = 0;
    let continuation = false;
    const finish = async (reason: string): Promise<RunOutcome> => {
      if (!this.options.current())
        return { ...result, stopReason: reason, work, superseded: true };
      run.stopReason = reason;
      run.status =
        reason === "completed"
          ? "completed"
          : reason === "error"
            ? "failed"
            : "interrupted";
      run.updatedAt = Date.now();
      await this.options.persist();
      return { ...result, stopReason: reason, work };
    };
    while (this.options.current() && !signal.aborted) {
      work = await this.options.snapshot();
      if (!this.options.current() || signal.aborted) break;
      if (work.unknownOperationIds.length) return finish("outcome_unknown");
      if (
        run.budget.toolCallsUsed >= run.budget.maxToolCalls &&
        work.missing.length
      )
        return finish("tool_budget");
      if (
        run.budget.modelRequestsObservable &&
        run.budget.iterationsUsed >= run.budget.maxIterations
      )
        return finish("iteration_budget");
      // External provider internals are opaque; bound host continuation starts separately.
      if (
        !run.budget.modelRequestsObservable &&
        run.budget.executorStarts >= run.budget.maxIterations
      )
        return finish("executor_budget");
      run.status = "running";
      run.budget.executorStarts++;
      await this.options.persist();
      if (!this.options.current() || signal.aborted) break;
      try {
        result = await this.options.executor.run(
          {
            prompt: continuation ? workInstruction(run, work) : prompt,
            continuation,
          },
          signal,
        );
      } catch (error) {
        result = {
          stopReason: signal.aborted ? "aborted" : "error",
          text: result.text,
          failureMessage:
            error instanceof Error ? error.message : String(error),
        };
      }
      if (!this.options.current()) return { ...result, work, superseded: true };
      work = await this.options.snapshot();
      if (signal.aborted) return finish("aborted");
      if (work.unknownOperationIds.length) return finish("outcome_unknown");
      if (result.stopReason !== "completed") return finish(result.stopReason);
      if (!work.missing.length) return finish("completed");
      const gap = JSON.stringify({
        missing: work.missing
          .map((x) => JSON.stringify([x.id, x.description, x.progress]))
          .sort(),
        completed: work.completed
          .map((x) => `${x.id}:${x.revision ?? 0}`)
          .sort(),
      });
      repeatedGap = gap === previousGap ? repeatedGap + 1 : 0;
      previousGap = gap;
      if (repeatedGap >= 2) return finish("stalled");
      this.options.progress(
        this.options.language === "en-US"
          ? `${repeatedGap ? "Remaining work is unchanged; address the specific issues" : "Continuing the remaining work"}: ${work.missing.map((x) => x.description).join("; ")}`
          : repeatedGap
            ? `剩余工作未变化，请根据具体问题修复：${work.missing.map((x) => x.description).join("；")}`
            : `继续完成剩余工作：${work.missing.map((x) => x.description).join("；")}`,
      );
      continuation = true;
    }
    return finish("aborted");
  }
}
