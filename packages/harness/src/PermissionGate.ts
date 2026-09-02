import type {
  ApprovalRequest,
  ApprovalResolution,
  PermissionMode,
  ToolRiskLevel,
} from "@confucius/protocol";
import type { IdFactory } from "./ids";

export interface PermissionGateOptions {
  modeFor: (toolName: string) => PermissionMode;
  riskFor: (toolName: string) => ToolRiskLevel;
  resolve?: (
    request: ApprovalRequest,
  ) => Promise<ApprovalResolution> | ApprovalResolution;
  ids: IdFactory;
  now: () => number;
}

export class PermissionGate {
  constructor(private readonly options: PermissionGateOptions) {}

  async decide(input: {
    sessionId: string;
    turnId: string;
    toolName: string;
    args: Record<string, unknown>;
    onRequest?: (request: ApprovalRequest) => void;
  }): Promise<
    | { verdict: "allow"; request?: ApprovalRequest; resolution?: ApprovalResolution }
    | { verdict: "deny"; request?: ApprovalRequest; resolution?: ApprovalResolution }
  > {
    const mode = this.options.modeFor(input.toolName);
    if (mode === "auto_allow") {
      return { verdict: "allow" };
    }
    if (mode === "deny") {
      return { verdict: "deny" };
    }

    const request: ApprovalRequest = {
      id: this.options.ids(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolName: input.toolName,
      args: input.args,
      riskLevel: this.options.riskFor(input.toolName),
      createdAt: this.options.now(),
    };

    // Surface the request before waiting for the UI to resolve it. Emitting
    // only after `resolve` completes deadlocks interactive approval flows:
    // the UI cannot show a request that the turn loop has not published yet.
    input.onRequest?.(request);

    if (!this.options.resolve) {
      return { verdict: "deny", request };
    }

    const resolution = await this.options.resolve(request);
    return {
      verdict: resolution.verdict,
      request,
      resolution,
    };
  }
}
