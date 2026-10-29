import {
  clampUiFontSize,
  clampUiLineHeight,
  DEFAULT_UI_FONT_SIZE,
  UI_FONTS,
  UI_COLOR_KEYS,
  MIN_UI_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  UI_FONT_SIZE_STEP,
  MIN_UI_LINE_HEIGHT,
  MAX_UI_LINE_HEIGHT,
  UI_LINE_HEIGHT_STEP,
  isUiFont,
  isUiFontFamily,
  isUiLanguage,
  isUiTheme,
  parseUiThemeColors,
  validateConfigPatch,
  type ConfigSetParams,
  type UiFont,
  type UiLanguage,
  type UiTheme,
  type UiThemeColors,
  type UiPalette,
} from "@confucius/protocol";
import paletteSource from "../../../addon/content/workspacePalette.css";
import { getString } from "../../utils/locale";
import { createWorkspaceButton, bindTabNavigation } from "./workspaceControls";
import { installedUiFonts } from "./workspaceTypography";
import {
  neutralPalette,
  normalizeHexColor,
  paletteDefaults,
  palettePreset,
} from "./appearanceModel";

const NS = "http://www.w3.org/1999/xhtml";
const defaults = paletteDefaults(paletteSource);

/** This editor only owns a draft. The caller persists getPatch() on Save. */
export function createAppearanceSettings(
  doc: Document,
  initial: ConfigSetParams,
) {
  const node = (tag: string, className = "", text?: string) => {
    const item = doc.createElementNS(NS, tag) as HTMLElement;
    item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  const root = node("section", "confucius-appearance-settings");
  root.append(
    node(
      "p",
      "confucius-settings-help",
      getString("workspace-appearance-save-help"),
    ),
  );
  const grid = node("div", "confucius-appearance-grid");
  const typography = node("section", "confucius-settings-section");
  const themeSection = node("section", "confucius-settings-section");
  typography.append(
    node("h3", "", getString("workspace-appearance-typography")),
  );
  themeSection.append(node("h3", "", getString("workspace-appearance-colors")));
  grid.append(typography, themeSection);
  root.append(grid);
  let font: UiFont = isUiFont(initial.uiFont) ? initial.uiFont : "sans";
  let family = isUiFontFamily(initial.uiFontFamily)
    ? initial.uiFontFamily.trim()
    : "";
  let theme: UiTheme = isUiTheme(initial.uiTheme) ? initial.uiTheme : "auto";
  let language: UiLanguage = isUiLanguage(initial.uiLanguage)
    ? initial.uiLanguage
    : "en-US";
  let colors: UiThemeColors = JSON.parse(
    JSON.stringify(parseUiThemeColors(initial.uiThemeColors)),
  );

  const field = (parent: HTMLElement, label: string, id: string) => {
    const wrap = node("div", "confucius-settings-field");
    const caption = node("label", "", label) as HTMLLabelElement;
    caption.htmlFor = id;
    wrap.append(caption);
    parent.append(wrap);
    return wrap;
  };
  const radioGroup = <T extends string>(
    parent: HTMLElement,
    id: string,
    label: string,
    choices: readonly T[],
    title: (value: T) => string,
    current: T,
    choose: (value: T) => void,
  ) => {
    const row = node("div", "confucius-settings-options");
    row.id = id;
    row.setAttribute("role", "radiogroup");
    row.setAttribute("aria-label", label);
    const buttons = new Map<T, HTMLButtonElement>();
    const paint = (value: T) => {
      for (const [key, button] of buttons) {
        button.setAttribute("aria-checked", String(key === value));
        button.tabIndex = key === value ? 0 : -1;
      }
    };
    for (const value of choices) {
      const button = createWorkspaceButton(doc, "", title(value));
      button.setAttribute("role", "radio");
      button.dataset.value = value;
      button.addEventListener("click", () => {
        choose(value);
        paint(value);
      });
      buttons.set(value, button);
      row.append(button);
    }
    row.addEventListener("keydown", (event) => {
      const key = event as KeyboardEvent;
      if (
        key.isComposing ||
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(key.key)
      )
        return;
      const items = [...buttons.values()];
      const index = items.indexOf(doc.activeElement as HTMLButtonElement);
      const next =
        key.key === "Home"
          ? 0
          : key.key === "End"
            ? items.length - 1
            : (index +
                (["ArrowLeft", "ArrowUp"].includes(key.key) ? -1 : 1) +
                items.length) %
              items.length;
      event.preventDefault();
      items[next].click();
      items[next].focus();
    });
    parent.append(row);
    paint(current);
    return paint;
  };

  const fontWrap = field(
    typography,
    getString("workspace-font-family"),
    "confucius-cfg-font",
  );
  const picker = node("details", "confucius-font-picker") as HTMLDetailsElement;
  const fontSummary = node("summary", "confucius-button");
  fontSummary.id = "confucius-cfg-font";
  picker.append(fontSummary);
  const pickerBody = node("div", "confucius-font-picker-body");
  picker.append(pickerBody);
  fontWrap.append(picker);
  let source: "preset" | "local" = font === "custom" ? "local" : "preset";
  let fonts: string[] | undefined;
  let loading = false;
  let fontError = "";
  let composing = false;
  let activeFont = -1;
  const search = node("input") as HTMLInputElement;
  search.type = "search";
  search.id = "confucius-cfg-font-query";
  search.setAttribute("aria-label", getString("workspace-font-search"));
  search.placeholder = getString("workspace-font-search");
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-autocomplete", "list");
  search.setAttribute("aria-controls", "confucius-cfg-font-results");
  search.setAttribute("aria-expanded", "true");
  const results = node("div", "confucius-font-results");
  results.id = "confucius-cfg-font-results";
  results.setAttribute("role", "listbox");
  results.setAttribute("aria-label", getString("workspace-font-family"));
  const fontStatus = node("p", "confucius-settings-help");
  fontStatus.setAttribute("role", "status");
  const retry = createWorkspaceButton(
    doc,
    "confucius-cfg-font-retry",
    getString("workspace-font-retry"),
  );
  retry.hidden = true;
  const fontName = (value: UiFont) => getString(`workspace-font-${value}`);
  const updateFontSummary = () => {
    fontSummary.textContent =
      font === "custom"
        ? family || getString("workspace-font-local")
        : fontName(font);
  };
  const selectFont = (value: string) => {
    if (source === "preset") font = value as UiFont;
    else {
      font = "custom";
      family = value;
    }
    updateFontSummary();
    picker.open = false;
    fontSummary.focus({ preventScroll: true });
  };
  const renderFonts = () => {
    results.replaceChildren();
    activeFont = -1;
    search.removeAttribute("aria-activedescendant");
    const query = search.value.trim().toLocaleLowerCase();
    const items =
      source === "preset"
        ? UI_FONTS.filter((value) => value !== "custom").map((value) => ({
            value,
            label: fontName(value),
          }))
        : (fonts ?? []).map((value) => ({ value, label: value }));
    const matches = items.filter((item) =>
      `${item.label} ${item.value}`.toLocaleLowerCase().includes(query),
    );
    for (const item of matches.slice(0, 200)) {
      const row = createWorkspaceButton(doc, "", item.label);
      row.id = `confucius-font-option-${results.childElementCount}`;
      row.className += " confucius-font-option";
      row.setAttribute("role", "option");
      row.setAttribute(
        "aria-selected",
        String(
          source === "preset"
            ? font === item.value
            : font === "custom" && family === item.value,
        ),
      );
      row.tabIndex = -1;
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("click", () => selectFont(item.value));
      results.append(row);
    }
    const missing =
      source === "local" &&
      fonts &&
      font === "custom" &&
      !fonts.includes(family);
    fontStatus.textContent =
      source === "preset"
        ? getString("workspace-font-preset-help")
        : loading
          ? getString("workspace-font-loading")
          : fontError ||
            (missing
              ? getString("workspace-font-missing")
              : matches.length
                ? `${matches.length} ${getString("workspace-font-local-count")}`
                : getString("workspace-font-no-results"));
    retry.hidden = source !== "local" || !fontError;
    search.setAttribute("aria-busy", String(source === "local" && loading));
  };
  const loadFonts = async () => {
    if (loading) return;
    loading = true;
    fontError = "";
    renderFonts();
    try {
      fonts = await installedUiFonts();
      if (!fonts.length) fontError = getString("workspace-font-unavailable");
    } catch {
      fontError = getString("workspace-font-unavailable");
    } finally {
      loading = false;
      renderFonts();
    }
  };
  const paintSource = radioGroup(
    pickerBody,
    "confucius-cfg-font-source",
    getString("workspace-font-family"),
    ["preset", "local"] as const,
    (value) => getString(`workspace-font-${value}`),
    source,
    (value) => {
      source = value;
      search.value = "";
      renderFonts();
      if (value === "local" && !fonts) void loadFonts();
    },
  );
  pickerBody.append(search, results, fontStatus, retry);
  retry.addEventListener("click", () => void loadFonts());
  picker.addEventListener("toggle", () => {
    if (picker.open && source === "local" && !fonts) void loadFonts();
  });
  search.addEventListener("compositionstart", () => {
    composing = true;
  });
  search.addEventListener("compositionend", () => {
    composing = false;
    renderFonts();
  });
  search.addEventListener("input", () => {
    if (!composing) renderFonts();
  });
  picker.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (key.isComposing || composing) return;
    if (key.key === "Escape" && picker.open) {
      event.preventDefault();
      event.stopPropagation();
      picker.open = false;
      fontSummary.focus();
    } else if (
      event.target === search &&
      ["ArrowDown", "ArrowUp", "Enter"].includes(key.key)
    ) {
      const rows = [...results.children] as HTMLElement[];
      if (key.key === "Enter") {
        if (activeFont >= 0) {
          event.preventDefault();
          rows[activeFont]?.click();
        }
        return;
      }
      event.preventDefault();
      if (!rows.length) return;
      activeFont =
        activeFont < 0
          ? key.key === "ArrowDown"
            ? 0
            : rows.length - 1
          : (activeFont + (key.key === "ArrowDown" ? 1 : -1) + rows.length) %
            rows.length;
      for (const [index, row] of rows.entries())
        row.dataset.active = String(index === activeFont);
      search.setAttribute("aria-activedescendant", rows[activeFont].id);
      rows[activeFont].scrollIntoView({ block: "nearest" });
    }
  });
  updateFontSummary();
  renderFonts();

  const numericField = (
    label: string,
    id: string,
    value: number,
    min: number,
    max: number,
    step: number,
    unit: string,
    parent = typography,
  ) => {
    const wrap = field(parent, label, id);
    const controls = node("div", "confucius-range-controls");
    const range = node("input") as HTMLInputElement;
    range.type = "range";
    range.id = `${id}-range`;
    const number = node("input") as HTMLInputElement;
    number.type = "number";
    number.id = id;
    for (const input of [range, number]) {
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.setAttribute("aria-label", label);
    }
    range.addEventListener("input", () => {
      number.value = range.value;
    });
    number.addEventListener("input", () => {
      if (number.validity.valid && number.value) range.value = number.value;
    });
    controls.append(
      range,
      number,
      node("span", "confucius-settings-unit", unit),
    );
    wrap.append(
      controls,
      node(
        "p",
        "confucius-settings-help",
        `${min}–${max}${unit ? ` ${unit}` : ""}`,
      ),
    );
    return {
      number,
      set: (next: number) => {
        range.value = number.value = String(next);
      },
    };
  };
  const size = numericField(
    getString("workspace-font-size"),
    "confucius-cfg-font-size",
    clampUiFontSize(initial.uiFontSize),
    MIN_UI_FONT_SIZE,
    MAX_UI_FONT_SIZE,
    UI_FONT_SIZE_STEP,
    "px",
  );
  const line = numericField(
    getString("workspace-line-height"),
    "confucius-cfg-line-height",
    clampUiLineHeight(initial.uiLineHeight),
    MIN_UI_LINE_HEIGHT,
    MAX_UI_LINE_HEIGHT,
    UI_LINE_HEIGHT_STEP,
    "",
  );
  const languageWrap = field(
    typography,
    getString("workspace-ui-language"),
    "confucius-cfg-language",
  );
  radioGroup(
    languageWrap,
    "confucius-cfg-language",
    getString("workspace-ui-language"),
    ["zh-CN", "en-US"] as const,
    (value) =>
      getString(
        value === "zh-CN"
          ? "workspace-ui-language-zh"
          : "workspace-ui-language-en",
      ),
    language,
    (value) => {
      language = value;
    },
  );

  typography.append(
    node("h3", "", getString("workspace-appearance-annotations")),
  );
  typography.append(
    node(
      "p",
      "confucius-settings-help",
      getString("workspace-annotation-typography-help"),
    ),
  );
  let annotationMode =
    initial.annotationFontSize != null ||
    initial.annotationLineHeight != null ||
    initial.annotationParagraphSpacing != null
      ? "custom"
      : "global";
  let annotationDraftInitialized = annotationMode === "custom";
  const annotationControls = node("div");
  const paintAnnotationMode = radioGroup(
    typography,
    "confucius-cfg-annotation-mode",
    getString("workspace-appearance-annotations"),
    ["global", "custom"] as const,
    (value) => getString(`workspace-annotation-typography-${value}`),
    annotationMode as "global" | "custom",
    (value) => {
      annotationMode = value;
      annotationControls.hidden = value === "global";
      if (value === "custom" && !annotationDraftInitialized) {
        annotationSize.set(clampUiFontSize(size.number.value));
        annotationLine.set(clampUiLineHeight(line.number.value));
        annotationDraftInitialized = true;
      }
    },
  );
  annotationControls.hidden = annotationMode === "global";
  typography.append(annotationControls);
  const annotationSize = numericField(
    getString("workspace-annotation-font-size"),
    "confucius-cfg-annotation-font-size",
    clampUiFontSize(initial.annotationFontSize ?? initial.uiFontSize),
    MIN_UI_FONT_SIZE,
    MAX_UI_FONT_SIZE,
    UI_FONT_SIZE_STEP,
    "px",
    annotationControls,
  );
  const annotationLine = numericField(
    getString("workspace-annotation-line-height"),
    "confucius-cfg-annotation-line-height",
    clampUiLineHeight(initial.annotationLineHeight ?? initial.uiLineHeight),
    MIN_UI_LINE_HEIGHT,
    MAX_UI_LINE_HEIGHT,
    UI_LINE_HEIGHT_STEP,
    "",
    annotationControls,
  );
  const annotationParagraph = numericField(
    getString("workspace-annotation-paragraph-spacing"),
    "confucius-cfg-annotation-paragraph-spacing",
    initial.annotationParagraphSpacing ?? 12,
    0,
    32,
    1,
    "px",
    annotationControls,
  );

  const modeWrap = field(
    themeSection,
    getString("workspace-ui-theme"),
    "confucius-cfg-theme",
  );
  const paintTheme = radioGroup(
    modeWrap,
    "confucius-cfg-theme",
    getString("workspace-ui-theme"),
    ["auto", "light", "dark"] as const,
    (value) => getString(`workspace-ui-theme-${value}`),
    theme,
    (value) => {
      theme = value;
    },
  );
  let editingMode: "light" | "dark" = "light";
  const colorTabs = node(
    "div",
    "confucius-settings-options confucius-color-tabs",
  );
  colorTabs.setAttribute("role", "tablist");
  colorTabs.setAttribute(
    "aria-label",
    getString("workspace-appearance-colors"),
  );
  bindTabNavigation(colorTabs);
  const colorPanel = node("div", "confucius-color-panel");
  colorPanel.id = "confucius-cfg-color-panel";
  colorPanel.setAttribute("role", "tabpanel");
  const tabs = new Map<"light" | "dark", HTMLButtonElement>();
  const rawColors = {
    light: { ...defaults.light, ...colors.light },
    dark: { ...defaults.dark, ...colors.dark },
  };
  const presets = {
    light: palettePreset("light", colors.light),
    dark: palettePreset("dark", colors.dark),
  } as Record<"light" | "dark", "default" | "neutral" | "custom">;
  const colorInputs = new Map<
    (typeof UI_COLOR_KEYS)[number],
    { text: HTMLInputElement; swatch: HTMLInputElement }
  >();
  const paintColors = () => {
    for (const [mode, button] of tabs) {
      button.setAttribute("aria-selected", String(mode === editingMode));
      button.tabIndex = mode === editingMode ? 0 : -1;
    }
    colorPanel.setAttribute("aria-labelledby", tabs.get(editingMode)!.id);
    paintPreset(presets[editingMode]);
    for (const [key, input] of colorInputs) {
      input.text.value = rawColors[editingMode][key];
      input.text.setAttribute(
        "aria-invalid",
        String(!normalizeHexColor(input.text.value)),
      );
      input.swatch.value =
        normalizeHexColor(input.text.value) ?? defaults[editingMode][key];
    }
  };
  for (const mode of ["light", "dark"] as const) {
    const tab = createWorkspaceButton(
      doc,
      `confucius-cfg-colors-${mode}`,
      getString(`workspace-ui-theme-${mode}`),
    );
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", colorPanel.id);
    tab.addEventListener("click", () => {
      editingMode = mode;
      paintColors();
    });
    tabs.set(mode, tab);
    colorTabs.append(tab);
  }
  themeSection.append(colorTabs, colorPanel);
  const paintPreset = radioGroup(
    colorPanel,
    "confucius-cfg-color-preset",
    getString("workspace-color-preset"),
    ["default", "neutral", "custom"] as const,
    (value) => getString(`workspace-color-preset-${value}`),
    presets.light,
    (value) => {
      presets[editingMode] = value;
      if (value === "default") {
        delete colors[editingMode];
        rawColors[editingMode] = { ...defaults[editingMode] };
      } else if (value === "neutral") {
        colors[editingMode] = neutralPalette(editingMode);
        rawColors[editingMode] = { ...colors[editingMode] } as UiPalette;
      } else colors[editingMode] = { ...rawColors[editingMode] };
      paintColors();
    },
  );
  const colorGrid = node("div", "confucius-color-fields");
  for (const key of UI_COLOR_KEYS) {
    const row = node("div", "confucius-color-field");
    const label = node(
      "label",
      "",
      getString(`workspace-color-${key}`),
    ) as HTMLLabelElement;
    const text = node("input") as HTMLInputElement;
    text.id = `confucius-cfg-color-${key}`;
    text.type = "text";
    text.maxLength = 7;
    text.spellcheck = false;
    text.setAttribute("aria-label", label.textContent ?? key);
    label.htmlFor = text.id;
    const swatch = node("input") as HTMLInputElement;
    swatch.type = "color";
    swatch.setAttribute("aria-label", label.textContent ?? key);
    const edit = (value: string) => {
      const normalized = normalizeHexColor(value);
      rawColors[editingMode][key] = normalized ?? value;
      presets[editingMode] = "custom";
      colors[editingMode] = { ...rawColors[editingMode] };
      paintPreset("custom");
      text.setAttribute("aria-invalid", String(!normalized));
      if (normalized) swatch.value = normalized;
    };
    text.addEventListener("input", () => edit(text.value));
    text.addEventListener("blur", () => {
      const normalized = normalizeHexColor(text.value);
      if (normalized) text.value = normalized;
    });
    swatch.addEventListener("input", () => {
      text.value = swatch.value;
      edit(swatch.value);
    });
    row.append(label, swatch, text);
    colorInputs.set(key, { text, swatch });
    colorGrid.append(row);
  }
  colorPanel.append(colorGrid);
  paintColors();
  const reset = createWorkspaceButton(
    doc,
    "confucius-cfg-appearance-reset",
    getString("workspace-appearance-reset"),
  );
  reset.addEventListener("click", () => {
    font = "sans";
    family = "";
    theme = "auto";
    colors = {};
    rawColors.light = { ...defaults.light };
    rawColors.dark = { ...defaults.dark };
    presets.light = presets.dark = "default";
    size.set(DEFAULT_UI_FONT_SIZE);
    line.set(clampUiLineHeight("standard"));
    annotationMode = "global";
    annotationDraftInitialized = false;
    paintAnnotationMode("global");
    annotationControls.hidden = true;
    annotationSize.set(DEFAULT_UI_FONT_SIZE);
    annotationLine.set(clampUiLineHeight("standard"));
    annotationParagraph.set(12);
    source = "preset";
    search.value = "";
    paintSource(source);
    updateFontSummary();
    renderFonts();
    paintTheme(theme);
    paintColors();
  });
  root.append(reset);
  return {
    element: root,
    getPatch(): ConfigSetParams {
      for (const input of [
        size.number,
        line.number,
        ...(annotationMode === "custom"
          ? [
              annotationSize.number,
              annotationLine.number,
              annotationParagraph.number,
            ]
          : []),
      ]) {
        if (!input.value || !input.reportValidity()) {
          input.focus();
          throw new Error(getString("workspace-appearance-invalid-number"));
        }
      }
      for (const mode of ["light", "dark"] as const) {
        if (colors[mode])
          for (const key of UI_COLOR_KEYS) {
            if (!normalizeHexColor(rawColors[mode][key])) {
              editingMode = mode;
              paintColors();
              colorInputs.get(key)!.text.focus();
              throw new Error(getString("workspace-appearance-invalid-color"));
            }
          }
      }
      if (font === "custom" && !family.trim())
        throw new Error(getString("workspace-font-unavailable"));
      const patch: ConfigSetParams = {
        uiFont: font,
        uiFontFamily: family,
        uiFontSize: Number(size.number.value),
        uiLineHeight: Number(line.number.value),
        annotationFontSize:
          annotationMode === "custom"
            ? Number(annotationSize.number.value)
            : null,
        annotationLineHeight:
          annotationMode === "custom"
            ? Number(annotationLine.number.value)
            : null,
        annotationParagraphSpacing:
          annotationMode === "custom"
            ? Number(annotationParagraph.number.value)
            : null,
        uiLanguage: language,
        uiTheme: theme,
        uiThemeColors: JSON.parse(JSON.stringify(colors)),
      };
      const validated = validateConfigPatch(patch as Record<string, unknown>);
      if (!validated.ok) throw new Error(validated.errors.join("; "));
      return patch;
    },
  };
}
