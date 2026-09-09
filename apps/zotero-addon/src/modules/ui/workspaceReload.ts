import type { TaskContextReference } from "@confucius/protocol";

export type WorkspaceSettingsTab =
  "model" | "runtime" | "memory" | "security" | "appearance" | "update";

export interface WorkspaceViewSnapshot {
  taskId: string | null;
  drafts: [string, string][];
  references: [string, TaskContextReference[]][];
  viewports: [string, { scrollTop: number; followsBottom: boolean }][];
  showSessions?: boolean;
  settingsTab?: WorkspaceSettingsTab;
}

export interface WorkspaceReload {
  layout: "window" | "sidebar";
  view: WorkspaceViewSnapshot;
  width?: number;
  height?: number;
}

const readers = new WeakMap<HTMLElement, () => WorkspaceViewSnapshot>();

export function registerWorkspaceSnapshot(
  root: HTMLElement,
  read: () => WorkspaceViewSnapshot,
): () => void {
  readers.set(root, read);
  return () => readers.delete(root);
}

export function openWorkspaceSettingsTab(
  doc: Document | null,
): WorkspaceSettingsTab | undefined {
  const id = doc?.querySelector(
    '#confucius-settings-overlay [role="tab"][aria-selected="true"]',
  )?.id;
  const tab = id?.replace("confucius-cfg-tab-", "");
  if (
    tab === "model" ||
    tab === "runtime" ||
    tab === "memory" ||
    tab === "security" ||
    tab === "appearance" ||
    tab === "update"
  )
    return tab;
  return undefined;
}

export function captureWorkspaceSnapshot(
  root: HTMLElement,
): WorkspaceViewSnapshot {
  const read = readers.get(root);
  if (read) return read();

  // A pre-fix version may leave its untracked window alive after shutdown.
  // Read only visible UI data; never carry its old host, callbacks or settings values.
  const entry = root.querySelector<HTMLElement>('[data-entry-id^="overview:"]');
  const selected = entry?.dataset.entryId?.slice("overview:".length);
  const taskId = selected && selected !== "new" ? selected : null;
  const prompt = root.querySelector<HTMLTextAreaElement>("#confucius-prompt");
  const timeline = root.querySelector<HTMLElement>(".confucius-timeline-pane");
  return {
    taskId,
    drafts: prompt ? [[taskId ?? "new", prompt.value]] : [],
    references: [],
    viewports:
      taskId && timeline
        ? [
            [
              taskId,
              {
                scrollTop: timeline.scrollTop,
                followsBottom:
                  timeline.scrollHeight -
                    timeline.scrollTop -
                    timeline.clientHeight <
                  96,
              },
            ],
          ]
        : [],
    showSessions:
      root
        .querySelector("#confucius-toggle-sessions")
        ?.getAttribute("aria-expanded") === "true",
    settingsTab: openWorkspaceSettingsTab(root.ownerDocument),
  };
}

/** One-shot process state survives a bootstrap replacement, not a Zotero restart. */
type ReloadCarrier = { confuciusWorkspaceReload?: string };

export function saveWorkspaceReload(
  carrier: ReloadCarrier,
  value: WorkspaceReload | null,
): void {
  carrier.confuciusWorkspaceReload = JSON.stringify(value);
}

export function takeWorkspaceReload(
  carrier: ReloadCarrier,
): WorkspaceReload | null | undefined {
  const value = carrier.confuciusWorkspaceReload;
  delete carrier.confuciusWorkspaceReload;
  if (value === undefined) return undefined;
  try {
    const snapshot = JSON.parse(value) as WorkspaceReload | null;
    if (
      snapshot &&
      (snapshot.layout === "window" || snapshot.layout === "sidebar") &&
      snapshot.view
    )
      return snapshot;
  } catch {
    // An incompatible handoff must not prevent the new plugin from starting.
  }
  return null;
}
