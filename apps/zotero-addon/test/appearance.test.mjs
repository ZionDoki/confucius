import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { test } from "node:test";
import {
  paletteDefaults,
  palettePreset,
  customPaletteCss,
  neutralPalette,
  normalizeHexColor,
} from "../src/modules/ui/appearanceModel.ts";
import {
  installedUiFonts,
  normalizeInstalledFonts,
  resolveUiFont,
} from "../src/modules/ui/workspaceTypography.ts";
import { readAppearancePrefs } from "../src/utils/appearancePrefs.ts";

test("preset defaults come from the shared CSS palette; custom colors stay scoped and yield to system contrast", () => {
  const css = readFileSync(
    new URL("../addon/content/workspacePalette.css", import.meta.url),
    "utf8",
  );
  const defaults = paletteDefaults(css);
  assert.equal(defaults.light.paper, "#faf9f6");
  assert.equal(defaults.dark.paper, "#201f1c");
  const overrides = customPaletteCss({
    light: { accent: "#123456" },
    dark: { ink: "#abcdef" },
  });
  assert.match(overrides, /forced-colors: none/);
  assert.match(overrides, /prefers-contrast: no-preference/);
  assert.match(overrides, /prefers-color-scheme: light/);
  assert.match(overrides, /prefers-color-scheme: dark/);
  assert.match(overrides, /\.confucius-menu-surface/);
  assert.match(overrides, /--confucius-accent-text: #123456/);
  assert.match(overrides, /--confucius-primary: #abcdef/);
  assert.equal(
    customPaletteCss({ light: { ink: "red;}body{color:red" } }).includes(
      "color:red",
    ),
    false,
  );
  assert.notDeepEqual(neutralPalette("light"), neutralPalette("dark"));
  assert.equal(palettePreset("light", neutralPalette("light")), "neutral");
  assert.equal(palettePreset("dark", neutralPalette("dark")), "neutral");
  assert.equal(palettePreset("dark", {}), "default");
  assert.equal(palettePreset("light", { accent: "#123456" }), "custom");
  assert.equal(normalizeHexColor(" #AbC "), "#aabbcc");
  assert.equal(normalizeHexColor("transparent"), null);
});

test("local font enumeration preserves Unicode, removes duplicates, and safely quotes family names", async (t) => {
  const before = { Cc: globalThis.Cc, Ci: globalThis.Ci };
  t.after(() => Object.assign(globalThis, before));
  globalThis.Ci = { nsIFontEnumerator: {} };
  globalThis.Cc = {
    "@mozilla.org/gfx/fontenumerator;1": {
      createInstance: () => ({
        EnumerateAllFontsAsync: async () => [
          "思源宋体",
          "Inter",
          "Inter",
          ".Hidden",
          "invalid\nfont",
        ],
      }),
    },
  };
  const fonts = await installedUiFonts();
  assert.equal(fonts.length, 2);
  assert(fonts.includes("思源宋体"));
  assert.deepEqual(normalizeInstalledFonts(undefined), []);
  assert.match(
    resolveUiFont("custom", 'A "quoted" font'),
    /^"A \\"quoted\\" font",/,
  );
  assert.match(resolveUiFont("custom", "思源宋体"), /^"思源宋体",/);
  assert.equal(resolveUiFont("custom", "bad\nfont"), resolveUiFont("custom"));
  assert.equal(resolveUiFont("unknown"), resolveUiFont("sans"));
});

test("legacy preferences and decimal Gecko storage round-trip without changing defaults", (t) => {
  const before = globalThis.Zotero;
  t.after(() => {
    globalThis.Zotero = before;
  });
  const prefs = { uiFont: "sans", uiFontSize: 14, uiLineHeight: "relaxed" };
  globalThis.Zotero = { Prefs: { get: (key) => prefs[key.split(".").at(-1)] } };
  assert.equal(readAppearancePrefs().uiFontSize, 14);
  assert.equal(readAppearancePrefs().uiLineHeight, 1.75);
  Object.assign(prefs, {
    uiFontSizeExact: "14.5",
    uiLineHeight: "1.95",
    uiFont: "custom",
    uiFontFamily: "思源宋体",
    uiThemeColors: '{"dark":{"paper":"#202024"}}',
  });
  const next = readAppearancePrefs();
  assert.equal(next.uiFontSize, 14.5);
  assert.equal(next.uiLineHeight, 1.95);
  assert.equal(next.uiFontFamily, "思源宋体");
  assert.deepEqual(next.uiThemeColors, { dark: { paper: "#202024" } });
  prefs.uiThemeColors = "corrupt";
  assert.deepEqual(readAppearancePrefs().uiThemeColors, {});
});
