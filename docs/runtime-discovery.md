# CLI connections

English · [简体中文](runtime-discovery.zh-CN.md)

[User guide](README.md) · [Model setup](model-selection.md)

## Connect Codex or Kimi

1. Install the CLI on the same computer as Zotero and complete its sign-in.
2. Open **Confucius Settings → Runtime**.
3. Leave the executable path empty and click **Check again**.
4. Check the detected path and status, then choose the runtime and model in the composer.

Automatic detection covers common PATH, package-manager and desktop-app layouts
on macOS, Windows and Linux. It does not require Zotero to include Node.js.

## Use a custom installation

Enter the executable's absolute path. Paths with spaces, Chinese characters,
surrounding quotes and `~/` are supported; Windows also supports common path
variables such as `%USERPROFILE%`.

- Windows Codex: an npm `.cmd` launcher can resolve to its packaged native binary.
- Windows Kimi: select the `.exe`.
- macOS/Linux: select a native executable or a supported Kimi Python entry point.
- Shell aliases and a CLI installed only inside WSL are not host executables.

An invalid manual path produces an error instead of silently selecting another
installation. Clear the path to restore automatic detection.

## Troubleshooting

| Status           | Next step                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Unavailable      | Check installation, path and executable permissions; repair missing package dependencies. |
| Sign-in required | Sign in through the CLI, then refresh.                                                    |
| Error            | Check the displayed path/version and the error; update the CLI if needed.                 |

If a terminal can find the CLI but Zotero cannot, supply the full path: graphical
apps may inherit a different PATH. A successful version check does not confirm
model access. For other issues, see [troubleshooting](troubleshooting.md).

Detection tests cover more installation layouts than have been tested on real
machines; support does not imply that every CLI version has passed a live task.
