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
  /**
   * Host-side human-readable one-liner naming the object the call acts on
   * (a title, query, or name — not raw JSON or a bare item key). The
   * approval card shows this by default; raw args stay behind a toggle.
   */
  summary?: string;
}

export interface ApprovalResolution {
  id: string;
  verdict: ApprovalVerdict;
  scope: PermissionScope;
  editedArgs?: Record<string, unknown>;
}
