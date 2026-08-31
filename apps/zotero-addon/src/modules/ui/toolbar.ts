import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { openWorkspaceWindow } from "./workspaceWindow";

const BUTTON_ID = `${config.addonRef}-toolbar-button`;
const MENU_ID = `${config.addonRef}-tools-menuitem`;

export function registerToolbarButton(win?: Window): void {
  const doc = (win ?? Zotero.getMainWindow()).document;
  if (!doc.getElementById(BUTTON_ID)) {
    const anchor = doc.querySelector(
      "#zotero-tabs-toolbar > .zotero-tb-separator",
    );
    if (!anchor?.nextElementSibling) {
      ztoolkit.log("[Confucius] tabs toolbar separator not found");
    } else {
      ztoolkit.UI.insertElementBefore(
        {
          tag: "div",
          namespace: "html",
          id: BUTTON_ID,
          attributes: {
            title: getString("toolbar-tooltip"),
          },
          styles: {
            backgroundImage: `url(chrome://${config.addonRef}/content/icons/favicon.svg)`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center",
            backgroundSize: "18px",
            display: "flex",
            width: "28px",
            height: "28px",
            minWidth: "28px",
            alignItems: "center",
            borderRadius: "5px",
            cursor: "pointer",
          },
          listeners: [
            {
              type: "click",
              listener: () => {
                openWorkspaceWindow();
              },
            },
          ],
        },
        anchor.nextElementSibling,
      );
    }
  }

  const popup = doc.getElementById("menu_ToolsPopup");
  if (popup && !doc.getElementById(MENU_ID)) {
    const createXul = (
      doc as Document & {
        createXULElement?: (tag: string) => HTMLElement;
      }
    ).createXULElement;
    const item = createXul?.("menuitem");
    if (item) {
      item.id = MENU_ID;
      item.setAttribute("label", getString("toolbar-tooltip"));
      item.addEventListener("command", () => {
        openWorkspaceWindow();
      });
      popup.appendChild(item);
    }
  }
}

export function unregisterToolbarButton(win?: Window): void {
  const doc = (win ?? Zotero.getMainWindow()).document;
  doc.getElementById(BUTTON_ID)?.remove();
  doc.getElementById(MENU_ID)?.remove();
}
