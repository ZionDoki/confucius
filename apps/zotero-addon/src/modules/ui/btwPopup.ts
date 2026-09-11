import {
  btwSourceKey,
  clampUiFontSize,
  DEFAULT_UI_LINE_HEIGHT,
  isUiLineHeight,
  UI_LINE_HEIGHT_VALUES,
  type BtwSelection,
  type BtwSource,
  type BtwView,
} from "@confucius/protocol";
import { ensurePaletteStyles } from "./workspaceSurface";
import { configuredUiLanguage } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { UI_FONT_STACKS } from "./workspaceTypography";

const NS = "http://www.w3.org/1999/xhtml";
export interface BtwHost {
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
type Rect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};
interface PopupOptions {
  doc: Document;
  host: BtwHost;
  fillAnswerHtml(node: HTMLElement, text: string): void;
  selection: BtwSelection;
  anchor(): Rect;
  bounds?: () => Rect;
  closed?(): void;
}
export interface BtwPopup {
  close(): void;
  readonly element: HTMLElement;
}
const active = new Map<Document, BtwPopup>();

export const BTW_CSS = `
.confucius-btw { position: fixed; z-index: 15000; box-sizing: border-box; display: flex; flex-direction: column; gap: 0; padding: 0; max-height: none; color: var(--confucius-ink); background: var(--confucius-elevated); border-radius: 8px; box-shadow: var(--confucius-shadow); overflow: hidden; text-align: start; }
.confucius-btw * { box-sizing: border-box; }
.confucius-btw-input { appearance: none; flex: 0 0 34px; display: block; width: 100%; min-width: 0; height: 34px; margin: 0; padding: 6px 10px; border: 1px solid var(--confucius-line); border-radius: 8px; background: var(--confucius-surface); color: var(--confucius-ink); font: inherit; line-height: 20px; }
.confucius-btw-input::placeholder { color: var(--confucius-muted); opacity: 1; }
.confucius-btw[data-expanded=true] .confucius-btw-input { width: calc(100% - 16px); margin: 0 8px 8px; border-radius: 6px; }
.confucius-btw-input:focus-visible { outline: 2px solid var(--confucius-focus); outline-offset: -2px; }
.confucius-btw-answer { overflow-y: auto; overscroll-behavior: contain; min-height: 0; overflow-wrap: anywhere; padding: 12px; }
.confucius-btw-answer:empty, .confucius-btw-status:empty { display: none; }
.confucius-btw-question { color: var(--confucius-secondary); font-weight: 550; font-size: .92em; margin: 20px 0 6px; white-space: pre-wrap; }
.confucius-btw-question:first-child { margin-top: 0; }
.confucius-btw-reply { white-space: normal; }
.confucius-btw-reply > :first-child { margin-top: 0; }
.confucius-btw-reply > :last-child { margin-bottom: 0; }
.confucius-btw-reply p, .confucius-btw-reply ul, .confucius-btw-reply ol { margin: 0 0 10px; }
.confucius-btw-reply ul, .confucius-btw-reply ol { padding-inline-start: 20px; }
.confucius-btw-reply :is(h1,h2,h3,h4,h5,h6) { margin: 16px 0 8px; font-size: 1.08em; line-height: 1.4; }
.confucius-btw-reply a { color: var(--confucius-accent-text); }
.confucius-btw-reply pre { overflow-x: auto; white-space: pre; margin: 10px 0; padding: 8px; border-radius: 6px; background: var(--confucius-surface); }
.confucius-btw-reply table { display: block; overflow-x: auto; border-collapse: collapse; }
.confucius-btw-reply td, .confucius-btw-reply th { padding: 4px; border-bottom: 1px solid var(--confucius-line); }
.confucius-btw-reply blockquote { margin: 12px 0; padding-left: 12px; border-left: 2px solid var(--confucius-line); }
.confucius-btw-reply hr { height: 0; margin: 24px 0; border: 0; background: none; }
.confucius-btw-status { flex-shrink: 0; max-height: 72px; overflow: auto; overflow-wrap: anywhere; padding: 6px 12px 8px; color: var(--confucius-muted); font-size: .92em; line-height: 1.5; }
.confucius-btw-status[data-error=true] { color: var(--confucius-danger); }
@media (forced-colors: active) { .confucius-btw { outline: 1px solid CanvasText; } }
`;

/** The same prompt-only surface is used in PDF, report and conversation readers. */
export function showBtwPopup(options: PopupOptions): BtwPopup {
  const { doc, host } = options;
  active.get(doc)?.close();
  ensurePaletteStyles(doc);
  const win = doc.defaultView!;
  if (!doc.getElementById("confucius-btw-css")) {
    const style = doc.createElementNS(NS, "style");
    style.id = "confucius-btw-css";
    style.textContent = BTW_CSS;
    (doc.head ?? doc.documentElement)?.append(style);
  }
  const el = (tag: string, className: string) => {
    const node = doc.createElementNS(NS, tag) as HTMLElement;
    node.className = className;
    return node;
  };
  const popup = el("section", "confucius-btw confucius-menu-surface");
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Btw");
  const font = String(getPref("uiFont"));
  popup.style.fontFamily =
    UI_FONT_STACKS[font as keyof typeof UI_FONT_STACKS] ?? UI_FONT_STACKS.sans;
  popup.style.fontSize = `${clampUiFontSize(getPref("uiFontSize"))}px`;
  const lineHeight = getPref("uiLineHeight");
  popup.style.lineHeight = String(
    UI_LINE_HEIGHT_VALUES[
      isUiLineHeight(lineHeight) ? lineHeight : DEFAULT_UI_LINE_HEIGHT
    ],
  );
  const answer = el("div", "confucius-btw-answer");
  const status = el("div", "confucius-btw-status");
  status.setAttribute("role", "status");
  const input = el("input", "confucius-btw-input") as HTMLInputElement;
  input.type = "text";
  input.maxLength = 100000;
  input.autocomplete = "off";
  const english = configuredUiLanguage() === "en-US";
  input.placeholder = english ? "Ask about this passage…" : "询问这段内容…";
  input.setAttribute("aria-label", input.placeholder);
  popup.append(answer, status, input);
  (doc.body ?? doc.documentElement)?.append(popup);
  let closed = false,
    dirty = false,
    busy = false,
    sending = false,
    composing = false;
  let id: string | undefined,
    sequence: number | undefined,
    pollTimer: number | undefined,
    draftTimer: number | undefined;
  let savedDraft: Promise<unknown> = Promise.resolve();
  let request: { id: string; text: string } | undefined;
  let latestView: BtwView | undefined;
  let deferredAnswer = false;
  const rows = new Map<
    string,
    { question: HTMLElement; reply: HTMLElement; text: string }
  >();
  const setStatus = (text: string, error = false) => {
    status.textContent = text;
    status.dataset.error = String(error);
    popup.dataset.expanded = String(!!answer.childElementCount || !!text);
    position();
  };
  const position = () => {
    if (closed) return;
    const rect = options.anchor();
    const bounds = options.bounds?.();
    const minX = Math.max(8, (bounds?.left ?? 0) + 8),
      maxX = Math.min(win.innerWidth, bounds?.right ?? win.innerWidth) - 8;
    const width = Math.max(1, Math.min(420, maxX - minX));
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(minX, Math.min(rect.left, maxX - width))}px`;
    const minY = Math.max(8, (bounds?.top ?? 0) + 8);
    const maxY =
      Math.min(win.innerHeight, bounds?.bottom ?? win.innerHeight) - 8;
    const roomBelow = Math.max(0, maxY - rect.bottom - 8);
    const roomAbove = Math.max(0, rect.top - minY - 8);
    answer.style.maxHeight = "360px";
    const preferredHeight = popup.getBoundingClientRect().height;
    const below =
      roomBelow >= Math.min(preferredHeight, 180) || roomBelow >= roomAbove;
    const room = Math.min(
      maxY - minY,
      Math.max(34, below ? roomBelow : roomAbove),
    );
    const chromeHeight =
      preferredHeight - answer.getBoundingClientRect().height;
    answer.style.maxHeight = `${Math.max(0, Math.min(360, room - chromeHeight))}px`;
    const height = popup.getBoundingClientRect().height;
    popup.style.top = `${Math.max(minY, Math.min(maxY - height, below ? rect.bottom + 8 : rect.top - height - 8))}px`;
  };
  const saveDraft = (force = false) => {
    if (draftTimer !== undefined) win.clearTimeout(draftTimer);
    draftTimer = undefined;
    if (!id || !dirty || (sending && !force)) return savedDraft;
    const text = input.value,
      btwId = id;
    dirty = false;
    savedDraft = savedDraft
      .catch(() => undefined)
      .then(() => host.rpc("btw/draft", { btwId, text }));
    void savedDraft.catch((error) => {
      dirty = true;
      if (!closed) setStatus(String(error), true);
    });
    return savedDraft;
  };
  const render = (view: BtwView) => {
    if (closed) return;
    latestView = view;
    deferredAnswer = false;
    id = view.record.id;
    sequence = view.sequence;
    const stick =
      answer.scrollHeight - answer.scrollTop - answer.clientHeight < 50;
    busy = view.record.turns.some((t) => t.status === "running");
    for (const turn of view.record.turns) {
      let row = rows.get(turn.id);
      if (!row) {
        const question = el("div", "confucius-btw-question"),
          reply = el("div", "confucius-btw-reply");
        question.textContent = turn.prompt;
        answer.append(question, reply);
        row = { question, reply, text: "" };
        rows.set(turn.id, row);
      }
      // Keep a user selection in the answer intact while unrelated turns stream.
      const selection = win.getSelection();
      const selected =
        selection &&
        !selection.isCollapsed &&
        Array.from({ length: selection.rangeCount }, (_, index) =>
          selection.getRangeAt(index),
        ).some((range) => range.intersectsNode(row.reply));
      if (row.text !== turn.answer && !selected) {
        options.fillAnswerHtml(row.reply, turn.answer);
        row.text = turn.answer;
      } else if (row.text !== turn.answer) deferredAnswer = true;
    }
    const last = view.record.turns.at(-1);
    if (view.storageError) setStatus(view.storageError, true);
    else if (busy)
      setStatus(
        english
          ? "Thinking… You can continue reading."
          : "正在回答，可继续阅读…",
      );
    else if (last?.error) setStatus(last.error, true);
    else setStatus("");
    popup.setAttribute("aria-busy", String(busy));
    if (stick) answer.scrollTop = answer.scrollHeight;
    position();
  };
  const selectionChanged = () => {
    if (deferredAnswer && latestView) render(latestView);
  };
  const poll = async () => {
    try {
      if (closed || !id) return;
      const view = (await host.rpc("btw/events", {
        btwId: id,
        afterSequence: sequence,
      })) as Partial<BtwView>;
      if (view.record) render(view as BtwView);
      else if (view.storageError && !closed) setStatus(view.storageError, true);
    } catch (error) {
      if (!closed) setStatus(String(error), true);
    } finally {
      if (!closed) pollTimer = win.setTimeout(() => void poll(), 750);
    }
  };
  const opening = host
    .rpc("btw/open", { selection: options.selection })
    .then((raw) => {
      const view = raw as BtwView;
      id = view.record.id;
      if (closed) {
        void saveDraft();
        return;
      }
      if (!dirty) input.value = view.record.draft;
      render(view);
      void poll();
    })
    .catch((error) => {
      if (!closed) setStatus(String(error), true);
    });
  const submit = async () => {
    const text = input.value.trim();
    if (!text || sending || composing) return;
    if (busy) {
      setStatus(
        english
          ? "Wait for this answer; your draft is kept."
          : "回答仍在生成，草稿已保留。",
      );
      return;
    }
    sending = true;
    try {
      await opening;
      if (!id || closed) return;
      await saveDraft(true);
      if (!request || request.text !== text)
        request = {
          id: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
          text,
        };
      const view = (await host.rpc("btw/prompt", {
        btwId: id,
        requestId: request.id,
        text,
        selection: options.selection,
      })) as BtwView;
      if (input.value.trim() === text) {
        input.value = "";
        dirty = false;
      } else dirty = true;
      request = undefined;
      render(view);
    } catch (error) {
      if (!closed) setStatus(String(error), true);
    } finally {
      sending = false;
      if (dirty) void saveDraft();
    }
  };
  input.addEventListener("input", () => {
    dirty = true;
    if (draftTimer !== undefined) win.clearTimeout(draftTimer);
    draftTimer = win.setTimeout(() => void saveDraft(), 300);
  });
  input.addEventListener("paste", (event) => {
    const pasted = (event as ClipboardEvent).clipboardData?.getData(
      "text/plain",
    );
    if (pasted === undefined) return;
    event.preventDefault();
    input.setRangeText(
      pasted.replace(/[\r\n]+/g, " "),
      input.selectionStart ?? input.value.length,
      input.selectionEnd ?? input.value.length,
      "end",
    );
    dirty = true;
    void saveDraft();
  });
  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
  });
  input.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (
      key.key === "Enter" &&
      !key.isComposing &&
      !composing &&
      key.keyCode !== 229
    ) {
      event.preventDefault();
      event.stopPropagation();
      void submit();
    }
  });
  const outside = (event: Event) => {
    if (!popup.contains(event.target as Node)) controller.close();
  };
  const escape = (event: KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      !event.isComposing &&
      !composing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      event.stopPropagation();
      controller.close();
    }
  };
  // PDF pages live in nested reader frames; their pointer events do not bubble.
  const outsideDocuments = new Set<Document>();
  const watchOutside = (target: Document) => {
    if (outsideDocuments.has(target)) return;
    outsideDocuments.add(target);
    target.addEventListener("pointerdown", outside, true);
    target.addEventListener("keydown", escape, true);
    target.addEventListener("load", watchFrames, true);
    for (const frame of target.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument) watchOutside(frame.contentDocument);
      } catch {
        /* Unrelated cross-origin frames are not part of this reader. */
      }
    }
  };
  const watchFrames = () => {
    if (closed) return;
    for (const target of [...outsideDocuments]) {
      for (const frame of target.querySelectorAll("iframe")) {
        try {
          if (frame.contentDocument) watchOutside(frame.contentDocument);
        } catch {
          /* Ignore unrelated cross-origin frames. */
        }
      }
    }
  };
  const controller: BtwPopup = {
    element: popup,
    close: () => {
      if (closed) return;
      void saveDraft();
      closed = true;
      if (pollTimer !== undefined) win.clearTimeout(pollTimer);
      if (draftTimer !== undefined) win.clearTimeout(draftTimer);
      for (const target of outsideDocuments) {
        target.removeEventListener("pointerdown", outside, true);
        target.removeEventListener("keydown", escape, true);
        target.removeEventListener("load", watchFrames, true);
      }
      outsideDocuments.clear();
      win.removeEventListener("resize", position);
      doc.removeEventListener("scroll", position, true);
      doc.removeEventListener("selectionchange", selectionChanged);
      win.removeEventListener("unload", controller.close);
      popup.remove();
      if (active.get(doc) === controller) active.delete(doc);
      options.closed?.();
    },
  };
  active.set(doc, controller);
  watchOutside(doc);
  win.addEventListener("resize", position);
  doc.addEventListener("scroll", position, true);
  doc.addEventListener("selectionchange", selectionChanged);
  win.addEventListener("unload", controller.close, { once: true });
  position();
  return controller;
}

export function closeBtwPopups() {
  for (const popup of [...active.values()]) popup.close();
}

export function nearbySelection(text: string, selected: string): string {
  const at = text.indexOf(selected);
  return at < 0
    ? selected.slice(0, 4000)
    : text
        .slice(
          Math.max(0, at - 2000),
          Math.min(text.length, at + selected.length + 2000),
        )
        .slice(0, 20000);
}

/** Delegated binding survives report revisions and incremental timeline updates. */
export function bindBtwSelection(
  root: HTMLElement,
  host: BtwHost,
  fillAnswerHtml: PopupOptions["fillAnswerHtml"],
): () => void {
  const doc = root.ownerDocument!,
    win = doc.defaultView!;
  let popup: BtwPopup | undefined;
  let last = "";
  const selected = () => {
    const selection = win.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const start =
      range.startContainer.nodeType === 1
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    const end =
      range.endContainer.nodeType === 1
        ? (range.endContainer as Element)
        : range.endContainer.parentElement;
    if (
      start?.closest(".confucius-btw, button, input, textarea") ||
      end?.closest(".confucius-btw, button, input, textarea")
    )
      return;
    const surface = start?.closest("[data-btw-source]") as HTMLElement | null;
    if (!surface || !root.contains(surface) || !end || !surface.contains(end))
      return;
    const text = selection.toString();
    if (!text.trim() || text.length > 100000) return;
    let source: BtwSource;
    try {
      source = JSON.parse(surface.dataset.btwSource!);
    } catch {
      return;
    }
    const signature = `${btwSourceKey(source)}:${JSON.stringify(source)}:${text}`;
    if (signature === last && popup?.element.isConnected) return;
    const frozen = range.cloneRange(),
      fallback = range.getBoundingClientRect();
    popup?.close();
    last = signature;
    popup = showBtwPopup({
      doc,
      host,
      fillAnswerHtml,
      selection: {
        source,
        text,
        surroundingText: nearbySelection(surface.textContent ?? "", text),
        capturedAt: Date.now(),
      },
      anchor: () =>
        frozen.startContainer.isConnected
          ? frozen.getBoundingClientRect()
          : fallback,
      bounds: () => root.getBoundingClientRect(),
      closed: () => {
        popup = undefined;
        last = "";
      },
    });
  };
  const keyup = (event: KeyboardEvent) => {
    if (
      event.shiftKey &&
      [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    )
      selected();
  };
  root.addEventListener("pointerup", selected);
  root.addEventListener("keyup", keyup);
  return () => {
    popup?.close();
    root.removeEventListener("pointerup", selected);
    root.removeEventListener("keyup", keyup);
  };
}
