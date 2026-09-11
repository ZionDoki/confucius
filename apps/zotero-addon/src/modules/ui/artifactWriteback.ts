import { renderMarkdownHtml, type ArtifactRecord } from "@confucius/protocol";
import type { WorkspaceHost } from "./WorkspaceView";
import { configuredUiLanguage, getString } from "../../utils/locale";
import {
  ArtifactWritebackApproval,
  type WritebackPreview,
} from "./artifactWritebackApproval";
import {
  createWorkspaceButton as button,
  bindDialogNavigation,
} from "./workspaceControls";
import { createMenuSurface, bindMenuNavigation } from "./workspaceMenus";
import { renderNotePreview } from "./notePreview";

function el(doc: Document, tag: string, className?: string): HTMLElement {
  const node = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElement;
  if (className) node.className = className;
  return node;
}

export function showArtifactWriteback(
  win: Window,
  root: HTMLElement,
  host: WorkspaceHost,
  artifact: ArtifactRecord,
  revision: number,
  onSaved: () => Promise<void>,
): void {
  const doc = win.document;
  if (doc.getElementById("confucius-writeback-overlay")) return;
  const rpc = host.rpc.bind(host);
  const targets = [
    { value: "zotero_note", label: getString("workspace-writeback-note") },
    {
      value: "knowledge_base",
      label: getString("workspace-writeback-knowledge"),
    },
  ];
  if (artifact.kind === "annotation_set")
    targets.unshift({
      value: "zotero_annotations",
      label: getString("workspace-writeback-annotations"),
    });
  if (artifact.kind === "collection_diff")
    targets.unshift(
      {
        value: "zotero_collection",
        label: getString("workspace-writeback-collection"),
      },
      { value: "zotero_tags", label: getString("workspace-writeback-tags") },
    );
  let target = targets[0];
  const approval = new ArtifactWritebackApproval(host);
  const returnFocus = doc.activeElement as HTMLElement | null;
  const overlay = el(doc, "div", "confucius-dialog confucius-note-save");
  overlay.id = "confucius-writeback-overlay";
  overlay.setAttribute("aria-labelledby", "confucius-writeback-heading");
  const closeWriteback = () => {
    win.removeEventListener("unload", closeWriteback);
    void approval
      .close()
      .catch((error) =>
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    overlay.remove();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  win.addEventListener("unload", closeWriteback, { once: true });
  bindDialogNavigation(overlay, closeWriteback);
  const panel = el(
    doc,
    "div",
    "confucius-dialog-panel confucius-note-save-panel",
  );
  const heading = el(doc, "h2", "confucius-note-save-heading");
  heading.id = "confucius-writeback-heading";
  const meta = el(doc, "div", "confucius-note-save-meta");
  meta.textContent = `${artifact.title} · ${getString("workspace-artifact-version")} ${revision}`;
  const controls = el(doc, "div", "confucius-note-save-controls");
  const destination = el(doc, "div", "confucius-note-save-destination");
  const targetButton = button(doc, "confucius-writeback-target", "");
  targetButton.setAttribute("aria-haspopup", "menu");
  targetButton.setAttribute("aria-expanded", "false");
  targetButton.setAttribute("aria-controls", "confucius-writeback-target-menu");
  const menu = createMenuSurface(doc, {
    id: "confucius-writeback-target-menu",
    role: "menu",
  });
  menu.hidden = true;
  const dismissMenu = () => {
    menu.hidden = true;
    targetButton.setAttribute("aria-expanded", "false");
    targetButton.focus({ preventScroll: true });
  };
  bindMenuNavigation(menu, dismissMenu);
  const targetButtons = targets.map((option) => {
    const control = button(doc, "", option.label);
    control.setAttribute("role", "menuitemradio");
    control.addEventListener("click", () => {
      target = option;
      dismissMenu();
      updateControls();
      void loadPreview();
    });
    menu.append(control);
    return { control, option };
  });
  targetButton.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    targetButton.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden)
      targetButtons.find((item) => item.option === target)?.control.focus();
  });
  destination.append(targetButton, menu);
  controls.append(destination);
  const knowledgeInput = el(doc, "input") as HTMLInputElement;
  knowledgeInput.id = "confucius-writeback-knowledge-id";
  knowledgeInput.type = "text";
  knowledgeInput.placeholder = getString("workspace-writeback-knowledge-id");
  knowledgeInput.setAttribute("aria-label", knowledgeInput.placeholder);
  knowledgeInput.hidden = true;
  const preview = el(doc, "div", "confucius-note-save-preview");
  const errorLine = el(doc, "div", "confucius-note-save-error");
  errorLine.setAttribute("role", "alert");
  const actions = el(doc, "div", "confucius-note-save-actions");
  const status = el(doc, "span", "confucius-note-save-status");
  status.setAttribute("aria-live", "polite");
  const cancel = button(
    doc,
    "confucius-writeback-cancel",
    getString("workspace-settings-cancel"),
  );
  const requestApproval = button(
    doc,
    "confucius-writeback-request",
    getString("workspace-writeback-prepare"),
    "primary",
  );
  requestApproval.disabled = true;
  let busy = false;
  let previewGeneration = 0;
  const updateControls = () => {
    heading.textContent =
      target.value === "zotero_note"
        ? getString("workspace-writeback-preview")
        : `${configuredUiLanguage() === "en-US" ? "Save to " : "保存到 "}${target.label}`;
    targetButton.textContent = `${getString("workspace-writeback-destination")} ▾`;
    targetButton.title = target.label;
    targetButton.disabled = busy || approval.pending;
    knowledgeInput.hidden = target.value !== "knowledge_base";
    knowledgeInput.disabled = busy || approval.pending;
    for (const item of targetButtons) {
      item.control.setAttribute("aria-checked", String(item.option === target));
      item.control.disabled = busy || approval.pending;
    }
  };
  const openLink = (href: string) => {
    void host
      .openLink?.(href)
      .then((result) => {
        if (!result.ok) errorLine.textContent = result.message ?? "";
      })
      .catch((error) => {
        errorLine.textContent = String(error);
      });
  };
  const showPreview = (result: WritebackPreview) => {
    preview.replaceChildren();
    const isNew =
      result.note?.isNew ??
      result.before === getString("workspace-writeback-new");
    status.textContent = isNew
      ? getString(
          target.value === "zotero_note"
            ? "workspace-writeback-note-new"
            : "workspace-writeback-new",
        )
      : getString("workspace-writeback-update");
    if (!isNew) {
      const previous = el(doc, "details", "confucius-note-save-previous");
      const summary = el(doc, "summary");
      summary.textContent = getString("workspace-writeback-before");
      const content = el(doc, "div", "confucius-note-content");
      renderNotePreview(
        content,
        target.value === "zotero_note"
          ? result.before
          : renderMarkdownHtml(result.before),
        openLink,
      );
      previous.append(summary, content);
      preview.append(previous);
    }
    const note = el(
      doc,
      "article",
      "confucius-note-content confucius-note-save-paper",
    );
    note.setAttribute("aria-label", getString("workspace-writeback-after"));
    renderNotePreview(
      note,
      result.note?.html ?? renderMarkdownHtml(result.after),
      openLink,
    );
    preview.append(note);
    preview.scrollTop = 0;
  };
  const loadPreview = async () => {
    const generation = ++previewGeneration;
    requestApproval.disabled = true;
    errorLine.textContent = "";
    status.textContent =
      configuredUiLanguage() === "en-US"
        ? "Preparing preview…"
        : "正在准备预览…";
    preview.setAttribute("aria-busy", "true");
    try {
      const result = (await rpc("artifact/writebackPreview", {
        id: artifact.id,
        revision,
        target: target.value,
      })) as WritebackPreview;
      if (!overlay.isConnected || generation !== previewGeneration) return;
      showPreview(result);
      requestApproval.disabled = false;
    } catch (error) {
      if (!overlay.isConnected || generation !== previewGeneration) return;
      preview.replaceChildren();
      status.textContent = "";
      errorLine.textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === previewGeneration)
        preview.removeAttribute("aria-busy");
    }
  };
  cancel.addEventListener("click", closeWriteback);
  requestApproval.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    requestApproval.disabled = true;
    menu.hidden = true;
    updateControls();
    errorLine.textContent = "";
    void (async () => {
      try {
        if (approval.pending) {
          await approval.approve();
          closeWriteback();
          await onSaved();
          return;
        }
        const prepared = await approval.prepare({
          id: artifact.id,
          revision,
          target: target.value,
          knowledgeBaseId: knowledgeInput.value.trim() || undefined,
        });
        if (!prepared || !overlay.isConnected) return;
        // Commit prepares a fresh snapshot; confirm exactly what will be saved.
        showPreview(prepared);
        requestApproval.textContent = getString("workspace-writeback-confirm");
        requestApproval.disabled = false;
        requestApproval.focus({ preventScroll: true });
      } catch (error) {
        if (!overlay.isConnected) return;
        errorLine.textContent =
          error instanceof Error ? error.message : String(error);
        requestApproval.disabled = false;
      } finally {
        busy = false;
        updateControls();
      }
    })();
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeWriteback();
    else if (!destination.contains(event.target as Node)) {
      menu.hidden = true;
      targetButton.setAttribute("aria-expanded", "false");
    }
  });
  actions.append(status, cancel, requestApproval);
  panel.append(
    heading,
    meta,
    controls,
    knowledgeInput,
    preview,
    errorLine,
    actions,
  );
  overlay.append(panel);
  root.append(overlay);
  updateControls();
  void loadPreview();
}
