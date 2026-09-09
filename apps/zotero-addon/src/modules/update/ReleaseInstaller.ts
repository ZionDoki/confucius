import { compareVersions, type ReleaseUpdate } from "./GitHubRelease";
import { cancelUpdateTimeout, scheduleUpdateTimeout } from "./UpdateTimer";

interface InstallListener {
  onInstallEnded(): void;
  onInstallPostponed(): void;
  onInstallFailed(): void;
  onInstallCancelled(): void;
}

export interface PackageInstall {
  addon?: { id: string; version: string; isCompatible?: boolean };
  error?: number;
  install(): Promise<unknown> | unknown;
  cancel(): void;
  addListener(listener: InstallListener): void;
  removeListener(listener: InstallListener): void;
}

export interface ReleaseInstallResult {
  restartRequired: boolean;
}

export interface InstallerRuntime {
  download(url: string): Promise<Uint8Array>;
  createTempFile(): Promise<string>;
  write(path: string, bytes: Uint8Array): Promise<unknown>;
  digest(path: string): Promise<string>;
  remove(path: string): Promise<unknown>;
  prepare(path: string): Promise<PackageInstall | null>;
  scheduleTimeout(callback: () => void, delay: number): unknown;
  cancelTimeout(timer: unknown): void;
}

/** Download and verify our package; Zotero only performs the final XPI install. */
export async function installRelease(
  release: ReleaseUpdate,
  addonId: string,
  runtime: InstallerRuntime = zoteroRuntime,
): Promise<ReleaseInstallResult> {
  const bytes = await runtime.download(release.downloadURL);
  if (bytes.byteLength !== release.size)
    throw new Error("The downloaded update is incomplete. Please try again.");
  const path = await runtime.createTempFile();
  try {
    await runtime.write(path, bytes);
    if (`sha256:${await runtime.digest(path)}` !== release.digest)
      throw new Error(
        "The update checksum does not match. Please download it again.",
      );
    const install = await runtime.prepare(path);
    if (!install) throw new Error("Zotero could not open the update package.");
    if (
      install.error ||
      install.addon?.id !== addonId ||
      compareVersions(install.addon.version, release.version) !== 0 ||
      install.addon.isCompatible === false
    ) {
      install.cancel();
      throw new Error(
        "The update package has the wrong identity, version, or Zotero compatibility.",
      );
    }
    return await new Promise<ReleaseInstallResult>((resolve, reject) => {
      let settled = false;
      let installation: Promise<unknown>;
      const finish = (result?: ReleaseInstallResult, error?: Error): void => {
        if (settled) return;
        settled = true;
        runtime.cancelTimeout(timer);
        install.removeListener(listener);
        if (error) {
          try {
            install.cancel();
          } catch {
            /* Already failed/cancelled. */
          }
          reject(error);
        } else resolve(result!);
      };
      const fail = (error: unknown) =>
        finish(
          undefined,
          error instanceof Error ? error : new Error(String(error)),
        );
      const listener: InstallListener = {
        // Gecko's install promise also waits for the new bootstrap startup.
        // The event alone can arrive before that startup has completed.
        onInstallEnded: () => {
          void Promise.resolve()
            .then(() => installation)
            .then(() => finish({ restartRequired: false }), fail);
        },
        onInstallPostponed: () => finish({ restartRequired: true }),
        onInstallFailed: () =>
          fail(
            new Error(
              `Zotero could not install the update (${install.error ?? "unknown error"}).`,
            ),
          ),
        onInstallCancelled: () =>
          fail(new Error("Update installation was cancelled.")),
      };
      const timer = runtime.scheduleTimeout(
        () =>
          fail(new Error("Update installation timed out. Please try again.")),
        60_000,
      );
      install.addListener(listener);
      try {
        installation = Promise.resolve(install.install());
        void installation.catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  } finally {
    await runtime.remove(path);
  }
}

const zoteroRuntime: InstallerRuntime = {
  async download(url) {
    const result = await Zotero.HTTP.request("GET", url, {
      responseType: "arraybuffer",
      headers: {
        Accept: "application/octet-stream",
        "Cache-Control": "no-cache",
      },
      timeout: 120_000,
    });
    return new Uint8Array(result.response);
  },
  async createTempFile() {
    const file = Services.dirsvc.get("TmpD", Ci.nsIFile);
    file.append("confucius-update.xpi");
    file.createUnique(0, 0o600);
    return file.path;
  },
  write: (path, bytes) => IOUtils.write(path, bytes),
  digest: (path) => IOUtils.computeHexDigest(path, "sha256"),
  remove: (path) => IOUtils.remove(path, { ignoreAbsent: true }),
  async prepare(path) {
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    ) as {
      AddonManager: {
        getInstallForFile(file: nsIFile): Promise<PackageInstall | null>;
      };
    };
    return AddonManager.getInstallForFile(Zotero.File.pathToFile(path));
  },
  scheduleTimeout: scheduleUpdateTimeout,
  cancelTimeout: cancelUpdateTimeout,
};
