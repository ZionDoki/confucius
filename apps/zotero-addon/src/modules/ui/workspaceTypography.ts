import { isUiFont, isUiFontFamily, type UiFont } from "@confucius/protocol";

/** Offline presets use installed fonts and retain CJK/system fallbacks. */
export const UI_FONT_STACKS: Record<UiFont, string> = {
  sans: '"Segoe UI", "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  modern:
    'Inter, "Aptos", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  "cjk-sans":
    '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", system-ui, sans-serif',
  "cjk-serif":
    '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", SimSun, serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  "noto-sans":
    '"Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "PingFang SC", sans-serif',
  "noto-serif":
    '"Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif',
  mono: '"Cascadia Mono", ui-monospace, Consolas, "Courier New", monospace',
  custom: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
};

export function resolveUiFont(font: unknown, family?: unknown): string {
  if (font === "custom" && isUiFontFamily(family) && family.trim()) {
    // Quote the whole family. Punctuation can never turn into additional CSS.
    const quoted = family.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${quoted}", ${UI_FONT_STACKS.custom}`;
  }
  return UI_FONT_STACKS[isUiFont(font) ? font : "sans"];
}

export function normalizeInstalledFonts(fonts: unknown): string[] {
  if (!Array.isArray(fonts)) return [];
  return [
    ...new Set(
      fonts
        .filter(
          (name): name is string =>
            isUiFontFamily(name) &&
            Boolean(name.trim()) &&
            !name.startsWith("."),
        )
        .map((name) => name.trim()),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

/** Privileged Gecko enumeration, without browser font-access permissions. */
export async function installedUiFonts(): Promise<string[]> {
  const enumerator = Cc["@mozilla.org/gfx/fontenumerator;1"].createInstance(
    Ci.nsIFontEnumerator,
  );
  const fonts: unknown =
    typeof enumerator.EnumerateAllFontsAsync === "function"
      ? await enumerator.EnumerateAllFontsAsync()
      : enumerator.EnumerateAllFonts();
  return normalizeInstalledFonts(fonts);
}
