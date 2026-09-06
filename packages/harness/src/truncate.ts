import type { ToolResult } from "@confucius/protocol";

export const MAX_TOOL_RESULT_CHARS = 20_000;

export function truncateToolResult(
  result: ToolResult,
  maxChars = MAX_TOOL_RESULT_CHARS,
): ToolResult {
  if (result.ok && result.data && typeof result.data === "object") {
    const data = result.data as Record<string, unknown>;
    if (
      result.toolName === "get_annotations" &&
      Array.isArray(data.annotations)
    ) {
      // Review actual saved text/comments without repeating geometry and every
      // historical candidate. Keep source identity so later review is auditable.
      return {
        ...result,
        data: {
          ...data,
          annotations: data.annotations.map((value) => {
            const { position: _position, ...annotation } = value as Record<
              string,
              unknown
            >;
            return annotation;
          }),
          proposals: Array.isArray(data.proposals)
            ? data.proposals.map((value) => {
                const proposal = value as Record<string, unknown>;
                return {
                  ...proposal,
                  entries: Array.isArray(proposal.entries)
                    ? proposal.entries.map((value) => {
                        const { draft: _draft, ...entry } = value as Record<
                          string,
                          unknown
                        >;
                        return entry;
                      })
                    : proposal.entries,
                };
              })
            : data.proposals,
        },
      };
    }
    if (result.toolName === "inspect_pdf_page") {
      // One complete spatial page is needed to interpret all table headers.
      return result;
    }
    // The provider already bounds this text and returns an exact continuation
    // offset. A second truncation would silently skip part of the report.
    if (result.toolName === "artifact_read") return result;
    if (
      ["propose_annotations", "propose_highlights"].includes(result.toolName) &&
      Array.isArray(data.annotations)
    ) {
      // The original candidate text remains in the assistant call. Preserve all
      // feedback and its input index without echoing every quote and comment.
      const { highlights: _legacyEcho, ...receipt } = data;
      return {
        ...result,
        data: {
          ...receipt,
          annotations: data.annotations.map((value, index) => {
            const entry = value as Record<string, unknown>;
            const {
              id,
              type,
              page,
              status,
              annotationKey,
              error,
              reviewIssue,
            } = entry;
            return {
              inputIndex: index + 1,
              id,
              type,
              page,
              status,
              annotationKey,
              error,
              reviewIssue,
            };
          }),
        },
      };
    }
    // A saved document is already durable. Return its receipt, not another copy
    // of the entire authored body in every subsequent model request.
    if (
      ["artifact_upsert", "artifact_patch"].includes(result.toolName) &&
      data.artifact
    ) {
      const artifact = data.artifact as Record<string, unknown>;
      const {
        body: _body,
        citations,
        revisions: _revisions,
        ...receipt
      } = artifact;
      return {
        ...result,
        data: {
          ...data,
          artifact: receipt,
          citationCount: Array.isArray(citations)
            ? citations.length
            : (data.citationCount ?? 0),
          contentStored: true,
        },
      };
    }
    // Cutting serialized JSON in the middle of a page hides both the page
    // boundary and the unread tail. Keep whole pages and advertise continuation.
    if (result.toolName === "get_pages" && Array.isArray(data.pages)) {
      const pages: unknown[] = [];
      let used = JSON.stringify({ ...data, pages: [] }).length + 500;
      for (const page of data.pages) {
        const size = JSON.stringify(page).length;
        // One complete page takes precedence over this soft size limit.
        if (pages.length && used + size > maxChars) break;
        pages.push(page);
        used += size;
      }
      const omitted = data.pages[pages.length] as { page?: number } | undefined;
      return {
        ...result,
        data: {
          ...data,
          pages,
          truncated: Boolean(data.truncated) || Boolean(omitted),
          nextPage: omitted?.page ?? data.nextPage ?? null,
        },
      };
    }
  }
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
