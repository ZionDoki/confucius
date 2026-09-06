# Changelog

## Unreleased

### Changed

- Research reports keep a one-minute overview inside the document, followed by
  the method, cited evidence and limitations. Reviews update the same report
  and keep the overview consistent with corrected findings.
- Agents can read a saved report in bounded portions and revise selected
  passages together without resending the whole document. Unchanged citations,
  sources and earlier revisions are preserved. An accurate deep-reading draft
  can be marked ready after source review without rewriting its body.

### Fixed

- The artifact tool now directs models to omit the ID when creating a report
  and reuse the current task's saved ID when revising it. An ID that belongs to
  another task returns an actionable argument error instead of a misleading
  permission denial. Models are no longer asked to supply a task ID; older calls
  remain compatible and cannot redirect a save into another task. Artifact saves
  remain independent of Zotero write approvals.
- Report patches reject stale revisions, ambiguous text and overlapping edits
  without applying any part of the patch. Interrupted saves are reconciled by
  their persisted operation identity, preventing duplicate revisions on replay.

### Validation and known limits

- The development changes pass 774 automated tests, type checking, lint, build,
  skill synchronization and version consistency checks on Windows with Node.js 24.
- Deterministic report-editing tests cover atomic overview/evidence corrections,
  concurrent edits, citation preservation, bounded reads, source-review
  prerequisites and interrupted writes. See the
  [report revision contract and checks](.github/maintainers/research-reports.md).
- The new report workflow has not yet been tested with a real model in an
  installed Zotero build. Smaller edit payloads are measured as UTF-8 bytes,
  not billed tokens or an end-to-end success-rate improvement.

## 0.4.1 - 2026-09-06

Confucius 0.4.1 improves PDF annotation accuracy, evidence review and feedback
during tool execution.

### Changed

- PDF annotations can be committed directly from selectable source passages,
  individually or in batches. Models no longer need to retype the source quote
  or create a separate proposal first; existing quote/page calls remain supported.
- Deep-reading reports are saved as drafts before a separate evidence review of
  source pages and saved comments. Reviews retain source evidence and existing
  annotation identities while separating earlier drafting reasoning.
- Tool receipts avoid repeating saved report bodies, annotation geometry and
  proposal text. PDF page results preserve complete pages and indicate where
  reading should continue.

### Fixed

- Annotation locations follow native PDF characters and positions, including
  typographic ligatures and line breaks. Invalid or stale passage references are
  rejected, and one unresolved entry does not discard the rest of a batch.
- Editing a saved annotation comment validates that annotation without treating
  unrelated annotations as part of the edit. Completed writes retain their
  original request identity for safe continuation.
- The configured response language is carried through reading, comments,
  reports, progress and repair turns while source quotations retain their text.
- Tool calls such as `commit_annotations` keep the loading indicator and status
  text below the conversation visible during approval and execution, alongside
  the progress and elapsed time shown inside the tool.
- PDF reading and annotation tools reuse open readers and initialize new or
  unloaded PDF tabs in the background, preventing repeated window activation
  during agent work.
- Tool-call commentary appears in a collapsible progress section. Interrupted
  runs no longer concatenate those messages into a final answer, and completed
  replies exclude earlier tool-call preambles. Whitespace-only preambles do not
  create empty progress blocks.

### Upgrade notes

- This is a stable update from 0.4.0. Install through Confucius Settings → Update
  or install the release XPI, then restart Zotero. No new data migration or model
  reconfiguration is required; existing tasks, annotations and explicit update
  channel preferences are preserved.

### Validation and known limits

- The release candidate passes 759 automated tests, type checking, lint, build,
  version/release checks and skill synchronization on Windows 11 with Node.js 24.
  In normally installed Zotero 10.0.1, MiniMax-M3 saves all three target sentences
  in one commit and returns a Chinese final reply. Existing settings, 24 tasks
  and 20 original annotations remain unchanged; background reads retain the
  selected tab and reuse their reader.
- Isolated 0.3.8 → 0.4.1 upgrade checks preserve task identities, history,
  checkpoints, notes and artifact revisions. Two restarts and explicit
  continuation preserve the completed write without duplication. This uses a
  deterministic local model and does not measure model quality.
- In a fixed three-sentence case repeated five times per version, complete and
  correctly positioned highlights increased from 10/15 to 15/15. Both versions
  saved 15 annotations. Reported mean token use decreased 40.2%; one baseline
  run was interrupted after saving its marks and may lack final request usage.
  These are small-sample interface results, not universal reliability or billing
  guarantees. The comparison isolates the annotation interface change, not all
  differences from 0.4.0.
- Evidence review does not guarantee factual correctness. Reading reports can
  still confuse statistical scope or denominators; scanned PDFs, OCR and
  cross-page sentence annotation are outside this experiment's validation.
  One MiniMax-M3 candidate run also exposed a raw thinking marker before its
  Chinese final reply; provider-specific reply formatting is not fully normalized.
- Release preparation and installation checks are recorded in the
  [0.4.1 acceptance record](https://github.com/ZionDoki/confucius/blob/v0.4.1/.github/maintainers/acceptance/release-0.4.1.md).

## 0.4.0 - 2026-09-06

Confucius 0.4.0 brings resumable research tasks, diagnostic exports and an
independent plugin updater to the stable channel. This release includes the
0.4.0 Beta changes and the subsequent Windows fixes.

### Added

- Export a task diagnostic report from the task header or task menu. The offline
  HTML includes searchable events, history and artifact revisions, with a JSON
  download. Recognized credentials are redacted; external-engine data that is
  unavailable to Confucius is identified as such.
- A saved Include prereleases switch controls Beta updates independently of
  automatic checks. Stable packages default to stable updates; an explicit
  channel choice survives upgrades. Disabling previews never downgrades.

### Changed

- Native, Kimi and Codex share task coordination, cumulative budgets and explicit
  stop reasons. Continuing a task preserves its request, history and saved work;
  Kimi and Codex retain their own internal execution and context management.
- Tasks track evidence, drafts, proposed changes and saved results. Partially
  completed annotation batches retain successful items so recovery can address
  the remainder. Restarted tasks wait for explicit continuation.
- Task state, history, logs and generated artifacts now live in the local Zotero
  profile, with resumable migration and retained identities and source backups.
- Confucius discovers, compares, downloads and verifies GitHub releases itself,
  independently of Zotero's global automatic-update setting. Automatic checks run
  after startup and every six hours; installation requires a click.
- User documentation now focuses on setup, model selection, recovery, data and
  updates. Release rules and acceptance records live in the maintainer guide;
  obsolete design drafts have been removed.

### Fixed

- Fixed toolbar registration and first-open layout changes while restoring tasks
  and preferences. Saved diagnostic events survive activity-view trimming.
- Improved streamed model responses, reasoning replay, incomplete tool-call
  handling, parameter validation and timeout recovery.
- PDF reading can be cancelled, and expensive regular-expression searches run in
  a separate Worker with a deadline.
- Failed release requests, incomplete assets and checksum mismatches remain
  visible as errors instead of being reported as an up-to-date installation.
- External engines connect to the active Zotero profile's HTTP port. Codex
  0.153.4 MCP consent requests now reach the existing host tool permission policy.
- Blank and scanned PDF pages no longer fail with a cross-compartment Worker
  cloning error during physical-page text extraction.
- Windows runtime IO supports long history paths, allowing queued history to
  recover without changing task IDs or replaying completed writes.
- Diagnostic redaction preserves scientific numbers and entity IDs when a local
  endpoint uses a short dummy credential.

### Upgrade notes

- This is a stable release and supersedes both 0.3.8 and 0.4.0-beta.1. If an older
  updater cannot find it, install `confucius.xpi` manually through Zotero's add-on
  manager once, then restart Zotero. Future checks use Confucius Settings → Update;
  enable Include prereleases only if you want Beta releases.
- Back up the Zotero library and local Confucius runtime directory before
  upgrading. Migration retains the old source and backup, but downgrading does
  not copy new task progress back to the old directory. Native Zotero notes,
  annotations and attachments remain managed by Zotero.
- Zotero 7–10 are supported by the package manifest. This release's native
  Windows acceptance used Zotero 10.0.1; Zotero 7/8 were not retested.

### Validation and known limits

- The 0.4.0 local package passed 719 automated tests, typecheck, lint, build,
  version and release-note checks. A normal 0.3.8 → 0.4.0 upgrade and two restarts
  preserved task history, budgets, report revisions and a real note without
  duplicating it. See [0.4.0 release acceptance](https://github.com/ZionDoki/confucius/blob/v0.4.0/.github/maintainers/acceptance/release-0.4.0.md).
- [Windows acceptance](https://github.com/ZionDoki/confucius/blob/v0.4.0/.github/maintainers/acceptance/windows-acceptance-2026-09-06.md)
  records the earlier candidate's engine and fault tests. It includes the same
  product fixes; package hashes differ from the final versioned build.
- Real Native, Kimi and Codex runs each created a report and two PDF highlights
  from Attention Is All You Need. Long-context, cancellation and process-restart
  checks preserved saved reports, budgets and annotation identities. Kimi/Codex
  recalled the original test constraint; Native failed that semantic recall
  check, and its first report required a factual correction. These are individual
  task samples, not a general model-quality or success-rate claim.
- Windows installed-package upgrade, interrupted migration, long-path recovery,
  exclusive file locks, partial annotation recovery and PDF Worker edge cases
  passed their scoped checks. WPS Cloud results cover only local synced-folder
  IO and lock recovery; cloud synchronization, reconnects, multiple devices and
  hosting the whole Zotero database there remain unverified.
- Disk-full, separate filesystem permission denial, Windows export-dialog UI and
  the full cross-engine fault matrix remain unverified. Native PDF annotation
  lookup can take about five seconds per entry; large batches may hit the deadline.
- After publication, the independent updater in the earlier Windows candidate
  discovered, downloaded, verified and installed the public 0.4.0 asset with
  Zotero's global automatic updates disabled. Both channel choices found the
  stable release; normal restarts retained the Beta preference, three reports
  and six highlights. This baseline was the unpublished candidate containing the
  new updater, not the original published beta.1 package.
- That post-release check found Native's diagnostic elapsed time can include
  idle time when the plugin unloads. The checked model/tool counts, token totals,
  saved reports and annotations were unchanged; elapsed-time accuracy remains a
  known issue.

## 0.4.0-beta.1 - 2026-09-06

This is a preview release of the Harness upgrade. Install its XPI manually;
the stable automatic-update channel remains on the latest stable release.

### Task execution and recovery

- Unified Native, Kimi and Codex task coordination, with explicit stop reasons,
  cumulative budgets and continuation based on current proposals and artifacts.
  Kimi and Codex retain their own internal agent loops.
- Replaced fixed preset phases with evidence, drafts, versioned submissions and
  actual results. Normal tasks can continue known unfinished work within their
  existing request and budget.
- Added prepared operations, shared execution deadlines and durable per-operation
  intents and receipts. Partial annotation commits retain successful items;
  recovery reconciles uncertain effects without requiring a model inspection
  call or repeating completed writes.
- Improved model protocol handling, reasoning replay, streamed tool-call
  completeness, schema validation and request timeout recovery.
- Moved runtime state into the local Zotero profile with resumable migration,
  source backups and retained task, proposal and artifact identities.

### Workspace and diagnostics

- Fixed toolbar registration and first-open workspace layout changes while
  restoring a task and loading preferences.
- Added task diagnostic report export from the task header and task menu.
  Offline HTML includes searchable events, history, checkpoints, operations,
  proposals and artifact revisions, plus a full JSON download. Export progress
  appears on the disabled export button.
- Archived host events independently of UI retention and excluded diagnostic
  batches from model history retrieval. Exports redact recognized credentials
  and identify unavailable external-engine internals and legacy trace gaps.
- Added cancellable PDF work and isolated regular-expression Worker execution.

### Validation and known limits

- Automated tests, type checking, lint and builds are required for this release.
  macOS development Zotero acceptance covers actual tool writes, partial
  annotation recovery, workspace startup and report export.
- Installed the released 0.3.8 package in an isolated Zotero profile, upgraded
  through AddonManager and verified restart recovery. Task/window identities,
  history bodies, note and artifact revisions, and the completed write receipt
  survived; explicit continuation kept one native note and consumed budget.
  See [upgrade acceptance](https://github.com/ZionDoki/confucius/blob/v0.4.0-beta.1/docs/upgrade-acceptance.md).
- Real-model end-to-end acceptance for Native, Kimi and Codex, plus Windows
  storage and PDF Worker acceptance, are deferred to the next version. The
  Windows follow-up procedures and result template are in
  [Windows acceptance](https://github.com/ZionDoki/confucius/blob/v0.4.0-beta.1/docs/windows-acceptance.md).
- Native Reader annotation lookup can take about five seconds per entry in the
  tested environment. Large batches may reach the execution deadline; completed
  items retain their receipts.
- This release does not claim identical context-window behavior across engines
  or improved task success rates across all base models.
- Migration retains the old runtime source and backup. Downgrading does not
  copy newly written runtime state back into the older version's directory.

## 0.3.8 - 2026-09-05

- Added a complete dark appearance that follows Zotero's theme, including the
  workspace, reader sidebar, composer, menus, settings, knowledge base and
  artifact reader. Shared colors also cover status messages and thin scrollbars;
  theme changes preserve drafts, focus and reading position.
- Added Follow Zotero, Light and Dark choices in Appearance settings with live
  preview and saved preferences, and replaced the text send arrow with a balanced
  rounded SVG icon.
- Relaxed sidebar list and navigation spacing, removed inherited native button
  height limits that clipped multi-line labels, and kept keyboard focus rings
  inside controls without showing them after pointer clicks.
- Added warm white and dark ink logo variants. Toolbar, preference, progress,
  and add-on icons adapt to the active color scheme; the workspace mark follows
  its surrounding text color.
- Updated the product film in the English and Chinese READMEs.

## 0.3.7 - 2026-09-05

### Context and history

- Native research tasks continue across replaceable context windows without
  automatic summary calls. Window changes preserve the task, original request,
  sources, artifacts, work notes, and remaining run budget.
- Added durable, paginated task history and working notes shared by Native,
  Codex, and Kimi. Agents retrieve earlier evidence on demand, and the `@`
  picker can reference both papers and previous tasks by stable ID.
- History retrieval respects paper scope and deleted tasks. Earlier instructions
  and approvals remain source material and do not authorize new actions.
- Schema-v3 migration backs up existing state and imports messages, events, and
  logs without inventing missing content. Failed persistence keeps the current
  window; restart recovery preserves completed tool results and prevents
  automatic retries of writes whose result is unknown.
- Context indicators distinguish reported, estimated, and unavailable usage.
  Codex and Kimi retain their own CLI context management.

### Workspace and reading

- Refreshed the workspace, menus, task list, settings, knowledge base, and
  artifact reader with warm white surfaces, clearer typography, fewer borders,
  and consistent keyboard and focus behavior.
- Thin scrollbars keep layout dimensions stable in sidebars and separate
  windows. Drafts, source references, reading positions, and keyboard focus
  survive navigation; streaming updates respect readers viewing older content.
- The composer has a compact, fixed-height text area with Chinese IME support
  and no blue typing outline. Its toolbar controls share a vertical alignment.
- `/` stages localized research presets as editable drafts. Plan and preset
  chips appear beside `+`, briefly show a close icon on hover, and dismiss with
  one click while retaining the draft and sources.
- Model selection opens the model list first, followed by that model's supported
  thinking settings. Codex and Kimi use their actual CLI capability catalogs;
  Native APIs use documented model profiles and preserve provider defaults for
  unknown models.
- Task source actions now live on the source menu in the task header, removing
  ambiguous duplicate Zotero actions from `+`. Settings provide save feedback;
  the knowledge base preserves unsaved edits while navigating.

### Platform compatibility

- Fixed macOS Codex and Kimi discovery aborting on nonexistent candidate paths.
  Detection now covers common macOS, Linux, and Windows installations, package
  managers, desktop bundles, and executable paths containing spaces or Chinese.
- Runtime probes and launches use the same executable and environment, with
  clearer missing-installation, authentication, and protocol diagnostics.
- `npm start` automatically locates Zotero on macOS, Linux, and Windows while
  respecting explicit overrides. Building does not require an installed Zotero.

### Release consistency

- Unified package, lockfile, runtime, and plugin versions. Tagged releases check
  their version against the changelog and publish its notes with a consistent
  `Confucius vX.Y.Z` title, plugin package, and Zotero update manifest.
- Windows and Linux discovery are covered by simulated platform tests. Native
  desktop acceptance for this release was performed on macOS with Zotero 10.

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
