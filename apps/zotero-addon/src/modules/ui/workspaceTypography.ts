import type { UiFont } from "@confucius/protocol";

/** Local font stacks for the three UI font presets (no web fonts, offline-safe). */
export const UI_FONT_STACKS: Record<UiFont, string> = {
  sans: '"Segoe UI", "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  mono: '"Cascadia Mono", ui-monospace, Consolas, "Courier New", monospace',
};
