import type { UpdateStatus } from "@confucius/protocol";
import {
  fetchReleases,
  selectUpdate,
  type ReleaseUpdate,
} from "./GitHubRelease";
import { installRelease } from "./ReleaseInstaller";

export interface UpdateServiceOptions {
  addonId: string;
  currentVersion: string;
  getAutoUpdate: () => boolean;
  setAutoUpdate: (enabled: boolean) => void;
  getIncludePrerelease: () => boolean;
  setIncludePrerelease: (enabled: boolean) => void;
  loadReleases?: () => Promise<unknown>;
  installRelease?: (release: ReleaseUpdate, addonId: string) => Promise<void>;
  now?: () => number;
  checkTimeoutMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
}

/** Confucius owns release discovery, preferences, and automatic checks. */
export class UpdateService {
  private readonly now: () => number;
  private readonly scheduleTimeout: NonNullable<
    UpdateServiceOptions["scheduleTimeout"]
  >;
  private readonly cancelTimeout: NonNullable<
    UpdateServiceOptions["cancelTimeout"]
  >;
  private pendingRelease: ReleaseUpdate | null = null;
  private last: Omit<
    UpdateStatus,
    "currentVersion" | "autoUpdate" | "includePrerelease"
  > = { state: "idle", canInstall: false };
  private checking: Promise<UpdateStatus> | null = null;
  private installing: Promise<UpdateStatus> | null = null;
  private backgroundTimer: unknown = null;
  private started = false;
  private disposed = false;

  constructor(private readonly options: UpdateServiceOptions) {
    this.now = options.now ?? Date.now;
    this.scheduleTimeout =
      options.scheduleTimeout ??
      ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancelTimeout =
      options.cancelTimeout ??
      ((handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.scheduleBackgroundCheck(30_000);
  }

  dispose(): void {
    this.disposed = true;
    this.started = false;
    this.cancelBackgroundCheck();
  }

  async status(): Promise<UpdateStatus> {
    return {
      currentVersion: this.options.currentVersion,
      autoUpdate: this.options.getAutoUpdate(),
      includePrerelease: this.options.getIncludePrerelease(),
      ...this.last,
    };
  }

  check(): Promise<UpdateStatus> {
    if (this.disposed || this.last.state === "ready") return this.status();
    if (this.installing) return this.installing;
    if (this.checking) return this.checking;
    this.checking = this.performCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  install(): Promise<UpdateStatus> {
    if (this.disposed || this.last.state === "ready") return this.status();
    if (this.installing) return this.installing;
    // Finish discovery before setting installing: check() also joins installs.
    if (this.checking) return this.checking.then(() => this.install());
    if (!this.pendingRelease)
      return this.check().then((status) =>
        status.canInstall ? this.install() : status,
      );
    const release = this.pendingRelease;
    this.installing = this.performInstall(release).finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  async setAuto(enabled: boolean): Promise<UpdateStatus> {
    this.options.setAutoUpdate(enabled);
    this.cancelBackgroundCheck();
    this.scheduleBackgroundCheck(30_000);
    return this.status();
  }

  async setPrerelease(enabled: boolean): Promise<UpdateStatus> {
    if (this.installing || this.last.state === "ready") return this.status();
    await this.checking;
    this.options.setIncludePrerelease(enabled);
    this.pendingRelease = null;
    this.last = { state: "idle", canInstall: false };
    return this.check();
  }

  private async performCheck(): Promise<UpdateStatus> {
    this.pendingRelease = null;
    this.last = { state: "checking", canInstall: false };
    let timer: unknown;
    try {
      const data = await Promise.race([
        (this.options.loadReleases ?? fetchReleases)(),
        new Promise<never>((_, reject) => {
          timer = this.scheduleTimeout(
            () =>
              reject(
                new Error("GitHub update check timed out. Please try again."),
              ),
            this.options.checkTimeoutMs ?? 30_000,
          );
        }),
      ]);
      if (this.disposed) return this.status();
      const release = selectUpdate(
        data,
        this.options.currentVersion,
        this.options.getIncludePrerelease(),
      );
      this.pendingRelease = release;
      this.last = {
        state: release ? "available" : "up-to-date",
        canInstall: Boolean(release),
        availableVersion: release?.version,
        checkedAt: this.now(),
      };
    } catch (error) {
      this.last = {
        state: "error",
        canInstall: false,
        checkedAt: this.now(),
        message: readableError(error),
      };
    } finally {
      if (timer !== undefined) this.cancelTimeout(timer);
    }
    return this.status();
  }

  private async performInstall(release: ReleaseUpdate): Promise<UpdateStatus> {
    this.last = {
      ...this.last,
      state: "downloading",
      canInstall: false,
      message: undefined,
    };
    try {
      await (this.options.installRelease ?? installRelease)(
        release,
        this.options.addonId,
      );
      this.pendingRelease = null;
      this.last = {
        state: "ready",
        canInstall: false,
        availableVersion: release.version,
        restartRequired: true,
        checkedAt: this.now(),
      };
    } catch (error) {
      this.last = {
        ...this.last,
        state: "error",
        canInstall: true,
        checkedAt: this.now(),
        message: readableError(error),
      };
    }
    return this.status();
  }

  private cancelBackgroundCheck(): void {
    if (this.backgroundTimer !== null) this.cancelTimeout(this.backgroundTimer);
    this.backgroundTimer = null;
  }

  private scheduleBackgroundCheck(delay: number): void {
    if (!this.started || !this.options.getAutoUpdate()) return;
    this.backgroundTimer = this.scheduleTimeout(() => {
      this.backgroundTimer = null;
      void this.check().finally(() => {
        this.cancelBackgroundCheck();
        this.scheduleBackgroundCheck(6 * 60 * 60_000);
      });
    }, delay);
  }
}

function readableError(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : String(error);
}
