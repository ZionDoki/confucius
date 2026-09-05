# Changelog

## Unreleased

## 0.3.6 - 2026-09-05

### Updates

- Added a bilingual Update settings tab backed by Zotero's native add-on
  manager, with manual checks, explicit install status, and an automatic-update
  toggle.

### Research presets and annotations

- The three featured tasks use default settings when optional preferences are
  absent. Their hints list the settings accepted in the prompt.
- Each task separates source analysis from file creation. Both stages receive
  the user's edited prompt, and each stage has its own tool list. This applies
  to Native, Codex, and Kimi.
- Paper review uses the `commit_annotations` dialog for approval. A denied or
  failed PDF write returns the report without retrying the write.
- Annotation artifacts tolerate MiniMax-style string encoding for page,
  library, and rectangle numbers while retaining strict schema validation.

### Long-running turns

- Multi-page inspection sends at most one page image per model round and keeps
  text anchors for every requested page.
- Parallel external Runtime inspections also return at most one page image.
  The remaining calls return text anchors and note the omitted image.
- Page-image model calls have a cancellable 45-second deadline and retry once
  with text anchors. User-initiated Stop does not trigger that retry.
- The workspace shows the current phase and elapsed time, including PDF image
  analysis and text fallback.

## 0.3.5 - 2026-09-04

### Paper review and PDF annotations

- Paper-review tasks return a cited report and an annotation set with a legend.
- Annotation sets support highlights, underlines, and image-region notes, with
  safe per-annotation `#RRGGBB` colors and defaults for each annotation type.
- PDF writes preflight the complete batch, roll back on save or Reader refresh
  failure, refresh the active Reader once, and return canonical links to every
  created annotation.
- Page inspection can pass a transient rendered page to vision-capable models;
  page images are removed before events, checkpoints, logs, or host state are
  persisted. Text-only models are told not to guess regions.

### Tasks and workspace

- The empty workspace and `/` picker show three modes: Paper review, Evidence
  audit, and Synthesis. All 13 template IDs remain
  compatible with existing tasks and legacy entry points.
- Research-mode names, descriptions, and editable prompt drafts follow the
  selected Chinese or English interface language.
- Appearance settings now include an explicit Chinese/English switch and
  compact, standard, or relaxed reading line height.
- Choosing a research mode creates an editable draft. Work starts after Send,
  and validation failures preserve the draft.
- The `/` and `@` pickers share placement, dimensions, keyboard behavior, and
  focus styles. The security profile uses the same menu component.
- Task titles start with a local summary. The first successful exchange replaces
  it with a title in the interface language. Failures and timeouts keep the
  local title.

### Links and compatibility

- Historical `zotero://item/<key>` links open again. New item and PDF links are
  built only through canonical URI helpers, including annotation and page
  fallback targets for navigation.
- Existing highlight-only artifacts and `propose_highlights` calls remain
  readable while new work uses the discriminated annotation format.
- PDF page inspection now unwraps Zotero Reader objects, clones viewport
  arguments into the Reader compartment, and uses its crop renderer so text
  anchors and transient page images work in a real Zotero 7 Reader.

## 0.3.4 - 2026-09-04

### Reliability

- Exhausted model retries now report the final HTTP status and provider
  response body instead of a generic failure message.
- Failed Native Runtime turns roll back their in-flight history and
  checkpoints, so the same task can accept a new prompt without carrying a
  broken turn forward. Failed turns also skip follow-up history compaction.
- Completed streams collapse token deltas into timeline events before applying
  the history cap, preserving more earlier turns when a task is reopened.

### Workspace

- Timeline scroll position and follow-bottom state are restored independently
  for each task.
- Unsent composer drafts are isolated by task instead of following the user
  into another conversation.
- Conversation Markdown, including tables and code blocks, now follows the
  configured interface font size.
- The `/` command picker now matches the `@` paper picker in panel styling,
  row layout, responsive width, available-height handling, and placement.
- PDF search coordinates are normalized and cloned into the reader window.
  Committed highlights are sent to the active reader and opened by annotation
  ID.

### Docs

- Product READMEs now link to the GitHub-hosted demo video. The
  bundled video has been removed from the repository.

## 0.3.3 - 2026-09-04

### Research workflow

- Ordinary agent replies stay in the activity stream. A completed turn no
  longer auto-saves the assistant text as a report artifact.
  `artifact_upsert` is used for saved files such as paper reviews, audits,
  maps, and note drafts.

### Docs

- Product READMEs now embed the demo video with a `<video>` player instead of
  a cover image that links out.

## 0.3.2 - 2026-09-04

### Agent runtimes

- Codex App Server and Kimi ACP now run through an in-add-on Runtime Host. No
  Node sidecar, descriptor file, port, or separate startup command is needed.
- Runtime discovery now covers provider-owned Windows install directories,
  user bin directories, WinGet, npm's packaged native Codex binary, and PATH.
  Codex and Kimi can also be selected explicitly in either settings surface.
- The Runtime Host can be disabled from Settings and remains enabled by
  default. Kimi login status is verified by opening a real ACP session.
- OpenAI-compatible and Ollama endpoints now separate streamed
  `<think>...</think>` reasoning. New Agent runs default to 128 model steps.

### Research workflow

- The composer can add Zotero papers through a searchable, incremental `@`
  picker. PDF, Markdown, and TXT files can be dropped anywhere in the
  Confucius workspace while the composer is available.
- Assistant responses now expose copy, branch, and save-to-note actions. The
  composer uses one Runtime/model picker and closes menus when focus moves
  elsewhere.
- Each task keeps the Zotero sources selected at creation. Add and Replace
  controls update them when the Zotero selection changes.
- Artifact reading now uses a full-bleed overlay with a right action rail,
  custom menus, compact sidebar files, and corrected narrow-width
  overflow.
- English and Simplified Chinese product READMEs now include the product film,
  installation guidance, Runtime options, and security boundaries.

## 0.3.1 - 2026-09-04

- The activity stream is now the permanent main workspace; the separate
  artifact canvas and stream-wide collapse control are gone.
- Research artifacts appear as versioned file blocks in the stream. Click a
  block to inspect revisions, citations, and write-back actions in a
  full-workspace viewer.

## 0.3.0 - 2026-09-03

### Research workbench

- Conversations are stored as research tasks with a Zotero source snapshot,
  task templates, status, and controls for changing the source selection.
- Research outputs are saved as structured, versioned artifacts with Zotero
  citations. Notes, annotations, collections, and tags always show a
  before/after preview before write-back.
- Memory defaults to review. Proposed memories can be edited, accepted, or
  rejected before saving.

### Agent runtimes

- Added the local Agent sidecar with Native, Codex App Server, and Kimi ACP
  runtimes. Runtime availability and login state are checked from the real
  runtime session. Native mode remains available when the sidecar is missing.
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

## 0.2.1 - 2026-09-03

### Workspace

- Clicking a markdown literature link now opens the item the same way the
  timeline locate control does (library selection plus the PDF reader when
  there is an attachment). Chrome XHTML was swallowing clicks on
  `zotero://` hrefs; the URI is kept on `data-href` and handled in
  JavaScript.
- Opening the workspace no longer hangs. Privileged chrome cannot parse
  answer HTML with `DOMParser` / `text/html`.

## 0.2.0 - 2026-09-03

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

## 0.1.2 - 2026-09-02

### Memory, logs, and context

- Conversation transcripts are now kept as searchable markdown files under
  `<Zotero data>/confucius/logs/`. Context compaction does not delete them.
- New read tools `conversation_log_search` and `conversation_log_read`, plus
  `logs/list|search|read` RPCs, let the agent recover earlier details after a
  thread has been summarized.
- A tool-layer access hook records every log and memory retrieval. Excerpts
  hit several times are promoted into memories (`promoted-from-log`);
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

## 0.1.1 - 2026-09-02

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
- Six knowledge-base tools and nine RPC methods create, update, retrieve,
  search, and organize topics. Writes require approval.

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
  removes the hidden Zotero link.
- Note search merges recent database writes with Zotero's eventual index, and
  DOI imports fall back to CSL metadata when the translator chain returns no
  items.
- The live Zotero matrix exercises all 60 built-in tools, including PDF text,
  real highlights and annotation coordinates, attachments, memory, and the
  research knowledge base.

### Persistent memory (new)

- Plain-text long-term memory based on Mem0, stored as one Markdown file
  per memory under `<Zotero data>/confucius/memory/`, with a regenerated
  `MEMORY.md` index. The files are the source of truth and can be edited in any
  text editor. Invalid files do not prevent the store from loading.
- Embedding-free retrieval: BM25 with CJK character bigrams fused with
  recency decay (30-day half-life), access reinforcement, extraction
  confidence, and tag boosts.
- After each turn, an extraction pass proposes
  add/update/delete ops; updates keep in-file revision history, and a lexical
  Jaccard pre-check folds near-duplicates before spending model calls.
  Disable per turn loop with the `memoryAutoExtract` pref.
- Agent-facing `memory_search` / `memory_list` (read, auto-allowed) and
  `memory_save` / `memory_update` / `memory_delete` (write, approval-gated)
  tools, plus `memory/list|search|save|delete` RPCs and a memory panel with
  per-memory forget in both workspace UIs. Relevant memories are injected
  into the system prompt.

### Conversation continuity (new)

- Sessions replay their full conversation on every prompt instead of
  restarting from scratch; history is persisted across restarts and
  compacted by LLM summarization past 80k characters.
- Model output streams live (`streamResponses` pref, on by default) with
  incremental `text_delta` / `reasoning_delta` events; reasoning_content
  from reasoning models is surfaced. Non-streaming still supported.

### Safety & control

- Permission scopes: Approve once / for this session / always (persisted).
- Plan mode filters the tool list to read-only operations and uses a planning
  prompt.
- Sessions can be deleted from either UI; pending approvals auto-deny on
  abort, delete, or superseding prompts instead of hanging.
- `search_with_regex` rejects nested-quantifier patterns (ReDoS), caps the
  subject at 500k characters, and handles empty matches.
- The workspace-probe endpoint requires the pairing token. Previously, any web
  page could open the workspace window. Token comparisons are
  constant-time-ish; query-string tokens are no longer accepted.
- Tool argument validation now enforces declared types and enums, not just
  required keys.

### Integrations

- MCP: configured servers connect to the read-only
  MCP endpoint returns spec-compliant content blocks with `isError`.
- Model adapter: 429/5xx retry with backoff, usage accounting, tolerant
  tool-call argument parsing for both streaming and buffered responses.
- Ollama native support: a base URL ending in `/api/chat` (Ollama's own
  wire format) is auto-detected and uses NDJSON streaming,
  `message.thinking` mapped to reasoning deltas, object-valued tool
  arguments, and `prompt_eval_count`/`eval_count` usage counters.
- Token usage is normalized across OpenAI snake_case and Ollama counters.

### Housekeeping

- `state.json` growth bounded (400 events/session, 60 sessions, debounced
  writes).
- Skills are generated from `skills/` by `scripts/sync-skills.mjs` with a
  drift check in CI; dead code (duplicate workspace-app.js, unused health
  endpoint) removed.
- The committed Chrome Markdown bundle is regenerated and checked for drift.
- Chrome release archives preserve and verify nested icons and vendored KaTeX
  instead of flattening away required extension assets.
- Evals are executed as tests; every commit runs typecheck + tests on
  Node 22 and 24, builds the xpi and the Chrome zip; tags publish a GitHub
  release with both artifacts.
