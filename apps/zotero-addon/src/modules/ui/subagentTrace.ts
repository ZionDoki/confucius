import {
  SUBAGENT_TOOL_NAMES,
  type ConfuciusEvent,
  type TimelineToolCall,
} from "@confucius/protocol";

export interface SubagentTraceGroup {
  key: string;
  kind: "tool" | "message" | "model" | "event";
  label: string;
  state: "running" | "completed" | "failed" | "interrupted";
  text: string;
  events: ConfuciusEvent[];
}

/** Delegate activity has its own entry. Failed calls still explain why no child appeared. */
export function ordinaryTimelineCalls(calls: TimelineToolCall[]) {
  return calls.filter(
    (call) =>
      !SUBAGENT_TOOL_NAMES.has(call.toolName) || call.result?.ok === false,
  );
}

export function subagentWaitProgress(events: ConfuciusEvent[], ids?: string[]) {
  const statuses = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "subagent_updated") continue;
    const child = event.payload.subagent;
    if (!ids?.length || ids.includes(child.id))
      statuses.set(child.id, child.status);
  }
  return {
    total: statuses.size,
    settled: [...statuses.values()].filter(
      (status) => status !== "queued" && status !== "running",
    ).length,
  };
}

/** Group related receipts and stream chunks without dropping any recorded event. */
export function subagentTraceGroups(
  events: ConfuciusEvent[],
): SubagentTraceGroup[] {
  const groups: SubagentTraceGroup[] = [],
    calls = new Map<string, SubagentTraceGroup>();
  let message: SubagentTraceGroup | undefined;
  let execution = 0;
  for (const [index, event] of events.entries()) {
    if (event.type === "turn_started") {
      execution++;
      for (const group of groups)
        if (group.state === "running") group.state = "interrupted";
    }
    const p = event.payload;
    const tool =
      event.type === "tool_requested" ||
      event.type === "tool_result" ||
      event.type === "tool_progress";
    const model = event.type === "model_request_progress";
    const key = tool
      ? `${execution}:${event.turnId}:tool:${(p as { callId: string }).callId}`
      : model
        ? `${execution}:${event.turnId}:model:${event.payload.requestId}:${event.payload.attempt}`
        : `event:${event.id ?? index}`;
    if (event.type === "text_delta") {
      const phase = event.payload.phase ?? "output";
      if (
        !message ||
        message.label !== phase ||
        message.events.at(-1)?.turnId !== event.turnId
      ) {
        message = {
          key,
          kind: "message",
          label: phase,
          state: "completed",
          text: "",
          events: [],
        };
        groups.push(message);
      }
      message.text += event.payload.text;
      message.events.push(event);
      continue;
    }
    message = undefined;
    let group = tool || model ? calls.get(key) : undefined;
    if (!group) {
      group = {
        key,
        kind: tool ? "tool" : model ? "model" : "event",
        label: event.type,
        state: "completed",
        text: "",
        events: [],
      };
      groups.push(group);
      if (tool || model) calls.set(key, group);
    }
    group.events.push(event);
    if (event.type === "tool_requested") {
      group.label = event.payload.toolName;
      group.state = "running";
    } else if (event.type === "tool_result") {
      group.label = event.payload.result.toolName;
      group.state = event.payload.result.ok ? "completed" : "failed";
      group.text = event.payload.result.ok ? "" : event.payload.result.message;
    } else if (event.type === "tool_progress") {
      if (group.state !== "failed") group.text = event.payload.message;
    } else if (event.type === "model_request_progress") {
      group.state =
        event.payload.status === "started" ? "running" : event.payload.status;
      group.text = event.payload.message ?? "";
    } else if (event.type === "turn_failed") {
      group.state = "failed";
      group.text = event.payload.message;
    } else if (event.type === "turn_aborted") {
      group.state = "failed";
      group.text = event.payload.reason ?? "";
    }
  }
  return groups;
}
