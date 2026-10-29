import {
  UI_COLOR_KEYS,
  parseUiThemeColors,
  type UiPalette,
  type UiThemeColors,
} from "@confucius/protocol";

export const APPEARANCE_SCOPE =
  ":where([data-confucius-window], .confucius-workspace-root, .confucius-menu-surface, .confucius-dialog, #confucius-artifact-window, #confucius-knowledge-overlay, #confucius-preferences, #confucius-sidebar, #confucius-sidebar-splitter, [data-confucius-preferences-scroll], [data-confucius-annotation])";

/** The shared stylesheet is the only source of default palette colors. */
export function paletteDefaults(
  css: string,
): Record<"light" | "dark", UiPalette> {
  const darkStart = css.indexOf("/* An explicit preference");
  const read = (source: string): UiPalette =>
    Object.fromEntries(
      UI_COLOR_KEYS.map((key) => {
        const match = source.match(
          new RegExp(`--confucius-${key}:\\s*(#[0-9a-f]{6})\\s*;`, "i"),
        );
        if (!match) throw new Error(`Shared palette is missing ${key}`);
        return [key, match[1]];
      }),
    ) as UiPalette;
  return { light: read(css), dark: read(css.slice(darkStart)) };
}

export function neutralPalette(mode: "light" | "dark"): UiPalette {
  return mode === "light"
    ? {
        paper: "#ffffff",
        canvas: "#f4f4f5",
        surface: "#eaeaed",
        ink: "#252529",
        secondary: "#606069",
        accent: "#465fb0",
      }
    : {
        paper: "#202024",
        canvas: "#18181b",
        surface: "#303036",
        ink: "#f0f0f3",
        secondary: "#bdbdc7",
        accent: "#aabaff",
      };
}

/** Recover the named preset from saved colors, without an extra preference. */
export function palettePreset(
  mode: "light" | "dark",
  colors?: Partial<UiPalette>,
): "default" | "neutral" | "custom" {
  if (!colors || !Object.keys(colors).length) return "default";
  const neutral = neutralPalette(mode);
  return UI_COLOR_KEYS.every(
    (key) => colors[key]?.toLowerCase() === neutral[key],
  )
    ? "neutral"
    : "custom";
}

export function normalizeHexColor(value: string): string | null {
  const text = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(text))
    return (
      "#" +
      [...text.slice(1)]
        .map((n) => n + n)
        .join("")
        .toLowerCase()
    );
  return null;
}

function mix(a: string, b: string, amount: number): string {
  return (
    "#" +
    [1, 3, 5]
      .map((offset) =>
        Math.round(
          parseInt(a.slice(offset, offset + 2), 16) * (1 - amount) +
            parseInt(b.slice(offset, offset + 2), 16) * amount,
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

/** Derived states continue to use the same semantic tokens as every surface. */
export function paletteDeclarations(colors: Partial<UiPalette>): string {
  const entries: Record<string, string> = { ...colors };
  if (colors.paper) {
    entries.elevated = colors.paper;
    entries["drop-surface"] = colors.paper + "ee";
  }
  if (colors.secondary) entries.muted = colors.secondary;
  if (colors.accent) {
    entries["accent-text"] = colors.accent;
    entries.focus = colors.accent;
    entries["loading-deep"] = colors.accent;
    entries["loading-bright"] = colors.accent;
    entries["loading-shine"] = colors.accent;
  }
  if (colors.ink) {
    entries.primary = colors.ink;
    entries["selection-ink"] = colors.ink;
  }
  if (colors.paper && colors.ink) {
    entries.line = mix(colors.paper, colors.ink, 0.15);
    entries["line-strong"] = mix(colors.paper, colors.ink, 0.35);
    entries["primary-ink"] = colors.paper;
    entries["primary-hover"] = mix(colors.ink, colors.paper, 0.12);
    entries.scrollbar = mix(colors.paper, colors.ink, 0.45);
    entries["scrollbar-hover"] = mix(colors.paper, colors.ink, 0.65);
  }
  if (colors.surface && colors.ink)
    entries.hover = mix(colors.surface, colors.ink, 0.08);
  if (colors.surface && colors.accent) {
    entries.selected = mix(colors.surface, colors.accent, 0.15);
    entries.selection = mix(colors.surface, colors.accent, 0.25);
  }
  return Object.entries(entries)
    .map(([key, value]) => `--confucius-${key}: ${value};`)
    .join("\n");
}

export function customPaletteCss(value: UiThemeColors): string {
  const colors = parseUiThemeColors(value);
  const light = paletteDeclarations(colors.light ?? {});
  const dark = paletteDeclarations(colors.dark ?? {});
  // System contrast always wins. No inline color overrides are installed.
  return `@media (forced-colors: none) and (prefers-contrast: no-preference) {
    :root[data-confucius-theme=light] ${APPEARANCE_SCOPE},
    :root[data-confucius-window][data-confucius-theme=light] { ${light} }
    @media (prefers-color-scheme: light) {
      :root:not([data-confucius-theme=dark]):not([data-confucius-theme=light]) ${APPEARANCE_SCOPE},
      :root[data-confucius-window]:not([data-confucius-theme=dark]):not([data-confucius-theme=light]) { ${light} }
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-confucius-theme=light]) ${APPEARANCE_SCOPE},
      :root[data-confucius-window]:not([data-confucius-theme=light]) { ${dark} }
    }
    :root[data-confucius-theme=dark] ${APPEARANCE_SCOPE},
    :root[data-confucius-window][data-confucius-theme=dark] { ${dark} }
  }`;
}
