import {
  coalesceTimeline,
  type ConfuciusEvent,
  type ModelRequestProgress,
  type TimelineBlock,
} from "@confucius/protocol";

/** The RPC and durable timeline can report the same failed submission. */
export function sendErrorInTimeline(
  message: string,
  events: readonly ConfuciusEvent[],
  afterEventId: string | null | undefined,
): boolean {
  if (!message || afterEventId === undefined) return false;
  const boundary = afterEventId
    ? events.findIndex((event) => event.id === afterEventId)
    : -1;
  if (afterEventId && boundary < 0) return false;
  return events
    .slice(boundary + 1)
    .some(
      (event) =>
        event.type === "turn_failed" && event.payload.message === message,
    );
}

/** Only the final elapsed clock stays outside the animated status text. */
export function waitingTextParts(text: string): {
  message: string;
  elapsed: string;
} {
  const match = text.match(/^(.*) · (\d+:[0-5]\d)$/s);
  return match
    ? { message: match[1], elapsed: match[2] }
    : { message: text, elapsed: "" };
}

export function createWaitingIndicator(
  doc: Document,
  workText: string,
): HTMLElement {
  const create = (tag: string) =>
    doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
  const label = create("div");
  label.className = "tui-waiting";
  const mark = create("span");
  mark.className = "tui-waiting-mark";
  mark.setAttribute("aria-hidden", "true");
  // Keep an actual glyph below the decorative mask. A stale palette or a
  // failed chrome image must never erase the working indicator.
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("width", "19");
  svg.setAttribute("height", "19");
  svg.setAttribute("focusable", "false");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M200 76 A 90 90 0 1 0 200 180 Q 187 178 173 164 A 58 58 0 1 1 173 92 Q 187 80 200 76 Z",
  );
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  const metal = create("span");
  metal.className = "tui-waiting-metal";
  mark.append(svg, metal);
  const content = create("span");
  content.className = "tui-waiting-content";
  const message = create("span");
  message.className = "tui-waiting-message";
  const text = create("span");
  text.className = "tui-waiting-text";
  text.setAttribute("role", "status");
  const shine = create("span");
  shine.className = "tui-waiting-shine";
  shine.setAttribute("aria-hidden", "true");
  message.append(text, shine);
  const elapsed = create("span");
  elapsed.className = "tui-waiting-elapsed";
  content.append(message, elapsed);
  label.append(mark, content);
  updateWaitingIndicator(label, workText);
  return label;
}

/** Preserve both animated elements while polling, streaming, and changing stages. */
export function updateWaitingIndicator(
  label: HTMLElement,
  workText: string,
): void {
  if (label.dataset.waitingText === workText) return;
  label.dataset.waitingText = workText;
  const parts = waitingTextParts(workText);
  const text = label.querySelector(".tui-waiting-text");
  if (text && text.textContent !== parts.message)
    text.textContent = parts.message;
  const shine = label.querySelector(".tui-waiting-shine");
  if (shine && shine.textContent !== parts.message)
    shine.textContent = parts.message;
  const elapsed = label.querySelector<HTMLElement>(".tui-waiting-elapsed");
  if (elapsed) {
    const clock = parts.elapsed ? ` · ${parts.elapsed}` : "";
    if (elapsed.textContent !== clock) elapsed.textContent = clock;
    elapsed.hidden = !parts.elapsed;
  }
}

/** Keys are local to a durable turn, so new text and earlier tool results do not replace unrelated turns. */
export function keyedTimeline(
  events: ConfuciusEvent[],
  executionEnded = false,
): Array<{ key: string; block: TimelineBlock }> {
  const groups: Array<{
    id: string;
    turnId: string;
    events: ConfuciusEvent[];
  }> = [];
  const starts = new Set<string>();
  const research = new Set<string>();
  const children = new Map(
    events.flatMap((event) =>
      event.type === "subagent_updated"
        ? [[event.payload.subagent.id, event.payload.subagent] as const]
        : [],
    ),
  );
  for (const event of events) {
    const researchKey =
      event.type === "literature_updated" && event.payload.summary.latestQuery
        ? `literature:${event.payload.summary.latestQuery.id}`
        : event.type === "subagent_updated"
          ? `subagent:${event.payload.subagent.id}`
          : undefined;
    if (researchKey && research.has(researchKey)) continue;
    if (researchKey) research.add(researchKey);
    const entry =
      event.type === "subagent_updated"
        ? {
            ...event,
            payload: { subagent: children.get(event.payload.subagent.id)! },
          }
        : event;
    const last = groups.at(-1);
    const turnId = event.turnId ?? last?.turnId ?? event.id;
    if (last?.turnId === turnId && event.type !== "turn_started")
      last.events.push(entry);
    else {
      const id = starts.has(turnId) ? `${turnId}:${event.id}` : turnId;
      starts.add(turnId);
      groups.push({ id, turnId, events: [entry] });
    }
  }
  const lastStart = groups.findLastIndex(
    (group) => group.events[0]?.type === "turn_started",
  );
  return groups.flatMap((group, index) => {
    const counts = new Map<string, number>();
    const ended =
      executionEnded ||
      index < lastStart ||
      group.events.some(
        (event) =>
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_aborted",
      );
    return coalesceTimeline(group.events).map((block) => {
      if (ended && block.kind === "tools")
        for (const call of block.calls)
          if (!call.result) call.interrupted = true;
      const count = counts.get(block.kind) ?? 0;
      counts.set(block.kind, count + 1);
      const id =
        block.kind === "literature"
          ? block.query.id
          : block.kind === "subagent"
            ? block.subagent.id
            : block.kind === "artifact"
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

// A closed disclosure's DOM does not contain its pending/received tool data.
// Keep semantic signatures outside the DOM so full receipts aren't duplicated
// into attributes, and so reconciliation cannot retain a stale lazy closure.
const activitySignatures = new WeakMap<HTMLElement, string>();
export function setActivitySignature(node: HTMLElement, signature: string) {
  activitySignatures.set(node, signature);
}
function activitySignature(node: HTMLElement): string {
  return activitySignatures.get(node) ?? String(node.outerHTML);
}

/** Keep unchanged DOM, open details, selection, and focused controls while the stream grows. */
export function reconcileActivity(
  current: HTMLElement,
  next: HTMLElement,
  preserveSelection = true,
): void {
  const focused = current.ownerDocument?.activeElement as HTMLElement | null;
  const selection = current.ownerDocument?.getSelection?.();
  let restoreFocus: HTMLElement | undefined;
  const old = new Map(
    Array.from(current.children).map((node) => [
      (node as HTMLElement).dataset.entryId,
      node as HTMLElement,
    ]),
  );
  const desired: HTMLElement[] = [];
  for (const fresh of Array.from(next.children) as HTMLElement[]) {
    const previous = fresh.dataset.entryId
      ? old.get(fresh.dataset.entryId)
      : undefined;
    let chosen = fresh;
    if (previous) {
      const waiting =
        fresh.dataset.entryId === "waiting"
          ? previous.querySelector<HTMLElement>(".tui-waiting")
          : null;
      const nextWaiting = waiting
        ? fresh.querySelector<HTMLElement>(".tui-waiting")
        : null;
      // Generated signatures exclude transient state such as an opened details element.
      const signature = activitySignature(fresh);
      const conversationControl =
        focused &&
        previous.contains(focused) &&
        ((focused.matches("summary") &&
          focused.parentElement?.getAttribute("data-disclosure-key")) ||
          focused.matches(".confucius-reasoning-toggle"));
      if (
        fresh.dataset.literatureAnchor &&
        previous.dataset.literatureAnchor === fresh.dataset.literatureAnchor
      ) {
        // The literature controller owns this subtree, including its editor.
        chosen = previous;
      } else if (waiting && nextWaiting) {
        updateWaitingIndicator(waiting, nextWaiting.dataset.waitingText ?? "");
        chosen = previous;
      } else if (
        activitySignatures.get(previous) === signature ||
        (preserveSelection &&
          selection?.toString() &&
          previous.contains(selection.anchorNode)) ||
        (!conversationControl &&
          previous.contains(focused) &&
          previous.dataset.proposalStatus === fresh.dataset.proposalStatus)
      ) {
        chosen = previous;
      } else {
        const details = previous.querySelectorAll("details");
        fresh
          .querySelectorAll("details")
          .forEach((detail: HTMLDetailsElement, index: number) => {
            // Shared conversation disclosures restore by call identity, not row order.
            if (detail.dataset.disclosureKey) return;
            detail.open =
              (details[index] as HTMLDetailsElement | undefined)?.open ??
              detail.open;
          });
        activitySignatures.set(fresh, signature);
        if (conversationControl) {
          const key = focused?.parentElement?.getAttribute(
            "data-disclosure-key",
          );
          restoreFocus = key
            ? (
                Array.from(fresh.querySelectorAll("summary")) as HTMLElement[]
              ).find(
                (summary) =>
                  summary.parentElement?.getAttribute("data-disclosure-key") ===
                  key,
              )
            : (fresh.querySelector<HTMLElement>(
                ".confucius-reasoning-toggle",
              ) ?? undefined);
          // The top-level tools disclosure is itself the activity row.
          if (key === fresh.dataset.disclosureKey)
            restoreFocus =
              fresh.querySelector<HTMLElement>(":scope > summary") ?? undefined;
        }
      }
    } else activitySignatures.set(fresh, activitySignature(fresh));
    desired.push(chosen);
  }
  // Remove replaced rows before placing their successors. Leaving them at the
  // cursor needlessly reparents every later retained row, restarting CSS
  // animations and disturbing focus even when its DOM identity is unchanged.
  const retained = new Set<Node>(desired);
  for (const node of Array.from(current.childNodes))
    if (node && !retained.has(node)) current.removeChild(node);
  let cursor: Node | null = current.firstChild;
  for (const chosen of desired) {
    if (chosen !== cursor) current.insertBefore(chosen, cursor);
    cursor = chosen.nextSibling;
  }
  if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
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
  const cause = retryCause(progress, english);
  let label: string;
  if (
    progress.exhausted ||
    (progress.status === "failed" && !progress.retryable)
  )
    label = `${cause} · ${english ? "Request failed · Saving progress" : "请求失败 · 正在保留进度"}`;
  else if (progress.stage === "recovering")
    label = english
      ? "Restoring task · Keeping saved results"
      : "正在恢复任务 · 保留已保存成果";
  else if (progress.status === "failed")
    label = `${cause} · ${english ? "Retrying" : "正在重试"}`;
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

function retryCause(progress: ModelRequestProgress, english: boolean): string {
  if (progress.code === "server")
    return /HTTP\s+504\b/i.test(progress.message ?? "")
      ? english
        ? "Gateway timeout"
        : "网关超时"
      : english
        ? "Model service error"
        : "模型服务异常";
  if (progress.code === "rate_limit")
    return english ? "Rate limited" : "请求受到限流";
  if (progress.code === "timeout")
    return english ? "Request timed out" : "请求超时";
  if (progress.code === "transport")
    return english ? "Connection interrupted" : "连接中断";
  if (progress.code === "auth")
    return english ? "Authentication failed" : "身份验证失败";
  if (progress.code === "invalid_request")
    return english ? "Invalid model request" : "模型请求无效";
  return english ? "Request error" : "请求异常";
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
    preparing: english ? "Preparing handoff" : "正在准备交接",
    archiving: english ? "Archiving history" : "正在归档历史",
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
