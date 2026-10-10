import { renderMarkdownHtml } from "@confucius/protocol";
import type { KnowledgeDocument, KnowledgeItem } from "../host/KnowledgeIndex";
import type { WorkspaceHost } from "./WorkspaceView";
import {
  createWorkspaceButton as button,
  bindDialogNavigation,
} from "./workspaceControls";
import { getString } from "../../utils/locale";
import { renderNotePreview } from "./notePreview";
import { exportKnowledgeDocument } from "./knowledgeExport";

/** One source catalogue, shared by notes, research memory and legacy documents. */
export function createKnowledgeLibrary(
  win: Window,
  root: HTMLElement,
  host: WorkspaceHost,
  proposals: () => HTMLElement[],
  changed: () => Promise<void>,
  sourceTask: (taskId: string) => { title: string; open(): void } | undefined,
) {
  const doc = win.document;
  const el = (tag: string, className = "") => {
    const node = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      tag,
    ) as HTMLElement;
    node.className = className;
    return node;
  };
  let overlay: HTMLElement | undefined;
  let search: HTMLInputElement;
  let list: HTMLElement;
  let detail: HTMLElement;
  let proposalList: HTMLElement;
  let error: HTMLElement;
  let more: HTMLButtonElement;
  let nextOffset: number | undefined;
  let generation = 0;
  let readGeneration = 0;
  let timer: number | undefined;
  let returnFocus: HTMLElement | null;
  let editing = false;
  let selectedId: string | undefined;
  const failure = (value: unknown) => {
    if (overlay) error.textContent = String(value);
  };
  const close = () => {
    generation++;
    readGeneration++;
    win.clearTimeout(timer);
    overlay?.remove();
    overlay = undefined;
    editing = false;
    selectedId = undefined;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  const show = async (id: string) => {
    const current = ++readGeneration;
    selectedId = id;
    for (const row of Array.from(list.children))
      row.setAttribute(
        "aria-current",
        String((row as HTMLElement).dataset.source === id),
      );
    editing = false;
    error.textContent = "";
    detail.replaceChildren();
    try {
      const value = (await host.rpc("knowledge/read", {
        id,
      })) as KnowledgeDocument;
      if (!overlay || current !== readGeneration) return;
      detail.replaceChildren();
      const title = el("h2");
      title.textContent = value.title;
      const actions = el("div", "confucius-knowledge-actions");
      const exportButton = button(
        doc,
        "",
        getString("workspace-knowledge-export"),
      );
      exportButton.addEventListener("click", () => {
        exportButton.disabled = true;
        void host
          .rpc("knowledge/read", { id })
          .then((value) =>
            exportKnowledgeDocument(win, value as KnowledgeDocument),
          )
          .catch(failure)
          .finally(() => {
            exportButton.disabled = false;
          });
      });
      actions.append(exportButton);
      const content = el("article", "confucius-note-content");
      renderNotePreview(
        content,
        value.format === "html"
          ? value.content
          : renderMarkdownHtml(value.content),
        (href) => {
          void host.openLink?.(href).catch(failure);
        },
      );
      if ("libraryID" in value.source) {
        const open = button(
          doc,
          "",
          getString("workspace-knowledge-open-note"),
        );
        open.addEventListener(
          "click",
          () =>
            void host
              .rpc("reader/open", { ...value.source, selectItem: true })
              .catch(failure),
        );
        actions.prepend(open);
      } else if (value.kind !== "legacy") {
        const memoryId = value.source.memoryId;
        const edit = button(doc, "", getString("workspace-knowledge-correct"));
        edit.addEventListener("click", () => {
          editing = true;
          const input = el(
            "textarea",
            "confucius-knowledge-memory-input",
          ) as HTMLTextAreaElement;
          input.value = value.content;
          input.setAttribute(
            "aria-label",
            getString("workspace-knowledge-correct"),
          );
          const save = button(doc, "", getString("workspace-knowledge-save"));
          const cancel = button(
            doc,
            "",
            getString("workspace-settings-cancel"),
          );
          cancel.addEventListener("click", () => void show(id));
          save.addEventListener("click", () => {
            save.disabled = true;
            void host
              .rpc("knowledge/correct", {
                id: memoryId,
                content: input.value,
                expected: value.content,
              })
              .then(async () => {
                await changed();
                if (!overlay || current !== readGeneration) return;
                await show(id);
                await load();
              })
              .catch(failure)
              .finally(() => {
                save.disabled = false;
              });
          });
          content.replaceChildren(input, save, cancel);
          input.focus();
        });
        const forget = button(doc, "", getString("workspace-knowledge-forget"));
        forget.addEventListener("click", () => {
          if (!win.confirm(getString("workspace-knowledge-forget-confirm")))
            return;
          forget.disabled = true;
          void host
            .rpc("knowledge/forget", { id: memoryId })
            .then(async () => {
              if (overlay && current === readGeneration) {
                readGeneration++;
                editing = false;
                detail.replaceChildren(proposalList);
              }
              await changed();
              await load();
            })
            .catch(failure)
            .finally(() => {
              forget.disabled = false;
            });
        });
        actions.append(edit, forget);
      }
      detail.append(title, actions, content);
      if (value.sourceRefs?.length) {
        const source = el("details");
        const summary = el("summary");
        summary.textContent = getString("workspace-knowledge-sources");
        source.append(summary);
        for (const ref of value.sourceRefs) {
          const task = ref.startsWith("task:")
            ? sourceTask(ref.slice(5))
            : undefined;
          const row = el("p");
          if (task) {
            const link = button(doc, "", task.title);
            link.classList.add("confucius-link");
            link.dataset.variant = "link";
            link.addEventListener("click", () => {
              close();
              task.open();
            });
            row.append(link);
          } else {
            row.textContent = ref.startsWith("task:")
              ? getString("workspace-knowledge-source-unavailable")
              : ref;
          }
          source.append(row);
        }
        detail.append(source);
      }
      proposalList.replaceChildren(...proposals());
      detail.append(proposalList);
    } catch (caught) {
      if (current === readGeneration) failure(caught);
    }
  };
  const load = async (append = false) => {
    if (!overlay) return;
    const current = ++generation;
    more.disabled = true;
    error.textContent = "";
    try {
      const result = (await host.rpc("knowledge/index", {
        query: search.value,
        offset: append ? nextOffset : 0,
        limit: 50,
      })) as { items: KnowledgeItem[]; nextOffset?: number; total: number };
      if (!overlay || current !== generation) return;
      if (!append) list.replaceChildren();
      for (const item of result.items) {
        const row = button(doc, "", "");
        row.classList.add("confucius-knowledge-result");
        row.dataset.source = item.id;
        row.setAttribute("aria-current", String(item.id === selectedId));
        const title = el("span");
        title.textContent = item.title;
        const source = el("small");
        source.textContent = getString(
          `workspace-knowledge-source-${item.kind}`,
        );
        const excerpt = el("span", "confucius-knowledge-excerpt");
        excerpt.textContent = item.excerpt ?? "";
        row.append(title, source, excerpt);
        row.addEventListener("click", () => void show(item.id));
        list.append(row);
      }
      if (!result.total) {
        const empty = el("p");
        empty.textContent = getString("workspace-knowledge-index-empty");
        list.append(empty);
      }
      nextOffset = result.nextOffset;
      more.hidden = nextOffset === undefined;
    } catch (caught) {
      if (current === generation) failure(caught);
    } finally {
      if (current === generation) more.disabled = false;
    }
  };
  return {
    get isOpen() {
      return !!overlay;
    },
    close,
    refresh() {
      if (!overlay) return;
      proposalList.replaceChildren(...proposals());
      if (!editing) void load();
    },
    async open() {
      if (overlay) {
        search.focus();
        return;
      }
      returnFocus = doc.activeElement as HTMLElement | null;
      overlay = el("div", "confucius-knowledge-overlay");
      overlay.id = "confucius-knowledge-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", getString("workspace-knowledge"));
      bindDialogNavigation(overlay, close);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close();
      });
      const shell = el(
        "section",
        "confucius-knowledge-shell confucius-knowledge-index",
      );
      const header = el("header", "confucius-knowledge-header");
      const title = el("h2");
      title.textContent = getString("workspace-knowledge");
      const dismiss = button(doc, "", "×");
      dismiss.classList.add("confucius-icon-button");
      dismiss.setAttribute(
        "aria-label",
        getString("workspace-knowledge-close"),
      );
      dismiss.addEventListener("click", close);
      header.append(title, dismiss);
      const body = el("div", "confucius-knowledge-index-body");
      const sidebar = el("div", "confucius-knowledge-index-list");
      search = el("input") as HTMLInputElement;
      search.type = "search";
      search.placeholder = getString("workspace-knowledge-index-search");
      search.setAttribute("aria-label", search.placeholder);
      search.addEventListener("input", (event) => {
        if ((event as InputEvent).isComposing) return;
        win.clearTimeout(timer);
        timer = win.setTimeout(() => void load(), 200);
      });
      search.addEventListener("compositionend", () => {
        win.clearTimeout(timer);
        void load();
      });
      list = el("div", "confucius-knowledge-results");
      more = button(doc, "", getString("workspace-knowledge-more"));
      more.hidden = true;
      more.addEventListener("click", () => void load(true));
      sidebar.append(search, list, more);
      detail = el("div", "confucius-knowledge-index-detail");
      proposalList = el("div", "confucius-knowledge-proposals");
      proposalList.append(...proposals());
      const hint = el("p");
      hint.textContent = getString("workspace-knowledge-index-hint");
      detail.append(hint, proposalList);
      error = el("div", "confucius-knowledge-error");
      error.setAttribute("role", "alert");
      body.append(sidebar, detail);
      shell.append(header, error, body);
      overlay.append(shell);
      root.append(overlay);
      search.focus();
      await load();
    },
  };
}
