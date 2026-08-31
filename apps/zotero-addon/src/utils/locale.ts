import { config } from "../../package.json";

type LocaleKey = string;

export function initLocale() {
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
  );
  addon.data.locale = {
    current: l10n,
  };
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
