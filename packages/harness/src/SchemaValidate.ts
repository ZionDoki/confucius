import type { JsonSchemaObject, ToolFailure } from "@confucius/protocol";

interface SchemaProperty {
  type?: string;
  enum?: unknown[];
  items?: { type?: string };
}

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
  if (missing.length > 0) {
    return {
      ok: false,
      toolName,
      code: "invalid_args",
      message: `Missing required arguments: ${missing.join(", ")}`,
      details: { missing },
    };
  }

  const properties = (schema.properties ?? {}) as Record<
    string,
    SchemaProperty
  >;
  for (const [key, spec] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }
    const problem = checkProperty(toolName, key, spec, value);
    if (problem) {
      return problem;
    }
  }
  return null;
}

function checkProperty(
  toolName: string,
  key: string,
  spec: SchemaProperty,
  value: unknown,
): ToolFailure | null {
  if (Array.isArray(spec.enum) && spec.enum.length > 0) {
    if (!spec.enum.some((option) => option === value)) {
      return invalid(
        toolName,
        key,
        `"${String(value)}" is not one of: ${spec.enum
          .map((option) => JSON.stringify(String(option)))
          .join(", ")}`,
      );
    }
  }
  if (!spec.type) {
    return null;
  }
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") {
        return invalid(toolName, key, `expected string, got ${typeName(value)}`);
      }
      break;
    case "integer":
      if (!isIntegerLike(value)) {
        return invalid(toolName, key, `expected integer, got ${typeName(value)}`);
      }
      break;
    case "number":
      if (!isNumberLike(value)) {
        return invalid(toolName, key, `expected number, got ${typeName(value)}`);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        return invalid(toolName, key, `expected boolean, got ${typeName(value)}`);
      }
      break;
    case "array":
      if (!Array.isArray(value)) {
        return invalid(toolName, key, `expected array, got ${typeName(value)}`);
      }
      break;
    case "object":
      if (typeof value !== "object" || Array.isArray(value)) {
        return invalid(toolName, key, `expected object, got ${typeName(value)}`);
      }
      break;
    default:
      return null;
  }
  return null;
}

function invalid(toolName: string, key: string, message: string): ToolFailure {
  return {
    ok: false,
    toolName,
    code: "invalid_args",
    message: `Invalid argument "${key}": ${message}`,
    details: { argument: key },
  };
}

function typeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

// Models occasionally serialize numbers as strings; handlers already coerce,
// so accept the string form rather than rejecting the call outright.
function isIntegerLike(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isInteger(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return Number.isInteger(Number(value));
  }
  return false;
}

function isNumberLike(value: unknown): boolean {
  if (typeof value === "number") {
    return !Number.isNaN(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return !Number.isNaN(Number(value));
  }
  return false;
}
