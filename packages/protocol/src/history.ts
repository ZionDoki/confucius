import type { AgentBackendKind, TaskStatus } from "./research";

/** A reference is data, never a delegation or an authorization grant. */
export interface TaskContextReference {
  kind: "task";
  taskId: string;
  title: string;
}

export interface ContextWindowState {
  id: string;
  number: number;
  createdAt: number;
  control: "host" | "runtime";
  inputTokens?: number;
  capacityTokens?: number;
  historyCoverage?: "host-visible" | "runtime-partial";
  usageSource: "reported" | "estimated" | "unknown";
}

export interface HistoryItemRef {
  taskId: string;
  windowId: string;
  itemId: string;
}

export interface HistoryItem extends HistoryItemRef {
  turnId?: string;
  role: "user" | "assistant" | "tool" | "event";
  toolName?: string;
  createdAt: number;
  characters: number;
  sourceIds: string[];
  legacy?: boolean;
  incomplete?: boolean;
  excerpt: string;
}

export interface HistoryTask {
  id: string;
  title: string;
  updatedAt: number;
  status: TaskStatus;
  backend: AgentBackendKind;
}

export function initialContextWindow(
  taskId: string,
  backend: AgentBackendKind,
  now = Date.now(),
): ContextWindowState {
  return {
    id: `ctx_${taskId}_1`,
    number: 1,
    createdAt: now,
    control: backend === "native" ? "host" : "runtime",
    historyCoverage: backend === "native" ? "host-visible" : "runtime-partial",
    usageSource: backend === "native" ? "estimated" : "unknown",
  };
}

export function taskContextReferences(value: unknown): TaskContextReference[] {
  if (!Array.isArray(value)) return [];
  const refs = new Map<string, TaskContextReference>();
  for (const item of value) {
    if (
      item?.kind === "task" &&
      typeof item.taskId === "string" &&
      /^[\w-]+$/.test(item.taskId)
    ) {
      refs.set(item.taskId, {
        kind: "task",
        taskId: item.taskId,
        title: String(item.title ?? item.taskId).slice(0, 300),
      });
    }
  }
  return [...refs.values()].slice(0, 20);
}
