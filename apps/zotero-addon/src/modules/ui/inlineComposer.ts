import {
  composerMentions,
  composerMentionText,
  type ComposerMention,
} from "@confucius/protocol";

export interface ComposerSource {
  id: string;
  label: string;
  title: string;
  binding?: boolean;
}

export interface ComposerInput extends HTMLDivElement {
  value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  disabled: boolean;
  setSelectionRange(start: number, end: number): void;
}

interface Draft {
  text: string;
  mentions: ComposerMention[];
  binding?: ComposerSource;
}

/** A plain-text editor with atomic, identity-bearing references. No HTML is stored. */
export function createInlineComposer(
  doc: Document,
  options: {
    placeholder: string;
    canChangeSources: () => boolean;
    activate: (id: string) => void;
    sourcesChanged: (removed: string[], added: string[]) => void;
  },
) {
  const input = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) as ComposerInput;
  input.id = "confucius-prompt";
  input.contentEditable = "true";
  input.setAttribute("role", "textbox");
  input.setAttribute("aria-multiline", "true");
  input.setAttribute("aria-label", options.placeholder);
  input.dataset.placeholder = options.placeholder;
  const known = new Map<string, ComposerSource>();
  let binding: ComposerSource | undefined;
  let composing = false;
  let previous: Draft = { text: "", mentions: [] };
  let before: Draft | undefined;
  const undo: Draft[] = [],
    redo: Draft[] = [];

  function read(container: Node = input): Draft {
    let text = "";
    const mentions: ComposerMention[] = [];
    let bound: ComposerSource | undefined;
    function visit(node: Node | null) {
      if (!node) return;
      if (node.nodeType === 3) {
        text += (node.textContent ?? "").replace(/\u200b/g, "");
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      const element = node as HTMLElement;
      const id = element.dataset?.composerSource;
      if (id) {
        const source = known.get(id);
        if (!source) return;
        if (source.binding) {
          bound = source;
          return;
        }
        const start = text.length;
        text += composerMentionText(source.label);
        mentions.push({ id, label: source.label, start, end: text.length });
        return;
      }
      if (element.tagName === "BR") {
        text += "\n";
        return;
      }
      if (
        ["DIV", "P"].includes(element.tagName) &&
        node !== container &&
        text &&
        !text.endsWith("\n")
      )
        text += "\n";
      node.childNodes.forEach(visit);
    }
    visit(container);
    return { text, mentions, binding: bound };
  }
  const ids = (draft: Draft) =>
    new Set([
      ...draft.mentions.map((item) => item.id),
      ...(draft.binding ? [draft.binding.id] : []),
    ]);
  function selection() {
    const selected = doc.getSelection();
    if (
      !selected?.rangeCount ||
      !input.contains(selected.anchorNode) ||
      !input.contains(selected.focusNode)
    )
      return { start: read().text.length, end: read().text.length };
    const range = selected.getRangeAt(0);
    const prefix = doc.createRange();
    prefix.selectNodeContents(input);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = read(prefix.cloneContents()).text.length;
    prefix.setEnd(range.endContainer, range.endOffset);
    return { start, end: read(prefix.cloneContents()).text.length };
  }
  function position(offset: number): [Node, number] {
    let count = 0;
    let found: [Node, number] | undefined;
    function visit(parent: Node) {
      for (let index = 0; index < parent.childNodes.length; index++) {
        const node = parent.childNodes[index];
        const element = node as HTMLElement;
        if (element.dataset?.composerSource) {
          const source = known.get(element.dataset.composerSource);
          if (source?.binding) continue;
          const size = source ? composerMentionText(source.label).length : 0;
          if (offset < count + size) {
            found = [parent, index];
            return;
          }
          count += size;
        } else if (node.nodeType === 3) {
          const text = node.textContent ?? "";
          const size = text.replace(/\u200b/g, "").length;
          if (offset <= count + size) {
            let actual = 0,
              length = 0;
            while (
              actual < text.length &&
              (length < offset - count || text[actual] === "\u200b")
            ) {
              if (text[actual] !== "\u200b") length++;
              actual++;
            }
            found = [node, actual];
            return;
          }
          count += size;
        } else if (element.tagName === "BR") {
          if (offset <= count) {
            found = [parent, index];
            return;
          }
          count++;
        } else {
          if (["DIV", "P"].includes(element.tagName) && count) count++;
          visit(node);
          if (found) return;
        }
      }
    }
    visit(input);
    return found ?? [input, input.childNodes.length];
  }
  function setSelection(start: number, end: number) {
    const selected = doc.getSelection();
    if (!selected) return;
    const range = doc.createRange();
    const a = position(Math.max(0, start)),
      b = position(Math.max(start, end));
    range.setStart(...a);
    range.setEnd(...b);
    selected.removeAllRanges();
    selected.addRange(range);
  }
  function token(source: ComposerSource) {
    known.set(source.id, source);
    const node = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    node.type = "button";
    node.contentEditable = "false";
    node.className = "confucius-inline-reference";
    node.dataset.composerSource = source.id;
    node.dataset.binding = String(!!source.binding);
    if (source.binding) node.id = "confucius-pdf-binding";
    node.title = source.title;
    node.setAttribute("aria-label", source.title);
    node.setAttribute("aria-haspopup", "dialog");
    const at = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    at.className = "confucius-inline-at";
    at.textContent = "@";
    const label = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    label.textContent = source.label;
    node.append(at, label);
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (options.canChangeSources()) options.activate(source.id);
    });
    node.addEventListener("keydown", (raw) => {
      const event = raw as KeyboardEvent;
      if (
        event.isComposing ||
        composing ||
        !["Backspace", "Delete"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (options.canChangeSources()) remove(node);
    });
    return node;
  }
  function sync() {
    const draft = read();
    let prose = draft.text;
    for (const mention of [...draft.mentions].reverse())
      prose = prose.slice(0, mention.start) + prose.slice(mention.end);
    input.dataset.empty = String(!prose.trim());
    input.dataset.boundPdf = draft.binding?.id ?? "";
    previous = draft;
    binding = draft.binding;
  }
  function prose() {
    const draft = read();
    let text = draft.text;
    for (const mention of [...draft.mentions].reverse())
      text = text.slice(0, mention.start) + text.slice(mention.end);
    return text;
  }
  function render(draft: Draft) {
    input.replaceChildren();
    binding = draft.binding;
    if (binding) input.append(token(binding), doc.createTextNode("\u200b"));
    let cursor = 0;
    for (const mention of composerMentions(draft.text, draft.mentions)) {
      input.append(doc.createTextNode(draft.text.slice(cursor, mention.start)));
      const source = known.get(mention.id) ?? {
        id: mention.id,
        label: mention.label,
        title: mention.label,
      };
      input.append(token(source));
      cursor = mention.end;
    }
    input.append(doc.createTextNode(draft.text.slice(cursor) || "\u200b"));
    sync();
  }
  function remember(draft: Draft) {
    undo.push(draft);
    if (undo.length > 100) undo.shift();
    redo.length = 0;
  }
  function changed(old: Draft, notify = true) {
    const next = read(),
      oldIds = ids(old),
      nextIds = ids(next);
    sync();
    options.sourcesChanged(
      [...oldIds].filter((id) => !nextIds.has(id)),
      [...nextIds].filter((id) => !oldIds.has(id)),
    );
    if (notify)
      input.dispatchEvent(
        new doc.defaultView!.Event("input", { bubbles: true }),
      );
  }
  function remove(node: HTMLElement) {
    const old = read();
    remember(old);
    const range = doc.createRange();
    range.setStartBefore(node);
    range.collapse(true);
    node.remove();
    input.focus({ preventScroll: true });
    const selected = doc.getSelection();
    selected?.removeAllRanges();
    selected?.addRange(range);
    changed(old);
  }
  function adjacent(backward: boolean): HTMLElement | null {
    const selected = doc.getSelection();
    if (!selected?.isCollapsed || !input.contains(selected.anchorNode))
      return null;
    let node = selected.anchorNode;
    if (node?.nodeType === 3) {
      const rest = backward
        ? node.textContent?.slice(0, selected.anchorOffset)
        : node.textContent?.slice(selected.anchorOffset);
      const gap = rest?.replace(/\u200b/g, "") ?? "";
      if (gap !== "" && gap !== " ") return null;
      node = backward ? node.previousSibling : node.nextSibling;
    } else
      node =
        node?.childNodes[selected.anchorOffset - (backward ? 1 : 0)] ?? null;
    while (node?.nodeType === 3 && !node.textContent?.replace(/\u200b/g, ""))
      node = backward ? node.previousSibling : node.nextSibling;
    return (node as HTMLElement)?.dataset?.composerSource
      ? (node as HTMLElement)
      : null;
  }
  function selectedReferences(): boolean {
    const selected = doc.getSelection();
    return (
      !!selected?.rangeCount &&
      !selected.isCollapsed &&
      input.contains(selected.anchorNode) &&
      input.contains(selected.focusNode) &&
      input.querySelectorAll<HTMLElement>("[data-composer-source]").length >
        0 &&
      [...input.querySelectorAll("[data-composer-source]")].some((node) =>
        selected.getRangeAt(0).intersectsNode(node),
      )
    );
  }
  input.addEventListener("keydown", (raw) => {
    const event = raw as KeyboardEvent;
    if (event.isComposing || composing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      const from = event.shiftKey ? redo : undo,
        to = event.shiftKey ? undo : redo;
      const draft = from.at(-1);
      if (!draft) return;
      const old = read();
      if (
        !options.canChangeSources() &&
        JSON.stringify([...ids(old)]) !== JSON.stringify([...ids(draft)])
      )
        return;
      from.pop();
      to.push(old);
      render(draft);
      setSelection(draft.text.length, draft.text.length);
      changed(old);
      return;
    }
    if (!["Backspace", "Delete"].includes(event.key)) return;
    const node = adjacent(event.key === "Backspace");
    if (node) {
      event.preventDefault();
      event.stopPropagation();
      if (options.canChangeSources()) remove(node);
    }
  });
  input.addEventListener("beforeinput", (event) => {
    const edit = event as InputEvent;
    if (composing || edit.isComposing) return;
    if (!options.canChangeSources() && selectedReferences()) {
      event.preventDefault();
      return;
    }
    if (
      ["deleteContentBackward", "deleteContentForward"].includes(edit.inputType)
    ) {
      const node = adjacent(edit.inputType === "deleteContentBackward");
      if (node) {
        event.preventDefault();
        if (options.canChangeSources()) remove(node);
        return;
      }
    }
    before = read();
  });
  input.addEventListener("input", () => {
    if (composing) return;
    const old = before ?? previous;
    before = undefined;
    if (JSON.stringify(old) !== JSON.stringify(read())) {
      remember(old);
      changed(old, false);
    } else sync();
  });
  input.addEventListener("compositionstart", () => {
    composing = true;
    before = read();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    const old = before ?? previous;
    before = undefined;
    remember(old);
    changed(old);
  });
  function insertText(text: string) {
    if (!options.canChangeSources() && selectedReferences()) return;
    const old = read(),
      selected = doc.getSelection();
    if (!selected?.rangeCount || !input.contains(selected.anchorNode)) return;
    const range = selected.getRangeAt(0);
    range.deleteContents();
    const node = doc.createTextNode(text.replace(/\r\n?/g, "\n"));
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selected.removeAllRanges();
    selected.addRange(range);
    remember(old);
    changed(old);
  }
  input.addEventListener("paste", (raw) => {
    const event = raw as ClipboardEvent;
    event.preventDefault();
    insertText(event.clipboardData?.getData("text/plain") ?? "");
  });
  for (const type of ["copy", "cut"] as const)
    input.addEventListener(type, (raw) => {
      const event = raw as ClipboardEvent;
      const selected = doc.getSelection();
      if (!selected?.rangeCount || selected.isCollapsed) return;
      event.preventDefault();
      const fragment = selected.getRangeAt(0).cloneContents();
      const copied = read(fragment);
      event.clipboardData?.setData(
        "text/plain",
        (copied.binding ? `@${copied.binding.label} ` : "") + copied.text,
      );
      if (type === "cut") insertText("");
    });
  // Rich HTML is never accepted, including drag-and-drop from another app.
  input.addEventListener("drop", (raw) => {
    const event = raw as DragEvent;
    if (
      event.dataTransfer?.files?.length ||
      event.dataTransfer?.types.includes("application/x-moz-file")
    )
      return;
    event.preventDefault();
    insertText(event.dataTransfer?.getData("text/plain") ?? "");
  });
  Object.defineProperties(input, {
    value: {
      get: () => read().text,
      set: (text: string) => {
        const value = String(text);
        // Polling may restore the same draft. Replacing contenteditable children
        // still resets Gecko's native caret, selection, scroll and composition.
        if (value === read().text) return;
        render({
          text: value,
          mentions: composerMentions(value, previous.mentions),
          binding,
        });
      },
    },
    selectionStart: { get: () => selection().start },
    selectionEnd: { get: () => selection().end },
    disabled: {
      get: () => input.contentEditable !== "true",
      set: (disabled: boolean) => {
        input.contentEditable = String(!disabled);
      },
    },
  });
  input.setSelectionRange = setSelection;
  render(previous);
  return {
    input,
    mentions: () => read().mentions,
    prose,
    sourceIds: () => [...ids(read())],
    reset(text: string, mentions: ComposerMention[] = []) {
      undo.length = 0;
      redo.length = 0;
      known.clear();
      render({ text, mentions });
    },
    setSources(sources: ComposerSource[]) {
      const allowed = new Set(sources.map((source) => source.id));
      // Preserve native DOM selection anchors while reconciling sources. A
      // serialized offset becomes stale when a reference is inserted before it.
      for (const node of input.querySelectorAll<HTMLElement>(
        "[data-composer-source]",
      )) {
        if (!allowed.has(node.dataset.composerSource!)) {
          node.remove();
        }
      }
      const current = ids(read());
      for (const source of [...sources].reverse()) {
        known.set(source.id, source);
        const node = [
          ...input.querySelectorAll<HTMLElement>("[data-composer-source]"),
        ].find((node) => node.dataset.composerSource === source.id);
        if (node) {
          if (node.title !== source.title) node.title = source.title;
          if (node.getAttribute("aria-label") !== source.title)
            node.setAttribute("aria-label", source.title);
          const label = node.querySelector("span:last-child")!;
          if (label.textContent !== source.label)
            label.textContent = source.label;
          continue;
        }
        // Older drafts stored @[Title] as text. Hydrate only references already
        // present in their saved context, and only when the title is unambiguous.
        // Pasting text into an editor with an existing token never binds a source.
        if (
          !source.binding &&
          !current.has(source.id) &&
          sources.filter((item) => !item.binding && item.label === source.label)
            .length === 1
        ) {
          const draft = read(),
            label = composerMentionText(source.label);
          const offsets: number[] = [];
          for (
            let offset = draft.text.indexOf(label);
            offset >= 0;
            offset = draft.text.indexOf(label, offset + label.length)
          ) {
            if (
              !draft.mentions.some(
                (item) =>
                  item.start < offset + label.length && item.end > offset,
              )
            )
              offsets.push(offset);
          }
          for (const offset of offsets.reverse()) {
            const range = doc.createRange();
            range.setStart(...position(offset));
            range.setEnd(...position(offset + label.length));
            range.deleteContents();
            range.insertNode(token(source));
          }
          if (offsets.length) {
            current.add(source.id);
          }
        }
        if (!current.has(source.id)) {
          const node = token(source),
            gap = doc.createTextNode(source.binding ? "\u200b" : " ");
          const pdf = input.querySelector<HTMLElement>(
            '[data-composer-source][data-binding="true"]',
          );
          if (!source.binding && pdf) pdf.after(node, gap);
          else input.prepend(node, gap);
        }
      }
      sync();
    },
    insert(source: ComposerSource, start: number, end: number) {
      known.set(source.id, source);
      const old = read();
      remember(old);
      const range = doc.createRange();
      range.setStart(...position(start));
      range.setEnd(...position(end));
      range.deleteContents();
      const node = token(source);
      range.insertNode(node);
      node.after(doc.createTextNode(" "));
      sync();
      input.focus();
      setSelection(
        start + composerMentionText(source.label).length + 1,
        start + composerMentionText(source.label).length + 1,
      );
      changed(old);
    },
  };
}
