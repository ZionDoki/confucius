import { config } from "../../../package.json";
import { getString } from "../../utils/locale";
import { ensurePaletteStyles } from "./workspaceSurface";
import { fillAnswerHtml } from "./WorkspaceView";
import { mountNativeAnnotationView } from "./nativeAnnotationView";

let unregister: (() => void) | undefined;

export function registerNativeAnnotations(): void {
  if (unregister) return;
  const views = new Map<Document, () => void>();
  let stopped = false;
  const attach = (doc: Document, reader: _ZoteroTypes.ReaderInstance) => {
    if (stopped || views.has(doc) || !doc.body) return;
    ensurePaletteStyles(doc, { inline: true });
    const main = Zotero.getMainWindow();
    const dispose = mountNativeAnnotationView(doc, {
      render: fillAnswerHtml,
      selectAnnotation: (id) => {
        // Reading a card selects that annotation, just like the native comment
        // does. This also keeps native copy/delete handling out of multi-select.
        const internal = Components.utils.waiveXrays(
          reader._internalReader,
        ) as unknown as {
          _state: { selectedAnnotationIDs: string[] };
          setSelectedAnnotations(
            ids: string[],
            fromView: boolean,
            event: object,
          ): void;
        };
        if (
          !id ||
          !reader._iframeWindow ||
          typeof internal.setSelectedAnnotations !== "function"
        )
          return;
        const selected = internal._state.selectedAnnotationIDs;
        if (selected.length === 1 && selected[0] === id) return;
        internal.setSelectedAnnotations(
          Components.utils.cloneInto([id], reader._iframeWindow),
          true,
          Components.utils.cloneInto(
            { button: 2, shiftKey: false, ctrlKey: false, metaKey: false },
            reader._iframeWindow,
          ),
        );
      },
      editLabel: getString("annotation-edit-comment"),
      resizeLabel: (corner) => getString(`annotation-resize-${corner}`),
      observer: main.MutationObserver,
      resizeObserver: main.ResizeObserver,
    });
    const cleanup = () => {
      dispose();
      doc.defaultView?.removeEventListener("unload", cleanup);
      views.delete(doc);
    };
    views.set(doc, cleanup);
    doc.defaultView?.addEventListener("unload", cleanup, { once: true });
  };
  const listener: _ZoteroTypes.Reader.EventHandler<
    "renderToolbar" | "renderSidebarAnnotationHeader"
  > = (event) => {
    if (event.reader.type !== "pdf") return;
    try {
      attach(
        Components.utils.unwaiveXrays(event.doc) as Document,
        event.reader,
      );
    } catch (error) {
      ztoolkit.log("[Confucius] annotation view", error);
    }
  };
  Zotero.Reader.registerEventListener(
    "renderToolbar",
    listener,
    config.addonID,
  );
  Zotero.Reader.registerEventListener(
    "renderSidebarAnnotationHeader",
    listener,
    config.addonID,
  );
  // Hot enabling must also cover readers whose sidebar is closed.
  for (const reader of Zotero.Reader._readers) {
    if (reader.type !== "pdf") continue;
    void reader._initPromise
      .then(() => {
        if (!stopped && reader._iframeWindow?.document)
          attach(
            Components.utils.unwaiveXrays(
              reader._iframeWindow.document,
            ) as Document,
            reader,
          );
      })
      .catch((error) =>
        ztoolkit.log("[Confucius] annotation reader startup", error),
      );
  }
  unregister = () => {
    stopped = true;
    Zotero.Reader.unregisterEventListener("renderToolbar", listener);
    Zotero.Reader.unregisterEventListener(
      "renderSidebarAnnotationHeader",
      listener,
    );
    for (const cleanup of [...views.values()]) cleanup();
  };
}

export function unregisterNativeAnnotations(): void {
  unregister?.();
  unregister = undefined;
}
