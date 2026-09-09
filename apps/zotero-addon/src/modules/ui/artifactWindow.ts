import { config } from "../../../package.json";
import type { ArtifactRecord } from "@confucius/protocol";
import type { WorkspaceHost } from "./WorkspaceView";
import {
  mountArtifactWindow,
  type ArtifactWindowView,
} from "./artifactWindowView";

type RenderMarkdown = (node: HTMLElement, text: string) => void;

/** A parentless, ordinary top-level window. Never a dependent or modal dialog. */
export const ARTIFACT_WINDOW_FEATURES =
  "chrome,dialog=no,all,resizable=yes,dependent=no,width=920,height=780";

interface WindowEntry {
  win: Window;
  taskId: string;
  revision?: number;
  view?: ArtifactWindowView;
}

export class ArtifactWindows {
  private readonly windows = new Map<string, WindowEntry>();

  constructor(
    private readonly createWindow: () => Window,
    private readonly mount = mountArtifactWindow,
    private readonly defer?: (callback: () => void, delay: number) => void,
  ) {}

  open(
    host: WorkspaceHost,
    artifact: ArtifactRecord,
    revision: number | undefined,
    fillAnswerHtml: RenderMarkdown,
  ): Window {
    const existing = this.windows.get(artifact.id);
    if (existing && !existing.win.closed) {
      existing.revision = revision;
      existing.view?.select(revision);
      existing.win.focus();
      return existing.win;
    }
    const win = this.createWindow();
    const entry: WindowEntry = { win, taskId: artifact.taskId, revision };
    this.windows.set(artifact.id, entry);
    const start = () => {
      if (
        win.closed ||
        this.windows.get(artifact.id) !== entry ||
        entry.view ||
        !win.document.getElementById("confucius-artifact-window")
      )
        return;
      entry.view = this.mount(
        win,
        host,
        artifact,
        entry.revision,
        fillAnswerHtml,
      );
      win.removeEventListener("DOMContentLoaded", start);
      win.removeEventListener("load", start);
      // Register against the final chrome document, after its initial
      // about:blank has been replaced. That replacement is not a user close.
      win.addEventListener(
        "unload",
        () => {
          entry.view?.dispose();
          win.removeEventListener("DOMContentLoaded", start);
          win.removeEventListener("load", start);
          if (this.windows.get(artifact.id) === entry)
            this.windows.delete(artifact.id);
        },
        { once: true },
      );
    };
    win.addEventListener("DOMContentLoaded", start);
    win.addEventListener("load", start);
    start();
    // Gecko can replace the initial inner window before its load listeners run.
    // Retry from the plugin until ready or closed, including slow chrome loads.
    // A timer on the initial inner window would be lost with that document.
    const checkReady = () => {
      if (this.windows.get(artifact.id) !== entry) return;
      if (win.closed) {
        this.windows.delete(artifact.id);
        return;
      }
      start();
      if (!entry.view) this.defer?.(checkReady, 100);
    };
    if (!entry.view) this.defer?.(checkReady, 0);
    return win;
  }

  closeTask(taskId: string): void {
    for (const entry of [...this.windows.values()])
      if (entry.taskId === taskId && !entry.win.closed) entry.win.close();
  }

  async closeArtifact(artifactId: string): Promise<void> {
    const entry = this.windows.get(artifactId);
    if (!entry || entry.win.closed) return;
    await entry.view?.dispose();
    if (!entry.win.closed) entry.win.close();
  }

  closeAll(): void {
    for (const entry of [...this.windows.values()])
      if (!entry.win.closed) entry.win.close();
    this.windows.clear();
  }
}

export function openNativeArtifactWindow(): Window {
  const win = Services.ww.openWindow(
    // Gecko accepts null to create a window without an owning parent.
    // @ts-expect-error Generated XPCOM types omit the nullable parent.
    null,
    `chrome://${config.addonRef}/content/artifact.xhtml`,
    "_blank",
    ARTIFACT_WINDOW_FEATURES,
    null,
  );
  if (!win) throw new Error("Could not open the report window");
  return win as unknown as Window;
}

export const artifactWindows = new ArtifactWindows(
  openNativeArtifactWindow,
  mountArtifactWindow,
  (callback, delay) => {
    void Zotero.Promise.delay(delay).then(callback);
  },
);
