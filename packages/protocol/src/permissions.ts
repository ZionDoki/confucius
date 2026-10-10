export type PermissionMode = "auto_allow" | "ask" | "deny";

export type PermissionScope = "once" | "session" | "always";

export type ToolRiskLevel =
  "read" | "network" | "write" | "mcp" | "command" | "file_write" | "high_cost";

export type ApprovalKind =
  | "tool"
  | "command"
  | "file_change"
  | "runtime_permission"
  | "artifact_writeback";

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
  origin?: "native" | "codex" | "kimi";
  kind?: ApprovalKind;
  before?: string;
  after?: string;
  providerRequestId?: string | number;
}

export interface ApprovalResolution {
  id: string;
  verdict: ApprovalVerdict;
  scope: PermissionScope;
  editedArgs?: Record<string, unknown>;
}

/** RPC replies are untrusted data until the complete decision is validated. */
export function isApprovalResolution(
  value: unknown,
): value is ApprovalResolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const resolution = value as Record<string, unknown>;
  return (
    typeof resolution.id === "string" &&
    resolution.id.trim().length > 0 &&
    (resolution.verdict === "allow" || resolution.verdict === "deny") &&
    (resolution.scope === "once" ||
      resolution.scope === "session" ||
      resolution.scope === "always") &&
    (resolution.editedArgs === undefined ||
      (resolution.editedArgs !== null &&
        typeof resolution.editedArgs === "object" &&
        !Array.isArray(resolution.editedArgs)))
  );
}
