# Confucius

[Watch the 44-second product film](https://github.com/user-attachments/assets/3a39a858-3aa5-4198-a4b5-4f13002d19e4)

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/ZionDoki/confucius/releases/latest"><img src="https://img.shields.io/github/v/release/ZionDoki/confucius?style=flat-square&label=release" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/Zotero-7%2B-CC2936?style=flat-square" alt="Zotero 7+" />
  <img src="https://img.shields.io/badge/License-AGPL--3.0-171714?style=flat-square" alt="AGPL-3.0" />
</p>

Confucius is an open-source research workspace for Zotero 7 and later. It lets
a model read papers, collections, PDF selections, and local text files in
Zotero.

[Download the latest release](https://github.com/ZionDoki/confucius/releases/latest)
· [Changelog](CHANGELOG.md) · [Build from source](#build-from-source)

## Features

- Read one paper or compare several papers.
- Check claims against passages, figures, and annotations.
- Create notes, reports, literature maps, triage tables, and PDF annotations.
- Review a diff before notes, annotations, collections, or tags are written to
  Zotero.
- Resume tasks and search saved research memory.
- Use an OpenAI-compatible endpoint, Ollama, Codex, or Kimi.

You can start from the Zotero item menu, the PDF reader selection menu, or the
Confucius workspace. Type `@` to add papers, type `/` to choose a task, or drop
PDF, Markdown, and TXT files into the workspace.

Task results appear as files in the activity view. Each file keeps its revision
history and citations. Ordinary replies remain in the activity view.

## Runtimes

| Runtime | Connection                        |
| ------- | --------------------------------- |
| Native  | OpenAI-compatible API or Ollama   |
| Codex   | Installed Codex CLI and its login |
| Kimi    | Installed Kimi CLI and its login  |

Codex and Kimi run through the Zotero add-on. Leave their executable paths
empty to use automatic detection, or choose the executable in Settings. Detection covers common macOS,
Windows, and Linux installations, including Homebrew, npm, nvm/fnm, uv/pipx,
and the Codex desktop app. Refresh after installing or signing in. Codex npm
entry points resolve to their packaged native binary without requiring Node
inside Zotero. See [runtime discovery](docs/runtime-discovery.md) for supported
layouts and troubleshooting.

The Native runtime supports streamed text and separate reasoning output. The
model-step limit is configurable and defaults to 128.

## Install

1. Download `confucius.xpi` from the
   [latest release](https://github.com/ZionDoki/confucius/releases/latest).
2. In Zotero, open **Tools → Add-ons**.
3. Open the gear menu and choose **Install Add-on From File**.
4. Select `confucius.xpi`, then use the Confucius toolbar button.

Zotero can install later releases from **Confucius Settings → Update**.

For the Native runtime, add a Base URL, model name, and API key under
**Zotero → Settings → Confucius**. A local Ollama endpoint usually does not need
an API key. For Codex or Kimi, sign in with the provider's CLI before selecting
that runtime.

## Files and data

- Tasks, files, and conversations are stored under the Zotero data directory.
- Research memories are Markdown files under
  `<Zotero data>/confucius/memory/`.
- Conversation logs are stored under `<Zotero data>/confucius/logs/`.
- Model requests follow the data policy of the endpoint or runtime you choose.

New installations use Review mode for memory. You can edit, accept, or reject a
memory before it is saved. Auto and Off modes are available in Settings.

## Permissions

- External runtimes receive Zotero read tools and `artifact_upsert` by default.
- Shell commands and general file writes require a selected working directory.
- Zotero writes show their proposed changes and require approval.
- The local MCP endpoint listens on `127.0.0.1:23119` and requires the pairing
  token shown in Settings. `/health` is the only unauthenticated route.
- PDF text, web content, and metadata are handled as data, not instructions.

## Build from source

Development requires Node.js 22.8 or later and Zotero 7 or later.

```bash
git clone https://github.com/ZionDoki/confucius.git
cd confucius
npm install
npm run build --workspace @confucius/zotero-addon
```

The XPI is written to:

```text
apps/zotero-addon/.scaffold/build/confucius.xpi
```

Start the development build with:

```bash
npm start
```

This works from the repository root or `apps/zotero-addon`. Startup locates
Zotero in macOS system/user Applications, common Windows install directories
and App Paths registrations, or Linux PATH, system/user installs and extracted
archives. The terminal prints the selected executable.

An `.env` file is optional. For a custom installation, copy
`apps/zotero-addon/.env.example` to `.env` in the same directory and set
`ZOTERO_PLUGIN_ZOTERO_BIN_PATH`; leave it empty for automatic detection. Shell
environment values take precedence over `.env`. An invalid explicit path
produces an actionable error. Building and releasing do not require Zotero.

## Repository layout

```text
apps/zotero-addon     Zotero add-on and runtime host
packages/protocol     RPC, task, artifact, and event types
packages/harness      Native agent loop, model adapters, and permissions
packages/memory       Markdown memory and conversation logs
packages/zotero-tools Zotero tools and paper-text processing
packages/mcp-client   MCP-over-HTTP client
packages/skill-format SKILL.md parser
skills/               Built-in skill sources
evals/                Test traces
apps/agent-sidecar    Legacy protocol fixture; not included in the XPI
```

Useful commands:

```bash
npm test
npm run typecheck
npm run verify
npm run build
```

The local read-only MCP endpoint is:

```text
http://127.0.0.1:23119/confucius/v1/mcp
```

## License

AGPL-3.0-or-later
