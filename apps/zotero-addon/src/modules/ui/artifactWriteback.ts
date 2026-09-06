import type { ArtifactRecord } from "@confucius/protocol";
import type { WorkspaceHost } from "./WorkspaceView";
import { getString } from "../../utils/locale";
import {
  ArtifactWritebackApproval,
  type WritebackPreview,
} from "./artifactWritebackApproval";
import {
  createWorkspaceButton as button,
  bindDialogNavigation,
} from "./workspaceControls";

function el(
  doc: Document,
  tag: string,
  style?: Record<string, string>,
  attributes?: Record<string, string>,
): HTMLElement {
  const node = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElement;
  if (style) Object.assign(node.style, style);
  for (const [key, value] of Object.entries(attributes ?? {}))
    node.setAttribute(key, value);
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
  const rpc = host.rpc.bind(host);
  function writebackTargets(
    artifact: ArtifactRecord,
  ): Array<{ value: string; label: string }> {
    const targets = [
      {
        value: "zotero_note",
        label: getString("workspace-writeback-note"),
      },
      {
        value: "knowledge_base",
        label: getString("workspace-writeback-knowledge"),
      },
    ];
    if (artifact.kind === "annotation_set") {
      targets.unshift({
        value: "zotero_annotations",
        label: getString("workspace-writeback-annotations"),
      });
    }
    if (artifact.kind === "collection_diff") {
      targets.unshift({
        value: "zotero_tags",
        label: getString("workspace-writeback-tags"),
      });
      targets.unshift({
        value: "zotero_collection",
        label: getString("workspace-writeback-collection"),
      });
    }
    return targets;
  }

  function openWritebackPreview(
    artifact: ArtifactRecord,
    revision: number,
  ): void {
    if (doc.getElementById("confucius-writeback-overlay")) return;
    const approval = new ArtifactWritebackApproval(host);
    const returnFocus = doc.activeElement as HTMLElement | null;
    const overlay = el(
      doc,
      "div",
      { zIndex: "1300" },
      {
        id: "confucius-writeback-overlay",
        "aria-label": getString("workspace-writeback-preview"),
      },
    );
    overlay.className = "confucius-dialog";
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
    const panel = el(doc, "div");
    panel.className = "confucius-dialog-panel";
    const heading = el(doc, "div", {
      marginBottom: "10px",
      fontSize: "16px",
      fontWeight: "700",
    });
    heading.textContent = getString("workspace-writeback-preview");
    const targetSelect = el(
      doc,
      "select",
      {
        width: "100%",
        height: "34px",
        marginBottom: "10px",
        border: "1px solid var(--confucius-line)",
        borderRadius: "7px",
        background: "var(--confucius-elevated)",
      },
      { id: "confucius-writeback-target" },
    ) as HTMLSelectElement;
    for (const target of writebackTargets(artifact)) {
      const option = el(doc, "option", undefined, { value: target.value });
      option.textContent = target.label;
      targetSelect.appendChild(option);
    }
    const knowledgeInput = el(
      doc,
      "input",
      {
        display: "none",
        width: "100%",
        height: "34px",
        marginBottom: "10px",
        padding: "0 8px",
        boxSizing: "border-box",
        border: "1px solid var(--confucius-line)",
        borderRadius: "7px",
      },
      {
        type: "text",
        placeholder: getString("workspace-writeback-knowledge-id"),
      },
    ) as HTMLInputElement;
    const preview = el(doc, "div");
    preview.className = "confucius-before-after";
    const errorLine = el(doc, "div", {
      minHeight: "18px",
      marginTop: "8px",
      color: "var(--confucius-danger)",
    });
    const actions = el(doc, "div", {
      display: "flex",
      justifyContent: "flex-end",
      gap: "8px",
      marginTop: "10px",
    });
    const cancel = button(doc, "", getString("workspace-settings-cancel"));
    const requestApproval = button(
      doc,
      "confucius-writeback-request",
      getString("workspace-writeback-prepare"),
      "primary",
    );
    requestApproval.setAttribute("disabled", "true");
    let previewGeneration = 0;
    const showPreview = (result: WritebackPreview) => {
      preview.replaceChildren();
      for (const [label, value] of [
        [getString("workspace-writeback-before"), result.before],
        [getString("workspace-writeback-after"), result.after],
      ]) {
        const column = el(doc, "div");
        const title = el(doc, "div", {
          color: "var(--confucius-muted)",
          fontSize: "11px",
          fontWeight: "700",
        });
        title.textContent = label;
        const content = el(doc, "pre");
        content.textContent = value;
        column.append(title, content);
        preview.append(column);
      }
    };
    const loadPreview = async (): Promise<void> => {
      const generation = ++previewGeneration;
      requestApproval.setAttribute("disabled", "true");
      errorLine.textContent = "";
      preview.textContent = "";
      try {
        const result = (await rpc("artifact/writebackPreview", {
          id: artifact.id,
          revision,
          target: targetSelect.value,
        })) as { before: string; after: string };
        if (!overlay.isConnected || generation !== previewGeneration) return;
        showPreview(result);
        requestApproval.removeAttribute("disabled");
      } catch (error) {
        if (!overlay.isConnected || generation !== previewGeneration) return;
        errorLine.textContent =
          error instanceof Error ? error.message : String(error);
      }
    };
    targetSelect.addEventListener("change", () => {
      knowledgeInput.style.display =
        targetSelect.value === "knowledge_base" ? "block" : "none";
      void loadPreview();
    });
    cancel.addEventListener("click", closeWriteback);
    requestApproval.addEventListener("click", () => {
      requestApproval.setAttribute("disabled", "true");
      targetSelect.disabled = true;
      knowledgeInput.disabled = true;
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
            target: targetSelect.value,
            knowledgeBaseId: knowledgeInput.value.trim() || undefined,
          });
          if (!prepared || !overlay.isConnected) return;
          // Commit prepares a fresh snapshot. Show that exact snapshot before
          // resolving the approval, without depending on an open workspace.
          showPreview(prepared);
          requestApproval.textContent = getString(
            "workspace-writeback-confirm",
          );
          requestApproval.removeAttribute("disabled");
          requestApproval.focus({ preventScroll: true });
        } catch (error) {
          if (!overlay.isConnected) return;
          errorLine.textContent =
            error instanceof Error ? error.message : String(error);
          requestApproval.removeAttribute("disabled");
          targetSelect.disabled = approval.pending;
          knowledgeInput.disabled = approval.pending;
        }
      })();
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeWriteback();
    });
    actions.appendChild(cancel);
    actions.appendChild(requestApproval);
    panel.appendChild(heading);
    panel.appendChild(targetSelect);
    panel.appendChild(knowledgeInput);
    panel.appendChild(preview);
    panel.appendChild(errorLine);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    root.appendChild(overlay);
    targetSelect.focus({ preventScroll: true });
    void loadPreview();
  }

  openWritebackPreview(artifact, revision);
}
