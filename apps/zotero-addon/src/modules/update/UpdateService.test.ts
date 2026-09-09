import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { UpdateService, type UpdateServiceOptions } from "./UpdateService";
import {
  compareVersions,
  selectUpdate,
  type ReleaseUpdate,
} from "./GitHubRelease";
import {
  installRelease,
  type InstallerRuntime,
  type PackageInstall,
} from "./ReleaseInstaller";

const digest = "a".repeat(64);
function release(version = "0.3.8") {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes("-"),
    assets: [
      {
        name: "confucius.xpi",
        state: "uploaded",
        url: "https://api.github.com/repos/ZionDoki/confucius/releases/assets/123",
        digest: `sha256:${digest}`,
        size: 3,
      },
    ],
  };
}
function fixture(options: Partial<UpdateServiceOptions> = {}) {
  let auto = true,
    prerelease = false,
    requests = 0,
    installs = 0;
  const service = new UpdateService({
    addonId: "confucius@zotero.plugin",
    currentVersion: "0.3.6",
    getAutoUpdate: () => auto,
    setAutoUpdate: (enabled) => {
      auto = enabled;
    },
    getIncludePrerelease: () => prerelease,
    setIncludePrerelease: (enabled) => {
      prerelease = enabled;
    },
    loadReleases: async () => {
      requests++;
      return [release("0.4.0-beta.1"), release()];
    },
    installRelease: async (update, id) => {
      assert.equal(id, "confucius@zotero.plugin");
      assert.equal(update.version, "0.3.8");
      installs++;
      return { restartRequired: false };
    },
    now: () => 1234,
    ...options,
  });
  return { service, requests: () => requests, installs: () => installs };
}

describe("release selection", () => {
  it("orders numeric versions and SemVer prereleases", () => {
    const ordered = [
      "0.3.9",
      "0.3.10",
      "0.4.0-alpha",
      "0.4.0-beta.2",
      "0.4.0-beta.10",
      "0.4.0-rc.1",
      "0.4.0",
      "0.10.0",
      "1.0.0",
    ];
    for (let i = 1; i < ordered.length; i++)
      assert.ok(compareVersions(ordered[i], ordered[i - 1]) > 0);
    assert.equal(compareVersions("v0.3.8+build.1", "0.3.8"), 0);
    assert.throws(
      () => compareVersions("banana", "0.3.8"),
      /Invalid release version/,
    );
  });
  it("selects the newest eligible version regardless of release ordering", () => {
    const releases = [release("0.3.7"), release("0.4.0-beta.1"), release()];
    assert.equal(selectUpdate(releases, "0.3.6", false)?.version, "0.3.8");
    assert.equal(
      selectUpdate(releases, "0.3.6", true)?.version,
      "0.4.0-beta.1",
    );
    assert.equal(selectUpdate(releases, "0.4.0-beta.1", false), null);
    assert.equal(selectUpdate(releases, "0.4.0-beta.1", true), null);
    assert.equal(
      selectUpdate([release("0.4.0")], "0.4.0-beta.1", true)?.version,
      "0.4.0",
    );
  });
  it("ignores drafts and prerelease tags even if GitHub's prerelease flag is wrong", () => {
    assert.equal(
      selectUpdate(
        [
          { ...release("9.0.0"), draft: true },
          { ...release("0.4.0-beta.1"), prerelease: false },
          release(),
        ],
        "0.3.8",
        false,
      ),
      null,
    );
  });
  it("never reports malformed, empty, or incomplete releases as up to date", () => {
    for (const value of [{ message: "API rate limit exceeded" }, [], [{}]])
      assert.throws(() => selectUpdate(value, "0.3.6", false));
    assert.throws(
      () => selectUpdate([{ ...release(), assets: [] }], "0.3.6", false),
      /no Confucius installation package/,
    );
    for (const asset of [
      { url: "https://evil.example/confucius.xpi" },
      { digest: null },
      { size: 0 },
    ]) {
      const r = release();
      Object.assign(r.assets[0], asset);
      assert.throws(() => selectUpdate([r], "0.3.6", false));
    }
  });
});

describe("UpdateService", () => {
  it("reports its own preference and version without consulting Zotero's updater", async () => {
    const { service } = fixture();
    assert.deepEqual(await service.status(), {
      currentVersion: "0.3.6",
      autoUpdate: true,
      includePrerelease: false,
      state: "idle",
      canInstall: false,
    });
    assert.equal((await service.setAuto(false)).autoUpdate, false);
    assert.equal((await service.setAuto(true)).autoUpdate, true);
  });
  it("discovers and installs updates with an explicit install action", async () => {
    const { service, requests, installs } = fixture();
    const first = service.check();
    assert.equal(service.check(), first);
    const status = await first;
    assert.equal(status.state, "available");
    assert.equal(status.availableVersion, "0.3.8");
    assert.equal(installs(), 0);
    const ready = await service.install();
    assert.equal(ready.state, "ready");
    assert.equal(ready.restartRequired, false);
    assert.equal(ready.currentVersion, "0.3.8");
    await service.check();
    await service.install();
    assert.equal(requests(), 3);
    assert.equal(installs(), 1);
  });
  it("a new hot-updated host reports the applied version and can check for the next update or change channel", async () => {
    const { service } = fixture();
    service.start(true);
    const applied = await service.status();
    assert.equal(applied.state, "ready");
    assert.equal(applied.currentVersion, "0.3.6");
    assert.equal(applied.availableVersion, "0.3.6");
    assert.equal(applied.restartRequired, false);
    assert.equal((await service.setPrerelease(true)).includePrerelease, true);
    assert.equal((await service.check()).canInstall, true);
    service.dispose();
  });
  it("keeps the running version when Zotero stages an update for restart", async () => {
    const { service } = fixture({
      installRelease: async () => ({ restartRequired: true }),
    });
    const ready = await service.install();
    assert.equal(ready.state, "ready");
    assert.equal(ready.restartRequired, true);
    assert.equal(ready.currentVersion, "0.3.6");
    assert.equal(ready.availableVersion, "0.3.8");
  });
  it("checks before installing when no prior check exists", async () => {
    const { service, requests, installs } = fixture();
    assert.equal((await service.install()).state, "ready");
    assert.equal(requests(), 1);
    assert.equal(installs(), 1);
  });
  it("reports up to date only after successfully comparing release versions", async () => {
    const { service } = fixture({ currentVersion: "0.3.8" });
    const status = await service.check();
    assert.equal(status.state, "up-to-date");
    assert.equal(status.canInstall, false);
    assert.equal(status.checkedAt, 1234);
  });
  it("changing the channel immediately discovers prereleases", async () => {
    const { service } = fixture();
    assert.equal(
      (await service.setPrerelease(true)).availableVersion,
      "0.4.0-beta.1",
    );
    assert.equal(
      (await service.setPrerelease(false)).availableVersion,
      "0.3.8",
    );
  });
  it("keeps network and HTTP failures visible and allows a later retry", async () => {
    let failed = true;
    const { service } = fixture({
      loadReleases: async () => {
        if (failed) throw new Error("GitHub HTTP 403: rate limited");
        return [release()];
      },
    });
    const status = await service.check();
    assert.equal(status.state, "error");
    assert.match(status.message ?? "", /HTTP 403/);
    failed = false;
    assert.equal((await service.check()).state, "available");
  });
  it("times out and ignores late release responses", async () => {
    let resolve!: (data: unknown) => void;
    const { service } = fixture({
      checkTimeoutMs: 5,
      loadReleases: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    assert.equal((await service.check()).state, "error");
    resolve([release()]);
    await setImmediate();
    assert.equal((await service.status()).state, "error");
  });
  it("coalesces installs and checks while downloading and preserves retryability", async () => {
    let reject!: (error: Error) => void;
    const { service } = fixture({
      installRelease: () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    });
    await service.check();
    const installing = service.install();
    assert.equal(service.install(), installing);
    assert.equal(service.check(), installing);
    reject(new Error("download failed"));
    const result = await installing;
    assert.equal(result.state, "error");
    assert.equal(result.canInstall, true);
  });
  it("runs its own automatic checks, never installs automatically, and disposes timers", async () => {
    let nextId = 0;
    const timers = new Map<number, { callback: () => void; delay: number }>();
    const { service, requests, installs } = fixture({
      scheduleTimeout: (callback, delay) => {
        const id = ++nextId;
        timers.set(id, { callback, delay });
        return id;
      },
      cancelTimeout: (id) => {
        timers.delete(Number(id));
      },
    });
    service.start();
    service.start();
    assert.equal(timers.size, 1);
    const [id, timer] = [...timers][0];
    assert.equal(timer.delay, 30_000);
    timers.delete(id);
    timer.callback();
    await setImmediate();
    assert.equal(requests(), 1);
    assert.equal(installs(), 0);
    assert.equal([...timers.values()][0].delay, 6 * 60 * 60_000);
    await service.setAuto(false);
    assert.equal(timers.size, 0);
    await service.setAuto(true);
    assert.equal(timers.size, 1);
    service.dispose();
    assert.equal(timers.size, 0);
    await service.check();
    assert.equal(requests(), 1);
  });
  it("does not publish an in-flight background result after shutdown", async () => {
    let resolve!: (data: unknown) => void;
    const { service } = fixture({
      loadReleases: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const checking = service.check();
    service.dispose();
    resolve([release()]);
    assert.equal((await checking).canInstall, false);
  });
});

function installerFixture() {
  const calls: string[] = [];
  let listener: Parameters<PackageInstall["addListener"]>[0];
  const install: PackageInstall = {
    addon: {
      id: "confucius@zotero.plugin",
      version: "0.3.8",
      isCompatible: true,
    },
    install() {
      calls.push("install");
      listener.onInstallEnded();
    },
    cancel() {
      calls.push("cancel");
    },
    addListener(value) {
      listener = value;
    },
    removeListener() {
      calls.push("unlisten");
    },
  };
  const runtime: InstallerRuntime = {
    download: async () => {
      calls.push("download");
      return new Uint8Array([1, 2, 3]);
    },
    createTempFile: async () => "test-update.xpi",
    write: async () => {
      calls.push("write");
    },
    digest: async () => digest,
    remove: async () => {
      calls.push("remove");
    },
    prepare: async () => {
      calls.push("prepare");
      return install;
    },
    scheduleTimeout: (callback, delay) => setTimeout(callback, delay),
    cancelTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const update = selectUpdate([release()], "0.3.6", false) as ReleaseUpdate;
  return {
    calls,
    install,
    runtime,
    update,
    ended: () => listener.onInstallEnded(),
    postponed: () => listener.onInstallPostponed(),
  };
}

describe("release installation", () => {
  it("downloads, verifies and installs the intended package, then removes the temporary file", async () => {
    const { calls, runtime, update } = installerFixture();
    assert.deepEqual(
      await installRelease(update, "confucius@zotero.plugin", runtime),
      {
        restartRequired: false,
      },
    );
    assert.deepEqual(calls, [
      "download",
      "write",
      "prepare",
      "install",
      "unlisten",
      "remove",
    ]);
  });
  it("waits for bootstrap completion after the install-ended event", async () => {
    const { install, runtime, update, ended } = installerFixture();
    let complete!: () => void;
    install.install = () => {
      ended();
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    };
    let settled = false;
    const pending = installRelease(
      update,
      "confucius@zotero.plugin",
      runtime,
    ).then((result) => {
      settled = true;
      return result;
    });
    await setImmediate();
    assert.equal(settled, false);
    complete();
    assert.deepEqual(await pending, { restartRequired: false });
  });
  it("does not report a successful hot update when bootstrap rejects", async () => {
    const { install, runtime, update, ended } = installerFixture();
    install.install = () => {
      ended();
      return Promise.reject(new Error("bootstrap failed"));
    };
    await assert.rejects(
      installRelease(update, "confucius@zotero.plugin", runtime),
      /bootstrap failed/,
    );
  });
  it("reports staged updates without waiting for the deferred install promise", async () => {
    const { install, runtime, update, postponed } = installerFixture();
    install.install = () => {
      postponed();
      return new Promise(() => {});
    };
    assert.deepEqual(
      await installRelease(update, "confucius@zotero.plugin", runtime),
      {
        restartRequired: true,
      },
    );
  });
  it("rejects truncated downloads and checksum mismatches before installation", async () => {
    for (const mismatch of ["size", "digest"]) {
      const { calls, runtime, update } = installerFixture();
      if (mismatch === "size") update.size = 4;
      else update.digest = `sha256:${"b".repeat(64)}`;
      await assert.rejects(
        installRelease(update, "confucius@zotero.plugin", runtime),
        /incomplete|checksum/,
      );
      assert.equal(calls.includes("prepare"), false);
      if (mismatch === "digest") assert.equal(calls.at(-1), "remove");
    }
  });
  it("rejects the wrong plugin, version and compatibility", async () => {
    for (const wrong of [
      { id: "other@plugin" },
      { version: "0.3.9" },
      { isCompatible: false },
    ]) {
      const { calls, install, runtime, update } = installerFixture();
      Object.assign(install.addon!, wrong);
      await assert.rejects(
        installRelease(update, "confucius@zotero.plugin", runtime),
        /identity, version, or Zotero compatibility/,
      );
      assert.equal(calls.includes("install"), false);
      assert.equal(calls.at(-1), "remove");
    }
  });
  it("cancels stalled installs and removes their temporary files", async () => {
    const { calls, install, runtime, update } = installerFixture();
    install.install = () => undefined;
    runtime.scheduleTimeout = (callback) => setTimeout(callback, 5);
    await assert.rejects(
      installRelease(update, "confucius@zotero.plugin", runtime),
      /timed out/,
    );
    assert.ok(calls.includes("cancel"));
    assert.equal(calls.at(-1), "remove");
  });
});
