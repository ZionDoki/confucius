# Confucius

Native research agent for Zotero.

Confucius is a research-task workbench embedded in Zotero. Its native agent
loop runs inside Zotero; optional official agent runtimes run through a local
companion process.

## What it does

- **Research tasks and artifacts**: locked source context, resumable work, typed
  artifacts, revision history, citations, and reviewable Zotero write-back
- **Activity stream** (not chat bubbles): plans, reasoning, tools, approvals,
  commands, file diffs, errors, and the conversation audit trail
- **Library**: search, collections, notes, tags, saved searches, PDF outline/pages/sections
- **Reading & annotation**: paper deep-reading skills, highlight proposals, annotation commits — writes wait in the Review column
- **Persistent memory**: off, review-before-save, or automatic extraction into
  a Mem0-inspired plain-text store that survives restarts (see below)
- **Conversation logs**: full transcripts kept as searchable files; repeated retrieval promotes a log excerpt into memory, and hot memories are pinned into the system prompt
- **Research knowledge base**: visible topics that organize literature, notes, insights, attempted methods, discussion results, and editable Markdown mind maps
- **Conversation continuity**: sessions replay their history and compact against the model's context window
- **Streaming**: replies and reasoning stream live into the timeline
- **Plan mode**: a read-only mode for investigating before committing to writes
- **Skills**: Paper Deep Reading, Claim Evidence Audit, Related Work Map, Library Triage, Annotation Pass, Mind Map, Research Knowledge Base
- **MCP**: read-only server at `http://127.0.0.1:23119/confucius/v1/mcp` (Bearer pairing token), plus optional extra MCP servers configured as JSON in prefs
- **Agent runtimes**: Native, Codex App Server, and Kimi ACP v1 behind one
  task/event/approval model

## Install

```bash
git clone https://github.com/ZionDoki/confucius.git
cd confucius
npm install
npm run build --workspace @confucius/zotero-addon
```

Install `apps/zotero-addon/.scaffold/build/confucius.xpi` from Zotero → Tools → Add-ons → Install Add-on From File.

For development: `npm start` in `apps/zotero-addon` (needs a local Zotero 7+ binary).

Then: Settings → Confucius → set **Base URL** and **Model**. Add an **API key**
for hosted OpenAI-compatible endpoints; local Ollama does not require one.
Copy the pairing token if you want to call the local MCP or HTTP API.

Open the workspace from the Confucius toolbar button.

### Optional agent sidecar

Codex and Kimi tasks use the repository-owned Node sidecar. Start it
separately; the Zotero add-on discovers it but never launches it:

```bash
npm run sidecar
```

The sidecar uses each provider's official CLI/SDK login state. Log in with the
provider's own command before selecting that Runtime in Confucius; Confucius
does not read or copy desktop-app tokens. By default, external tasks receive
only task-scoped Zotero/MCP capabilities in an isolated empty directory. A
real working directory, shell command, or file change requires explicit
workspace selection and approval.

## Persistent memory

Confucius remembers durable facts about you and your research across sessions. Storage is plain text under `<Zotero data>/confucius/memory/`: one markdown file per memory plus a regenerated `MEMORY.md` index. Files are the only source of truth — open, edit, or delete them in any editor.

Like [Mem0](https://github.com/mem0ai/mem0), an extraction pass after each turn
can propose what to add, update, or delete. New installs and upgrades default
to **Review**, so candidates remain editable and are not saved until accepted.
Unlike Mem0:

|           | Mem0                  | Confucius                                                           |
| --------- | --------------------- | ------------------------------------------------------------------- |
| Storage   | vector store (opaque) | markdown files, human-auditable                                     |
| Retrieval | embeddings            | BM25 + CJK bigrams, recency decay, access reinforcement, confidence |
| Updates   | overwrite             | in-file revision history                                            |
| Dedupe    | embeddings            | lexical Jaccard pre-check (no extra model calls)                    |

Relevant memories are injected into the system prompt automatically, and the agent can call `memory_search` / `memory_save` / `memory_update` / `memory_delete` directly. Turn the automatic extraction off in Settings → Confucius if you prefer fully manual memory.

Every session also writes an append-only markdown log under `<Zotero data>/confucius/logs/`. In-context compaction never deletes those files. The agent searches them with `conversation_log_search`; a hook on every log/memory tool call counts retrievals. Excerpts hit several times become durable memories, and memories hit often enough are pinned so they stay in the prompt. Compaction itself is sized from the active endpoint's context window (reserving system prompt, tools, and output tokens) rather than a fixed character cap.

Research knowledge bases use the same auditable Markdown store. Open the tree
icon in the workspace to create a topic, search and filter its entries, edit
paper links and notes, or maintain a collapsible mind map from Markdown
headings and indented lists. The agent queries these topics before writing so
continuing research stays connected instead of becoming duplicate summaries.

## Layout

```
packages/protocol     wire types: RPC methods, tool catalog, events
packages/harness      model-agnostic agent loop, adapters, permissions
packages/memory       plain-text persistent memory (Mem0-inspired)
packages/skill-format SKILL.md frontmatter parser
packages/mcp-client   MCP-over-HTTP client
packages/zotero-tools tool catalog + paper text/regex utilities
apps/agent-sidecar     Codex App Server and Kimi ACP bridge
apps/zotero-addon     the production host (Zotero 7+)
skills/               skill definitions (source of truth, bundled at build)
evals/                golden traces, executed as tests
scripts/              sync-skills, version check
```

```bash
npm test        # unit tests + eval traces (also syncs generated skills)
npm run verify  # drift + version checks + typecheck + tests
npm run build   # all workspaces; xpi lands in apps/zotero-addon/.scaffold/build
npm run sidecar # optional local bridge for external agent runtimes
```

## Security notes

- The HTTP bridge listens on `127.0.0.1:23119` and requires the pairing token (Authorization header) on everything except `/health`.
- Public MCP exposes read-only Zotero tools. Task-scoped sidecar MCP adds
  `artifact_upsert`; Zotero writes still return to the add-on for diff review
  and approval.
- Shell and filesystem writes are disabled in the default Zotero-only profile.
  Workspace capability must name a normalized directory and be confirmed.
- PDF and web text is treated as untrusted data, never as instructions.

## License

AGPL-3.0-or-later
