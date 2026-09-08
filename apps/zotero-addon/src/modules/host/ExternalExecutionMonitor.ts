import type { ConfuciusEvent } from "@confucius/protocol";

/** Only real model/tool events renew the lease. Polling an empty event page does not. */
export class ExternalExecutionMonitor {
  private timer?: unknown;
  private approvals = new Set<string>();
  private closed = false;
  private retrying = false;
  constructor(
    private expired: () => void,
    private timers: {
      schedule(callback: () => void, ms: number): unknown;
      cancel(handle: unknown): void;
      idleMs?: number;
      retryMs?: number;
    },
  ) {
    this.arm();
  }

  observe(event: ConfuciusEvent): void {
    if (this.closed) return;
    if (
      ![
        "approval_required",
        "approval_resolved",
        "model_request_progress",
        "model_usage_updated",
        "text_delta",
        "reasoning_delta",
        "tool_requested",
        "tool_progress",
        "tool_result",
        "command_execution",
        "file_change",
      ].includes(event.type)
    )
      return;
    if (event.type === "model_request_progress" && event.payload.purpose)
      return;
    if (event.type === "approval_required")
      this.approvals.add(event.payload.request.id);
    if (event.type === "approval_resolved")
      this.approvals.delete(event.payload.resolution.id);
    if (event.type === "model_request_progress" && !event.payload.purpose)
      this.retrying =
        event.payload.status === "failed" && event.payload.retryable === true;
    else if (
      [
        "text_delta",
        "reasoning_delta",
        "tool_requested",
        "tool_result",
      ].includes(event.type)
    )
      this.retrying = false;
    this.arm();
  }

  private arm(): void {
    if (this.timer !== undefined) this.timers.cancel(this.timer);
    this.timer = undefined;
    if (this.closed || this.approvals.size) return;
    this.timer = this.timers.schedule(
      () => {
        this.closed = true;
        this.expired();
      },
      this.retrying
        ? (this.timers.retryMs ?? 120_000)
        : (this.timers.idleMs ?? 300_000),
    );
  }

  dispose(): void {
    this.closed = true;
    if (this.timer !== undefined) this.timers.cancel(this.timer);
    this.timer = undefined;
  }
}
