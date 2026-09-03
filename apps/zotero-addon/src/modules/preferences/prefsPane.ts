import { getPref, setPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";
import { config } from "../../../package.json";
import {
  clampMaxIterations,
  clampMaxToolCalls,
  isMemoryConsent,
  type RuntimeStatus,
} from "@confucius/protocol";

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
  const kimiPath = doc.getElementById(
    "confucius-pref-kimiExecutable",
  ) as HTMLInputElement | null;
  const kimiSave = doc.getElementById(
    "confucius-pref-runtime-kimi-save",
  ) as HTMLButtonElement | null;
  if (!status || !refresh) return;

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

  const paint = (
    sidecarConnected: boolean,
    runtimes: RuntimeStatus[],
  ): void => {
    status.textContent = "";
    const summary = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLElement;
    summary.textContent = sidecarConnected
      ? getString("workspace-sidecar-connected")
      : getString("workspace-sidecar-offline");
    summary.style.fontWeight = "600";
    summary.style.marginBottom = "6px";
    status.appendChild(summary);
    for (const runtime of runtimes) {
      const row = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLElement;
      row.style.padding = "3px 0";
      row.style.overflowWrap = "anywhere";
      row.textContent = `${runtime.backend} · ${runtime.state}${
        runtime.version ? ` · ${runtime.version}` : ""
      }${runtime.message ? ` · ${runtime.message}` : ""}`;
      status.appendChild(row);
      if (runtime.backend === "kimi" && runtime.executable && kimiPath) {
        kimiPath.value = runtime.executable;
      }
    }
  };

  const load = async (force: boolean): Promise<void> => {
    refresh.disabled = true;
    try {
      if (!host) throw new Error("Confucius host is unavailable");
      const result = (await host.rpc(
        force ? "runtime/refresh" : "runtime/list",
        {},
      )) as { sidecarConnected?: boolean; runtimes?: RuntimeStatus[] };
      paint(result.sidecarConnected === true, result.runtimes ?? []);
    } catch (error) {
      paint(false, []);
      status.title = error instanceof Error ? error.message : String(error);
    } finally {
      refresh.disabled = false;
    }
  };

  refresh.addEventListener("click", () => void load(true));
  kimiSave?.addEventListener("click", () => {
    void (async () => {
      if (!host) throw new Error("Confucius host is unavailable");
      await host.rpc("runtime/configure", {
        backend: "kimi",
        executable: kimiPath?.value.trim() ?? "",
      });
      await load(true);
    })().catch((error) => {
      status.title = error instanceof Error ? error.message : String(error);
    });
  });
  // Login can change while Zotero and the sidecar stay open. Probe the ACP
  // session boundary whenever this pane opens instead of showing stale state.
  void load(true);
}
