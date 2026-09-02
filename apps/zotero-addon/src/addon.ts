import { config } from "../package.json";
import hooks from "./hooks";
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

  /** Workspace and Chrome look up `Zotero.Confucius.rpc`. */
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.hooks.host.rpc(method, params);
  }
}

export default Addon;
