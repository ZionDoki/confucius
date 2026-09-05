import { isUiTheme, type UiTheme } from "@confucius/protocol";
import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";

const bindings = new Map<Document, () => void>();

export function applyDocumentTheme(doc: Document, theme: UiTheme): void {
  doc.documentElement?.setAttribute("data-confucius-theme", theme);
}

export function restoreDocumentTheme(doc: Document): void {
  const theme = getPref("uiTheme");
  applyDocumentTheme(doc, isUiTheme(theme) ? theme : "auto");
}

/** Preferences update every open Confucius surface without rebuilding views. */
export function bindAppearance(doc: Document): void {
  if (bindings.has(doc)) return;
  const sync = () => {
    restoreDocumentTheme(doc);
    const select = doc.getElementById(
      "confucius-pref-uiTheme",
    ) as HTMLSelectElement | null;
    if (select)
      select.value =
        doc.documentElement?.getAttribute("data-confucius-theme") ?? "auto";
  };
  const observer = Zotero.Prefs.registerObserver(
    `${config.prefsPrefix}.uiTheme`,
    sync,
    true,
  );
  const cleanup = () => {
    Zotero.Prefs.unregisterObserver(observer);
    doc.defaultView?.removeEventListener("unload", cleanup);
    doc.documentElement?.removeAttribute("data-confucius-theme");
    bindings.delete(doc);
  };
  bindings.set(doc, cleanup);
  doc.defaultView?.addEventListener("unload", cleanup, { once: true });
  sync();
}

export function disposeAppearanceBindings(): void {
  for (const cleanup of [...bindings.values()]) cleanup();
}
