export type PermissionMode = "auto_allow" | "ask" | "deny";

export type PermissionScope = "once" | "session" | "always";

export type ToolRiskLevel = "read" | "network" | "write" | "mcp" | "high_cost";

export type ApprovalVerdict = "allow" | "deny";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  turnId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  createdAt: number;
}

export interface ApprovalResolution {
  id: string;
  verdict: ApprovalVerdict;
  scope: PermissionScope;
  editedArgs?: Record<string, unknown>;
}
