import type { ConfuciusEvent } from "./events";
import type { ToolResult } from "./tools";

export type ReasoningFold = "preview" | "open" | "compact";

export interface TimelineToolCall {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  progress?: string;
}

export type TimelineBlock =
  | { kind: "user"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tools"; calls: TimelineToolCall[] }
  | {
      kind: "status";
      tone: "memory" | "fail" | "abort";
      text: string;
    };

/** Default is a 3-line preview; first click expands; next click is one line. */
export function nextReasoningFold(
  current?: ReasoningFold | null,
): ReasoningFold {
  if (!current || current === "preview") {
    return "open";
  }
  if (current === "open") {
    return "compact";
  }
  return "open";
}

function flushText(blocks: TimelineBlock[], text: { value: string }): void {
  if (text.value) {
    blocks.push({ kind: "text", text: text.value });
    text.value = "";
  }
}

/**
 * Between formal answers there is at most one thinking group and one
 * tools group: later deltas append instead of opening a new fold.
 */
function flushPending(
  blocks: TimelineBlock[],
  reasoning: { text: string },
  tools: { calls: TimelineToolCall[] },
): void {
  if (reasoning.text) {
    blocks.push({ kind: "reasoning", text: reasoning.text });
    reasoning.text = "";
  }
  if (tools.calls.length) {
    blocks.push({ kind: "tools", calls: tools.calls });
    tools.calls = [];
  }
}

function attachCall(
  tools: TimelineToolCall[],
  callId: string,
): TimelineToolCall | undefined {
  return tools.find((call) => call.callId === callId);
}

/**
 * Collapse a live event stream into TUI blocks. Formal answers stay
 * unfolded; thinking and tool calls each fold into a single group until
 * the next answer.
 */
export function coalesceTimeline(events: ConfuciusEvent[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  const reasoning = { text: "" };
  const text = { value: "" };
  const tools: { calls: TimelineToolCall[] } = { calls: [] };

  const flushAnswer = () => {
    flushPending(blocks, reasoning, tools);
    flushText(blocks, text);
  };

  for (const event of events) {
    if (event.type === "text_delta") {
      flushPending(blocks, reasoning, tools);
      text.value += event.payload.text;
      continue;
    }
    if (event.type === "reasoning_delta") {
      flushText(blocks, text);
      reasoning.text += event.payload.text;
      continue;
    }
    if (event.type === "tool_requested") {
      flushText(blocks, text);
      tools.calls.push({
        callId: event.payload.callId,
        toolName: event.payload.toolName,
        args: event.payload.args,
      });
      continue;
    }
    if (event.type === "tool_result") {
      flushText(blocks, text);
      const existing = attachCall(tools.calls, event.payload.callId);
      if (existing) {
        existing.result = event.payload.result;
        continue;
      }
      tools.calls.push({
        callId: event.payload.callId,
        toolName: event.payload.result.toolName,
        args: {},
        result: event.payload.result,
      });
      continue;
    }
    if (event.type === "tool_progress") {
      const existing = attachCall(tools.calls, event.payload.callId);
      if (existing) {
        existing.progress = event.payload.message;
      }
      continue;
    }
    if (event.type === "turn_started") {
      flushAnswer();
      blocks.push({ kind: "user", text: event.payload.userText });
      continue;
    }
    if (event.type === "memory_updated") {
      flushAnswer();
      blocks.push({
        kind: "status",
        tone: "memory",
        text: `memory ${event.payload.op}${
          event.payload.title ? `: ${event.payload.title}` : ""
        }`,
      });
      continue;
    }
    if (event.type === "turn_failed") {
      flushAnswer();
      blocks.push({
        kind: "status",
        tone: "fail",
        text: event.payload.message,
      });
      continue;
    }
    if (event.type === "turn_aborted") {
      flushAnswer();
      blocks.push({ kind: "status", tone: "abort", text: "Stopped" });
      continue;
    }
  }
  flushAnswer();
  return blocks;
}

export function toolsSummary(calls: TimelineToolCall[]): string {
  const names = calls.map((call) => call.toolName).filter(Boolean);
  return names.join(" · ");
}

export function toolLineStatus(call: TimelineToolCall): string {
  if (!call.result) {
    return call.progress || "…";
  }
  return call.result.ok ? "ok" : call.result.code;
}
