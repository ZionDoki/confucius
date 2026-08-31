import { getPref, setPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";
import { config } from "../../../package.json";

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
    label: getString("prefs-title") === "confucius-prefs-title"
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
    const el = doc.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) {
      return;
    }
    el.value = String(getPref(key) ?? "");
    el.addEventListener("change", () => {
      if (numeric) {
        setPref(key, Number(el.value) || 0);
      } else {
        setPref(key, el.value as never);
      }
    });
  };
  bind("confucius-pref-baseUrl", "baseUrl");
  bind("confucius-pref-apiKey", "apiKey");
  bind("confucius-pref-model", "model");
  bind("confucius-pref-maxTokens", "maxTokens", true);
  bind("confucius-pref-mcpServersJson", "mcpServersJson");
  const bindCheck = (
    id: string,
    key: Parameters<typeof getPref>[0],
  ) => {
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
  bindCheck("confucius-pref-memoryAutoExtract", "memoryAutoExtract");
  const token = doc.getElementById(
    "confucius-pref-pairingToken",
  ) as HTMLInputElement | null;
  if (token) {
    token.value = String(getPref("pairingToken") || "");
  }
}
