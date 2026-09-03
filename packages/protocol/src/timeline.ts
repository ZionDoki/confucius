import type { ConfuciusEvent, PlanStep } from "./events";
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
  | { kind: "plan"; steps: PlanStep[] }
  | {
      kind: "command";
      callId: string;
      command: string;
      status: "started" | "completed" | "failed";
      output?: string;
      exitCode?: number;
    }
  | {
      kind: "file";
      path: string;
      status: "proposed" | "applied" | "rejected";
      diff?: string;
    }
  | {
      kind: "status";
      tone: "info" | "artifact" | "memory" | "fail" | "abort";
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
    if (event.type === "plan_updated") {
      flushAnswer();
      blocks.push({ kind: "plan", steps: event.payload.steps });
      continue;
    }
    if (event.type === "command_execution") {
      flushAnswer();
      const existing = [...blocks]
        .reverse()
        .find(
          (block): block is Extract<TimelineBlock, { kind: "command" }> =>
            block.kind === "command" && block.callId === event.payload.callId,
        );
      if (existing) Object.assign(existing, event.payload);
      else blocks.push({ kind: "command", ...event.payload });
      continue;
    }
    if (event.type === "file_change") {
      flushAnswer();
      blocks.push({ kind: "file", ...event.payload });
      continue;
    }
    if (event.type === "turn_diff_updated") {
      flushAnswer();
      blocks.push({
        kind: "file",
        path: "Turn diff",
        status: "proposed",
        diff: event.payload.diff,
      });
      continue;
    }
    if (event.type === "artifact_upserted") {
      flushAnswer();
      blocks.push({
        kind: "status",
        tone: "artifact",
        text: `artifact r${event.payload.artifact.revision}: ${event.payload.artifact.title}`,
      });
      continue;
    }
    if (event.type === "runtime_status") {
      flushAnswer();
      blocks.push({
        kind: "status",
        tone: event.payload.runtime.state === "error" ? "fail" : "info",
        text: `${event.payload.runtime.backend}: ${event.payload.runtime.state}${
          event.payload.runtime.message
            ? ` — ${event.payload.runtime.message}`
            : ""
        }`,
      });
      continue;
    }
    if (event.type === "context_drifted") {
      // The workspace context bar owns this interactive notice (including its
      // add/replace actions). Keep the event for audit and integrations, but
      // do not duplicate the same message in the activity stream.
      continue;
    }
    if (event.type === "context_updated") {
      continue;
    }
    if (event.type === "memory_proposed") {
      flushAnswer();
      blocks.push({
        kind: "status",
        tone: "memory",
        text: `memory proposal: ${
          event.payload.proposal.title ?? event.payload.proposal.op
        }`,
      });
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
