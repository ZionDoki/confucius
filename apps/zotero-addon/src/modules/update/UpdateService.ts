import type { UpdateStatus } from "@confucius/protocol";

export interface ManagedAddonInstall {
  version?: string;
  error?: unknown;
  install(): Promise<unknown> | unknown;
  addListener?(listener: AddonInstallListener): void;
  removeListener?(listener: AddonInstallListener): void;
}

export interface ManagedAddon {
  id: string;
  version: string;
  applyBackgroundUpdates: number;
  findUpdates(
    listener: AddonUpdateListener,
    reason: number,
  ): Promise<unknown> | unknown;
}

export interface AddonUpdateListener {
  onUpdateAvailable?(addon: ManagedAddon, install: ManagedAddonInstall): void;
  onNoUpdateAvailable?(addon: ManagedAddon): void;
  onUpdateFinished?(addon: ManagedAddon, error?: unknown): void;
  onCompatibilityUpdateAvailable?(addon: ManagedAddon): void;
  onNoCompatibilityUpdateAvailable?(addon: ManagedAddon): void;
}

export interface AddonInstallListener {
  onDownloadStarted?(install: ManagedAddonInstall): void;
  onDownloadEnded?(install: ManagedAddonInstall): void;
  onDownloadFailed?(install: ManagedAddonInstall): void;
  onDownloadCancelled?(install: ManagedAddonInstall): void;
  onInstallStarted?(install: ManagedAddonInstall): void;
  onInstallEnded?(install: ManagedAddonInstall): void;
  onInstallPostponed?(install: ManagedAddonInstall): void;
  onInstallFailed?(install: ManagedAddonInstall): void;
  onInstallCancelled?(install: ManagedAddonInstall): void;
}

export interface AddonManagerFacade {
  UPDATE_WHEN_USER_REQUESTED: number;
  AUTOUPDATE_DISABLE: number;
  AUTOUPDATE_ENABLE: number;
  getAddonByID(id: string): Promise<ManagedAddon | null>;
  shouldAutoUpdate?(addon: ManagedAddon): boolean;
}

export interface UpdateServiceOptions {
  addonId: string;
  currentVersion: string;
  loadAddonManager?: () => AddonManagerFacade;
  now?: () => number;
  checkTimeoutMs?: number;
  installTimeoutMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
}

/** Thin, testable wrapper around Zotero/Firefox's signed add-on updater. */
export class UpdateService {
  private readonly loadManager: () => AddonManagerFacade;
  private readonly now: () => number;
  private readonly scheduleTimeout: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
  private readonly cancelTimeout: (handle: unknown) => void;
  private pendingInstall: ManagedAddonInstall | null = null;
  private last: Omit<UpdateStatus, "currentVersion" | "autoUpdate"> = {
    state: "idle",
    canInstall: false,
  };
  private checking: Promise<UpdateStatus> | null = null;
  private installing: Promise<UpdateStatus> | null = null;

  constructor(private readonly options: UpdateServiceOptions) {
    this.loadManager = options.loadAddonManager ?? loadAddonManager;
    this.now = options.now ?? (() => Date.now());
    this.scheduleTimeout =
      options.scheduleTimeout ??
      ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.cancelTimeout =
      options.cancelTimeout ??
      ((handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async status(): Promise<UpdateStatus> {
    const { manager, addon } = await this.addon();
    return this.snapshot(manager, addon);
  }

  check(): Promise<UpdateStatus> {
    if (this.checking) return this.checking;
    this.checking = this.performCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  install(): Promise<UpdateStatus> {
    if (this.installing) return this.installing;
    this.installing = this.performInstall().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  async setAuto(enabled: boolean): Promise<UpdateStatus> {
    const { manager, addon } = await this.addon();
    addon.applyBackgroundUpdates = enabled
      ? manager.AUTOUPDATE_ENABLE
      : manager.AUTOUPDATE_DISABLE;
    return this.snapshot(manager, addon);
  }

  private async performCheck(): Promise<UpdateStatus> {
    const { manager, addon } = await this.addon();
    this.pendingInstall = null;
    this.last = { state: "checking", canInstall: false };
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let found: ManagedAddonInstall | null = null;
        const finish = (action: () => void): void => {
          if (settled) return;
          settled = true;
          this.cancelTimeout(timer);
          action();
          resolve();
        };
        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          this.cancelTimeout(timer);
          reject(error);
        };
        const timer = this.scheduleTimeout(
          () => fail(new Error("Update check timed out")),
          this.options.checkTimeoutMs ?? 30_000,
        );
        const listener: AddonUpdateListener = {
          onUpdateAvailable: (_current, install) => {
            found = install;
            finish(() => {
              this.pendingInstall = install;
              this.last = {
                state: "available",
                canInstall: true,
                availableVersion: install.version,
                checkedAt: this.now(),
              };
            });
          },
          onNoUpdateAvailable: () =>
            finish(() => {
              this.last = {
                state: "up-to-date",
                canInstall: false,
                checkedAt: this.now(),
              };
            }),
          onUpdateFinished: (_current, error) => {
            if (error && Number(error) !== 0) {
              finish(() => {
                this.last = {
                  state: "error",
                  canInstall: false,
                  checkedAt: this.now(),
                  message: `Update check failed (${String(error)})`,
                };
              });
            } else if (!found) {
              finish(() => {
                this.last = {
                  state: "up-to-date",
                  canInstall: false,
                  checkedAt: this.now(),
                };
              });
            }
          },
        };
        try {
          const returned = addon.findUpdates(
            listener,
            manager.UPDATE_WHEN_USER_REQUESTED,
          );
          if (isPromiseLike(returned)) {
            void returned.catch(fail);
          }
        } catch (error) {
          fail(error);
        }
      });
    } catch (error) {
      this.last = {
        state: "error",
        canInstall: false,
        checkedAt: this.now(),
        message: readableError(error),
      };
    }
    return this.snapshot(manager, addon);
  }

  private async performInstall(): Promise<UpdateStatus> {
    const { manager, addon } = await this.addon();
    if (!this.pendingInstall) {
      const checked = await this.check();
      if (!this.pendingInstall || !checked.canInstall) return checked;
    }
    const install = this.pendingInstall;
    this.last = {
      ...this.last,
      state: "downloading",
      canInstall: false,
      message: undefined,
    };
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          this.cancelTimeout(timer);
          install.removeListener?.(listener);
          if (error) reject(error);
          else resolve();
        };
        const timer = this.scheduleTimeout(
          () => finish(new Error("Update installation timed out")),
          this.options.installTimeoutMs ?? 5 * 60_000,
        );
        const listener: AddonInstallListener = {
          onDownloadFailed: (failed) =>
            finish(failed.error ?? new Error("Update download failed")),
          onDownloadCancelled: () =>
            finish(new Error("Update download was cancelled")),
          onInstallFailed: (failed) =>
            finish(failed.error ?? new Error("Update installation failed")),
          onInstallCancelled: () =>
            finish(new Error("Update installation was cancelled")),
          onInstallEnded: () => finish(),
          onInstallPostponed: () => finish(),
        };
        install.addListener?.(listener);
        try {
          const returned = install.install();
          if (isPromiseLike(returned)) {
            void returned.then(
              () => {
                if (!install.addListener) finish();
              },
              (error) => finish(error),
            );
          } else if (!install.addListener) {
            finish();
          }
        } catch (error) {
          finish(error);
        }
      });
      this.pendingInstall = null;
      this.last = {
        state: "ready",
        canInstall: false,
        availableVersion: install.version,
        restartRequired: true,
        checkedAt: this.now(),
      };
    } catch (error) {
      this.last = {
        ...this.last,
        state: "error",
        canInstall: Boolean(this.pendingInstall),
        message: readableError(error),
        checkedAt: this.now(),
      };
    }
    return this.snapshot(manager, addon);
  }

  private async addon(): Promise<{
    manager: AddonManagerFacade;
    addon: ManagedAddon;
  }> {
    const manager = this.loadManager();
    const addon = await manager.getAddonByID(this.options.addonId);
    if (!addon) throw new Error("Confucius add-on is not registered");
    return { manager, addon };
  }

  private snapshot(
    manager: AddonManagerFacade,
    addon: ManagedAddon,
  ): UpdateStatus {
    // `shouldAutoUpdate()` folds in Firefox/Zotero-wide policy and can return
    // false for a development install even after this add-on was explicitly
    // set to AUTOUPDATE_ENABLE. The switch represents the add-on's own choice,
    // so preserve explicit enable/disable values and consult the global policy
    // only for the manager's implicit/default mode.
    const autoUpdate =
      addon.applyBackgroundUpdates === manager.AUTOUPDATE_ENABLE
        ? true
        : addon.applyBackgroundUpdates === manager.AUTOUPDATE_DISABLE
          ? false
          : manager.shouldAutoUpdate
            ? manager.shouldAutoUpdate(addon)
            : true;
    return {
      currentVersion: addon.version || this.options.currentVersion,
      autoUpdate,
      ...this.last,
    };
  }
}

function loadAddonManager(): AddonManagerFacade {
  return (
    ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    ) as { AddonManager: AddonManagerFacade }
  ).AddonManager;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function",
  );
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : String(error);
}
