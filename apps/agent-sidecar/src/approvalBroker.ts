import type { ApprovalRequest, ApprovalResolution } from "@confucius/protocol";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (resolution: ApprovalResolution) => void;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  async request(request: ApprovalRequest): Promise<ApprovalResolution> {
    return new Promise<ApprovalResolution>((resolve) => {
      this.pending.set(request.id, { request, resolve });
    });
  }

  resolve(resolution: ApprovalResolution): boolean {
    const pending = this.pending.get(resolution.id);
    if (!pending) return false;
    this.pending.delete(resolution.id);
    pending.resolve(resolution);
    return true;
  }

  rejectTask(taskId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.sessionId !== taskId) continue;
      this.pending.delete(id);
      pending.resolve({ id, verdict: "deny", scope: "once" });
    }
  }
}
