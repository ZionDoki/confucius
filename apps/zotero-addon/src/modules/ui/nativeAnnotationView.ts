import { NATIVE_ANNOTATION_CSS } from "./nativeAnnotationStyles";
import {
  attachAnnotationPopupResize,
  type PopupCorner,
  type PopupSize,
} from "./annotationPopupResize";

const NS = "http://www.w3.org/1999/xhtml";
const SURFACES =
  ".annotation-popup, #annotationsView [data-sidebar-annotation-id]";
const OWN = ".confucius-annotation-rendered";
const RICH_TAGS = new Set(["b", "i", "sub", "sup"]);

/** Zotero's comment editor represents line breaks as BRs and DIVs, even hidden. */
export function annotationCommentSource(node: Node | null): string {
  if (!node) return "";
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const tag = element.localName;
  if (tag === "br") return "\n";
  const body = Array.from(node.childNodes)
    .map(annotationCommentSource)
    .join("");
  if (RICH_TAGS.has(tag)) return `<${tag}>${body}</${tag}>`;
  return tag === "div" &&
    !element.classList.contains("content") &&
    node.previousSibling
    ? `\n${body}`
    : body;
}

/** Restore only Zotero's four native inline formats, never HTML in code/math. */
export function restoreAnnotationRichText(root: HTMLElement): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  const visit = (node: Node | null) => {
    if (!node) return;
    if (node.nodeType === 1) {
      if (["pre", "code", "math"].includes((node as Element).localName)) return;
      for (const child of Array.from(node.childNodes)) visit(child);
    } else if (
      node.nodeType === 3 &&
      /<\/?(?:b|i|sub|sup)>/.test(node.textContent ?? "")
    ) {
      const text = node.textContent ?? "";
      const fragment = doc.createDocumentFragment();
      const stack: Array<Element | DocumentFragment> = [fragment];
      for (const token of text.split(/(<\/?(?:b|i|sub|sup)>)/)) {
        const open = token.match(/^<(b|i|sub|sup)>$/);
        const close = token.match(/^<\/(b|i|sub|sup)>$/);
        if (open) {
          const el = doc.createElementNS(NS, open[1]);
          stack.at(-1)!.appendChild(el);
          stack.push(el);
        } else if (close && (stack.at(-1) as Element).localName === close[1]) {
          stack.pop();
        } else stack.at(-1)!.appendChild(doc.createTextNode(token));
      }
      node.parentNode?.replaceChild(fragment, node);
    }
  };
  visit(root);
}

interface ViewOptions {
  render(node: HTMLElement, source: string): void;
  selectAnnotation(id: string): void;
  editLabel: string;
  resizeLabel(corner: PopupCorner): string;
  observer: typeof MutationObserver;
  resizeObserver: typeof ResizeObserver;
}

/** Add owned previews beside the native editor; never replace React/Flex nodes. */
export function mountNativeAnnotationView(
  doc: Document,
  options: ViewOptions,
): () => void {
  const win = doc.defaultView!;
  const style = doc.createElementNS(NS, "style");
  style.id = "confucius-native-annotation-css";
  style.textContent = NATIVE_ANNOTATION_CSS;
  (doc.head ?? doc.documentElement)?.appendChild(style);
  doc.documentElement?.setAttribute("data-confucius-reader", "true");
  const marked = new Set<HTMLElement>();
  const popupParents = new Map<HTMLElement, Element>();
  const entries = new Map<
    HTMLElement,
    {
      source: HTMLElement;
      value: string;
      view: HTMLElement;
      actions?: HTMLElement;
      readOnly: boolean;
    }
  >();
  const popups = new Map<
    HTMLElement,
    ReturnType<typeof attachAnnotationPopupResize>
  >();
  let popupSize: PopupSize | undefined;
  let frame = 0;
  let disposed = false;
  let composing = false;
  const timers = new Set<number>();
  const later = (work: () => void) => {
    const id = win.setTimeout(() => {
      timers.delete(id);
      if (!disposed) work();
    }, 0);
    timers.add(id);
  };
  const schedule = () => {
    if (!disposed && !frame) frame = win.requestAnimationFrame(refresh);
  };
  const resize = new options.resizeObserver(schedule);
  const remove = (comment: HTMLElement) => {
    entries.get(comment)?.actions?.remove();
    entries.get(comment)?.view.remove();
    comment.removeAttribute("data-confucius-rendered");
    comment.removeAttribute("data-confucius-editing");
    entries.delete(comment);
  };
  const placePopupActions = (surface: HTMLElement, actions?: HTMLElement) => {
    const more = surface.querySelector(".preview > header button.more");
    if (actions && more?.parentElement && actions.nextElementSibling !== more)
      more.before(actions);
  };
  function refresh() {
    frame = 0;
    if (disposed) return;
    for (const [comment, entry] of entries) {
      if (
        !comment.isConnected ||
        !comment.contains(entry.source) ||
        !comment.closest(SURFACES)
      )
        remove(comment);
    }
    for (const surface of marked) {
      if (!surface.isConnected) {
        resize.unobserve(surface);
        const parent = popupParents.get(surface);
        if (parent) resize.unobserve(parent);
        popupParents.delete(surface);
        marked.delete(surface);
        popups.get(surface)?.dispose();
        popups.delete(surface);
      }
    }
    for (const surface of Array.from(
      doc.querySelectorAll(SURFACES),
    ) as HTMLElement[]) {
      const popup = surface.classList.contains("annotation-popup");
      if (!marked.has(surface)) {
        marked.add(surface);
        surface.setAttribute(
          "data-confucius-annotation",
          popup ? "popup" : "card",
        );
        resize.observe(surface);
        if (popup && surface.parentElement) {
          popupParents.set(surface, surface.parentElement);
          resize.observe(surface.parentElement);
          popups.set(
            surface,
            attachAnnotationPopupResize(surface, {
              size: popupSize,
              label: options.resizeLabel,
              onSize: (size) => {
                popupSize = size;
              },
              schedule,
            }),
          );
        }
      }
      for (const comment of Array.from(
        surface.querySelectorAll(".preview > .comment"),
      ) as HTMLElement[]) {
        const source = comment.querySelector<HTMLElement>(".editor .content");
        if (!source) {
          remove(comment);
          continue;
        }
        const editing = source.contains(doc.activeElement);
        if (editing) {
          comment.setAttribute("data-confucius-editing", "true");
          if (popup) placePopupActions(surface, entries.get(comment)?.actions);
          continue;
        }
        comment.removeAttribute("data-confucius-editing");
        if (composing) continue;
        const value = annotationCommentSource(source);
        if (!value.trim()) {
          remove(comment);
          continue;
        }
        let entry = entries.get(comment);
        const readOnly = !!comment.closest(".preview.read-only");
        if (
          entry?.source !== source ||
          (entry && (!entry.view.isConnected || entry.readOnly !== readOnly))
        ) {
          remove(comment);
          entry = undefined;
        }
        if (!entry) {
          const view = doc.createElementNS(NS, "div") as HTMLElement;
          // Native copy/delete handling recognizes a comment's .content. Keep
          // that semantic wrapper around the preview and its edit action too.
          view.className = "confucius-annotation-rendered content";
          const body = doc.createElementNS(NS, "div") as HTMLElement;
          body.className = "confucius-annotation-markdown";
          body.tabIndex = 0;
          body.setAttribute("data-tabstop", "1");
          if (!popup)
            view.addEventListener("focusin", () =>
              options.selectAnnotation(source.id),
            );
          body.addEventListener("pointerdown", () => {
            if (!popup) options.selectAnnotation(source.id);
            body.focus({ preventScroll: true });
          });
          view.appendChild(body);
          // Reading, selecting, links and scrolling must not enter the native editor.
          for (const type of [
            "pointerdown",
            "mousedown",
            "click",
            "dblclick",
            "keydown",
          ])
            view.addEventListener(type, (event: Event) =>
              event.stopPropagation(),
            );
          entry = { source, value: "", view, readOnly };
          if (!readOnly) {
            const actions = doc.createElementNS(NS, "div") as HTMLElement;
            actions.className = "confucius-annotation-actions";
            const button = doc.createElementNS(
              NS,
              popup ? "input" : "button",
            ) as HTMLButtonElement | HTMLInputElement;
            button.type = "button";
            button.className = "confucius-button confucius-annotation-edit";
            // Native keyboard shortcuts exempt inputs from annotation deletion.
            // The header action no longer sits inside the preview's .content.
            if (popup) (button as HTMLInputElement).value = options.editLabel;
            else button.textContent = options.editLabel;
            button.setAttribute("aria-label", options.editLabel);
            button.setAttribute("data-tabstop", "1");
            button.tabIndex = 0;
            button.title = options.editLabel;
            for (const type of [
              "pointerdown",
              "mousedown",
              "dblclick",
              "keydown",
            ])
              actions.addEventListener(type, (event: Event) =>
                event.stopPropagation(),
              );
            button.addEventListener("click", (event: Event) => {
              event.stopPropagation();
              comment.setAttribute("data-confucius-editing", "true");
              comment.click(); // Native selection enables the sidebar's editor.
              const focusEditor = () => {
                if (!comment.isConnected) return;
                // A queued layout refresh may have run while the native
                // sidebar changed selection. Reveal again before focusing.
                comment.setAttribute("data-confucius-editing", "true");
                const editable = comment.querySelector<HTMLElement>(
                  '.editor .content[contenteditable="true"]',
                );
                if (editable) editable.focus();
                else comment.removeAttribute("data-confucius-editing");
                schedule();
              };
              if (source.getAttribute("contenteditable") === "true")
                focusEditor();
              else later(focusEditor);
            });
            entry.actions = actions;
            actions.appendChild(button);
            view.appendChild(actions);
          }
          entries.set(comment, entry);
          comment.appendChild(view);
        }
        if (popup) placePopupActions(surface, entry.actions);
        if (entry.value !== value) {
          const selection = win.getSelection();
          if (
            selection &&
            !selection.isCollapsed &&
            entry.view.contains(selection.anchorNode)
          )
            continue;
          try {
            options.render(entry.view.firstElementChild as HTMLElement, value);
            restoreAnnotationRichText(
              entry.view.firstElementChild as HTMLElement,
            );
            entry.value = value;
          } catch {
            remove(comment);
            continue;
          }
        }
        comment.setAttribute("data-confucius-rendered", "true");
      }
      if (popup) popups.get(surface)?.refresh();
    }
  }
  const observer = new options.observer((records) => {
    if (
      records.some((record) => {
        const target =
          record.target?.nodeType === 1
            ? (record.target as Element)
            : record.target?.parentElement;
        if (target?.closest(OWN)) return false;
        if (target?.closest(SURFACES)) return true;
        return [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node?.nodeType === 1 &&
            ((node as Element).matches(SURFACES) ||
              (node as Element).querySelector(SURFACES)),
        );
      })
    )
      schedule();
  });
  observer.observe(doc.body!, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "id", "contenteditable", "style"],
  });
  const focus = () => schedule();
  const compositionStart = () => {
    composing = true;
  };
  const compositionEnd = () => {
    composing = false;
    schedule();
  };
  doc.addEventListener("focusin", focus);
  doc.addEventListener("focusout", focus);
  doc.addEventListener("selectionchange", focus);
  doc.addEventListener("compositionstart", compositionStart);
  doc.addEventListener("compositionend", compositionEnd);
  win.addEventListener("resize", schedule);
  refresh();
  return () => {
    disposed = true;
    observer.disconnect();
    resize.disconnect();
    win.cancelAnimationFrame(frame);
    for (const timer of timers) win.clearTimeout(timer);
    doc.removeEventListener("focusin", focus);
    doc.removeEventListener("focusout", focus);
    doc.removeEventListener("selectionchange", focus);
    doc.removeEventListener("compositionstart", compositionStart);
    doc.removeEventListener("compositionend", compositionEnd);
    win.removeEventListener("resize", schedule);
    for (const comment of entries.keys()) remove(comment);
    for (const popup of popups.values()) popup.dispose();
    for (const surface of marked) {
      surface.removeAttribute("data-confucius-annotation");
    }
    doc.documentElement?.removeAttribute("data-confucius-reader");
    style.remove();
  };
}
