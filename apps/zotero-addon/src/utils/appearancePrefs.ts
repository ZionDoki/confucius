import {
  clampUiFontSize,
  clampUiLineHeight,
  DEFAULT_UI_FONT,
  isUiFont,
  isUiFontFamily,
  isUiTheme,
  parseUiThemeColors,
} from "@confucius/protocol";
import { getPref } from "./prefs";

/** Decimal values are strings in Gecko prefs; RPC and UI always receive numbers. */
export function readAppearancePrefs() {
  const font = getPref("uiFont");
  const family = getPref("uiFontFamily");
  const theme = getPref("uiTheme");
  const optionalNumber = (
    value: unknown,
    normalize: (value: number) => number,
  ) =>
    value === undefined ||
    value === null ||
    value === "" ||
    !Number.isFinite(Number(value))
      ? null
      : normalize(Number(value));
  return {
    uiFont: isUiFont(font) ? font : DEFAULT_UI_FONT,
    uiFontFamily: isUiFontFamily(family) ? family.trim() : "",
    uiFontSize: clampUiFontSize(
      getPref("uiFontSizeExact") || getPref("uiFontSize"),
    ),
    uiLineHeight: clampUiLineHeight(getPref("uiLineHeight")),
    annotationFontSize: optionalNumber(
      getPref("annotationFontSize"),
      clampUiFontSize,
    ),
    annotationLineHeight: optionalNumber(
      getPref("annotationLineHeight"),
      clampUiLineHeight,
    ),
    annotationParagraphSpacing: optionalNumber(
      getPref("annotationParagraphSpacing"),
      (value) => Math.max(0, Math.min(32, Math.round(value))),
    ),
    uiTheme: isUiTheme(theme) ? theme : ("auto" as const),
    uiThemeColors: parseUiThemeColors(getPref("uiThemeColors")),
  };
}
