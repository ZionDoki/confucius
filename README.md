# Confucius

Native research agent for Zotero.

Confucius is a sibling of Paper Chat. The agent loop runs inside Zotero.

## What it does

- **Timeline workspace** (not chat bubbles): tools, JSON results, approvals
- **Library**: search, collections, notes, tags, saved searches, PDF outline/pages/sections
- **Reading & annotation**: paper deep-reading skills, highlight proposals, annotation commits — writes wait in the Review column
- **Persistent memory**: a Mem0-inspired, plain-text long-term memory that survives restarts (see below)
- **Conversation logs**: full transcripts kept as searchable files; repeated retrieval promotes a log excerpt into memory, and hot memories are pinned into the system prompt
- **Research knowledge base**: visible topics that organize literature, notes, insights, attempted methods, discussion results, and editable Markdown mind maps
- **Conversation continuity**: sessions replay their history and compact against the model's context window
- **Streaming**: replies and reasoning stream live into the timeline
- **Plan mode**: a read-only mode for investigating before committing to writes
- **Skills**: Paper Deep Reading, Claim Evidence Audit, Related Work Map, Library Triage, Annotation Pass, Mind Map, Research Knowledge Base
- **MCP**: read-only server at `http://127.0.0.1:23119/confucius/v1/mcp` (Bearer pairing token), plus optional extra MCP servers configured as JSON in prefs

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

## Persistent memory

Confucius remembers durable facts about you and your research across sessions. Storage is plain text under `<Zotero data>/confucius/memory/`: one markdown file per memory plus a regenerated `MEMORY.md` index. Files are the only source of truth — open, edit, or delete them in any editor.

Like [Mem0](https://github.com/mem0ai/mem0), an extraction pass after each turn decides what to add, update, or delete. Unlike Mem0:

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
apps/zotero-addon     the production host (Zotero 7+)
skills/               skill definitions (source of truth, bundled at build)
evals/                golden traces, executed as tests
scripts/              sync-skills, version check
```

```bash
npm test        # unit tests + eval traces (also syncs generated skills)
npm run verify  # drift + version checks + typecheck + tests
npm run build   # all workspaces; xpi lands in apps/zotero-addon/.scaffold/build
```

## Security notes

- The HTTP bridge listens on `127.0.0.1:23119` and requires the pairing token (Authorization header) on everything except `/health`.
- Write tools always require approval unless you granted "always"; MCP tools are always gated.
- PDF and web text is treated as untrusted data, never as instructions.

## License

AGPL-3.0-or-later
