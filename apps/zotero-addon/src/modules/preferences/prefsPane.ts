import { UI_FONT_STACKS } from "../ui/workspaceTypography";
import { SURFACE_CSS } from "../ui/workspaceSurface";
import { getPref, setPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";
import { config } from "../../../package.json";
import {
  clampUiFontSize,
  isUiFont,
  isUiLineHeight,
  UI_LINE_HEIGHT_VALUES,
  clampMaxIterations,
  clampMaxToolCalls,
  isMemoryConsent,
  type AgentBackendKind,
  type RuntimeListResult,
} from "@confucius/protocol";
import { pickRuntimeExecutable } from "../ui/runtimeExecutablePicker";
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
  if (pane) {
    const font = getPref("uiFont");
    const lineHeight = getPref("uiLineHeight");
    pane.style.fontFamily = UI_FONT_STACKS[isUiFont(font) ? font : "sans"];
    pane.style.fontSize = `${clampUiFontSize(getPref("uiFontSize"))}px`;
    pane.style.lineHeight = String(
      UI_LINE_HEIGHT_VALUES[
        isUiLineHeight(lineHeight) ? lineHeight : "standard"
      ],
    );
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
    memoryConsent.value = isMemoryConsent(current) ? current : "review";
    memoryConsent.addEventListener("change", () => {
      const next = isMemoryConsent(memoryConsent.value)
        ? memoryConsent.value
        : "review";
      setPref("memoryConsent", next);
      // Keep the legacy preference coherent for older add-on builds without
      // ever turning an upgrade into silent automatic extraction.
      setPref("memoryAutoExtract", next === "auto");
    });
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
  bindRuntimeStatus(win);
}

function bindRuntimeStatus(win: Window): void {
  const doc = win.document;
  const status = doc.getElementById(
    "confucius-pref-runtime-status",
  ) as HTMLElement | null;
  const refresh = doc.getElementById(
    "confucius-pref-runtime-refresh",
  ) as HTMLButtonElement | null;
  const hostToggle = doc.getElementById(
    "confucius-pref-pluginRuntimeHost",
  ) as HTMLInputElement | null;
  const codexPath = doc.getElementById(
    "confucius-pref-codexExecutable",
  ) as HTMLInputElement | null;
  const kimiPath = doc.getElementById(
    "confucius-pref-kimiExecutable",
  ) as HTMLInputElement | null;
  const errorLine = doc.getElementById(
    "confucius-pref-runtime-error",
  ) as HTMLElement | null;
  if (!status || !refresh || !hostToggle || !codexPath || !kimiPath) return;

  hostToggle.checked = getPref("pluginRuntimeHost") !== false;
  codexPath.value = String(getPref("codexExecutable") || "");
  kimiPath.value = String(getPref("kimiExecutable") || "");

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

  const paint = (result: RuntimeListResult): void => {
    status.textContent = "";
    const summary = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLElement;
    summary.textContent = result.runtimeHostEnabled
      ? getString("pref-runtime-host-connected")
      : getString("pref-runtime-host-offline");
    summary.style.fontWeight = "600";
    summary.style.marginBottom = "6px";
    status.appendChild(summary);
    hostToggle.checked = result.runtimeHostEnabled;
    for (const runtime of result.runtimes) {
      const row = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLElement;
      row.style.padding = "3px 0";
      row.style.overflowWrap = "anywhere";
      row.textContent = `${runtime.backend} · ${runtime.state}${
        runtime.version ? ` · ${runtime.version}` : ""
      }${runtime.executable ? ` · ${runtime.executable}` : ""}${
        runtime.message ? ` · ${runtime.message}` : ""
      }`;
      status.appendChild(row);
    }
  };

  const load = async (force: boolean): Promise<void> => {
    refresh.disabled = true;
    if (errorLine) errorLine.textContent = "";
    try {
      if (!host) throw new Error("Confucius host is unavailable");
      const result = (await host.rpc(
        force ? "runtime/refresh" : "runtime/list",
        {},
      )) as RuntimeListResult;
      paint(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (errorLine) errorLine.textContent = message;
      status.title = message;
    } finally {
      refresh.disabled = false;
    }
  };

  refresh.addEventListener("click", () => void load(true));

  hostToggle.addEventListener("change", () => {
    void (async () => {
      if (!host) throw new Error("Confucius host is unavailable");
      hostToggle.disabled = true;
      const result = (await host.rpc("runtime/setPluginHost", {
        enabled: hostToggle.checked,
      })) as RuntimeListResult;
      paint(result);
    })()
      .catch((error) => {
        hostToggle.checked = !hostToggle.checked;
        if (errorLine) {
          errorLine.textContent =
            error instanceof Error ? error.message : String(error);
        }
      })
      .finally(() => {
        hostToggle.disabled = false;
      });
  });

  const configure = async (
    backend: Exclude<AgentBackendKind, "native">,
    input: HTMLInputElement,
  ): Promise<void> => {
    if (!host) throw new Error("Confucius host is unavailable");
    if (errorLine) errorLine.textContent = "";
    await host.rpc("runtime/configure", {
      backend,
      executable: input.value.trim(),
    });
    await load(true);
  };

  const bindExecutableControls = (
    backend: Exclude<AgentBackendKind, "native">,
    input: HTMLInputElement,
  ): void => {
    const save = doc.getElementById(
      `confucius-pref-runtime-${backend}-save`,
    ) as HTMLButtonElement | null;
    const browse = doc.getElementById(
      `confucius-pref-runtime-${backend}-browse`,
    ) as HTMLButtonElement | null;
    const auto = doc.getElementById(
      `confucius-pref-runtime-${backend}-auto`,
    ) as HTMLButtonElement | null;
    save?.addEventListener("click", () => {
      void configure(backend, input).catch((error) => {
        if (errorLine) {
          errorLine.textContent =
            error instanceof Error ? error.message : String(error);
        }
      });
    });
    browse?.addEventListener("click", () => {
      void pickRuntimeExecutable(win, getString(`pref-runtime-${backend}-path`))
        .then(async (path) => {
          if (!path) return;
          input.value = path;
          await configure(backend, input);
        })
        .catch((error) => {
          if (errorLine) {
            errorLine.textContent =
              error instanceof Error ? error.message : String(error);
          }
        });
    });
    auto?.addEventListener("click", () => {
      input.value = "";
      void configure(backend, input).catch((error) => {
        if (errorLine) {
          errorLine.textContent =
            error instanceof Error ? error.message : String(error);
        }
      });
    });
  };

  bindExecutableControls("codex", codexPath);
  bindExecutableControls("kimi", kimiPath);
  // Login can change while Zotero stays open. Probe the actual runtime
  // session boundary whenever this pane opens instead of showing stale state.
  void load(true);
}
