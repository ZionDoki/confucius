import { isUiTheme, type UiTheme } from "@confucius/protocol";
import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import { readAppearancePrefs } from "../../utils/appearancePrefs";
import { resolveUiFont } from "./workspaceTypography";
import { APPEARANCE_SCOPE, customPaletteCss } from "./appearanceModel";

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
    const appearance = readAppearancePrefs();
    let style = doc.getElementById("confucius-appearance-css");
    if (!style) {
      style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
      style.id = "confucius-appearance-css";
      (doc.head ?? doc.documentElement)?.appendChild(style);
    }
    style.textContent = `${APPEARANCE_SCOPE} {
      --confucius-font-family: ${resolveUiFont(appearance.uiFont, appearance.uiFontFamily)};
      --confucius-font-size: ${appearance.uiFontSize}px;
      --confucius-markdown-font-size: ${appearance.uiFontSize}px;
      --confucius-reading-line-height: ${appearance.uiLineHeight};
    }
    [data-confucius-annotation] {
      --confucius-font-size: ${appearance.annotationFontSize ?? appearance.uiFontSize}px;
      --confucius-markdown-font-size: ${appearance.annotationFontSize ?? appearance.uiFontSize}px;
      --confucius-reading-line-height: ${appearance.annotationLineHeight ?? appearance.uiLineHeight};
      --confucius-annotation-paragraph-spacing: ${appearance.annotationParagraphSpacing ?? 12}px;
    }\n${customPaletteCss(appearance.uiThemeColors)}`;
  };
  let pending: number | undefined;
  const observers = [
    "uiTheme",
    "uiThemeColors",
    "uiFont",
    "uiFontFamily",
    "uiFontSize",
    "uiFontSizeExact",
    "uiLineHeight",
    "annotationFontSize",
    "annotationLineHeight",
    "annotationParagraphSpacing",
  ].map((key) =>
    Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.${key}`,
      () => {
        doc.defaultView?.clearTimeout(pending);
        pending = doc.defaultView?.setTimeout(sync, 0);
      },
      true,
    ),
  );
  const cleanup = () => {
    for (const observer of observers) Zotero.Prefs.unregisterObserver(observer);
    doc.defaultView?.clearTimeout(pending);
    doc.getElementById("confucius-appearance-css")?.remove();
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
