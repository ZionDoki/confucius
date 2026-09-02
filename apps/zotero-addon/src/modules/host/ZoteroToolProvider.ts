import type {
  JsonSchemaObject,
  ToolDefinition,
  ToolResult,
  ToolRuntimeMeta,
} from "@confucius/protocol";
import type { ToolProvider } from "@confucius/harness";
import { MEMORY_READ_TOOLS, MEMORY_WRITE_TOOLS } from "@confucius/protocol";
import { TOOL_DEFINITIONS, TOOL_META } from "@confucius/zotero-tools";
import type { ZoteroToolHost } from "../tools/ZoteroToolHost";
import type { BrowserContextStore } from "./BrowserContext";

export class ZoteroToolProvider implements ToolProvider {
  constructor(
    private readonly host: ZoteroToolHost,
    private readonly browser: BrowserContextStore,
  ) {}

  listTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS.filter((tool) => !MEMORY_TOOL_NAMES.has(tool.name));
  }

  getMeta(name: string): ToolRuntimeMeta | null {
    if (MEMORY_TOOL_NAMES.has(name)) {
      return null;
    }
    return TOOL_META[name] ?? null;
  }

  getSchema(name: string): JsonSchemaObject | undefined {
    if (MEMORY_TOOL_NAMES.has(name)) {
      return undefined;
    }
    return TOOL_DEFINITIONS.find((tool) => tool.name === name)?.inputSchema;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (name.startsWith("browser.")) {
      return this.callBrowser(name, args);
    }
    return this.host.execute(name, args);
  }

  private async callBrowser(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const snap = this.browser.snapshot;
    if (name === "browser.get_active_tab") {
      return snap
        ? { ok: true, toolName: name, data: snap }
        : {
            ok: false,
            toolName: name,
            code: "unavailable",
            message: "No Chrome tab has been pushed yet",
          };
    }
    if (name === "browser.extract_identifiers") {
      return {
        ok: true,
        toolName: name,
        data: snap?.identifiers ?? {},
      };
    }
    if (name === "browser.extract_pdf") {
      return {
        ok: true,
        toolName: name,
        data: { pdfUrl: snap?.identifiers.pdfUrl ?? "" },
      };
    }
    if (name === "browser.extract_readable_text") {
      return {
        ok: true,
        toolName: name,
        data: { text: snap?.readableText ?? "" },
      };
    }
    if (name === "browser.import_current_page") {
      const identifier =
        snap?.identifiers.doi ||
        snap?.identifiers.arxiv ||
        snap?.identifiers.pmid ||
        snap?.url;
      if (!identifier) {
        return {
          ok: false,
          toolName: name,
          code: "unavailable",
          message: "No identifier on the active tab",
        };
      }
      const imported = await this.host.execute("add_item", {
        ...args,
        identifier,
      });
      return { ...imported, toolName: name };
    }
    return {
      ok: false,
      toolName: name,
      code: "not_found",
      message: `Unknown browser tool: ${name}`,
    };
  }
}

const MEMORY_TOOL_NAMES = new Set<string>([
  ...MEMORY_READ_TOOLS,
  ...MEMORY_WRITE_TOOLS,
]);
