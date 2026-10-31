import { ensurePaletteStyles, SURFACE_CSS } from "../ui/workspaceSurface";
import { getPref, setPref } from "../../utils/prefs";
import {
  getString,
  getLocaleMessage,
  configuredUiLanguage,
} from "../../utils/locale";
import { readAppearancePrefs } from "../../utils/appearancePrefs";
import { createAppearanceSettings } from "../ui/appearanceSettings";
import { createRuntimeSettings } from "../ui/runtimeSettings";
import { createProtocolSettings } from "../ui/modelSettings";
import {
  createWorkspaceButton,
  bindTabNavigation,
} from "../ui/workspaceControls";
import { openWorkspace, workspaceDocument } from "../ui/workspaceWindow";
import { config } from "../../../package.json";
import {
  clampMaxIterations,
  clampMaxToolCalls,
  isMemoryConsent,
  isModelApiProtocol,
  type ModelConfigView,
} from "@confucius/protocol";
import { bindPreferenceScrollbars } from "../ui/workspaceScrollbars";
import { ensureMcpToken } from "../bridge/pairingToken";

export type EndpointModelField =
  "baseUrl" | "apiKey" | "model" | "maxTokens" | "protocol";

/** Change one field of a known endpoint instead of mixing legacy prefs. */
export function endpointModelPatch(
  endpointId: string,
  key: EndpointModelField,
  value: string | number,
): Record<string, unknown> {
  return { endpoint: { id: endpointId, [key]: value } };
}

export interface ModelSaveScheduler {
  /** Debounce the newest edit for a field. */
  schedule(key: EndpointModelField, save: () => void): void;
  /** Drop a debounced copy; a committed edit supersedes it (change/blur). */
  cancel(key: EndpointModelField): void;
  /** Save every field still waiting to be written (window unload). */
  flush(): void;
}

/**
 * Coalesce live model-field edits. Typing waits for `delay` so a half-typed
 * API key is not written on every keystroke, while change/blur and closing
 * the pane flush the pending value immediately so the last edit is not lost.
 */
export function createModelSaveScheduler(options: {
  delay: number;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (handle: number) => void;
}): ModelSaveScheduler {
  const pending = new Map<
    EndpointModelField,
    { handle: number; save: () => void }
  >();
  const cancel = (key: EndpointModelField): void => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    options.clearTimer(entry.handle);
  };
  return {
    schedule(key, save) {
      cancel(key);
      const entry = { handle: -1, save };
      pending.set(key, entry);
      entry.handle = options.setTimer(() => {
        if (pending.get(key) !== entry) return;
        pending.delete(key);
        entry.save();
      }, options.delay);
    },
    cancel,
    flush() {
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) {
        options.clearTimer(entry.handle);
        entry.save();
      }
    },
  };
}

export async function registerPreferencePane(): Promise<void> {
  const paneId = "confucius-prefpane";
  try {
    Zotero.PreferencePanes.unregister?.(paneId);
  } catch {
    // First load has nothing to unregister.
  }
  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    id: paneId,
    src: rootURI + "content/preferences.xhtml",
    label:
      getString("prefs-title") === "confucius-prefs-title"
        ? "Confucius"
        : getString("prefs-title"),
    image: `chrome://${config.addonRef}/content/icons/favicon.svg`,
  });
}

export function bindPrefsWindow(win: Window): void {
  const doc = win.document;
  ensurePaletteStyles(doc);
  bindPreferenceScrollbars(win);
  if (!doc.getElementById("confucius-preferences-style")) {
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.id = "confucius-preferences-style";
    style.textContent = SURFACE_CSS;
    (doc.head ?? doc.documentElement)?.appendChild(style);
  }
  const pane = doc.getElementById(
    "confucius-preferences",
  ) as HTMLElement | null;
  if (!pane || pane.dataset.confuciusBound === "true") return;
  pane.dataset.confuciusBound = "true";
  const rpc = async (method: string, params?: Record<string, unknown>) => {
    const host = (
      Zotero as unknown as {
        Confucius?: {
          hooks?: {
            host?: {
              rpc(
                method: string,
                params?: Record<string, unknown>,
              ): Promise<unknown>;
            };
          };
        };
      }
    ).Confucius?.hooks?.host;
    if (!host) throw new Error("Confucius host unavailable");
    return host.rpc(method, params ?? {});
  };
  const nav = doc.getElementById("confucius-pref-tabs") as HTMLElement;
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", getString("workspace-settings"));
  bindTabNavigation(nav);
  const sections = [
    ...pane.querySelectorAll<HTMLElement>("[data-confucius-pref-tab]"),
  ];
  const tabs = new Map<string, HTMLButtonElement>();
  const select = (tab: string) => {
    for (const section of sections)
      section.hidden = section.dataset.confuciusPrefTab !== tab;
    for (const [value, button] of tabs) {
      button.setAttribute("aria-selected", String(value === tab));
      button.tabIndex = value === tab ? 0 : -1;
    }
  };
  for (const tab of [
    "model",
    "appearance",
    "runtime",
    "memory",
    "security",
    "update",
  ]) {
    const button = createWorkspaceButton(
      doc,
      `confucius-pref-tab-${tab}`,
      getString(`workspace-settings-tab-${tab}`),
    );
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => select(tab));
    const ids: string[] = [];
    for (const [index, section] of sections
      .filter((section) => section.dataset.confuciusPrefTab === tab)
      .entries()) {
      section.id = `confucius-pref-panel-${tab}-${index}`;
      section.setAttribute("role", "tabpanel");
      section.setAttribute("aria-labelledby", button.id);
      ids.push(section.id);
    }
    button.setAttribute("aria-controls", ids.join(" "));
    tabs.set(tab, button);
    nav.append(button);
  }
  select("model");
  const appearanceTarget = doc.getElementById("confucius-pref-appearance")!;
  const localizePane = () => {
    for (const [tab, button] of tabs)
      button.textContent = getString(`workspace-settings-tab-${tab}`);
    for (const item of pane.querySelectorAll("[data-l10n-id]")) {
      const id = item.getAttribute("data-l10n-id")!;
      const value = getLocaleMessage(id);
      if (value !== id) item.textContent = value;
    }
    for (const item of pane.querySelectorAll<HTMLElement>(
      "[data-confucius-l10n]",
    ))
      item.textContent = getString(item.dataset.confuciusL10n!);
    runtime.localize();
  };
  const mountAppearance = () => {
    appearanceTarget.replaceChildren();
    const editor = createAppearanceSettings(doc, {
      ...readAppearancePrefs(),
      uiLanguage: configuredUiLanguage(),
    });
    const actions = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "footer",
    );
    actions.className = "confucius-settings-footer";
    const save = createWorkspaceButton(
      doc,
      "confucius-pref-appearance-save",
      getString("workspace-settings-save"),
      "primary",
    );
    const cancel = createWorkspaceButton(
      doc,
      "confucius-pref-appearance-cancel",
      getString("workspace-settings-cancel"),
    );
    const feedback = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "p",
    ) as HTMLElement;
    feedback.className = "confucius-settings-feedback";
    feedback.setAttribute("role", "status");
    actions.append(feedback, cancel, save);
    appearanceTarget.append(editor.element, actions);
    let saving = false;
    cancel.addEventListener("click", () => {
      if (!saving) mountAppearance();
    });
    save.addEventListener("click", () => {
      if (saving || save.disabled) return;
      void (async () => {
        try {
          const patch = editor.getPatch() as Record<string, unknown>;
          const language = configuredUiLanguage();
          saving = true;
          save.disabled = cancel.disabled = true;
          editor.element.inert = true;
          appearanceTarget.setAttribute("aria-busy", "true");
          await rpc("config/set", patch);
          if (!editor.element.isConnected || win.closed) return;
          if (language !== configuredUiLanguage()) {
            localizePane();
            mountAppearance();
          }
          const currentFeedback = appearanceTarget.querySelector<HTMLElement>(
            ".confucius-settings-feedback",
          )!;
          currentFeedback.dataset.state = "saved";
          currentFeedback.textContent = getString("workspace-settings-saved");
        } catch (error) {
          delete feedback.dataset.state;
          feedback.textContent =
            error instanceof Error ? error.message : String(error);
        } finally {
          saving = false;
          save.disabled = cancel.disabled = false;
          editor.element.inert = false;
          appearanceTarget.removeAttribute("aria-busy");
        }
      })();
    });
  };
  mountAppearance();
  const runtime = createRuntimeSettings(doc, rpc);
  doc.getElementById("confucius-pref-runtime")?.append(runtime.element);
  void runtime.refresh();
  const updates = doc.getElementById("confucius-pref-updates");
  if (updates) {
    const help = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
    help.setAttribute("data-confucius-l10n", "workspace-update-help");
    help.textContent = getString("workspace-update-help");
    const open = createWorkspaceButton(
      doc,
      "confucius-pref-updates-open",
      getString("workspace-settings-open-updates"),
    );
    open.dataset.confuciusL10n = "workspace-settings-open-updates";
    let openingUpdates = false;
    open.addEventListener("click", () => {
      if (openingUpdates) return;
      openingUpdates = true;
      open.disabled = true;
      const workspace = openWorkspace(Zotero.getMainWindow());
      let attempts = 0;
      let opening = false;
      const finish = () => {
        openingUpdates = false;
        open.disabled = false;
      };
      const show = () => {
        if (win.closed || !workspace || workspace.closed) {
          finish();
          return;
        }
        const workspaceDoc = workspaceDocument(workspace.document);
        const button = workspaceDoc.getElementById(
          "confucius-settings",
        ) as HTMLElement | null;
        if (!button && attempts++ < 50) {
          win.setTimeout(show, 100);
          return;
        }
        const updateTab = workspaceDoc.getElementById(
          "confucius-cfg-tab-update",
        ) as HTMLElement | null;
        if (!updateTab) {
          if (!opening) {
            button?.click();
            opening = true;
          }
          if (attempts++ < 50) win.setTimeout(show, 100);
          else finish();
          return;
        }
        updateTab.click();
        workspace?.focus();
        finish();
      };
      show();
    });
    updates.append(help, open);
  }
  const bind = (
    id: string,
    key: Parameters<typeof getPref>[0],
    numeric = false,
  ) => {
    const el = doc.getElementById(id) as
      HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) {
      return;
    }
    el.value = String(getPref(key) ?? "");
    const persist = () => {
      if (numeric) {
        setPref(key, Number(el.value) || 0);
      } else {
        setPref(key, el.value as never);
      }
    };
    el.addEventListener("change", persist);
    el.addEventListener("input", persist);
    el.addEventListener("blur", persist);
  };
  bind("confucius-pref-mcpServersJson", "mcpServersJson");
  // Model fields belong to the active endpoint, not to whichever legacy pref
  // values happened to be visible when this pane first loaded. Read the
  // authoritative config when the pane gains focus and write changes back to
  // that endpoint by id so URL, key and model can never be mixed across
  // endpoints.
  const modelFields: Array<{
    el: HTMLInputElement;
    key: EndpointModelField;
    numeric: boolean;
  }> = [];
  const protocolInput = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "input",
  ) as HTMLInputElement;
  protocolInput.type = "hidden";
  const protocolSettings = createProtocolSettings(doc, (value) => {
    protocolInput.value = value;
    protocolInput.dispatchEvent(new win.Event("change", { bubbles: true }));
  });
  const baseField = doc.getElementById("confucius-pref-baseUrl");
  baseField?.after(protocolSettings.node, protocolInput);
  for (const [id, key, numeric] of [
    ["confucius-pref-baseUrl", "baseUrl", false],
    ["confucius-pref-apiKey", "apiKey", false],
    ["confucius-pref-model", "model", false],
    ["confucius-pref-maxTokens", "maxTokens", true],
  ] as const) {
    const input = doc.getElementById(id) as HTMLInputElement | null;
    if (input) modelFields.push({ el: input, key, numeric });
  }
  modelFields.push({ el: protocolInput, key: "protocol", numeric: false });
  for (const field of modelFields)
    field.el.value =
      field.key === "protocol" ? "auto" : String(getPref(field.key) ?? "");
  let activeEndpointId = "";
  let modelLoadGeneration = 0;
  let modelSaveGeneration = 0;
  let modelSaveCompletion = 0;
  // Edits made before the first config/get reply must not be lost: keep them
  // until the authoritative endpoint id is known, then replay them there.
  const pendingModelEdits = new Map<EndpointModelField, string | number>();
  const lastModelValues = new Map<EndpointModelField, string>();
  // Fields with a local edit that no config snapshot has confirmed yet.
  const dirtyModelFields = new Set<EndpointModelField>();
  const modelStatus = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "p",
  ) as HTMLElement;
  modelStatus.className = "confucius-settings-feedback";
  modelStatus.setAttribute("role", "status");
  const modelSection = modelFields[0]?.el.closest("groupbox");
  (modelSection ?? pane).append(modelStatus);
  let modelSaveChain: Promise<void> = Promise.resolve();
  const saveModelField = (
    field: (typeof modelFields)[number],
    endpoint: string,
    value: string | number,
  ): void => {
    const generation = ++modelSaveGeneration;
    modelSaveChain = modelSaveChain
      .catch(() => undefined)
      .then(async () => {
        try {
          const config = (await rpc(
            "config/set",
            endpointModelPatch(endpoint, field.key, value),
          )) as ModelConfigView;
          modelSaveCompletion++;
          // A newer edit owns this field; never let an older reply overwrite
          // the pane or the active endpoint snapshot.
          if (generation !== modelSaveGeneration) return;
          activeEndpointId = config.activeEndpointId;
          const serverValue = String(config[field.key] ?? "");
          if (lastModelValues.get(field.key) === String(value)) {
            dirtyModelFields.delete(field.key);
            lastModelValues.set(field.key, serverValue);
          }
          if (
            doc.activeElement !== field.el &&
            !pendingModelEdits.has(field.key)
          )
            field.el.value = serverValue;
          if (field.key === "protocol")
            protocolSettings.setValue(
              isModelApiProtocol(field.el.value) ? field.el.value : "auto",
            );
          delete modelStatus.dataset.state;
          modelStatus.textContent = "";
        } catch (error) {
          modelSaveCompletion++;
          if (generation !== modelSaveGeneration) return;
          if (lastModelValues.get(field.key) === String(value)) {
            lastModelValues.delete(field.key);
            dirtyModelFields.delete(field.key);
          }
          delete modelStatus.dataset.state;
          modelStatus.textContent =
            error instanceof Error ? error.message : String(error);
        }
      });
    void modelSaveChain;
  };
  const flushPendingModelEdits = (): void => {
    if (!activeEndpointId) return;
    const endpoint = activeEndpointId;
    for (const [key, value] of [...pendingModelEdits]) {
      pendingModelEdits.delete(key);
      const field = modelFields.find((entry) => entry.key === key);
      if (!field) continue;
      field.el.value = String(value);
      lastModelValues.set(key, String(value));
      dirtyModelFields.add(key);
      saveModelField(field, endpoint, value);
    }
  };
  const loadModelFields = async (): Promise<void> => {
    const generation = ++modelLoadGeneration;
    const saveGeneration = modelSaveGeneration;
    const saveCompletion = modelSaveCompletion;
    try {
      const config = (await rpc("config/get", {})) as ModelConfigView;
      // Discard a reply overtaken by a newer load or edit, including a save
      // that settled while this snapshot was in flight.
      if (
        generation !== modelLoadGeneration ||
        saveGeneration !== modelSaveGeneration ||
        saveCompletion !== modelSaveCompletion
      )
        return;
      const previousEndpoint = activeEndpointId;
      activeEndpointId = config.activeEndpointId;
      const endpointChanged =
        Boolean(previousEndpoint) &&
        previousEndpoint !== config.activeEndpointId;
      if (endpointChanged) {
        pendingModelEdits.clear();
        dirtyModelFields.clear();
      }
      for (const field of modelFields) {
        // Preserve an edit that still has focus unless the endpoint itself
        // changed; then every field must be replaced to avoid mixing scopes.
        if (!endpointChanged && doc.activeElement === field.el) continue;
        if (!endpointChanged && pendingModelEdits.has(field.key)) continue;
        const serverValue = String(config[field.key] ?? "");
        // A local edit with no matching snapshot yet owns the field; an older
        // config/get must not resurrect the previous value.
        if (
          !endpointChanged &&
          dirtyModelFields.has(field.key) &&
          lastModelValues.get(field.key) !== serverValue
        )
          continue;
        field.el.value = serverValue;
        if (field.key === "protocol")
          protocolSettings.setValue(
            isModelApiProtocol(serverValue) ? serverValue : "auto",
          );
        lastModelValues.set(field.key, serverValue);
        if (!endpointChanged) dirtyModelFields.delete(field.key);
      }
      if (!endpointChanged) flushPendingModelEdits();
      delete modelStatus.dataset.state;
      modelStatus.textContent = "";
    } catch (error) {
      if (generation !== modelLoadGeneration) return;
      delete modelStatus.dataset.state;
      modelStatus.textContent =
        error instanceof Error ? error.message : String(error);
    }
  };
  // Typing must reach the endpoint too, not only change/blur, or closing
  // Settings mid-edit drops the last value. Keystrokes are debounced so a
  // half-typed API key is not written; change/blur/unload commit immediately.
  const modelSaves = createModelSaveScheduler({
    delay: 400,
    setTimer: (callback, delay) => win.setTimeout(callback, delay),
    clearTimer: (handle) => win.clearTimeout(handle),
  });
  const persistModelField = (
    field: (typeof modelFields)[number],
    pendingValue?: string,
  ): void => {
    // A committed edit (change/blur) supersedes the debounced copy; the
    // debounce timer also lands here after removing its own entry.
    modelSaves.cancel(field.key);
    const raw = pendingValue ?? field.el.value;
    const value = field.numeric ? Number(raw) || 0 : raw;
    const serialized = String(value);
    // change and blur both fire for a committed text edit; persist once.
    if (lastModelValues.get(field.key) === serialized) return;
    lastModelValues.set(field.key, serialized);
    dirtyModelFields.add(field.key);
    pendingModelEdits.delete(field.key);
    // Without a live endpoint snapshot, keep the edit and refresh instead of
    // writing legacy fields that may describe a different endpoint.
    if (!activeEndpointId) {
      pendingModelEdits.set(field.key, value);
      void loadModelFields();
      return;
    }
    saveModelField(field, activeEndpointId, value);
  };
  for (const field of modelFields) {
    field.el.addEventListener("input", () => {
      // Capture the value now: a focus-driven refresh may replace the input
      // before the debounce fires, and the typed value must still be saved.
      const value = field.el.value;
      modelSaves.schedule(field.key, () => persistModelField(field, value));
    });
    field.el.addEventListener("change", () => persistModelField(field));
    field.el.addEventListener("blur", () => persistModelField(field));
  }
  tabs.get("model")?.addEventListener("click", () => void loadModelFields());
  const refreshModelFields = () => {
    if (!win.closed) void loadModelFields();
  };
  win.addEventListener("focus", refreshModelFields);
  win.addEventListener(
    "unload",
    () => {
      // Closing Settings must not lose a debounced edit.
      modelSaves.flush();
      win.removeEventListener("focus", refreshModelFields);
    },
    { once: true },
  );
  void loadModelFields();
  const bindCheck = (id: string, key: Parameters<typeof getPref>[0]) => {
    const el = doc.getElementById(id) as HTMLInputElement | null;
    if (!el) {
      return;
    }
    el.checked = getPref(key) !== false;
    el.addEventListener("change", () => {
      setPref(key, el.checked as never);
    });
  };
  bindCheck("confucius-pref-streamResponses", "streamResponses");
  const memoryConsent = doc.getElementById(
    "confucius-pref-memoryConsent",
  ) as HTMLSelectElement | null;
  if (memoryConsent) {
    const current = getPref("memoryConsent");
    memoryConsent.value = current === "off" ? "off" : "review";
    memoryConsent.addEventListener("change", () => {
      const next = isMemoryConsent(memoryConsent.value)
        ? memoryConsent.value
        : "review";
      setPref("memoryConsent", next === "off" ? "off" : "review");
      // Keep the legacy preference coherent for older add-on builds without
      // ever turning an upgrade into silent automatic extraction.
      setPref("memoryAutoExtract", next !== "off");
    });
  }
  const historyCleanup = doc.getElementById(
    "confucius-pref-historyAutoCleanup",
  ) as HTMLInputElement | null;
  if (historyCleanup) {
    historyCleanup.checked = getPref("historyAutoCleanup") !== false;
    historyCleanup.addEventListener("change", () =>
      setPref("historyAutoCleanup", historyCleanup.checked),
    );
  }
  const bindBudget = (
    id: string,
    key: "maxIterations" | "maxToolCalls",
    clamp: (value: unknown) => number,
  ) => {
    const el = doc.getElementById(id) as HTMLInputElement | null;
    if (!el) {
      return;
    }
    el.value = String(clamp(getPref(key)));
    const persist = () => {
      const next = clamp(el.value);
      setPref(key, next);
      el.value = String(next);
    };
    el.addEventListener("change", persist);
    el.addEventListener("blur", persist);
  };
  bindBudget(
    "confucius-pref-maxIterations",
    "maxIterations",
    clampMaxIterations,
  );
  bindBudget("confucius-pref-maxToolCalls", "maxToolCalls", clampMaxToolCalls);
  const token = doc.getElementById(
    "confucius-pref-pairingToken",
  ) as HTMLInputElement | null;
  if (token) {
    token.value = String(getPref("pairingToken") || "");
  }
  const mcpToken = doc.getElementById(
    "confucius-pref-mcpToken",
  ) as HTMLInputElement | null;
  if (mcpToken) {
    mcpToken.value = ensureMcpToken();
    // Provisioning can fail when this profile cannot write preferences. The
    // endpoint fails closed, so the Security pane must say why it is closed.
    const status = doc.getElementById(
      "confucius-pref-mcpToken-status",
    ) as HTMLElement | null;
    if (status) status.hidden = Boolean(mcpToken.value);
  }
}
