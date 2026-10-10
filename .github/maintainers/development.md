# Development setup

English · [简体中文](development.zh-CN.md)

[Maintainer guide](README.md) · [User guide](../../docs/README.md)

## Build your first XPI

Install Node.js **22.8+**. Zotero **7+** is needed for preview, not for building.

```sh
git clone https://github.com/ZionDoki/confucius.git
cd confucius
npm install
npm run build
```

The add-on is `apps/zotero-addon/.scaffold/build/confucius.xpi`.
A local build is not a published release.

## Preview in Zotero

Run `npm start` from the repository root or `apps/zotero-addon`.
The terminal reports the Zotero executable selected for the development workspace.
Click the Confucius toolbar button to open it.

Automatic discovery checks common macOS, Windows and Linux installations.
For a custom path, copy `apps/zotero-addon/.env.example` to `.env` in that
directory and set `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`. Leave it empty for detection.
Shell environment values override `.env`; an invalid explicit path produces an error.

Use an isolated development profile for tests that create or modify library data.

## Before changing code

Read [AGENTS.md](../../AGENTS.md). For UI changes, also read
[the shared design rules](../../docs/design.md).
For versions, changelogs or releases, follow [release rules](releases.md).

| Command                     | Purpose                                            |
| --------------------------- | -------------------------------------------------- |
| `npm test`                  | Synchronize bundled skills and run workspace tests |
| `npm run typecheck`         | Check TypeScript                                   |
| `npm run lint`              | Check formatting and lint where configured         |
| `npm run build`             | Build the add-on and check its types               |
| `npm run sync-skills:check` | Detect stale bundled skill copies                  |
| `npm run versions:check`    | Check version consistency                          |

Code changes require tests and type checking. A build or unit test cannot replace
a real Zotero, platform, model or upgrade check; report what was actually run.

## Repository map

| Path                    | Responsibility                                              |
| ----------------------- | ----------------------------------------------------------- |
| `apps/zotero-addon`     | UI, host, native Zotero tools and external runtime adapters |
| `packages/protocol`     | Shared types, schemas and instructions                      |
| `packages/harness`      | Native loop, context windows, budgets and permissions       |
| `packages/memory`       | Markdown memory, history, retrieval and retention           |
| `packages/zotero-tools` | Tool catalogue and paper-text processing                    |
| `packages/mcp-client`   | MCP-over-HTTP client                                        |
| `packages/skill-format` | Skill parser                                                |
| `skills`                | Built-in skill source files                                 |
| `evals`                 | Scripted harness fixtures                                   |
| `apps/agent-sidecar`    | Legacy protocol fixture; not shipped in the XPI             |

## Optional integrations

The local read-only MCP endpoint is normally
`http://127.0.0.1:23119/confucius/v1/mcp`; use Zotero's active HTTP port.
Authenticated routes require the pairing token in Settings; only `/health` is
unauthenticated. Do not put tokens in examples or committed files.

External runtime shell/file tools require an explicitly selected working
directory. Zotero writes remain governed by host permissions and review.
See [runtime contracts](runtime.md).

Keep traces, machine paths and test libraries under ignored `output/`.
Follow the [documentation rules](documentation.md) when updating guides.
