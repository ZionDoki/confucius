import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { toggleWorkspace } from "./workspaceWindow";

const BUTTON_ID = `${config.addonRef}-toolbar-button`;
const MENU_ID = `${config.addonRef}-tools-menuitem`;

export function registerToolbarButton(win?: Window): void {
  const doc = (win ?? Zotero.getMainWindow()).document;
  try {
    if (!doc.getElementById(BUTTON_ID)) {
      const host =
        doc.getElementById("zotero-pq-buttons") ||
        doc.getElementById("zotero-tabs-toolbar");
      const button = createToolbarButton(doc, win);
      if (host && button) {
        host.appendChild(button);
      } else {
        ztoolkit.log("[Confucius] tabs toolbar not found");
      }
    }
  } catch (error) {
    ztoolkit.log("[Confucius] toolbar button failed", error);
  }

  try {
    const popup = doc.getElementById("menu_ToolsPopup");
    if (popup && !doc.getElementById(MENU_ID)) {
      const item = createXul(doc, "menuitem");
      if (item) {
        item.id = MENU_ID;
        item.setAttribute("label", getString("toolbar-tooltip"));
        item.addEventListener("command", () => {
          toggleWorkspace(win);
        });
        popup.appendChild(item);
      }
    }
  } catch (error) {
    ztoolkit.log("[Confucius] tools menu item failed", error);
  }
}

function createToolbarButton(doc: Document, win?: Window): HTMLElement | null {
  const button = createXul(doc, "toolbarbutton");
  if (!button) {
    return null;
  }
  button.id = BUTTON_ID;
  button.classList.add("zotero-tb-button");
  button.setAttribute("tooltiptext", getString("toolbar-tooltip"));
  button.setAttribute("aria-label", getString("toolbar-tooltip"));
  button.setAttribute("tabindex", "-1");
  button.style.listStyleImage = `url(chrome://${config.addonRef}/content/icons/favicon.svg)`;
  let lastToggleAt = 0;
  const onActivate = () => {
    const now = Date.now();
    if (now - lastToggleAt < 250) {
      return;
    }
    lastToggleAt = now;
    toggleWorkspace(win);
  };
  button.addEventListener("command", onActivate);
  button.addEventListener("click", onActivate);
  return button;
}

function createXul(doc: Document, tag: string): HTMLElement | null {
  const create = (
    doc as Document & {
      createXULElement?: (name: string) => HTMLElement;
    }
  ).createXULElement;
  if (typeof create !== "function") {
    return null;
  }
  return create.call(doc, tag);
}

export function unregisterToolbarButton(win?: Window): void {
  const doc = (win ?? Zotero.getMainWindow()).document;
  doc.getElementById(BUTTON_ID)?.remove();
  doc.getElementById(MENU_ID)?.remove();
}
