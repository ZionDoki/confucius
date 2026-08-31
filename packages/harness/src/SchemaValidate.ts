import type { JsonSchemaObject, ToolFailure } from "@confucius/protocol";

export function validateArgs(
  toolName: string,
  schema: JsonSchemaObject | undefined,
  args: Record<string, unknown>,
): ToolFailure | null {
  if (!schema) {
    return null;
  }
  const required = schema.required ?? [];
  const missing = required.filter(
    (key) => args[key] === undefined || args[key] === null,
  );
  if (missing.length === 0) {
    return null;
  }
  return {
    ok: false,
    toolName,
    code: "invalid_args",
    message: `Missing required arguments: ${missing.join(", ")}`,
    details: { missing },
  };
}
