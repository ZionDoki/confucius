# Updates

English · [简体中文](updates.zh-CN.md)

[User guide](README.md)

## Install an update

1. Open **Confucius Settings → Update** and check for updates.
2. Review the offered version and choose **Download and install**.
3. Follow the displayed result: some updates take effect immediately, while a
   staged installation may require restarting Zotero.

Confucius checks versions and verifies packages itself. Zotero's global automatic
update switch does not disable Confucius's manual check.

## Stable or Beta?

| Setting                  | Versions offered                             |
| ------------------------ | -------------------------------------------- |
| Include prereleases: off | Stable releases only                         |
| Include prereleases: on  | Stable and Beta releases, whichever is newer |

Turning Betas off never downgrades an installed Beta. A stable release is newer
than a Beta with the same base version. Your explicit channel choice survives
restart and upgrade.

**Automatic checks** is independent: when enabled, checking starts about 30 seconds
after launch and repeats every six hours. Installation still needs your click.

## If updating fails

| Problem                                     | Next step                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| Network or rate-limit error                 | Retry later.                                                                       |
| “has no Confucius installation package yet” | The release metadata lacks an available XPI; retry later without uninstalling.     |
| Verification failed                         | Keep the current installation and retry with a valid package.                      |
| Version display looks old                   | Close and reopen the entire Confucius workspace; restart Zotero if still required. |

For an old installation without this updater, install an XPI through Zotero's
add-on manager. [Installation steps](../README.md#install).

## Documentation versus installed version

The repository guides describe the current code. Unreleased work can therefore
appear here before an installed stable release has it. Check the version shown
in Settings and the [release notes](../CHANGELOG.md).

Before changing versions, [back up your data](tasks-and-data.md). A successful build
or installation does not by itself prove that every migration or platform has
been tested.
