import type { ContextWindowState, HistoryItemRef } from "./history";
import type { SessionContext, SessionMode, TurnPhase } from "./session";
import type { ApprovalRequest, ApprovalResolution } from "./permissions";
import type { ToolFailure, ToolSuccess } from "./tools";
import type {
  ArtifactSummary,
  Citation,
  MemoryProposal,
  RuntimeStatus,
  TaskStatus,
} from "./research";

export type { ArtifactKind, ArtifactRecord, Citation } from "./research";

export interface ModelRequestProgress {
  requestId: string;
  attempt: number;
  status: "started" | "completed" | "failed";
  code?: string;
  retryable?: boolean;
  exhausted?: boolean;
  delayMs?: number;
  message?: string;
  partial?: { text?: string; reasoning?: string };
  purpose?: "title" | "memory";
}

export type ConfuciusEventType =
  | "model_request_progress"
  | "session_created"
  | "session_updated"
  | "turn_started"
  | "plan_updated"
  | "tool_requested"
  | "tool_progress"
  | "tool_result"
  | "approval_required"
  | "approval_resolved"
  | "artifact_upserted"
  | "text_delta"
  | "reasoning_delta"
  | "citation"
  | "context_updated"
  | "memory_updated"
  | "turn_completed"
  | "turn_failed"
  | "turn_aborted"
  | "task_status_changed"
  | "runtime_status"
  | "command_execution"
  | "file_change"
  | "turn_diff_updated"
  | "context_drifted"
  | "memory_proposed"
  | "context_usage_updated"
  | "model_usage_updated"
  | "context_window_changed"
  | "history_recalled";

export interface ConfuciusEventBase {
  id: string;
  sessionId: string;
  turnId?: string;
  type: ConfuciusEventType;
  ts: number;
}

export interface PlanStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
}

type EventPayloads = {
  model_request_progress: ModelRequestProgress;
  context_usage_updated: { inputTokens: number; capacityTokens?: number };
  model_usage_updated: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  context_window_changed: { window: ContextWindowState };
  history_recalled: { ref: HistoryItemRef; title: string; sourceIds: string[] };
  session_created: { title: string; mode: SessionMode };
  session_updated: { title?: string; mode?: SessionMode };
  turn_started: { userText: string };
  plan_updated: { steps: PlanStep[] };
  tool_requested: {
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
  };
  tool_progress: { callId: string; message: string };
  tool_result: {
    callId: string;
    result: ToolSuccess | ToolFailure;
  };
  approval_required: { request: ApprovalRequest };
  approval_resolved: { resolution: ApprovalResolution };
  artifact_upserted: { artifact: ArtifactSummary };
  text_delta: {
    text: string;
    phase?: "commentary" | "final_answer";
    requestId?: string;
    attempt?: number;
  };
  reasoning_delta: {
    requestId?: string;
    attempt?: number;
    text: string;
    /** Host-authored workflow phase shown while a long turn is running. */
    statusText?: string;
  };
  citation: { citation: Citation };
  context_updated: { context: SessionContext };
  memory_updated: {
    op: "add" | "update" | "delete";
    id: string;
    title?: string;
    total: number;
  };
  turn_completed: { phase: TurnPhase; stopReason?: string };
  turn_failed: {
    message: string;
    stopReason?: string;
    failure?: import("./runtimeFailure").RuntimeFailure;
  };
  turn_aborted: { reason: string; stopReason?: string };
  task_status_changed: { status: TaskStatus; reason?: string };
  runtime_status: { runtime: RuntimeStatus };
  command_execution: {
    callId: string;
    command: string;
    status: "started" | "completed" | "failed";
    output?: string;
    exitCode?: number;
  };
  file_change: {
    path: string;
    status: "proposed" | "applied" | "rejected";
    diff?: string;
  };
  turn_diff_updated: { diff: string };
  context_drifted: {
    lockedFingerprint: string;
    liveFingerprint: string;
  };
  memory_proposed: { proposal: MemoryProposal };
};

export type ConfuciusEvent = {
  [K in ConfuciusEventType]: ConfuciusEventBase & {
    type: K;
    payload: EventPayloads[K];
  };
}[ConfuciusEventType];
