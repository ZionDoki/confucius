import { config } from "../../../package.json";
import type { BtwSelection } from "@confucius/protocol";
import { fillAnswerHtml } from "./WorkspaceView";
import {
  showBtwPopup,
  closeBtwPopups,
  type BtwHost,
  type BtwPopup,
} from "./btwPopup";

let unregister: (() => void) | undefined;

/** Zotero owns PDF selection geometry; no global active-reader lookup is used. */
export function registerBtwReader(host: BtwHost): void {
  if (unregister) return;
  const cleanups = new Set<() => void>();
  const visible = new Map<
    Document,
    {
      signature: string;
      popup?: BtwPopup;
      marker: HTMLElement;
      anchor: DOMRect;
    }
  >();
  const listener: _ZoteroTypes.Reader.EventHandler<
    "renderTextSelectionPopup"
  > = (event) => {
    const { reader, params, append } = event;
    const doc = Components.utils.unwaiveXrays(event.doc) as Document;
    if (reader.type !== "pdf" || !params.annotation.text?.trim()) return;
    const item = reader.itemID ? Zotero.Items.get(reader.itemID) : reader._item;
    if (!item) return;
    const annotation = params.annotation as unknown as {
      text: string;
      pageLabel?: string;
      position?: string | { pageIndex?: number; rects?: number[][] };
    };
    let position: { pageIndex?: number; rects?: number[][] } = {};
    try {
      position =
        typeof annotation.position === "string"
          ? JSON.parse(annotation.position)
          : (annotation.position ?? {});
    } catch {
      /* Text remains available. */
    }
    const parentKey = item.parentItemKey || null;
    const parent = parentKey
      ? Zotero.Items.getByLibraryAndKey(item.libraryID, parentKey)
      : item;
    const selection: BtwSelection = {
      source: {
        kind: "pdf",
        libraryID: item.libraryID,
        attachmentKey: item.key,
        parentKey,
        title: String(
          (parent && parent.getDisplayTitle?.()) || reader._title || "PDF",
        ),
        pageIndex: position.pageIndex ?? null,
        pageLabel: annotation.pageLabel ?? null,
        rects: position.rects,
      },
      text: annotation.text,
      surroundingText: "",
      capturedAt: Date.now(),
    };
    const marker = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as HTMLElement;
    marker.style.cssText = "display:block;height:0;width:100%;";
    marker.setAttribute("aria-hidden", "true");
    append(marker);
    const win = doc.defaultView!;
    const cleanup = () => {
      observer?.disconnect();
      if (timer !== undefined) win.clearTimeout(timer);
      cleanups.delete(cleanup);
    };
    const mount = () => {
      if (!marker.isConnected) return;
      cleanup();
      const anchor = marker.getBoundingClientRect();
      const signature = JSON.stringify([selection.source, selection.text]);
      const previous = visible.get(doc);
      if (
        previous?.signature === signature &&
        previous.popup?.element.isConnected
      ) {
        previous.marker = marker;
        previous.anchor = anchor;
        return;
      }
      previous?.popup?.close();
      const entry = {
        signature,
        marker,
        anchor,
        popup: undefined as BtwPopup | undefined,
      };
      visible.set(doc, entry);
      entry.popup = showBtwPopup({
        doc,
        host,
        fillAnswerHtml,
        selection,
        anchor: () =>
          entry.marker.isConnected
            ? entry.marker.getBoundingClientRect()
            : entry.anchor,
        closed: () => {
          if (visible.get(doc) === entry) visible.delete(doc);
        },
      });
    };
    cleanups.add(cleanup);
    // Reader documents are content compartments; create the observer in chrome
    // so its options dictionary is not rejected by Gecko's security wrapper.
    const observer = new (Zotero.getMainWindow().MutationObserver)(mount);
    observer!.observe(doc.documentElement!, { childList: true, subtree: true });
    const timer = win.setTimeout(cleanup, 3000);
    mount();
  };
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    listener,
    config.addonID,
  );
  unregister = () => {
    Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", listener);
    for (const cleanup of [...cleanups]) cleanup();
    closeBtwPopups();
    visible.clear();
  };
}

export function unregisterBtwReader() {
  unregister?.();
  unregister = undefined;
}
