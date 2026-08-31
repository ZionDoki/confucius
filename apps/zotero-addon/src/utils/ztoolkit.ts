import { ZoteroToolkit } from "zotero-plugin-toolkit/ztoolkit";
import { config } from "../../package.json";

export { createZToolkit };

function createZToolkit() {
  const toolkit = new ZoteroToolkit();
  const env = __env__;
  toolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  toolkit.basicOptions.log.disableConsole = env === "production";
  toolkit.UI.basicOptions.ui.enableElementJSONLog = env === "development";
  toolkit.UI.basicOptions.ui.enableElementDOMLog = env === "development";
  toolkit.basicOptions.api.pluginID = config.addonID;
  toolkit.ProgressWindow.setIconURI(
    "default",
    `chrome://${config.addonRef}/content/icons/favicon.svg`,
  );
  return toolkit;
}
