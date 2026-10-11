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
import {
  createWorkspaceButton,
  bindTabNavigation,
} from "../ui/workspaceControls";
import { openWorkspace } from "../ui/workspaceWindow";
import { config } from "../../../package.json";
import {
  clampMaxIterations,
  clampMaxToolCalls,
  isMemoryConsent,
} from "@confucius/protocol";
import { bindPreferenceScrollbars } from "../ui/workspaceScrollbars";

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
        const button = workspace?.document.getElementById(
          "confucius-settings",
        ) as HTMLElement | null;
        if (!button && attempts++ < 50) {
          win.setTimeout(show, 100);
          return;
        }
        const updateTab = workspace?.document.getElementById(
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
  bind("confucius-pref-baseUrl", "baseUrl");
  bind("confucius-pref-apiKey", "apiKey");
  bind("confucius-pref-model", "model");
  bind("confucius-pref-maxTokens", "maxTokens", true);
  bind("confucius-pref-mcpServersJson", "mcpServersJson");
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
}
