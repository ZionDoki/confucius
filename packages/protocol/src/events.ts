import type { SessionContext, SessionMode, TurnPhase } from "./session";
import type { ApprovalRequest, ApprovalResolution } from "./permissions";
import type { ToolFailure, ToolSuccess } from "./tools";

export type ConfuciusEventType =
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
  | "turn_aborted";

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

export type ArtifactKind =
  | "note_draft"
  | "annotation_proposal"
  | "collection_diff"
  | "report"
  | "citation_list";

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  kind: ArtifactKind;
  title: string;
  body: unknown;
  updatedAt: number;
}

export interface Citation {
  itemLibraryID: number;
  itemKey: string;
  page?: number;
  section?: string;
  quote?: string;
}

type EventPayloads = {
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
  artifact_upserted: { artifact: ArtifactRecord };
  text_delta: { text: string };
  reasoning_delta: { text: string };
  citation: { citation: Citation };
  context_updated: { context: SessionContext };
  memory_updated: {
    op: "add" | "update" | "delete";
    id: string;
    title?: string;
    total: number;
  };
  turn_completed: { phase: TurnPhase };
  turn_failed: { message: string };
  turn_aborted: { reason: string };
};

export type ConfuciusEvent = {
  [K in ConfuciusEventType]: ConfuciusEventBase & {
    type: K;
    payload: EventPayloads[K];
  };
}[ConfuciusEventType];
