import { config } from "../../../package.json";
import type { ArtifactRecord } from "@confucius/protocol";
import type { WorkspaceHost } from "./WorkspaceView";
import { artifactWindows } from "./artifactWindow";
import {
  mountArtifactWindow,
  type ArtifactWindowView,
} from "./artifactWindowView";

/** The same reading document fills the workspace or runs in its own native window. */
export function mountWorkspaceArtifact(
  root: HTMLElement,
  host: WorkspaceHost,
  artifact: ArtifactRecord,
  revision: number | undefined,
  renderMarkdown: (node: HTMLElement, text: string) => void,
  onBack: () => void,
  onError: (error: unknown) => void,
): { taskId: string; dispose(): Promise<void> } {
  const doc = root.ownerDocument;
  if (!doc) throw new Error("Workspace has no document");
  const frame = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "iframe",
  ) as HTMLIFrameElement;
  frame.className = "confucius-artifact-host";
  frame.title = artifact.title;
  frame.setAttribute(
    "src",
    `chrome://${config.addonRef}/content/artifact.xhtml`,
  );
  const covered = [...root.children] as HTMLElement[];
  const prior = covered.map((node) => ({ node, inert: node.inert }));
  for (const { node } of prior) node.inert = true;
  root.classList.add("has-artifact");
  let view: ArtifactWindowView | undefined;
  let disposed = false;
  let saved: Promise<void> | undefined;
  let loadTimer: number | undefined;
  const dispose = () => {
    if (disposed) return saved ?? Promise.resolve();
    disposed = true;
    saved = Promise.resolve(view?.dispose());
    doc.defaultView?.clearTimeout(loadTimer);
    frame.removeEventListener("load", mount);
    frame.remove();
    root.classList.remove("has-artifact");
    for (const { node, inert } of prior) node.inert = inert;
    return saved;
  };
  const back = () => {
    void dispose().then(onBack).catch(onError);
  };
  const mount = () => {
    if (disposed || view) return;
    const win = frame.contentWindow;
    if (!win?.document.getElementById("confucius-artifact-window")) return;
    try {
      view = mountArtifactWindow(
        win,
        host,
        artifact,
        revision,
        renderMarkdown,
        {
          back,
          detach(current, selected) {
            artifactWindows.open(host, current, selected, renderMarkdown);
            // Reading state was flushed before the new document began loading.
            void dispose().catch(onError);
          },
        },
      );
    } catch (error) {
      void dispose().then(() => onError(error));
    }
  };
  frame.addEventListener("load", mount);
  root.append(frame);
  // Chrome can replace the initial frame document before its load listener fires.
  const checkReady = () => {
    mount();
    if (!disposed && !view)
      loadTimer = doc.defaultView?.setTimeout(checkReady, 100);
  };
  checkReady();
  return { taskId: artifact.taskId, dispose };
}
