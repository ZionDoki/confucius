import {
  coalesceTimeline,
  type ConfuciusEvent,
  type ModelRequestProgress,
  type TimelineBlock,
} from "@confucius/protocol";

/** Keys are local to a durable turn, so new text and earlier tool results do not replace unrelated turns. */
export function keyedTimeline(
  events: ConfuciusEvent[],
): Array<{ key: string; block: TimelineBlock }> {
  const groups: Array<{ id: string; events: ConfuciusEvent[] }> = [];
  for (const event of events) {
    const last = groups.at(-1);
    const id = event.turnId ?? last?.id ?? event.id;
    if (last?.id === id) last.events.push(event);
    else groups.push({ id, events: [event] });
  }
  return groups.flatMap((group) => {
    const counts = new Map<string, number>();
    return coalesceTimeline(group.events).map((block) => {
      const count = counts.get(block.kind) ?? 0;
      counts.set(block.kind, count + 1);
      const id =
        block.kind === "artifact"
          ? `${block.artifact.id}:${block.artifact.revision}`
          : block.kind === "tools"
            ? block.calls[0]?.callId
            : block.kind === "command"
              ? block.callId
              : count;
      return { key: `${group.id}:${block.kind}:${id}`, block };
    });
  });
}

/** Keep unchanged DOM, open details, selection, and focused controls while the stream grows. */
export function reconcileActivity(
  current: HTMLElement,
  next: HTMLElement,
): void {
  const old = new Map(
    Array.from(current.children).map((node) => [
      (node as HTMLElement).dataset.entryId,
      node as HTMLElement,
    ]),
  );
  let cursor: Node | null = current.firstChild;
  for (const fresh of Array.from(next.children) as HTMLElement[]) {
    const previous = fresh.dataset.entryId
      ? old.get(fresh.dataset.entryId)
      : undefined;
    let chosen = fresh;
    if (previous) {
      // Generated signatures exclude transient state such as an opened details element.
      const signature = String(fresh.outerHTML);
      if (
        previous.dataset.renderSignature === signature ||
        (previous.contains(current.ownerDocument?.activeElement ?? null) &&
          previous.dataset.proposalStatus === fresh.dataset.proposalStatus)
      ) {
        chosen = previous;
      } else {
        const details = previous.querySelectorAll("details");
        fresh
          .querySelectorAll("details")
          .forEach((detail: HTMLDetailsElement, index: number) => {
            detail.open =
              (details[index] as HTMLDetailsElement | undefined)?.open ??
              detail.open;
          });
        fresh.dataset.renderSignature = signature;
      }
    } else fresh.dataset.renderSignature = String(fresh.outerHTML);
    if (chosen !== cursor) current.insertBefore(chosen, cursor);
    cursor = chosen.nextSibling;
  }
  while (cursor) {
    const nextNode = cursor.nextSibling;
    current.removeChild(cursor);
    cursor = nextNode;
  }
}

export function turnAwaitingReply(events: readonly ConfuciusEvent[]): boolean {
  let turnId: string | undefined;
  for (const event of events) {
    if (event.type === "turn_started") turnId = event.turnId;
    else if (
      event.turnId === turnId &&
      ["turn_completed", "turn_aborted", "turn_failed"].includes(event.type)
    )
      turnId = undefined;
  }
  return !!turnId;
}

/** Retry status belongs to the working indicator, never to model reasoning. */
export function retryActivity(
  events: readonly ConfuciusEvent[],
  english: boolean,
  now = Date.now(),
): string | undefined {
  let turnId: string | undefined;
  let progress: ModelRequestProgress | undefined;
  let since = now;
  for (const event of events) {
    if (event.type === "turn_started") {
      turnId = event.turnId;
      progress = undefined;
    }
    if (!turnId || event.turnId !== turnId) continue;
    if (
      ["turn_completed", "turn_aborted", "turn_failed"].includes(event.type)
    ) {
      turnId = undefined;
      progress = undefined;
      continue;
    }
    if (event.type === "model_request_progress" && !event.payload.purpose) {
      const next = event.payload;
      if (
        next.status === "completed" ||
        (next.status === "started" && next.attempt === 1 && !next.stage)
      )
        progress = undefined;
      else {
        progress = next;
        since = event.ts;
      }
    } else if (
      event.type === "tool_requested" ||
      event.type === "tool_result" ||
      (event.type === "text_delta" &&
        event.origin !== "host" &&
        event.payload.text) ||
      (event.type === "reasoning_delta" &&
        event.payload.text &&
        !event.payload.statusText)
    ) {
      progress = undefined;
    }
  }
  if (!progress) return undefined;
  return formatRetry(progress, since, english, now);
}

function formatRetry(
  progress: ModelRequestProgress,
  since: number,
  english: boolean,
  now: number,
): string {
  let label: string;
  if (
    progress.exhausted ||
    (progress.status === "failed" && !progress.retryable)
  )
    label = english
      ? "Retry failed · Saving progress"
      : "重试失败 · 正在保留进度";
  else if (progress.stage === "recovering")
    label = english
      ? "Restoring connection · Keeping saved results"
      : "正在恢复连接 · 保留已保存成果";
  else if (progress.status === "failed")
    label = english
      ? "Connection interrupted · Retrying"
      : "连接中断 · 正在重试";
  else label = english ? "Retrying request" : "正在重试请求";
  const attempts = progress.maxAttempts
    ? `${progress.attempt}/${progress.maxAttempts}`
    : String(progress.attempt);
  const delay =
    progress.delayMs === undefined
      ? 0
      : Math.max(0, Math.ceil((since + progress.delayMs - now) / 1000));
  const elapsed = Math.max(0, Math.floor((now - since) / 1000));
  return `${label} · ${attempts}${delay ? (english ? ` · in ${delay}s` : ` · ${delay} 秒后`) : ""} · ${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
}

/** Context maintenance can continue after the reply; keep it in the same loading area. */
export function contextActivity(
  events: readonly ConfuciusEvent[],
  english: boolean,
  now = Date.now(),
): string | undefined {
  const labels = {
    searching: english ? "Searching context" : "正在检索上下文",
    reading: english ? "Reading context" : "正在读取上下文",
    distilling: english ? "Distilling memory" : "正在提炼记忆",
    clearing: english ? "Clearing old work" : "正在清理旧记录",
    switching: english ? "Switching context" : "正在切换上下文",
  };
  let active: keyof typeof labels | undefined;
  let callId: string | undefined;
  let since = now;
  let retry: ModelRequestProgress | undefined;
  let retrySince = now;
  for (const event of events) {
    if (event.type === "turn_started") {
      active = undefined;
      retry = undefined;
    }
    if (event.type === "context_progress") {
      if (event.payload.status === "started") {
        active = event.payload.stage;
        since = event.ts;
        retry = undefined;
      } else if (active === event.payload.stage) {
        active = undefined;
        retry = undefined;
      }
    }
    if (event.type === "tool_requested") {
      const stage =
        event.payload.toolName === "context_search"
          ? "searching"
          : event.payload.toolName === "context_read"
            ? "reading"
            : event.payload.toolName === "new_context"
              ? "switching"
              : undefined;
      if (stage) {
        active = stage;
        callId = event.payload.callId;
        since = event.ts;
      }
    }
    if (event.type === "tool_result" && event.payload.callId === callId) {
      active = undefined;
      callId = undefined;
    }
    if (
      active &&
      event.type === "model_request_progress" &&
      event.payload.purpose === "memory"
    ) {
      retry =
        event.payload.status === "completed" ||
        (event.payload.status === "started" && event.payload.attempt === 1)
          ? undefined
          : event.payload;
      retrySince = event.ts;
    }
    if (["turn_failed", "turn_aborted"].includes(event.type)) {
      active = undefined;
      retry = undefined;
    }
  }
  if (!active) return undefined;
  if (retry)
    return `${labels[active]} · ${formatRetry(retry, retrySince, english, now)}`;
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${labels[active]} · ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
