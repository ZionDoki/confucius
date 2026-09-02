import { config } from "../package.json";
import hooks from "./hooks";
import { openLink as navigateLink } from "./modules/ui/linkNavigator";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: unknown;
    };
    workspaceWindow?: Window;
  };
  public hooks: typeof hooks;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
  }

  /** Workspace looks up `Zotero.Confucius.rpc`. */
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.hooks.host.rpc(method, params);
  }

  /** Workspace link clicks land here (`Zotero.Confucius.openLink`). */
  openLink(href: string): Promise<{ ok: boolean; message?: string }> {
    return navigateLink(href);
  }
}

export default Addon;
