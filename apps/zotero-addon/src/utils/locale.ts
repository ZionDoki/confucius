import { config } from "../../package.json";
import { isUiLanguage, type UiLanguage } from "@confucius/protocol";
import { getPref } from "./prefs";

type LocaleKey = string;

function systemUiLanguage(): UiLanguage {
  return String(Zotero.locale).toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en-US";
}

export function configuredUiLanguage(): UiLanguage {
  const configured = getPref("uiLanguage");
  return isUiLanguage(configured) ? configured : systemUiLanguage();
}

export function initLocale(requested?: unknown): UiLanguage {
  const language = isUiLanguage(requested) ? requested : configuredUiLanguage();
  const LocalizationCtor =
    typeof Localization === "undefined"
      ? ztoolkit.getGlobal("Localization")
      : Localization;
  const l10n = new LocalizationCtor(
    [
      `${config.addonRef}-addon.ftl`,
      `${config.addonRef}-preferences.ftl`,
      `${config.addonRef}-mainWindow.ftl`,
    ],
    true,
    undefined,
    [language],
  );
  addon.data.locale = {
    current: l10n,
  };
  return language;
}

export function getString(id: LocaleKey): string {
  const fluentId = `${config.addonRef}-${id}`;
  const locale = addon.data.locale?.current as
    | {
        formatMessagesSync: (
          ids: Array<{ id: string }>,
        ) => Array<{ value?: string | null }>;
      }
    | undefined;
  const pattern = locale?.formatMessagesSync([{ id: fluentId }])[0];
  return pattern?.value || fluentId;
}

export function getLocaleID(id: LocaleKey) {
  return `${config.addonRef}-${id}`;
}
