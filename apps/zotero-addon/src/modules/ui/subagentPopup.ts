import type {
  ConfuciusEvent,
  SubagentRecord,
  SubagentSummary,
} from "@confucius/protocol";
import { createWorkspaceButton } from "./workspaceControls";
import { researchIcon } from "./literaturePanel";
import { getString } from "../../utils/locale";
type Rpc = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;
const text = (key: string) => getString(`workspace-subagent-${key}`);
const NS = "http://www.w3.org/1999/xhtml";
export function createSubagentEntries(
  doc: Document,
  taskId: string,
  record: SubagentSummary,
  rpc: Rpc,
) {
  const root = doc.createElementNS(NS, "div") as HTMLElement;
  root.className = "confucius-subagent-entries";
  const button = createWorkspaceButton(
    doc,
    "",
    `${record.title} · ${text(record.status)}`,
  );
  button.setAttribute("aria-haspopup", "dialog");
  button.dataset.subagentId = record.id;
  button.classList.add("confucius-subagent-entry");
  button.prepend(researchIcon(doc, "agent"));
  button.addEventListener("click", () =>
    openSubagentPopup(doc, taskId, record.id, button, rpc),
  );
  root.append(button);
  return root;
}
export function closeSubagentPopup(doc: Document) {
  (
    doc.getElementById("confucius-subagent-popup") as
      (HTMLElement & { close?: () => void }) | null
  )?.close?.();
}
function openSubagentPopup(
  doc: Document,
  taskId: string,
  id: string,
  anchor: HTMLElement,
  rpc: Rpc,
) {
  closeSubagentPopup(doc);
  const popup = doc.createElementNS(NS, "section") as HTMLElement & {
    close?: () => void;
  };
  popup.id = "confucius-subagent-popup";
  popup.className = "confucius-subagent-popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", text("title"));
  popup.tabIndex = -1;
  const heading = doc.createElementNS(NS, "h3"),
    body = doc.createElementNS(NS, "div"),
    activities = doc.createElementNS(NS, "div"),
    status = doc.createElementNS(NS, "div");
  body.className = "confucius-subagent-result";
  status.setAttribute("role", "status");
  const stop = createWorkspaceButton(doc, "", text("stop")),
    retry = createWorkspaceButton(doc, "", text("retry")),
    close = createWorkspaceButton(doc, "", text("close")),
    more = createWorkspaceButton(doc, "", text("more"));
  const controls = doc.createElementNS(NS, "div");
  controls.className = "confucius-literature-controls";
  controls.append(stop, retry, close);
  popup.append(heading, controls, status, body, activities, more);
  (doc.body ?? doc.documentElement!).append(popup);
  const currentAnchor = () => {
    if (!anchor.isConnected) {
      const replacement = (
        Array.from(
          doc.querySelectorAll(".confucius-subagent-entry"),
        ) as HTMLElement[]
      ).find((node) => node.dataset.subagentId === id);
      if (replacement) anchor = replacement;
    }
    return anchor;
  };
  const position = () => {
    const rect = currentAnchor().getBoundingClientRect();
    const viewportWidth = doc.defaultView?.innerWidth ?? 440;
    const viewportHeight = doc.defaultView?.innerHeight ?? 700;
    const width = Math.min(420, viewportWidth - 16);
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - width - 8))}px`;
    const height = Math.min(popup.scrollHeight, viewportHeight - 16);
    const top =
      rect.bottom + 8 + height <= viewportHeight - 8
        ? rect.bottom + 8
        : Math.max(8, rect.top - height - 8);
    popup.style.top = `${Math.min(top, viewportHeight - height - 8)}px`;
  };
  position();
  doc.defaultView?.addEventListener("resize", position);
  let closed = false,
    timer: number | undefined,
    offset = 0,
    next: number | null = null,
    request = 0;
  const dismiss = (restoreFocus = true) => {
    closed = true;
    request++;
    doc.defaultView?.clearTimeout(timer);
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", key, true);
    doc.defaultView?.removeEventListener("resize", position);
    popup.remove();
    if (restoreFocus && currentAnchor().isConnected)
      anchor.focus({ preventScroll: true });
  };
  const outside = (event: Event) => {
    if (
      !popup.contains(event.target as Node) &&
      !currentAnchor().contains(event.target as Node)
    )
      dismiss(false);
  };
  const key = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.key === "Escape" && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  };
  popup.close = () => dismiss();
  close.addEventListener("click", () => dismiss());
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", key, true);
  const load = async () => {
    doc.defaultView?.clearTimeout(timer);
    const sequence = ++request;
    try {
      const value = (await rpc("subagent/read", { taskId, id, offset })) as {
        record: SubagentRecord;
        events: ConfuciusEvent[];
        nextOffset: number | null;
      };
      if (closed || request !== sequence) return;
      heading.textContent = value.record.title;
      status.textContent = value.record.error ?? text(value.record.status);
      // Public result only; reasoning_delta is never retained in the child UI archive.
      if (!doc.getSelection()?.toString())
        body.textContent = value.record.result || value.record.goal;
      activities.replaceChildren();
      for (const event of value.events) {
        const line = doc.createElementNS(NS, "div");
        if (event.type === "tool_requested")
          line.textContent = `${text("tool")}: ${event.payload.toolName}`;
        else if (event.type === "tool_progress")
          line.textContent = event.payload.message;
        else if (event.type === "turn_failed")
          line.textContent = event.payload.message;
        else if (
          event.type === "text_delta" &&
          event.payload.phase === "commentary"
        )
          line.textContent = event.payload.text;
        if (line.textContent) activities.append(line);
      }
      next = value.nextOffset;
      more.hidden = next === null;
      stop.hidden = !["queued", "running"].includes(value.record.status);
      retry.hidden = !["failed", "cancelled", "interrupted"].includes(
        value.record.status,
      );
      position();
      if (!stop.hidden)
        timer = doc.defaultView?.setTimeout(() => void load(), 1500);
    } catch (error) {
      if (!closed && request === sequence) status.textContent = String(error);
    }
  };
  stop.addEventListener("click", () => {
    void rpc("subagent/cancel", { taskId, id })
      .then(load)
      .catch((e) => {
        status.textContent = String(e);
      });
  });
  retry.addEventListener("click", () => {
    void rpc("subagent/retry", { taskId, id })
      .then(load)
      .catch((e) => {
        status.textContent = String(e);
      });
  });
  more.addEventListener("click", () => {
    if (next !== null) {
      offset = next;
      void load();
    }
  });
  popup.focus({ preventScroll: true });
  void load();
}
