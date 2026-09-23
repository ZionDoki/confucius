# Confucius

[Watch the product film](https://github.com/user-attachments/assets/8cf1175e-d3f9-4c31-b19f-5e3b171456fc)

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/ZionDoki/confucius/releases/latest"><img src="https://img.shields.io/github/v/release/ZionDoki/confucius?style=flat-square&label=release" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/Zotero-7%2B-CC2936?style=flat-square" alt="Zotero 7+" />
  <img src="https://img.shields.io/badge/License-AGPL--3.0-171714?style=flat-square" alt="AGPL-3.0" />
</p>

**Confucius is an open-source research assistant for Zotero 7 and later.**
Start with a research question: discover papers through **OpenAlex**, select
relevant candidates, obtain available full text, and read or compare the evidence
in the same conversation. Your Zotero library, PDF selections, and local files
can join the research at any point.

[Download the latest stable release](https://github.com/ZionDoki/confucius/releases/latest)
· [User guide](docs/README.md) · [Changelog](CHANGELOG.md) · [Build from source](#build-from-source)

**New in [0.5.0](https://github.com/ZionDoki/confucius/releases/tag/v0.5.0):**
OpenAlex discovery, a shared literature capsule, and up to three research subagents
with a centered trace viewer. Continue with abstracts or currently available papers,
keep conversations grouped by their creation sources, and customize model reasoning
with optional models.dev reference metadata. Stable and Beta installations can
receive this stable release through Confucius Settings → Update.

## Features

- Search OpenAlex from a research question, with year and open-access filters.
- Keep the full search pool separate from selected candidates; review before
  saving papers to Zotero and downloading available PDFs.
- Delegate focused reading or method comparisons to research subagents, then
  bring their findings and evidence back into the conversation.

- Read one paper or compare several papers.
- Check claims against passages, figures, and annotations.
- Create notes, reports, literature maps, triage tables, and PDF annotations.
- Review a diff before notes, annotations, collections, or tags are written to
  Zotero.
- Resume tasks and search saved research memory.
- Use an OpenAI-compatible endpoint, Ollama, Codex, or Kimi.

You can start from the Zotero item menu, the PDF reader selection menu, or the
Confucius workspace. A new task needs no attached paper. Type `@` to add sources, or drop PDF, Markdown,
and TXT files into the workspace. Paper-specific `/` presets appear when compatible
sources are attached and prepare the next request in the current conversation.

Task results appear as files in the activity view. Each file keeps its revision
history and citations. Ordinary replies remain in the activity view.

## Find literature with OpenAlex

> Find papers from the last five years on graph neural networks for molecular
> property prediction. Recommend the most relevant candidates and explain why.

1. Add an **OpenAlex API Key** in Confucius Settings → Runtimes, or in
   Zotero → Settings → Confucius. [Get a key](https://openalex.org/settings/api).
2. Ask your question in the conversation. The Agent searches OpenAlex; a capsule
   above the composer shows candidate and retrieved-paper counts.
3. Review abstracts and selection reasons, check or uncheck candidates, or refine
   the selection in your next prompt. Open the capsule to review the shared list
   without moving your reading position in the conversation.
4. Choose **Review selection → Confirm and acquire full text**. Confucius reuses
   matching Zotero items and valid attachments, then tries open-access PDFs and
   OpenAlex cached PDFs where available.
5. For missing full text, open the paper in your browser, download it using your
   existing access, and drag the PDF onto that paper's target in the card.

OpenAlex retrieval uses Zotero's built-in HTTP client: no additional SDK, browser
extension, or download service is needed. The key stays with the host and is not
sent to the model. Each search page fetches up to 100 records; the deduplicated
pool count is distinct from the API's total hits. Availability, API quotas, and
access rights determine which full texts can be obtained. Reading only an abstract
does not count as reading the full paper. See the [literature research guide](docs/literature-research.md).

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

Install later releases from **Confucius Settings → Update**. Confucius checks
and verifies updates itself. Turn on **Include prereleases** to receive Betas;
turning it off checks stable releases only and never downgrades the installation.
Automatic checks and the Beta preference are saved independently; installation
requires clicking **Download and install**. Older packages using the previous
updater may need a manual XPI installation to get the new updater.

For the Native runtime, add a Base URL, model name, and API key under
**Zotero → Settings → Confucius**. A local Ollama endpoint usually does not need
an API key. For Codex or Kimi, sign in with the provider's CLI before selecting
that runtime.

## Files and data

- Task state, generated files, history, and conversation logs are stored under
  the local Zotero profile's `confucius/runtime-v1/`. Settings shows the actual path.
- Research memories are Markdown files under
  `<Zotero data>/confucius/memory/`.
- Zotero manages native notes, annotations, and attachments in its library.
- Model requests follow the data policy of the endpoint or runtime you choose.

New installations use Review mode for memory. You can edit, accept, or reject a
memory before it is saved. Auto and Off modes are available in Settings.

Upgrading from 0.3.x migrates runtime state to the local profile and retains the
old source and backup. Downgrading does not copy new progress back. Back up both
the library and the runtime directory; syncing the library alone does not sync
complete tasks. See [task recovery and data](docs/tasks-and-data.md).

In the Windows acceptance sample, Native lost an early constraint after a long
context and restart; its first paper report also needed a factual correction.
Check important requirements and citations when resuming. WPS Cloud testing
covers local synced-folder IO and recovery from file locks; cloud sync, multiple
devices, and hosting the entire Zotero database there remain unverified.

## Permissions

- External runtimes use scoped Zotero, literature, and research tools, with
  `artifact_upsert` for results. Literature imports and downloads require candidate
  confirmation; subagents cannot approve writes or recursively delegate.
- Shell commands and general file writes require a selected working directory.
- Zotero writes show their proposed changes and require approval.
- The local MCP endpoint uses Zotero's HTTP port (normally `127.0.0.1:23119`) and requires the pairing
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

Use the active Zotero HTTP port if it differs from the default above.
Architecture, release rules, and acceptance records are in the
[maintainer guide](.github/maintainers/README.md).

## License

AGPL-3.0-or-later
