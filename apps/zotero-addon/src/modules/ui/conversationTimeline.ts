import {
  nextReasoningFold,
  toolLineStatus,
  type ReasoningFold,
  type TimelineBlock,
  type TimelineToolCall,
} from "@confucius/protocol";
import { getString } from "../../utils/locale";
import { UI_FONT_STACKS } from "./workspaceTypography";
import { markScrollContainer } from "./workspaceScrollbars";
import { setActivitySignature } from "./workspaceActivity";

export interface ConversationPresentation {
  fillAnswerHtml(node: HTMLElement, text: string): void;
  locateLink(
    doc: Document,
    target: LocateTarget,
    style?: Record<string, string>,
  ): HTMLElement;
}

type Styles = Partial<CSSStyleDeclaration>;
function el(doc: Document, tag: string, style?: Styles): HTMLElement {
  const node = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElement;
  if (style) Object.assign(node.style, style);
  markScrollContainer(node);
  return node;
}
function tuiBlock(doc: Document, style?: Styles): HTMLElement {
  return el(doc, "div", {
    margin: "0 0 8px",
    padding: "0",
    border: "none",
    background: "transparent",
    ...style,
  });
}

/** One presentation for the conversation and its read-only child conversations. */
export function createConversationRenderer(
  presentation: ConversationPresentation,
) {
  const reasoningFold = new Map<string, ReasoningFold>();
  const expanded = new Set<string>();

  function disclosure(
    doc: Document,
    key: string,
    label: string,
    content: () => HTMLElement,
  ) {
    const root = el(doc, "details") as HTMLDetailsElement;
    root.dataset.disclosureKey = key;
    const head = el(doc, "summary");
    head.textContent = label;
    root.append(head);
    const populate = () => {
      if (root.open && !root.querySelector(":scope > div"))
        root.append(content());
    };
    const sync = () => {
      // Gecko queues toggle events. An obsolete/discarded row must not undo a
      // newer user choice after reconciliation or a switch to another child.
      if (!root.isConnected) return;
      if (root.open) expanded.add(key);
      else expanded.delete(key);
      populate();
    };
    root.open = expanded.has(key);
    populate();
    head.addEventListener("click", (event) => {
      if ((event as MouseEvent).button !== 0 || !root.isConnected) return;
      event.preventDefault();
      root.open = !root.open;
      sync();
    });
    // HTML summary activation is inconsistent in Zotero's chrome documents.
    // Handle both activation keys explicitly, preserving the same synchronous
    // state update as a pointer click and suppressing native double activation.
    head.addEventListener("keydown", (event) => {
      const key = event as KeyboardEvent;
      if (
        key.isComposing ||
        key.altKey ||
        key.ctrlKey ||
        key.metaKey ||
        !["Enter", " "].includes(key.key)
      )
        return;
      key.preventDefault();
      if (!key.repeat) head.click();
    });
    root.addEventListener("toggle", sync);
    return root;
  }

  function reasoning(doc: Document, text: string, key: string, label: string) {
    const row = tuiBlock(doc, {
      color: "var(--confucius-muted)",
      fontSize: "0.93em",
      padding: "0 4px",
    });
    row.className = "confucius-reasoning";
    const head = el(doc, "button") as HTMLButtonElement;
    head.type = "button";
    head.className = "confucius-reasoning-toggle";
    const body = el(doc, "div");
    body.className = "confucius-reasoning-body";
    const inner = el(doc, "div", { whiteSpace: "pre-wrap" });
    inner.textContent = text;
    body.append(inner);
    const update = () => {
      const fold = reasoningFold.get(key) ?? "preview";
      const open = fold === "open";
      row.dataset.fold = fold;
      head.textContent = `${open ? "▾" : "▸"} ${label}`;
      head.setAttribute("aria-expanded", String(open));
      body.style.maxHeight = open
        ? ""
        : fold === "preview"
          ? "4.4em"
          : "1.45em";
      body.style.overflow = open ? "visible" : "hidden";
    };
    head.addEventListener("click", () => {
      reasoningFold.set(key, nextReasoningFold(reasoningFold.get(key)));
      update();
    });
    row.append(head, body);
    update();
    return row;
  }

  function tools(doc: Document, calls: TimelineToolCall[], key: string) {
    const wrap = disclosure(
      doc,
      key,
      `${calls.length} ${getString("workspace-tui-tools")}  ${[...new Set(calls.map((call) => call.toolName))].join(" · ")}`,
      () => {
        const list = el(doc, "div");
        for (const call of calls) {
          const row = disclosure(
            doc,
            `${key}:${call.callId}`,
            `${call.toolName}  ${call.interrupted ? getString("workspace-subagent-interrupted") : toolLineStatus(call)}`,
            () => {
              const content = el(doc, "div");
              for (const [label, value] of [
                [getString("workspace-subagent-arguments"), call.args],
                [
                  getString("workspace-subagent-receipt"),
                  call.result ?? call.progress,
                ],
              ] as const) {
                if (value === undefined) continue;
                const title = el(doc, "div");
                title.className = "confucius-tool-label";
                title.textContent = label;
                const pre = el(doc, "pre");
                pre.textContent =
                  typeof value === "string"
                    ? value
                    : JSON.stringify(value, null, 2);
                content.append(title, pre);
              }
              const locate = call.result?.ok
                ? locateFromData(call.result.data)
                : null;
              if (locate) content.append(presentation.locateLink(doc, locate));
              return content;
            },
          );
          row.className = "confucius-tool-call";
          row.dataset.callId = call.callId;
          row.dataset.state = call.result
            ? call.result.ok
              ? "completed"
              : "failed"
            : call.interrupted
              ? "interrupted"
              : "running";
          list.append(row);
        }
        return list;
      },
    );
    wrap.className = "confucius-tools";
    wrap.style.fontFamily = UI_FONT_STACKS.mono;
    setActivitySignature(
      wrap,
      JSON.stringify([wrap.firstChild?.textContent, calls]),
    );
    return wrap;
  }

  function render(
    targetDoc: Document,
    block: TimelineBlock,
    key: string,
  ): HTMLElement | null {
    if (block.kind === "user") {
      const row = el(targetDoc, "div");
      row.className = "confucius-user-message";
      row.textContent = block.text;
      return row;
    }
    if (block.kind === "text") {
      const shell = tuiBlock(targetDoc, {
        color: "var(--confucius-ink)",
        fontSize: "1.08em",
        lineHeight: "1.7",
        margin: "6px 0 14px",
        padding: "2px 4px",
        maxWidth: "78ch",
      });
      shell.className = "confucius-answer-shell";
      if (block.turnId) shell.dataset.turnId = block.turnId;
      const body = el(targetDoc, "div");
      body.className = "tui-answer";
      presentation.fillAnswerHtml(body, block.text);
      shell.append(body);
      return shell;
    }
    if (block.kind === "reasoning" || block.kind === "commentary")
      return reasoning(
        targetDoc,
        block.text,
        key,
        getString(
          block.kind === "reasoning"
            ? "workspace-tui-thinking"
            : "workspace-tui-progress",
        ),
      );
    if (block.kind === "tools") return tools(targetDoc, block.calls, key);
    if (
      block.kind === "literature" ||
      block.kind === "subagent" ||
      block.kind === "artifact"
    )
      return null;
    if (block.kind === "plan") {
      const plan = el(targetDoc, "div");
      plan.className = "confucius-plan";
      const heading = el(targetDoc, "div", {
        marginBottom: "4px",
        color: "var(--confucius-muted)",
        fontSize: "11px",
        fontWeight: "700",
        textTransform: "uppercase",
      });
      heading.textContent = getString("workspace-activity-plan");
      plan.appendChild(heading);
      for (const step of block.steps) {
        const row = el(targetDoc, "div", {
          padding: "2px 0",
          color:
            step.status === "failed"
              ? "var(--confucius-danger)"
              : "var(--confucius-secondary)",
        });
        row.textContent = `${
          step.status === "done"
            ? "✓"
            : step.status === "running"
              ? "→"
              : step.status === "failed"
                ? "!"
                : "·"
        } ${step.label}`;
        plan.appendChild(row);
      }
      return plan;
    }
    if (block.kind === "command" || block.kind === "file") {
      const action = el(targetDoc, "div");
      action.className = "confucius-command";
      const heading = el(targetDoc, "div", {
        color:
          block.status === "failed" || block.status === "rejected"
            ? "var(--confucius-danger)"
            : "var(--confucius-secondary)",
      });
      heading.textContent =
        block.kind === "command"
          ? `$ ${block.command} · ${block.status}`
          : `${block.path} · ${block.status}`;
      action.appendChild(heading);
      const detail = block.kind === "command" ? block.output : block.diff;
      if (detail) {
        const pre = el(targetDoc, "pre", {
          maxHeight: "180px",
          margin: "5px 0 0",
          overflowX: "scroll",
          overflowY: "auto",
          whiteSpace: "pre-wrap",
        });
        pre.textContent = detail;
        action.appendChild(pre);
      }
      return action;
    }
    const row = tuiBlock(targetDoc, {
      color:
        block.tone === "fail"
          ? "var(--confucius-danger)"
          : "var(--confucius-muted)",
      fontSize: "0.93em",
      padding: "0 4px",
    });
    row.textContent = block.text;
    return row;
  }
  return { render };
}

export type LocateTarget = {
  libraryID?: number;
  key: string;
  pageIndex?: number;
  annotationKey?: string;
  selectItem?: boolean;
};

/**
 * Pull a jump target out of a tool result payload: anything that names an
 * attachment (attachmentKey/key) plus a way to land on a spot in it
 * (pageIndex, position.pageIndex or annotationKey).
 */
function locateFromData(data: unknown): LocateTarget | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  const attachmentKey =
    typeof record.attachmentKey === "string" ? record.attachmentKey.trim() : "";
  const key =
    attachmentKey || (typeof record.key === "string" ? record.key.trim() : "");
  if (!key) {
    return null;
  }
  const annotationKey =
    typeof record.annotationKey === "string" ? record.annotationKey.trim() : "";
  let pageIndex: number | undefined;
  if (
    typeof record.pageIndex === "number" &&
    Number.isInteger(record.pageIndex)
  ) {
    pageIndex = record.pageIndex;
  } else {
    const position = record.position as
      { pageIndex?: unknown } | null | undefined;
    if (
      position &&
      typeof position === "object" &&
      typeof position.pageIndex === "number"
    ) {
      pageIndex = position.pageIndex;
    }
  }
  if (!annotationKey && pageIndex === undefined) {
    return null;
  }
  return {
    libraryID:
      typeof record.libraryID === "number" ? record.libraryID : undefined,
    key,
    pageIndex,
    annotationKey: annotationKey || undefined,
  };
}
