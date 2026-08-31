import type {
  JsonSchemaObject,
  ToolDefinition,
  ToolResult,
  ToolRuntimeMeta,
} from "@confucius/protocol";
import { assertParallelSafeInvariant } from "./ConcurrencyScheduler";
import { normalizeResult, normalizeThrown } from "./ResultNormalizer";

export type ToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown> | unknown;

interface RegisteredTool {
  definition: ToolDefinition;
  meta: ToolRuntimeMeta;
  handler: ToolHandler;
}

export class MemoryToolProvider {
  private readonly tools = new Map<string, RegisteredTool>();

  register(
    definition: ToolDefinition,
    meta: ToolRuntimeMeta,
    handler: ToolHandler,
  ): void {
    if (definition.name !== meta.name) {
      throw new Error(
        `Tool definition name "${definition.name}" != meta name "${meta.name}"`,
      );
    }
    assertParallelSafeInvariant(meta);
    this.tools.set(definition.name, { definition, meta, handler });
  }

  listTools(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  getMeta(name: string): ToolRuntimeMeta | null {
    return this.tools.get(name)?.meta ?? null;
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    return this.tools.get(name)?.definition.inputSchema;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        toolName: name,
        code: "not_found",
        message: `Unknown tool: ${name}`,
      };
    }
    try {
      const value = await tool.handler(args, signal);
      return normalizeResult(name, value);
    } catch (error) {
      if (isAbortError(error)) {
        return {
          ok: false,
          toolName: name,
          code: "timeout",
          message: "Tool call aborted",
        };
      }
      return normalizeThrown(name, error);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function jsonObjectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchemaObject {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: true,
  };
}
