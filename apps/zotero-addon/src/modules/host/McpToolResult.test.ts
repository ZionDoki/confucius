import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { durableToolResult, mcpToolResult } from "./McpToolResult";

describe("MCP transient tool media", () => {
  const result = {
    ok: true as const,
    toolName: "inspect_pdf_page",
    data: { page: 2, lineAnchors: [{ text: "Methods" }] },
    transientMedia: [
      {
        type: "image" as const,
        mimeType: "image/png" as const,
        data: "PNG-BASE64-SENTINEL",
      },
    ],
  };

  it("emits the page image as MCP image content, not embedded JSON", () => {
    const converted = mcpToolResult(result);
    assert.equal(converted.isError, false);
    assert.equal(converted.content[0]?.type, "text");
    assert.doesNotMatch(JSON.stringify(converted.content[0]), /SENTINEL/);
    assert.deepEqual(converted.content[1], {
      type: "image",
      mimeType: "image/png",
      data: "PNG-BASE64-SENTINEL",
    });
  });

  it("strips transient media from the durable result", () => {
    const durable = durableToolResult(result);
    assert.doesNotMatch(JSON.stringify(durable), /SENTINEL|transientMedia/);
  });
});
