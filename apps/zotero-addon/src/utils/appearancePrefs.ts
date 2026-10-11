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
  return {
    uiFont: isUiFont(font) ? font : DEFAULT_UI_FONT,
    uiFontFamily: isUiFontFamily(family) ? family.trim() : "",
    uiFontSize: clampUiFontSize(
      getPref("uiFontSizeExact") || getPref("uiFontSize"),
    ),
    uiLineHeight: clampUiLineHeight(getPref("uiLineHeight")),
    uiTheme: isUiTheme(theme) ? theme : ("auto" as const),
    uiThemeColors: parseUiThemeColors(getPref("uiThemeColors")),
  };
}
