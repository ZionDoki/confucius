import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { openWorkspace } from "./workspaceWindow";

/**
 * Entry points that live inside the Zotero PDF reader: a toolbar badge and a
 * "Ask Confucius" item on the selection context menu. Both route the user to
 * the workspace (respecting the layout preference) and focus the prompt, so
 * the reading loop never leaves the current tab.
 */

interface ReaderEvent {
  reader: unknown;
  doc: Document;
  params?: unknown;
  append: (entry: unknown) => void;
}

type ReaderEventListener = (event: ReaderEvent) => void;

interface ReaderEventApi {
  registerEventListener?: (
    type: string,
    handler: ReaderEventListener,
    pluginID?: string,
  ) => void;
  unregisterEventListener?: (
    type: string,
    handler: ReaderEventListener,
  ) => void;
}

const PROMPT_ID = "confucius-prompt";

function readerEventApi(): ReaderEventApi {
  return Zotero.Reader as unknown as ReaderEventApi;
}

function focusWorkspacePrompt(): void {
  const win = openWorkspace();
  if (!win) {
    return;
  }
  const deadline = Date.now() + 3000;
  const tryFocus = () => {
    const prompt = win.document.getElementById(PROMPT_ID) as
      (HTMLElement & { focus: () => void }) | null;
    if (prompt) {
      prompt.focus();
      return;
    }
    if (Date.now() < deadline) {
      setTimeout(tryFocus, 100);
    }
  };
  tryFocus();
}

function onRenderToolbar(event: ReaderEvent): void {
  const { doc, append } = event;
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "confucius-reader-entry";
  const tooltip = getString("reader-entry-tooltip");
  button.setAttribute("title", tooltip);
  button.setAttribute("aria-label", tooltip);
  Object.assign(button.style, {
    width: "22px",
    height: "22px",
    flex: "none",
    margin: "0 4px",
    padding: "0",
    borderRadius: "50%",
    border: "none",
    background: "#b3452f",
    color: "#faf9f6",
    fontSize: "12px",
    fontWeight: "600",
    lineHeight: "22px",
    cursor: "pointer",
  });
  button.textContent = "C";
  button.addEventListener("command", focusWorkspacePrompt);
  button.addEventListener("click", focusWorkspacePrompt);
  append(button);
}

function onSelectContextMenu(event: ReaderEvent): void {
  event.append({
    label: getString("reader-ask"),
    onCommand: focusWorkspacePrompt,
  });
}

let registered = false;

export function registerReaderEntry(): void {
  if (registered) {
    return;
  }
  const api = readerEventApi();
  if (typeof api.registerEventListener !== "function") {
    return;
  }
  api.registerEventListener("renderToolbar", onRenderToolbar, config.addonID);
  api.registerEventListener(
    "createSelectorContextMenu",
    onSelectContextMenu,
    config.addonID,
  );
  registered = true;
}

export function unregisterReaderEntry(): void {
  if (!registered) {
    return;
  }
  const api = readerEventApi();
  api.unregisterEventListener?.("renderToolbar", onRenderToolbar);
  api.unregisterEventListener?.(
    "createSelectorContextMenu",
    onSelectContextMenu,
  );
  registered = false;
}
