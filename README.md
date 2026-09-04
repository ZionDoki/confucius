# Confucius

[Watch the 44-second product film](https://github.com/user-attachments/assets/3a39a858-3aa5-4198-a4b5-4f13002d19e4)

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <strong>Start with the literature. Move the research forward.</strong><br />
  An open-source research agent workspace for Zotero 7+
</p>

<p align="center">
  <a href="https://github.com/ZionDoki/confucius/releases/latest"><img src="https://img.shields.io/github/v/release/ZionDoki/confucius?style=flat-square&label=release" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/Zotero-7%2B-CC2936?style=flat-square" alt="Zotero 7+" />
  <img src="https://img.shields.io/badge/License-AGPL--3.0-171714?style=flat-square" alt="AGPL-3.0" />
</p>

Zotero is excellent at collecting and organizing papers. Confucius helps turn
them into the next piece of research.

Select a paper, a collection, or a passage in the PDF reader to start a deep
read, evidence audit, cross-paper comparison, or synthesis. Results are saved
as research artifacts with citations, revisions, and write-back status, so
they do not disappear into a chat transcript.

[Download the latest release](https://github.com/ZionDoki/confucius/releases/latest)
· [Read the changelog](CHANGELOG.md) · [Build from source](#build-from-source)

## One continuous research loop

```text
Lock sources → Agent analysis → Structured artifact → Review the diff → Write back to Zotero
```

1. **Lock the material.** Start from Zotero papers, collections, saved
   searches, or a reader selection. Use `@` to search the library, or drop
   PDF, Markdown, and TXT files anywhere in the workspace.
2. **Choose the right agent.** Run the built-in Native Runtime or use an
   authenticated Codex or Kimi installation. Once a task starts, changes to
   the live Zotero selection do not alter its locked context.
3. **Keep the result as an artifact.** Deep reads, evidence audits, literature
   maps, triage tables, note drafts, annotation sets, and citation lists appear
   as files in the activity stream and retain revision history.
4. **Write back on your terms.** Notes, highlights, collections, and tags show
   a before/after diff before Zotero is changed. You can accept, edit, or deny
   every write.

## Research work, grounded in your sources

| Starting point                 | Start in one click                                  | Typical result                                               |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------ |
| One paper                      | Deep read, evidence audit, related work, note draft | Claims, methods, evidence, limitations, and source locations |
| Several papers or a collection | Compare, triage, synthesize, map                    | Agreements, disagreements, gaps, and structured tables       |
| A PDF reader selection         | Explain, verify a claim, save an insight            | A note or annotation draft with a page-level citation        |
| PDF, MD, or TXT files          | Read, organize, cross-analyze                       | External material combined with the locked Zotero context    |

The three featured presets—Deep read, Evidence audit, and Synthesis—are
host-orchestrated workflows rather than canned prompts. You can edit the task
brief before sending; Confucius injects that same brief into an isolated
research context and then a fresh delivery context, connected only by a
bounded structured handoff. Each stage exposes only the tools it needs, so
research cannot prematurely generate an artifact and delivery cannot restart
the investigation.

### Read past the abstract

Confucius organizes a paper around its question, method, evidence, and
limitations. Citations can lead back to a Zotero item, PDF page, or reader
selection, which makes checking a claim much faster than searching through the
paper again. A Deep read also prepares highlights, underlines, and grounded
region notes, then requests permission to write them directly into the PDF.
If that write is denied, the report is still delivered without changing the
document.

### Compare papers on the same axes

Put several papers in one task and align their questions, methods, and
evidence. The resulting agreements, disagreements, and gaps can become a
literature map, triage table, or report, then keep evolving through revisions.

### Develop ideas with a trace

Research gaps, methodological limits, and open questions retain their sources.
A later hypothesis or study design can be followed back through that evidence
chain when it is time to challenge or refine it.

### Highlight, draft, and write back

The agent can prepare Zotero notes, annotations, collections, and tag changes.
Each operation waits for review, and a successful write records its source and
artifact revision.

## The activity stream is the workspace

Messages, plans, reasoning, tool calls, approvals, errors, and task state share
one chronological activity stream. Artifacts appear inside it as file blocks;
open one to read the full result, inspect citations and revisions, or prepare a
write-back.

Tasks survive interruptions. Native resumes from a safe checkpoint, while
Codex and Kimi resume with their provider session IDs. A tool call whose result
is unknown is never replayed silently after restart.

## Bring the agent you trust

| Runtime | Best suited for                                       | Integration                   |
| ------- | ----------------------------------------------------- | ----------------------------- |
| Native  | Self-hosted models, OpenAI-compatible APIs, Ollama    | Built-in Confucius agent loop |
| Codex   | Long-running tasks, plans, tools, streaming reasoning | Official Codex App Server     |
| Kimi    | Chinese-language research and ACP workflows           | Official Kimi ACP v1          |

Codex and Kimi run directly through the Zotero add-on. There is no sidecar,
extra port, or Node process for users to start. Confucius searches official
installation directories, PATH, WinGet, and common user locations, and it also
offers an executable picker when automatic discovery is not enough. Login
stays with the official CLI or SDK; Confucius does not copy desktop tokens.

The Native Runtime streams text and reasoning separately and recognizes
`<think>...</think>` in OpenAI-compatible and Ollama responses. An Agent Run
allows up to 128 model steps by default, with a configurable limit.

## Pick up where you left off

Tasks, artifacts, conversation logs, and research memories are persisted
separately. A later task can find previous conclusions, attempted methods, and
research preferences instead of starting with an empty conversation.

- Memories are readable Markdown files under
  `<Zotero data>/confucius/memory/`, ready to inspect, edit, or back up.
- New installs and upgrades default to Review. Memory proposals remain
  editable until they are accepted or rejected.
- Full conversations are append-only logs under
  `<Zotero data>/confucius/logs/`; context compaction never deletes them.
- Research knowledge bases organize papers, notes, insights, methods, and
  discussion outcomes, including editable Markdown mind maps.

## Install

### Install a release

1. Download the latest `.xpi` from
   [Releases](https://github.com/ZionDoki/confucius/releases/latest).
2. In Zotero, open **Tools → Add-ons**.
3. Open the gear menu, choose **Install Add-on From File**, and select the
   downloaded file.
4. Click the Confucius toolbar button to open the workspace.

After installation, open **Confucius Settings → Update** to check immediately
or let Zotero's native updater install future releases automatically.

For the Native Runtime, add a Base URL, model name, and API key under
**Zotero → Settings → Confucius**. A local Ollama endpoint usually needs no API
key. For Codex or Kimi, complete the provider's official login first, then
select that Runtime from the composer.

### Build from source

Node.js 22.8 or newer is required for development.

```bash
git clone https://github.com/ZionDoki/confucius.git
cd confucius
npm install
npm run build --workspace @confucius/zotero-addon
```

The packaged extension is written to:

```text
apps/zotero-addon/.scaffold/build/confucius.xpi
```

For local development:

```bash
npm start
```

This requires a local Zotero 7+ installation.

## Security and data boundaries

- The default Zotero-only profile gives an external Runtime task-scoped Zotero
  read tools and `artifact_upsert`. Shell access and filesystem writes remain
  disabled.
- Workspace capability requires an explicitly selected, normalized directory.
  Commands and file changes still require one-time or session approval.
- Every Zotero write shows a diff before it is committed.
- The local MCP endpoint listens on `127.0.0.1:23119` and requires a Bearer
  token except for `/health`. Its public tools are read-only.
- PDF text, web content, and metadata are treated as untrusted data, never as
  instructions.
- Tasks and memories are stored locally. Whether model requests leave the
  machine depends on the model service or Runtime you select.

## For developers

```text
apps/zotero-addon     Production Zotero 7+ add-on and Runtime Host
packages/protocol     RPC, task, artifact, and event contracts
packages/harness      Native agent loop, model adapters, and permissions
packages/memory       Plain-text memory and conversation logs
packages/zotero-tools Zotero tool catalog and paper text processing
packages/mcp-client   MCP-over-HTTP client
packages/skill-format SKILL.md parser
skills/               Built-in research skill sources
evals/                Reproducible golden traces
apps/agent-sidecar    Legacy protocol-contract fixture; not used by the XPI
```

```bash
npm test        # Unit tests and evaluation traces
npm run verify  # Sync, version, type, and full test checks
npm run build   # Build every workspace
```

The local read-only MCP endpoint is:

```text
http://127.0.0.1:23119/confucius/v1/mcp
```

Requests use the pairing token shown in Settings.

## License

AGPL-3.0-or-later
