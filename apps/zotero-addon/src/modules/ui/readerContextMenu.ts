import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { openWorkspace } from "./workspaceWindow";
import type {
  LaunchIntent,
  LockedContextSnapshot,
  TaskTemplateId,
} from "@confucius/protocol";

/**
 * Source-aware actions exposed from the PDF selection context menu. The
 * selection is frozen while Zotero builds the menu, before native menu focus
 * can clear the reader's DOM ranges.
 */

interface ReaderEvent {
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

interface ReaderLaunchHost {
  queueLaunch?: (value: LaunchIntent) => void;
  captureLockedContext?: () => LockedContextSnapshot;
}

function readerEventApi(): ReaderEventApi {
  return Zotero.Reader as unknown as ReaderEventApi;
}

function launchHost(): ReaderLaunchHost | undefined {
  const instance = (
    Zotero as unknown as Record<
      string,
      { hooks?: { host?: ReaderLaunchHost } } | undefined
    >
  )[config.addonInstance];
  return instance?.hooks?.host;
}

function captureLaunchContext(): LockedContextSnapshot | undefined {
  try {
    return launchHost()?.captureLockedContext?.();
  } catch {
    return undefined;
  }
}

function focusWorkspacePrompt(
  templateId: TaskTemplateId,
  context?: LockedContextSnapshot,
): void {
  launchHost()?.queueLaunch?.({ templateId, autoStart: true, context });
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

function onSelectContextMenu(event: ReaderEvent): void {
  const context = captureLaunchContext();
  if (!context?.selection?.text.trim()) {
    return;
  }
  const entries: Array<[string, TaskTemplateId]> = [
    ["reader-explain-selection", "explain-selection"],
    ["reader-verify-claim", "verify-claim"],
    ["reader-save-insight", "save-insight"],
    ["reader-selection-note", "selection-note"],
  ];
  for (const [labelKey, templateId] of entries) {
    event.append({
      label: getString(labelKey),
      onCommand: () => focusWorkspacePrompt(templateId, context),
    });
  }
}

let registered = false;

export function registerReaderContextMenu(): void {
  if (registered) {
    return;
  }
  const api = readerEventApi();
  if (typeof api.registerEventListener !== "function") {
    return;
  }
  api.registerEventListener(
    "createSelectorContextMenu",
    onSelectContextMenu,
    config.addonID,
  );
  // Zotero 7 routes the menu opened over selected PDF text through
  // createViewContextMenu. Keep the selector event as a compatibility path.
  api.registerEventListener(
    "createViewContextMenu",
    onSelectContextMenu,
    config.addonID,
  );
  registered = true;
}

export function unregisterReaderContextMenu(): void {
  if (!registered) {
    return;
  }
  const api = readerEventApi();
  api.unregisterEventListener?.(
    "createSelectorContextMenu",
    onSelectContextMenu,
  );
  api.unregisterEventListener?.("createViewContextMenu", onSelectContextMenu);
  registered = false;
}
