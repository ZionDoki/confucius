# Changelog

## Unreleased

## 0.3.0 — 2026-09-03

### Research workbench

- Conversations are now recoverable research tasks with a locked Zotero
  context, source-aware templates, clear task states, and explicit controls
  for adding or replacing a changed selection.
- Research outputs are saved as structured, versioned artifacts with Zotero
  citations. Notes, annotations, collections, and tags always show a
  before/after preview before write-back.
- Memory now defaults to review: proposed memories can be edited, accepted,
  or rejected instead of being saved silently.

### Agent runtimes

- Added the local Agent sidecar with Native, Codex App Server, and Kimi ACP
  runtimes. Runtime availability and login state are checked from the real
  runtime session, while a missing sidecar never blocks Native mode.
- External agents receive only task-scoped Zotero and artifact tools by
  default. Shell and file writes stay disabled unless a working directory is
  explicitly selected and approved.
- The Zotero MCP endpoint now supports standard stateless Streamable HTTP and
  a sidecar STDIO proxy.

### Reliability and interface

- Added restart-safe checkpoints, interrupted-task continuation, and
  protection against replaying tool calls whose result is unknown.
- Models that emit `<think>...</think>` now show that content as reasoning
  instead of mixing it into the answer. Duplicate selection-change notices
  and the extra PDF-toolbar button have been removed.

## 0.2.1 — 2026-09-03

### Workspace

- Clicking a markdown literature link now opens the item the same way the
  timeline locate control does (library selection plus the PDF reader when
  there is an attachment). Chrome XHTML was swallowing clicks on
  `zotero://` hrefs; the URI is kept on `data-href` and handled in
  JavaScript.
- Opening the workspace no longer hangs. Privileged chrome cannot parse
  answer HTML with `DOMParser` / `text/html`.

## 0.2.0 — 2026-09-03

### Skills

- Skills are injected with Agent Skills progressive disclosure: the system
  prompt always lists name, description, and triggers; the full `SKILL.md`
  body is loaded when the user types `/slug` or the agent calls the `skill`
  tool.
- Activating a skill no longer replaces the tool list with `allowed-tools`
  (which dropped memory, knowledge-base, and MCP tools). Preferred tools
  stay documented; the rest remain available.
- Skills moved out of the + menu. Type `/` in the composer to pick one with
  arrow keys or the mouse. Extra text after `/slug` is passed through as the
  prompt.

### Breaking

- Removed the Confucius Chrome extension, browser-tab tools, and the
  `/pair` / `/workspace-probe` HTTP endpoints. Confucius is Zotero-only.
  The local MCP/HTTP API and pairing token remain for MCP clients.

## 0.1.2 — 2026-09-02

### Memory, logs, and context

- Conversation transcripts are now kept as searchable markdown files under
  `<Zotero data>/confucius/logs/`. In-context compaction never deletes them.
- New read tools `conversation_log_search` and `conversation_log_read`, plus
  `logs/list|search|read` RPCs, let the agent recover earlier details after a
  thread has been summarized.
- A tool-layer access hook records every log and memory retrieval. Excerpts
  hit several times are promoted into durable memories (`promoted-from-log`);
  memories that keep being retrieved are pinned (`confucius:pinned`) and stay
  in the system prompt.
- History compaction is sized from the active endpoint's context window:
  system prompt, tool schemas, and output tokens are reserved first, then the
  working transcript is compacted at 70% of what remains. The old 80k-character
  cap no longer truncates large windows.
- The memory pane shows pinned and promoted-from-log entries, and a count of
  session logs on disk.
- The Zotero toolbar icon is a toggle in sidebar mode: click to open, click
  again to collapse the pane. Unbound `createXULElement` no longer crashes
  add-on startup, so the icon actually appears.
- The workspace timeline stays on the latest turn after send/poll instead of
  jumping back to the top. Settings has a sticky header close control. The
  send button runs an open slash command instead of submitting `/compact` as
  chat text. Log excerpts shown as memories no longer keep `**user:**` markup.

## 0.1.1 — 2026-09-02

First public preview release.

### Research knowledge base and mind maps

- Visible research topics are stored on top of the plain-Markdown memory
  engine and organize papers, notes, insights, attempted methods, discussion
  results, and editable mind maps.
- Zotero and Chrome both expose an in-plugin knowledge-base window with topic
  and entry search, type filters, paper links, and a live tree preview for
  Markdown heading/bullet outlines.
- New `mind-map` and `research-knowledge-base` skills teach the agent to query
  before writing, preserve evidence links, and update existing research state
  instead of creating duplicates.
- Six approval-aware knowledge-base tools and nine RPC methods let the agent
  efficiently create, update, retrieve, search, and organize durable topics.

### Workspace and tool reliability

- The sidebar is now the default layout; sidebar/window modes are mutually
  exclusive, and compact icon controls replace framed layout/settings buttons.
- Responsive layouts remain usable down to 250 px and switch the knowledge
  workspace to a readable single-column flow at narrow widths.
- Write approvals are emitted before execution and automatically reveal the
  review pane. Local-path and HTTP(S) attachments are both supported.
- Chrome can inject its tab extractor on demand for ordinary sites outside
  the predeclared literature domains and reports restricted pages cleanly.
- Clearing a paper source, or changing a paper entry to another type, now
  removes the hidden Zotero link instead of silently retaining it.
- Note search merges recent database writes with Zotero's eventual index, and
  DOI imports fall back to CSL metadata when the translator chain returns no
  items.
- The live Zotero matrix exercises all 60 built-in tools, including PDF text,
  real highlights and annotation coordinates, attachments, memory, and the
  research knowledge base.

### Persistent memory (new)

- Plain-text long-term memory inspired by Mem0, stored as one markdown file
  per memory under `<Zotero data>/confucius/memory/`, with a regenerated
  `MEMORY.md` index. Files are the only source of truth — audit or hand-edit
  them in any editor; the store tolerates corrupt files.
- Embedding-free retrieval: BM25 with CJK character bigrams fused with
  recency decay (30-day half-life), access reinforcement, extraction
  confidence, and tag boosts.
- Mem0-style consolidation after every turn: an extraction pass proposes
  add/update/delete ops; updates keep in-file revision history, and a lexical
  Jaccard pre-check folds near-duplicates before spending model calls.
  Disable per turn loop with the `memoryAutoExtract` pref.
- Agent-facing `memory_search` / `memory_list` (read, auto-allowed) and
  `memory_save` / `memory_update` / `memory_delete` (write, approval-gated)
  tools, plus `memory/list|search|save|delete` RPCs and a memory panel with
  per-memory forget in both workspace UIs. Relevant memories are injected
  into the system prompt automatically.

### Conversation continuity (new)

- Sessions replay their full conversation on every prompt instead of
  restarting from scratch; history is persisted across restarts and
  compacted by LLM summarization past 80k characters.
- Model output streams live (`streamResponses` pref, on by default) with
  incremental `text_delta` / `reasoning_delta` events; reasoning_content
  from reasoning models is surfaced. Non-streaming still supported.

### Safety & control

- Permission scopes: Approve once / for this session / always (persisted).
- Plan mode is now real: read-only tool filtering with plan-first prompting.
- Sessions can be deleted from either UI; pending approvals auto-deny on
  abort, delete, or superseding prompts instead of hanging.
- `search_with_regex` rejects nested-quantifier patterns (ReDoS), caps the
  subject at 500k chars, and no longer loops forever on empty matches.
- The workspace-probe endpoint requires the pairing token — previously any
  web page could open the workspace window. Token comparisons are
  constant-time-ish; query-string tokens are no longer accepted.
- Tool argument validation now enforces declared types and enums, not just
  required keys.

### Integrations

- MCP: all configured servers connect (not just the first); the read-only
  MCP endpoint returns spec-compliant content blocks with `isError`.
- Model adapter: 429/5xx retry with backoff, usage accounting, tolerant
  tool-call argument parsing for both streaming and buffered responses.
- Ollama native support: a base URL ending in `/api/chat` (Ollama's own
  wire format) is auto-detected and spoken directly — NDJSON streaming,
  `message.thinking` mapped to reasoning deltas, object-valued tool
  arguments, and `prompt_eval_count`/`eval_count` usage counters. Verified
  end to end with `qwen3.8-27b` (tools + thinking): `npm run test:live`.
- Token usage is normalized across OpenAI snake_case and Ollama counters.

### Housekeeping

- `state.json` growth bounded (400 events/session, 60 sessions, debounced
  writes).
- Skills are generated from `skills/` by `scripts/sync-skills.mjs` with a
  drift check in CI; dead code (duplicate workspace-app.js, unused health
  endpoint) removed.
- The committed Chrome Markdown bundle is regenerated deterministically and
  checked for drift; the updated build toolchain has a clean npm audit.
- Chrome release archives preserve and verify nested icons and vendored KaTeX
  instead of flattening away required extension assets.
- Evals are executed as tests; every commit runs typecheck + tests on
  Node 22 and 24, builds the xpi and the Chrome zip; tags publish a GitHub
  release with both artifacts.
