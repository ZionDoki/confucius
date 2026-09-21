import {
  isModelReasoningOverride,
  modelReasoning,
  type ModelReasoningOverride,
  type ModelCatalogEntry,
  type ModelCatalogResult,
} from "@confucius/protocol";
import { getString } from "../../utils/locale";
import { createWorkspaceButton } from "./workspaceControls";
import { markScrollContainer } from "./workspaceScrollbars";

const text = (key: string) => getString(`workspace-model-settings-${key}`);
function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  label?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElementTagNameMap[K];
  if (label) element.textContent = label;
  return element;
}
function field(doc: Document, label: string, input: HTMLElement) {
  const row = node(doc, "div");
  row.className = "confucius-settings-field";
  const name = node(doc, "label", label);
  name.htmlFor = input.id;
  input.style.width = "100%";
  row.append(name, input);
  return row;
}
function hint(doc: Document, label: string) {
  const p = node(doc, "p", label);
  p.style.color = "var(--confucius-muted)";
  p.style.overflowWrap = "anywhere";
  return p;
}

export function createReasoningSettings(
  doc: Document,
  changed: (override?: ModelReasoningOverride) => void,
) {
  const section = node(doc, "div");
  const label = node(doc, "label");
  const enabled = node(doc, "input");
  enabled.id = "confucius-cfg-custom-reasoning";
  enabled.type = "checkbox";
  label.append(enabled, doc.createTextNode(` ${text("custom")}`));
  const controls = node(doc, "div");
  controls.hidden = true;
  controls.style.marginTop = "12px";
  const transport = node(doc, "div");
  transport.id = "confucius-cfg-reasoning-transport";
  transport.className = "confucius-reasoning-transports";
  transport.setAttribute("role", "radiogroup");
  transport.setAttribute("aria-label", text("transport"));
  let transportValue = "openai";
  const transportButtons: HTMLButtonElement[] = [];
  const paintTransport = () => {
    for (const button of transportButtons) {
      const selected = button.dataset.transport === transportValue;
      button.setAttribute("aria-checked", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
  };
  for (const [value, label] of [
    ["openai", "reasoning_effort"],
    ["thinking", "thinking + reasoning_effort"],
    ["ollama", "Ollama think"],
  ]) {
    const button = createWorkspaceButton(doc, "", label);
    button.setAttribute("role", "radio");
    button.dataset.transport = value;
    button.addEventListener("click", () => {
      transportValue = value;
      paintTransport();
      update();
    });
    button.addEventListener("keydown", (raw) => {
      const event = raw as KeyboardEvent;
      if (event.isComposing || event.keyCode === 229) return;
      if (
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(event.key)
      )
        return;
      event.preventDefault();
      const index = transportButtons.indexOf(button);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? transportButtons.length - 1
            : (index +
                (["ArrowRight", "ArrowDown"].includes(event.key)
                  ? 1
                  : transportButtons.length - 1)) %
              transportButtons.length;
      transportButtons[next].click();
      transportButtons[next].focus();
    });
    transportButtons.push(button);
    transport.append(button);
  }
  paintTransport();
  const efforts = node(doc, "input");
  efforts.id = "confucius-cfg-reasoning-options";
  efforts.placeholder = "low, medium, high, ultra";
  const error = hint(doc, "");
  error.setAttribute("role", "status");
  error.style.color = "var(--confucius-danger)";
  controls.append(
    field(doc, text("transport"), transport),
    field(doc, text("options"), efforts),
    hint(doc, text("custom-help")),
    error,
  );
  section.append(label, controls);
  let thinkingKeep: "all" | undefined;
  const getOverride = (): ModelReasoningOverride | undefined => {
    if (!enabled.checked) return undefined;
    const value = {
      transport: transportValue,
      efforts: [...new Set(efforts.value.split(/[,，\s]+/).filter(Boolean))],
      ...(thinkingKeep && transportValue === "thinking"
        ? { thinkingKeep }
        : {}),
    };
    if (!isModelReasoningOverride(value))
      throw new Error(text("invalid-options"));
    return value;
  };
  const update = () => {
    controls.hidden = !enabled.checked;
    enabled.setAttribute("aria-expanded", String(enabled.checked));
    try {
      const value = getOverride();
      error.textContent = "";
      efforts.setCustomValidity("");
      changed(value);
    } catch (cause) {
      error.textContent = (cause as Error).message;
      efforts.setCustomValidity(error.textContent);
    }
  };
  enabled.addEventListener("change", update);
  efforts.addEventListener("input", update);
  const fill = (
    model: string,
    baseUrl: string,
    override?: ModelReasoningOverride,
  ) => {
    const capability = modelReasoning(model, baseUrl, override);
    enabled.checked = Boolean(override);
    transportValue =
      capability.transport === "none"
        ? /\/api\/chat\/?$/.test(baseUrl.trim())
          ? "ollama"
          : "openai"
        : capability.transport;
    paintTransport();
    thinkingKeep = capability.thinkingKeep;
    efforts.value = capability.efforts
      .filter((value) => value !== "auto")
      .join(", ");
    update();
  };
  return {
    node: section,
    getOverride,
    setModel: fill,
    applyCatalog: (entry: ModelCatalogEntry, baseUrl: string) => {
      if (!entry.reasoningEfforts) return;
      // The catalog describes controls, not the gateway's request format.
      // Keep an explicitly selected format; otherwise expose the suggested one.
      if (!enabled.checked) fill(entry.id, baseUrl);
      efforts.value = entry.reasoningEfforts.join(", ");
      enabled.checked = true;
      update();
    },
  };
}

export function createModelCatalogLookup(
  doc: Document,
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  apply: (entry: ModelCatalogEntry) => void,
) {
  const win = doc.defaultView!;
  const section = node(doc, "details");
  section.className = "confucius-settings-advanced confucius-model-catalog";
  section.append(
    node(doc, "summary", text("catalog")),
    hint(doc, text("catalog-help")),
  );
  const query = node(doc, "input");
  query.id = "confucius-cfg-catalog-query";
  query.type = "search";
  query.maxLength = 256;
  query.placeholder = text("filter-placeholder");
  query.autocomplete = "off";
  query.setAttribute("role", "combobox");
  query.setAttribute("aria-autocomplete", "list");
  query.setAttribute("aria-expanded", "false");
  query.setAttribute("aria-controls", "confucius-cfg-catalog-result");
  section.append(field(doc, text("query"), query));
  const result = node(doc, "div");
  result.id = "confucius-cfg-catalog-result";
  result.className = "confucius-catalog-results";
  result.setAttribute("role", "listbox");
  result.setAttribute("aria-label", text("result"));
  result.hidden = true;
  markScrollContainer(result);
  const status = hint(doc, "");
  status.id = "confucius-cfg-catalog-status";
  status.setAttribute("role", "status");
  query.setAttribute("aria-describedby", status.id);
  const detail = hint(doc, "");
  detail.className = "confucius-catalog-preview";
  detail.hidden = true;
  const actions = node(doc, "div");
  actions.className = "confucius-catalog-actions";
  const retry = createWorkspaceButton(
    doc,
    "confucius-cfg-catalog-retry",
    text("retry"),
  );
  retry.hidden = true;
  const use = createWorkspaceButton(
    doc,
    "confucius-cfg-catalog-apply",
    text("apply"),
  );
  use.disabled = true;
  use.title = text("select-first");
  actions.append(retry, use);
  section.append(status, result, detail, actions);

  let models: ModelCatalogEntry[] = [];
  let selected: ModelCatalogEntry | undefined;
  let activeIndex = -1;
  let expanded = false;
  let generation = 0;
  let timer: number | undefined;
  let inFlight: Promise<unknown> | undefined;
  let resolvedQuery: string | undefined;
  let composing = false;
  const current = (version: number) =>
    version === generation && section.open && section.isConnected;
  const invalidate = () => {
    generation++;
    win.clearTimeout(timer);
    timer = undefined;
  };
  const describe = () => {
    use.disabled = !selected;
    use.title = selected ? "" : text("select-first");
    detail.hidden = !selected;
    detail.textContent = selected
      ? [
          `${selected.providerName} · ${selected.id}`,
          selected.contextWindowTokens
            ? `${text("context")}: ${selected.contextWindowTokens.toLocaleString()}`
            : "",
          selected.maxOutputTokens
            ? `${text("output")}: ${selected.maxOutputTokens.toLocaleString()}`
            : "",
          selected.reasoningEfforts
            ? `${text("options")}: ${selected.reasoningEfforts.join(", ") || "—"}`
            : "",
          selected.reasoningBudget ? text("budget-unsupported") : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  };
  const paintActive = (scroll = false) => {
    const rows = Array.from(result.children) as HTMLElement[];
    for (const [index, row] of rows.entries()) {
      row.dataset.active = String(index === activeIndex);
      row.dataset.selected = String(models[index] === selected);
      row.setAttribute("aria-selected", String(models[index] === selected));
      row.lastElementChild!.textContent = models[index] === selected ? "✓" : "";
    }
    const active = rows[activeIndex];
    if (expanded && active) {
      query.setAttribute("aria-activedescendant", active.id);
      if (scroll) {
        const box = active.getBoundingClientRect();
        const viewport = result.getBoundingClientRect();
        if (box.top < viewport.top) result.scrollTop += box.top - viewport.top;
        else if (box.bottom > viewport.bottom)
          result.scrollTop += box.bottom - viewport.bottom;
      }
    } else query.removeAttribute("aria-activedescendant");
  };
  const showResults = (open: boolean) => {
    expanded = open;
    result.hidden = !open || models.length === 0;
    query.setAttribute("aria-expanded", String(!result.hidden));
    paintActive();
  };
  const select = (index: number) => {
    const entry = models[index];
    if (!entry) return;
    selected = entry;
    activeIndex = index;
    describe();
    showResults(false);
  };
  const paintResults = () => {
    result.replaceChildren();
    models.forEach((entry, index) => {
      const row = node(doc, "button");
      row.id = `confucius-catalog-option-${index}`;
      row.type = "button";
      row.tabIndex = -1;
      row.className = "confucius-settings-choice confucius-catalog-option";
      row.setAttribute("role", "option");
      row.dataset.provider = entry.providerId;
      row.dataset.model = entry.id;
      row.title = `${entry.providerName} · ${entry.id} · ${entry.name}`;
      const copy = node(doc, "span");
      copy.className = "confucius-catalog-option-copy";
      const name = node(doc, "span", entry.name);
      name.className = "confucius-catalog-option-name";
      const meta = node(doc, "span", `${entry.providerName} · ${entry.id}`);
      meta.className = "confucius-catalog-option-meta";
      const mark = node(doc, "span");
      mark.className = "confucius-settings-choice-check";
      mark.setAttribute("aria-hidden", "true");
      copy.append(name, meta);
      row.append(copy, mark);
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("mouseenter", () => {
        activeIndex = index;
        paintActive();
      });
      row.addEventListener("click", () => select(index));
      result.append(row);
    });
    result.scrollTop = 0;
    showResults(expanded);
  };
  const lookup = async (version: number) => {
    // Serialize lookups so typing during the initial download reuses its cache.
    if (inFlight) await inFlight.catch(() => undefined);
    if (!current(version)) return;
    const value = query.value;
    const request = rpc("config/modelCatalog", { query: value });
    inFlight = request;
    try {
      const response = (await request) as ModelCatalogResult;
      if (!current(version)) return;
      models = response.models;
      resolvedQuery = value;
      activeIndex = -1;
      status.textContent = models.length
        ? `${models.length} / ${response.total} · ${text("choose")}`
        : text("empty");
      query.setAttribute("aria-busy", "false");
      paintResults();
    } catch (error) {
      if (!current(version)) return;
      status.textContent = `${text("failed")} ${error instanceof Error ? error.message : String(error)}`;
      query.setAttribute("aria-busy", "false");
      retry.hidden = false;
    } finally {
      if (inFlight === request) inFlight = undefined;
    }
  };
  const schedule = (delay = 120) => {
    invalidate();
    selected = undefined;
    resolvedQuery = undefined;
    models = [];
    activeIndex = -1;
    retry.hidden = true;
    describe();
    expanded = true;
    paintResults();
    if (!section.open || !section.isConnected) return;
    status.textContent = text("loading");
    query.setAttribute("aria-busy", "true");
    const version = generation;
    timer = win.setTimeout(() => {
      void lookup(version);
    }, delay);
  };
  const reset = (value: string) => {
    invalidate();
    query.value = value;
    query.setAttribute("aria-busy", "false");
    selected = undefined;
    resolvedQuery = undefined;
    models = [];
    activeIndex = -1;
    expanded = false;
    retry.hidden = true;
    status.textContent = "";
    describe();
    paintResults();
    if (section.open && section.isConnected) schedule(0);
  };
  section.addEventListener("toggle", () => {
    if (section.open) {
      if (resolvedQuery === query.value) showResults(true);
      else schedule(0);
    } else {
      invalidate();
      query.setAttribute("aria-busy", "false");
      showResults(false);
    }
  });
  const openResults = () => {
    if (resolvedQuery === query.value) showResults(true);
    else if (query.getAttribute("aria-busy") !== "true") schedule(0);
  };
  query.addEventListener("focus", openResults);
  query.addEventListener("click", openResults);
  query.addEventListener("input", (event) => {
    if (composing || (event as InputEvent).isComposing) {
      invalidate();
      selected = undefined;
      resolvedQuery = undefined;
      describe();
      showResults(false);
      return;
    }
    schedule();
  });
  query.addEventListener("compositionstart", () => {
    composing = true;
    invalidate();
  });
  query.addEventListener("compositionend", () => {
    composing = false;
    schedule();
  });
  query.addEventListener("keydown", (raw) => {
    const event = raw as KeyboardEvent;
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      showResults(false);
    } else if (event.key === "Tab") showResults(false);
    else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      showResults(true);
      if (!models.length) return;
      activeIndex =
        activeIndex < 0
          ? event.key === "ArrowDown"
            ? 0
            : models.length - 1
          : (activeIndex +
              (event.key === "ArrowDown" ? 1 : models.length - 1)) %
            models.length;
      paintActive(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (expanded && activeIndex >= 0) select(activeIndex);
    }
  });
  section.addEventListener("focusout", (event: Event) => {
    const target = (event as FocusEvent).relatedTarget as Node | null;
    if (!query.contains(target) && !result.contains(target)) showResults(false);
  });
  retry.addEventListener("click", () => schedule(0));
  use.addEventListener("click", () => {
    if (!selected || use.disabled) return;
    apply(selected);
    status.textContent = text("applied");
  });
  return { node: section, reset };
}
