import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { JsonSchemaObject, ToolFailure } from "@confucius/protocol";

export interface ValidationIssue {
  path: string;
  reason: string;
  message: string;
  nextAction: string;
}
type Schema =
  | boolean
  | {
      [key: string]: unknown;
      type?: string | string[];
      properties?: Record<string, Schema>;
      items?: Schema;
      oneOf?: Schema[];
      anyOf?: Schema[];
      allOf?: Schema[];
    };
// Coercion is deliberately separate: Ajv must not turn null into an empty string,
// mutate union branches, or silently remove properties before consent.
const ajv = new Ajv({
  logger: false,
  allErrors: true,
  strictSchema: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  allowUnionTypes: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  ownProperties: true,
});
const cache = new WeakMap<object, ValidateFunction>();
const schemaKeys = new WeakMap<object, string>();
let schemaSequence = 0;
const annotationBatches = new Set([
  "propose_annotations",
  "propose_highlights",
  "commit_annotations",
]);
const issue = (
  path: string,
  reason: string,
  message: string,
): ValidationIssue => ({
  path,
  reason,
  message,
  nextAction: `Correct ${path} and submit the corrected arguments`,
});

export function validateArgumentShape(
  toolName: string,
  args: unknown,
): ToolFailure | null {
  if (args !== null && typeof args === "object" && !Array.isArray(args))
    return null;
  return {
    ok: false,
    toolName,
    code: "invalid_args",
    effect: "none",
    retryable: false,
    message: "Arguments must be a JSON object",
  };
}

/** Validate the schema at registration time when possible; external schemas fail closed. */
export function assertSupportedSchema(schema: unknown): void {
  validator(schema as Schema);
}

export function validateArgs(
  toolName: string,
  schema: JsonSchemaObject | undefined,
  args: Record<string, unknown>,
): ToolFailure | null {
  const shape = validateArgumentShape(toolName, args);
  if (shape) return shape;
  if (!schema) return null;
  const issues: ValidationIssue[] = [];
  if (schema.properties?.key && args.itemKey !== undefined) {
    if (args.key !== undefined && args.key !== args.itemKey)
      issues.push(
        issue(
          "$.key",
          "conflicting_alias",
          "key and itemKey refer to different items",
        ),
      );
    else {
      args.key = args.itemKey;
      delete args.itemKey;
    }
  }
  let effective = schema as Schema;
  if (annotationBatches.has(toolName)) {
    // Per-entry preflight intentionally returns partial batch reports. Keep all
    // container constraints here; omit only its entries' schemas.
    effective = { ...schema, properties: { ...schema.properties } } as Schema;
    if (typeof effective === "object")
      for (const name of ["annotations", "highlights"]) {
        const entry = effective.properties?.[name];
        if (entry && typeof entry === "object")
          effective.properties![name] = { ...entry, items: true };
      }
  }
  const result = validateValue(effective, args);
  issues.push(...result.issues);
  if (
    result.value &&
    typeof result.value === "object" &&
    !Array.isArray(result.value) &&
    !issues.length
  ) {
    for (const key of Object.keys(args)) delete args[key];
    for (const [key, value] of Object.entries(result.value))
      Object.defineProperty(args, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  if (!issues.length) return null;
  return {
    ok: false,
    toolName,
    code: "invalid_args",
    effect: "none",
    retryable: false,
    message: issues
      .map((entry) => `${entry.path}: ${entry.message}`)
      .join("; "),
    details: { argument: issues[0].path.replace(/^\$\./, ""), issues },
    issues,
  };
}

export function validateValue(
  schema: unknown,
  value: unknown,
): { value: unknown; issues: ValidationIssue[] } {
  try {
    const check = validator(schema as Schema);
    const normalized = normalize(
      schema as Schema,
      copyJson(value),
      0,
      schema as Schema,
      "",
    );
    return {
      value: normalized,
      issues: check(normalized)
        ? []
        : (check.errors ?? []).slice(0, 64).map(fromAjv),
    };
  } catch (error) {
    return {
      value,
      issues: [
        issue(
          "$",
          "invalid_schema_or_value",
          error instanceof Error ? error.message : String(error),
        ),
      ],
    };
  }
}

function validator(schema: Schema): ValidateFunction {
  if (schema !== null && typeof schema === "object") {
    const existing = cache.get(schema);
    if (existing) return existing;
    const key = `urn:confucius:tool-schema:${++schemaSequence}`;
    ajv.addSchema(schema, key);
    const compiled = ajv.getSchema(key)!;
    cache.set(schema, compiled);
    schemaKeys.set(schema, key);
    return compiled;
  }
  return ajv.compile(schema);
}

function fromAjv(error: ErrorObject): ValidationIssue {
  const parts = error.instancePath
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (error.keyword === "required")
    parts.push(String(error.params.missingProperty));
  if (error.keyword === "additionalProperties")
    parts.push(String(error.params.additionalProperty));
  const path =
    "$" +
    parts
      .map((part) => (/^\d+$/.test(part) ? `[${part}]` : `.${part}`))
      .join("");
  return issue(
    path,
    error.keyword === "additionalProperties" ? "unknown_field" : error.keyword,
    error.message ?? "Value violates schema",
  );
}

function copyJson(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("Object nesting exceeds 32 levels");
  if (Array.isArray(value))
    return value.map((entry) => copyJson(entry, depth + 1));
  if (value && typeof value === "object") {
    const object: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value))
      if (entry !== undefined)
        Object.defineProperty(object, key, {
          value: copyJson(entry, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
    return object;
  }
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Non-finite numbers are not JSON values");
  if (["function", "symbol", "bigint"].includes(typeof value))
    throw new Error("Arguments must contain only JSON values");
  return value;
}

function normalize(
  schema: Schema,
  value: unknown,
  depth = 0,
  root: Schema = schema,
  location = "",
): unknown {
  if (!schema || typeof schema !== "object") return value;
  if (depth > 32) throw new Error("Object nesting exceeds 32 levels");
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    const pointer = decodeURIComponent(schema.$ref.slice(1));
    let target: unknown = root;
    for (const part of pointer.slice(1).split("/"))
      target =
        target && typeof target === "object"
          ? (target as Record<string, unknown>)[
              part.replace(/~1/g, "/").replace(/~0/g, "~")
            ]
          : undefined;
    if (target !== undefined)
      value = normalize(target as Schema, value, depth + 1, root, pointer);
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  const keyword = schema.oneOf ? "oneOf" : "anyOf";
  const at = (path: string): ValidateFunction => {
    const key =
      typeof root === "object" && root ? schemaKeys.get(root) : undefined;
    const compiled = key ? ajv.getSchema(`${key}#${path}`) : undefined;
    if (!compiled) throw new Error(`Cannot validate schema branch ${path}`);
    return compiled;
  };
  if (alternatives) {
    // Prefer exact representations. Only choose a coercing branch when exactly
    // one branch accepts its normalized value; validation remains Ajv's job.
    const direct = alternatives.filter((_branch, index) =>
      at(`${location}/${keyword}/${index}`)(value),
    );
    if (direct.length === 0) {
      const candidates = alternatives
        .map((branch, index) => ({
          index,
          value: normalize(
            branch,
            copyJson(value),
            depth + 1,
            root,
            `${location}/${keyword}/${index}`,
          ),
        }))
        .filter((entry) =>
          at(`${location}/${keyword}/${entry.index}`)(entry.value),
        );
      if (candidates.length === 1) value = candidates[0].value;
    }
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    !types.includes("string") &&
    (types.includes("number") || types.includes("integer")) &&
    typeof value === "string" &&
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  ) {
    const number = Number(value);
    // Never round a large integer supplied by a model into another item id.
    if (
      Number.isFinite(number) &&
      (!Number.isInteger(number) || Number.isSafeInteger(number)) &&
      decimalKey(value) === decimalKey(String(number))
    )
      value = number;
  }
  if (
    types.includes("integer") &&
    typeof value === "number" &&
    !Number.isSafeInteger(value)
  )
    throw new Error(
      "Integer arguments must be exactly representable safe integers",
    );
  if (Array.isArray(value) && schema.items)
    value = value.map((entry) =>
      normalize(schema.items!, entry, depth + 1, root, `${location}/items`),
    );
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property !== undefined)
        object[key] = normalize(
          property,
          entry,
          depth + 1,
          root,
          `${location}/properties/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        );
    }
  }
  for (const [index, branch] of (schema.allOf ?? []).entries())
    value = normalize(
      branch,
      value,
      depth + 1,
      root,
      `${location}/allOf/${index}`,
    );
  return value;
}

function decimalKey(value: string): string {
  const [mantissa, exponent = "0"] = value.trim().toLowerCase().split("e");
  const negative = mantissa.startsWith("-");
  const unsigned = mantissa.replace(/^[+-]/, "");
  let power = Number(exponent) - (unsigned.split(".")[1]?.length ?? 0);
  let digits = unsigned.replace(".", "").replace(/^0+/, "");
  if (!digits) return "0";
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    power++;
  }
  return `${negative ? "-" : ""}${digits}e${power}`;
}
