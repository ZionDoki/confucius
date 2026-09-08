import type { AgentBackendKind, TaskStatus } from "./research";
import type { ConfuciusEvent } from "./events";

export interface TaskTraceReport {
  kind: "confucius-task-trace";
  schemaVersion: 1;
  task: {
    id: string;
    title: string;
    backend: AgentBackendKind;
    status: TaskStatus;
  };
  capture: {
    startedAt: number;
    finishedAt: number;
    running: boolean;
    changedDuringExport: boolean;
  };
  coverage: string[];
  sections: Record<
    string,
    { capturedAt: number; data?: unknown; error?: string }
  >;
  events: ConfuciusEvent[];
  issues: string[];
  redactions: { credentials: number; binaryPayloads: number };
  analysis?: TaskTraceAnalysis;
}

export interface TaskTraceAnalysis {
  output: Array<{ ts: number; turnId?: string; phase: string; text: string }>;
  reasoning: Array<{ ts: number; source: string; text: string }>;
  reasoningCoverage: string;
  work: { artifacts: number; savedAnnotations: number; missing: string[] };
  incidents: Array<{
    severity: "error" | "warning";
    message: string;
    eventId?: string;
  }>;
  repeatedPages: Array<{
    page: number;
    attachmentKey: string;
    count: number;
    reasons: string[];
  }>;
  runtime?: unknown;
  usage?: unknown;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Derived diagnostics do not alter execution state or claim access to provider internals. */
export function analyzeTaskTrace(report: TaskTraceReport): TaskTraceAnalysis {
  const state = record(report.sections.state?.data);
  const task = record(state.record);
  const run = record(task.run);
  const entries = Array.isArray(report.sections.artifacts?.data)
    ? report.sections.artifacts.data
    : [];
  const artifacts = entries
    .map((entry) => record(record(entry).record))
    .filter((artifact) => artifact.kind);
  const ready = artifacts.filter((artifact) => {
    const binding = record(artifact.execution);
    return (
      artifact.status !== "draft" &&
      (!run.id ||
        (binding.runId === run.id &&
          binding.intentRevision === run.intentRevision &&
          binding.sourceFingerprint === record(run.sources).fingerprint))
    );
  });
  const required = (
    Array.isArray(run.requiredArtifactKinds) ? run.requiredArtifactKinds : []
  ).filter(
    (kind) =>
      !(
        run.templateId === "deep-read" &&
        Number(run.templateVersion) < 2 &&
        kind === "annotation_set"
      ),
  );
  const result: TaskTraceAnalysis = {
    output: [],
    reasoning: [],
    incidents: [],
    repeatedPages: [],
    reasoningCoverage:
      "未记录到实质推理文本。可能是引擎未提供公开摘要，或旧记录范围不足；不能据此判断模型没有思考。",
    work: {
      artifacts: artifacts.length,
      savedAnnotations: 0,
      missing: required
        .filter((kind) => !ready.some((artifact) => artifact.kind === kind))
        .map(String),
    },
    ...(run.budget ? { usage: run.budget } : {}),
  };
  const saved = new Set<string>();
  const reads = new Map<
    string,
    { page: number; attachmentKey: string; count: number; reasons: string[] }
  >();
  const calls = new Map<string, Record<string, unknown>>();
  const textGroups = new Map<string, TaskTraceAnalysis["output"][number]>();
  const reasoningGroups = new Map<
    string,
    TaskTraceAnalysis["reasoning"][number]
  >();
  const finalTurns = new Set(
    report.events
      .filter(
        (event) =>
          event.type === "text_delta" &&
          event.origin === "host" &&
          event.payload?.phase === "final_answer" &&
          event.payload.text,
      )
      .map((event) => event.turnId),
  );
  let segment = 0;
  for (const event of report.events) {
    if (!event.payload || typeof event.payload !== "object") {
      result.incidents.push({
        severity: "warning",
        eventId: event.id,
        message: `${event.type}：事件正文缺失，无法分析此条记录。`,
      });
      continue;
    }
    if (
      event.type === "turn_started" ||
      event.type === "tool_requested" ||
      (event.type === "model_request_progress" &&
        event.payload.status === "failed")
    )
      segment++;
    if (
      event.type === "text_delta" &&
      (event.origin !== "host" || event.payload.phase === "final_answer")
    ) {
      const phase = event.payload.phase ?? "unclassified";
      const key = `${event.turnId}:text:${event.payload.itemId ?? `${segment}:${phase}`}`;
      const previous = textGroups.get(key);
      // A committed host answer already contains the executor's final stream.
      if (!(
        event.origin === "executor" &&
        phase === "final_answer" &&
        finalTurns.has(event.turnId)
      )) {
        if (previous) {
          previous.text += event.payload.text;
          if (event.payload.phase) previous.phase = phase;
        } else if (event.payload.text) {
          const row = {
            ts: event.ts,
            turnId: event.turnId,
            phase,
            text: event.payload.text,
          };
          textGroups.set(key, row);
          result.output.push(row);
        }
      }
    }
    if (
      event.type === "reasoning_delta" &&
      event.payload.text &&
      !event.payload.statusText &&
      event.payload.source !== "host"
    ) {
      const source = event.payload.source ?? "unclassified";
      const key = `${event.turnId}:reasoning:${source}:${event.payload.itemId ?? segment}`;
      const previous = reasoningGroups.get(key);
      if (previous) previous.text += event.payload.text;
      else {
        const row = { ts: event.ts, source, text: event.payload.text };
        reasoningGroups.set(key, row);
        result.reasoning.push(row);
      }
    }
    if (event.type === "runtime_status") result.runtime = event.payload;
    if (
      event.type === "model_request_progress" &&
      event.payload.status === "failed"
    )
      result.incidents.push({
        severity:
          event.payload.exhausted || !event.payload.retryable
            ? "error"
            : "warning",
        eventId: event.id,
        message: `${event.payload.scope ?? "request"} · ${event.payload.requestId} · ${event.payload.attempt}${event.payload.maxAttempts ? `/${event.payload.maxAttempts}` : ""} · ${event.payload.code ?? "failed"}: ${event.payload.message ?? "请求失败"}`,
      });
    if (event.type === "turn_aborted" || event.type === "turn_failed")
      result.incidents.push({
        severity: "error",
        eventId: event.id,
        message:
          event.type === "turn_aborted"
            ? event.payload.reason
            : event.payload.message,
      });
    if (event.type === "tool_requested")
      calls.set(event.payload.callId, event.payload.args);
    if (event.type !== "tool_result") continue;
    const tool = event.payload.result;
    if (!tool || typeof tool !== "object") {
      result.incidents.push({
        severity: "warning",
        eventId: event.id,
        message: "工具结果正文缺失，其他诊断记录仍可查看。",
      });
      continue;
    }
    if (!tool.ok) {
      result.incidents.push({
        severity: "warning",
        eventId: event.id,
        message: `${tool.toolName}: ${tool.message}`,
      });
      continue;
    }
    const data = record(tool.data);
    if (tool.toolName === "commit_annotations" && Array.isArray(data.committed))
      for (const mark of data.committed) {
        const key = record(mark).annotationKey;
        if (typeof key === "string") saved.add(key);
      }
    if (tool.toolName === "get_pages" && Array.isArray(data.pages)) {
      const args = calls.get(event.payload.callId);
      for (const value of data.pages) {
        const page = record(value);
        if (
          page.omitted ||
          typeof page.text !== "string" ||
          typeof page.page !== "number"
        )
          continue;
        const attachmentKey = String(data.attachmentKey ?? data.key ?? "");
        const key = `${attachmentKey}:${page.page}`;
        const read = reads.get(key) ?? {
          page: page.page,
          attachmentKey,
          count: 0,
          reasons: [],
        };
        read.count++;
        if (read.count > 1)
          read.reasons.push(
            String(
              args?.rereadReason ?? page.rereadReason ?? "旧记录未提供重读原因",
            ),
          );
        reads.set(key, read);
      }
    }
  }
  result.work.savedAnnotations = saved.size;
  result.repeatedPages = [...reads.values()].filter((read) => read.count > 1);
  for (const request of [
    record(run.modelRequest),
    record(run.providerRequest),
  ]) {
    if (request.status === "started" && run.status !== "running")
      result.incidents.push({
        severity: "warning",
        message: `任务已停止，但 ${request.requestId} 仍标为 started；旧记录未关闭请求状态。`,
      });
    if (request.status === "failed" && request.code === "host_restarted")
      result.incidents.push({
        severity: "warning",
        message: `${request.requestId}：宿主重启时关闭了尚未完成的请求，已保存成果可继续使用。`,
      });
  }
  if (result.work.missing.length)
    result.incidents.push({
      severity: "warning",
      message: `尚未完成成果：${result.work.missing.join("、")}。已保存的批注应在继续时复用。`,
    });
  if (!result.output.some((part) => part.phase === "final_answer"))
    result.incidents.push({
      severity: "warning",
      message: "未记录到明确标记的最终回复；旧记录可能未区分消息阶段。",
    });
  if (result.reasoning.length)
    result.reasoningCoverage =
      "以下仅包含引擎公开返回并被宿主记录的推理文本或摘要，不包含模型内部上下文。";
  return result;
}
