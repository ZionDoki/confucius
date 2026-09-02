import type { CollectionRef, ItemRef } from "./item";
import type { PermissionMode } from "./permissions";

export type SessionMode = "plan" | "agent";

export type TurnPhase =
  | "planning"
  | "acting"
  | "awaiting_approval"
  | "compacting"
  | "delivering"
  | "done"
  | "failed"
  | "aborted";

export interface SessionContext {
  item?: ItemRef;
  collection?: CollectionRef;
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode: SessionMode;
  context: SessionContext;
  permissionMode: PermissionMode;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  phase: TurnPhase;
  userText: string;
  createdAt: number;
  updatedAt: number;
}
