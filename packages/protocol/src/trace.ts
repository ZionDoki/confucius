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
}
