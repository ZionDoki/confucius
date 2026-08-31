import type { ToolResult } from "@confucius/protocol";

export const MAX_TOOL_RESULT_CHARS = 20_000;

export function truncateToolResult(
  result: ToolResult,
  maxChars = MAX_TOOL_RESULT_CHARS,
): ToolResult {
  const encoded = JSON.stringify(result);
  if (encoded.length <= maxChars) {
    return result;
  }
  if (!result.ok) {
    return {
      ...result,
      message: result.message.slice(0, maxChars),
      details: { truncated: true, originalChars: encoded.length },
    };
  }
  const preview = JSON.stringify(result.data).slice(0, maxChars);
  return {
    ok: true,
    toolName: result.toolName,
    data: {
      truncated: true,
      preview,
      originalChars: encoded.length,
    },
  };
}
