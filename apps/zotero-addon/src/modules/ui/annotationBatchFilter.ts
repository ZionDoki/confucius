import {
  annotationMatchesFilter,
  type AnnotationBatchView,
  type AnnotationBatchFilter,
} from "@confucius/protocol";
import {
  annotationBatchId,
  onAnnotationOwnershipChanged,
} from "../tools/AnnotationOwnership";
import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";

type Mark = { id: string; _hidden?: boolean; [key: string]: unknown };
interface FilterReader {
  _annotationManager: { _annotations: Mark[] };
  _state?: { annotations: Mark[] };
  _updateState: (
    state: { annotations?: Mark[]; [key: string]: unknown },
    init?: boolean,
  ) => void;
}
/** Filter copies at the render boundary; the native manager and database remain authoritative. */
export function installBatchVisibility(
  reader: FilterReader,
  matches: (key: string) => boolean,
  inReaderRealm: (state: { annotations: Mark[]; [key: string]: unknown }) => {
    annotations: Mark[];
    [key: string]: unknown;
  } = (state) => state,
  publish: (
    callback: FilterReader["_updateState"],
  ) => FilterReader["_updateState"] = (callback) => callback,
): { refresh(): void; dispose(): void } {
  const original = reader._updateState;
  let nativeAnnotations =
    reader._state?.annotations ?? reader._annotationManager._annotations;
  const apply: FilterReader["_updateState"] = function (state, init) {
    return original.call(
      reader,
      state.annotations
        ? inReaderRealm({
            ...state,
            annotations: Array.from(state.annotations, (mark) => ({
              ...mark,
              _hidden: !!mark._hidden || !matches(mark.id),
            })),
          })
        : state,
      init,
    );
  };
  const wrapped: FilterReader["_updateState"] = (state, init) => {
    if (state.annotations) nativeAnnotations = state.annotations;
    apply(state, init);
  };
  const exposed = publish(wrapped);
  reader._updateState = exposed;
  const refresh = () => apply({ annotations: nativeAnnotations });
  refresh();
  return {
    refresh,
    dispose() {
      if (reader._updateState === exposed) reader._updateState = original;
      original.call(
        reader,
        inReaderRealm({
          annotations: [...nativeAnnotations],
        }),
      );
    },
  };
}
let currentTaskId: string | undefined;
const refreshers = new Set<() => void>();
export function setAnnotationFilterTask(taskId?: string | null): void {
  currentTaskId = taskId ?? undefined;
  for (const refresh of refreshers) refresh();
}
let disposeAll: (() => void) | undefined;
export function registerAnnotationBatchFilter(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): void {
  disposeAll?.();
  const cleanups: Array<() => void> = [];
  let active = true;
  const installed = new WeakSet<object>();
  const install: _ZoteroTypes.Reader.EventHandler<"renderToolbar"> = async ({
    reader,
    doc,
    append,
  }) => {
    if (installed.has(reader)) return;
    installed.add(reader);
    // Zotero only accepts append during the synchronous toolbar callback.
    // Install its placeholder now, then wait before touching the render state.
    const box = doc.createElement("details");
    box.className = "confucius-annotation-batches";
    box.style.cssText =
      "position:relative;font-size:12px;max-width:260px;margin:0 6px";
    append(box);
    try {
      await reader._initPromise;
    } catch {
      box.remove();
      return;
    }
    if (!active) {
      box.remove();
      return;
    }
    const internal = reader._internalReader as unknown as FilterReader;
    const item = Zotero.Items.get(reader.itemID!);
    if (
      !item ||
      !internal?._annotationManager ||
      typeof internal._updateState !== "function"
    ) {
      box.remove();
      return;
    }
    const zh = getPref("uiLanguage") !== "en-US";
    const summary = doc.createElement("summary");
    summary.textContent = zh ? "标注批次" : "Annotation batches";
    const panel = doc.createElement("div");
    panel.style.cssText =
      "position:absolute;top:26px;right:0;z-index:1000;min-width:240px;max-height:360px;overflow:auto;padding:10px;background:var(--material-background,#fff);color:var(--fill-primary,#222);border:1px solid #aaa;border-radius:6px;box-shadow:0 4px 15px #0003";
    box.append(summary, panel);
    let view: AnnotationBatchView | undefined;
    let closed = false;
    let revision = 0;
    let refreshQueue = Promise.resolve();
    const visibility = installBatchVisibility(
      internal,
      (key) =>
        !view ||
        annotationMatchesFilter(
          view.membership[key],
          view.filter,
          currentTaskId ? annotationBatchId(currentTaskId) : undefined,
        ),
      (state) =>
        Components.utils.cloneInto(state, reader._iframeWindow!, {
          wrapReflectors: true,
        }),
      (callback) =>
        Components.utils.exportFunction(callback, reader._iframeWindow!, {
          allowCrossOriginArguments: true,
        }),
    );
    const paint = () => {
      if (!view || closed) return;
      panel.replaceChildren();
      const select = doc.createElement("select");
      select.setAttribute(
        "aria-label",
        zh ? "标注批次筛选" : "Filter annotation batches",
      );
      for (const [value, label] of [
        ["all", zh ? "全部" : "All"],
        ["current", zh ? "当前任务" : "Current task"],
        ["selected", zh ? "选择批次" : "Select batches"],
      ]) {
        const option = doc.createElement("option");
        option.value = value;
        option.textContent = label;
        option.disabled = value === "current" && !currentTaskId;
        select.append(option);
      }
      select.value = view.filter.mode;
      select.addEventListener(
        "change",
        () =>
          void refresh({
            ...view!.filter,
            mode: select.value as AnnotationBatchFilter["mode"],
          }),
      );
      panel.append(select);
      if (view.filter.mode === "selected") {
        const choices = [
          ...view.batches.map((batch) => ({
            id: batch.id,
            name: `${batch.name} · ${new Date(batch.createdAt).toLocaleDateString()} (${batch.count})`,
          })),
          {
            id: "",
            name: `${zh ? "原有标注" : "Existing annotations"} (${view.existingCount})`,
          },
        ];
        for (const choice of choices) {
          const label = doc.createElement("label");
          label.style.cssText = "display:block;margin-top:7px";
          const input = doc.createElement("input");
          input.type = "checkbox";
          input.checked = choice.id
            ? view.filter.batchIds.includes(choice.id)
            : view.filter.includeExisting;
          input.addEventListener("change", () => {
            const next = {
              ...view!.filter,
              batchIds: [...view!.filter.batchIds],
            };
            if (!choice.id) next.includeExisting = input.checked;
            else
              next.batchIds = input.checked
                ? [...next.batchIds, choice.id]
                : next.batchIds.filter((id) => id !== choice.id);
            void refresh(next);
          });
          label.append(input, doc.createTextNode(choice.name));
          panel.append(label);
        }
      }
      const count = Object.values(view.membership).filter((batch) =>
        annotationMatchesFilter(
          batch,
          view!.filter,
          currentTaskId ? annotationBatchId(currentTaskId) : undefined,
        ),
      ).length;
      const status = doc.createElement("div");
      status.style.marginTop = "8px";
      status.textContent = count
        ? zh
          ? `${count} 条标注（同时应用阅读器其他筛选）`
          : `${count} annotations; reader filters also apply`
        : zh
          ? "此筛选下没有标注"
          : "No annotations match";
      panel.append(status);
      summary.textContent = `${zh ? "标注批次" : "Batches"} · ${count}/${view.total}`;
    };
    const refresh = (filter?: AnnotationBatchFilter): Promise<void> => {
      if (closed) return Promise.resolve();
      const requestRevision = ++revision;
      if (view && filter) {
        view.filter = filter;
        paint();
        visibility.refresh();
      }
      refreshQueue = refreshQueue.then(async () => {
        if (closed) return;
        try {
          const result = (await rpc("annotation/batches", {
            libraryID: item.libraryID,
            key: item.key,
            ...(filter ? { filter } : {}),
          })) as AnnotationBatchView;
          if (!closed && requestRevision === revision) {
            view = result;
            visibility.refresh();
            paint();
          }
        } catch (error) {
          if (!closed) panel.textContent = String(error);
        }
      });
      return refreshQueue;
    };
    const rerender = () => {
      visibility.refresh();
      paint();
      void refresh();
    };
    refreshers.add(rerender);
    const stopOwnership = onAnnotationOwnershipChanged((pdf) => {
      if (pdf === `${item.libraryID}_${item.key}`) void refresh();
    });
    const observer = Zotero.Notifier.registerObserver(
      {
        notify: () => {
          void refresh();
        },
      },
      ["item"],
      "confucius-annotation-batches",
    );
    const cleanup = () => {
      if (closed) return;
      closed = true;
      stopOwnership();
      refreshers.delete(rerender);
      Zotero.Notifier.unregisterObserver(observer);
      visibility.dispose();
      box.remove();
      doc.defaultView?.removeEventListener("unload", cleanup);
    };
    cleanups.push(cleanup);
    doc.defaultView?.addEventListener("unload", cleanup, { once: true });
    await refresh();
  };
  Zotero.Reader.registerEventListener("renderToolbar", install, config.addonID);
  for (const reader of Zotero.Reader._readers) {
    const doc = reader._iframeWindow?.document;
    const toolbar = doc?.querySelector(".toolbar .end");
    if (doc && toolbar)
      void install({
        type: "renderToolbar",
        params: {},
        reader,
        doc,
        append: (element: Node) => toolbar.appendChild(element),
      } as Parameters<typeof install>[0]);
  }
  disposeAll = () => {
    active = false;
    Zotero.Reader.unregisterEventListener("renderToolbar", install);
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* reader may already be closed */
      }
    }
  };
}
export function unregisterAnnotationBatchFilter(): void {
  disposeAll?.();
  disposeAll = undefined;
}
