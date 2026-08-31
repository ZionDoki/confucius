import type { ToolResult } from "@confucius/protocol";

export function normalizeResult(toolName: string, value: unknown): ToolResult {
  if (isToolResult(value)) {
    return { ...value, toolName };
  }
  return {
    ok: true,
    toolName,
    data: value,
  };
}

export function normalizeThrown(toolName: string, error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    toolName,
    code: "internal",
    message,
  };
}

function isToolResult(value: unknown): value is ToolResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { ok?: unknown };
  return record.ok === true || record.ok === false;
}
