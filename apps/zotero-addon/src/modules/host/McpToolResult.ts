import type { ToolFailure, ToolSuccess } from "@confucius/protocol";

export interface McpToolCallResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError: boolean;
}

/** Keep media available to MCP vision clients while excluding it from text. */
export function mcpToolResult(
  result: ToolSuccess<unknown> | ToolFailure,
): McpToolCallResult {
  const durable = durableToolResult(result);
  return {
    content: [
      { type: "text", text: JSON.stringify(durable, null, 2) },
      ...(result.ok
        ? (result.transientMedia ?? []).map((media) => ({
            type: "image" as const,
            data: media.data,
            mimeType: media.mimeType,
          }))
        : []),
    ],
    isError: !result.ok,
  };
}

export function durableToolResult(
  result: ToolSuccess<unknown> | ToolFailure,
): ToolSuccess<unknown> | ToolFailure {
  if (!result.ok || !result.transientMedia) return result;
  const { transientMedia: _transientMedia, ...durable } = result;
  return durable;
}
