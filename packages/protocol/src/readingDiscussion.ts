import type { AgentBackendKind, TaskStatus } from "./research";

export interface ReadingDiscussionMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  incomplete?: boolean;
}

/** Public projection; runtime state and model configuration remain host-only. */
export interface ReadingDiscussionRecord {
  id: string;
  artifactId: string;
  parentTaskId: string;
  checkpointId: string;
  checkpointFingerprint: string;
  revision: number;
  title: string;
  backend: AgentBackendKind;
  status: TaskStatus;
  messages: ReadingDiscussionMessage[];
  createdAt: number;
  updatedAt: number;
  sequence: number;
  contextWindow: number;
  error?: string;
}

/** Private event cursor; task/global event indexes never receive these events. */
export interface ReadingDiscussionEvent {
  sequence: number;
  turnId: string;
  type: "text_delta" | "status" | "activity";
  text?: string;
  toolName?: string;
  status?: TaskStatus;
}
