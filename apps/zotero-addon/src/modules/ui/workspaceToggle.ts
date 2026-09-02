export type WorkspaceLayoutMode = "window" | "sidebar";
export type WorkspaceIconAction = "open" | "close";

export const WORKSPACE_SIDEBAR_ID = "confucius-sidebar";

/**
 * Icon-click decision for the Zotero toolbar button. Sidebar layout is a
 * toggle: a second click collapses an already-visible pane. Window layout
 * always opens/focuses the workspace window.
 */
export function workspaceIconAction(input: {
  layout: WorkspaceLayoutMode;
  sidebarVisible: boolean;
}): WorkspaceIconAction {
  if (input.layout === "sidebar" && input.sidebarVisible) {
    return "close";
  }
  return "open";
}

export function isWorkspaceSidebarVisible(doc: {
  getElementById(id: string): unknown;
}): boolean {
  const pane = doc.getElementById(WORKSPACE_SIDEBAR_ID) as {
    hidden?: boolean;
  } | null;
  if (!pane) {
    return false;
  }
  return pane.hidden !== true;
}
