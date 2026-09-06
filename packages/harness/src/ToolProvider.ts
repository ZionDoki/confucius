import type {
  JsonSchemaObject,
  ToolExecutionContext,
  ToolFailure,
  ToolDefinition,
  ToolResult,
  ToolRuntimeMeta,
} from "@confucius/protocol";

export interface ToolProvider {
  listTools(): ToolDefinition[];
  getMeta(name: string): ToolRuntimeMeta | null;
  getSchema(name: string): JsonSchemaObject | undefined;
  prepare?(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolFailure | null>;
  recordDenied?(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<void>;
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export class FilteredToolProvider implements ToolProvider {
  constructor(
    private readonly inner: ToolProvider,
    private readonly allowed: ReadonlySet<string> | null,
  ) {}

  listTools(): ToolDefinition[] {
    const tools = this.inner.listTools();
    if (!this.allowed) {
      return tools;
    }
    return tools.filter((tool) => this.allowed?.has(tool.name));
  }

  getMeta(name: string): ToolRuntimeMeta | null {
    if (this.allowed && !this.allowed.has(name)) {
      return null;
    }
    return this.inner.getMeta(name);
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    if (this.allowed && !this.allowed.has(name)) {
      return undefined;
    }
    return this.inner.getSchema(name);
  }

  async prepare(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolFailure | null> {
    if (this.allowed && !this.allowed.has(name))
      return {
        ok: false,
        toolName: name,
        code: "permission_denied",
        effect: "none",
        message: `Tool "${name}" is not allowed by the active skill`,
      };
    return this.inner.prepare?.(name, args, context) ?? null;
  }

  async recordDenied(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<void> {
    await this.inner.recordDenied?.(name, args, context);
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (this.allowed && !this.allowed.has(name)) {
      return {
        ok: false,
        toolName: name,
        code: "permission_denied",
        message: `Tool "${name}" is not allowed by the active skill`,
      };
    }
    return this.inner.call(name, args, signal, context);
  }
}

export interface ToolCallHookInfo {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
}

/**
 * Wrap any provider so every successful or failed call is visible to an
 * access hook (promotion, logging, metrics). Hook errors never fail the tool.
 */
export class HookedToolProvider implements ToolProvider {
  constructor(
    private readonly inner: ToolProvider,
    private readonly afterCall: (
      info: ToolCallHookInfo,
    ) => Promise<void> | void,
  ) {}

  listTools(): ToolDefinition[] {
    return this.inner.listTools();
  }

  getMeta(name: string): ToolRuntimeMeta | null {
    return this.inner.getMeta(name);
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    return this.inner.getSchema(name);
  }

  async prepare(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolFailure | null> {
    return this.inner.prepare?.(name, args, context) ?? null;
  }

  async recordDenied(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<void> {
    await this.inner.recordDenied?.(name, args, context);
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const result = await this.inner.call(name, args, signal, context);
    try {
      await this.afterCall({ toolName: name, args, result });
    } catch {
      // Access hooks must not change tool semantics.
    }
    return result;
  }
}

export class CompositeToolProvider implements ToolProvider {
  constructor(private readonly providers: ToolProvider[]) {}

  listTools(): ToolDefinition[] {
    const seen = new Set<string>();
    const tools: ToolDefinition[] = [];
    for (const provider of this.providers) {
      for (const tool of provider.listTools()) {
        if (seen.has(tool.name)) {
          continue;
        }
        seen.add(tool.name);
        tools.push(tool);
      }
    }
    return tools;
  }

  getMeta(name: string): ToolRuntimeMeta | null {
    for (const provider of this.providers) {
      const meta = provider.getMeta(name);
      if (meta) {
        return meta;
      }
    }
    return null;
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    for (const provider of this.providers) {
      const schema = provider.getSchema(name);
      if (schema) {
        return schema;
      }
    }
    return undefined;
  }

  async prepare(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolFailure | null> {
    const provider = this.providers.find((entry) => entry.getMeta(name));
    return provider?.prepare?.(name, args, context) ?? null;
  }

  async recordDenied(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<void> {
    const provider = this.providers.find((entry) => entry.getMeta(name));
    await provider?.recordDenied?.(name, args, context);
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    for (const provider of this.providers) {
      if (provider.listTools().some((tool) => tool.name === name)) {
        return provider.call(name, args, signal, context);
      }
    }
    return {
      ok: false,
      toolName: name,
      code: "not_found",
      message: `Unknown tool: ${name}`,
    };
  }
}
