import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UpdateService,
  type AddonInstallListener,
  type AddonManagerFacade,
  type AddonUpdateListener,
  type ManagedAddon,
  type ManagedAddonInstall,
  type UpdateServiceOptions,
} from "./UpdateService";

function fixture(
  updateVersion?: string,
  options: Partial<UpdateServiceOptions> = {},
) {
  let installListener: AddonInstallListener | undefined;
  let installStarted = 0;
  const install: ManagedAddonInstall = {
    version: updateVersion,
    addListener(listener) {
      installListener = listener;
    },
    removeListener(listener) {
      if (installListener === listener) installListener = undefined;
    },
    install() {
      installStarted += 1;
      installListener?.onDownloadStarted?.(install);
      installListener?.onDownloadEnded?.(install);
      installListener?.onInstallStarted?.(install);
      installListener?.onInstallEnded?.(install);
    },
  };
  const addon: ManagedAddon = {
    id: "confucius@zotero.plugin",
    version: "0.3.5",
    applyBackgroundUpdates: 1,
    findUpdates(listener: AddonUpdateListener) {
      if (updateVersion) listener.onUpdateAvailable?.(addon, install);
      else listener.onNoUpdateAvailable?.(addon);
      listener.onUpdateFinished?.(addon, 0);
    },
  };
  const manager: AddonManagerFacade = {
    UPDATE_WHEN_USER_REQUESTED: 7,
    AUTOUPDATE_DISABLE: 0,
    AUTOUPDATE_ENABLE: 2,
    getAddonByID: async () => addon,
    shouldAutoUpdate: (item) => item.applyBackgroundUpdates !== 0,
  };
  const service = new UpdateService({
    addonId: addon.id,
    currentVersion: addon.version,
    loadAddonManager: () => manager,
    now: () => 1234,
    ...options,
  });
  return {
    addon,
    install,
    manager,
    service,
    installStarted: () => installStarted,
  };
}

describe("UpdateService", () => {
  it("reports the installed version and native automatic-update state", async () => {
    const { service } = fixture();
    const status = await service.status();
    assert.equal(status.currentVersion, "0.3.5");
    assert.equal(status.autoUpdate, true);
    assert.equal(status.state, "idle");
  });

  it("checks, downloads, and stages an available signed update", async () => {
    const { service, installStarted } = fixture("0.3.6");
    const available = await service.check();
    assert.equal(available.state, "available");
    assert.equal(available.availableVersion, "0.3.6");
    assert.equal(available.canInstall, true);

    const ready = await service.install();
    assert.equal(installStarted(), 1);
    assert.equal(ready.state, "ready");
    assert.equal(ready.restartRequired, true);
    assert.equal(ready.availableVersion, "0.3.6");
  });

  it("reports an up-to-date result when no update is offered", async () => {
    const { service } = fixture();
    const status = await service.check();
    assert.equal(status.state, "up-to-date");
    assert.equal(status.canInstall, false);
    assert.equal(status.checkedAt, 1234);
  });

  it("persists explicit automatic-update enable and disable choices", async () => {
    const { addon, manager, service } = fixture();
    const disabled = await service.setAuto(false);
    assert.equal(addon.applyBackgroundUpdates, manager.AUTOUPDATE_DISABLE);
    assert.equal(disabled.autoUpdate, false);

    const enabled = await service.setAuto(true);
    assert.equal(addon.applyBackgroundUpdates, manager.AUTOUPDATE_ENABLE);
    assert.equal(enabled.autoUpdate, true);
  });

  it("reports an explicit enable even when Zotero's global policy is off", async () => {
    const { manager, service } = fixture();
    manager.shouldAutoUpdate = () => false;

    const enabled = await service.setAuto(true);
    assert.equal(enabled.autoUpdate, true);

    const disabled = await service.setAuto(false);
    assert.equal(disabled.autoUpdate, false);
  });

  it("keeps a failed check visible instead of throwing through the UI", async () => {
    const { addon, service } = fixture();
    addon.findUpdates = () => {
      throw new Error("network unavailable");
    };
    const status = await service.check();
    assert.equal(status.state, "error");
    assert.match(status.message ?? "", /network unavailable/);
  });

  it("times out when Zotero never completes an update check callback", async () => {
    const { addon, service } = fixture(undefined, { checkTimeoutMs: 5 });
    addon.findUpdates = () => undefined;
    const status = await service.check();
    assert.equal(status.state, "error");
    assert.equal(status.canInstall, false);
    assert.match(status.message ?? "", /check timed out/i);
  });

  it("times out and preserves retryability when an install callback stalls", async () => {
    const { install, service } = fixture("0.3.6", { installTimeoutMs: 5 });
    await service.check();
    install.install = () => undefined;
    const status = await service.install();
    assert.equal(status.state, "error");
    assert.equal(status.canInstall, true);
    assert.match(status.message ?? "", /installation timed out/i);
  });
});
