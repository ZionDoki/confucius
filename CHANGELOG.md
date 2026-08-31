# Changelog

## 1.0.0 — 2026-09-01

First production release.

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
- Evals are executed as tests; every commit runs typecheck + tests on
  Node 20 and 24, builds the xpi and the Chrome zip; tags publish a GitHub
  release with both artifacts.
