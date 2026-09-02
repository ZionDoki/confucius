# @confucius/memory

Plain-text persistent memory for the Confucius research agent, inspired by
[Mem0](https://github.com/mem0ai/mem0) and deliberately different where it
matters for a local, single-user product.

## Design

Like Mem0, memories are extracted from conversations by an LLM that emits
add / update / delete / no-op decisions, and relevant memories are injected
into the agent's context. The differences:

| Mem0 | Confucius memory |
| --- | --- |
| Vector store (opaque) | One markdown file per memory; files are the only source of truth, human-readable, git-friendly, hand-editable |
| Embedding retrieval | Hybrid BM25 (with CJK bigrams) + recency decay + access reinforcement + confidence fusion — deterministic, offline, zero dependencies |
| Update overwrites the vector | Updates keep a revision history and timestamps inside the file; provenance is auditable |
| Dedupe via embeddings | Cheap lexical Jaccard pre-check folds near-duplicates before any extra model call |
| Library API only | Both a tool surface (the agent calls `memory_search` / `memory_save` / …) and an automatic post-turn consolidation pass |
| — | `MEMORY.md` overview regenerated after every change, so the whole memory is browsable in any editor |

Storage layout under `<Zotero data>/confucius/memory/`:

```
MEMORY.md            # regenerated index (derived, never authoritative)
memories/
  mem_a1b2c3d4.md    # one memory: frontmatter metadata + body + history
```

Conversation logs live beside memory, under `<Zotero data>/confucius/logs/`. Each session is one markdown file. Compaction of the in-context working set never deletes them. `conversation_log_search` / `conversation_log_read` retrieve excerpts; a tool-layer access hook counts hits and promotes a repeatedly retrieved excerpt into a durable memory (`promoted-from-log`). Memories that keep being retrieved are pinned (`confucius:pinned`) and always injected into the system prompt.

History compaction uses the model's configured context window: it reserves room for the system prompt, tool schemas, and output tokens, then compact when the working transcript exceeds 70% of what remains.

A memory file:

```
---
id: mem_a1b2c3d4
type: preference
title: Prefers survey papers
tags: [reading]
created: 1725000000000
updated: 1725000000001
last-accessed: 1725000000005
access-count: 3
confidence: 0.9
---

Prefers survey papers when entering a new field.

<!-- history
1724000000000 | Used to prefer primary sources only.
-->
```

## Ranking

`score = 0.6·BM25 + 0.15·recency + 0.10·reinforcement + 0.15·confidence (+0.2 tag overlap)`

- recency: exponential decay with a 30-day half-life over last access
- reinforcement: `log1p(accessCount)` capped at 10 accesses — memories the
  agent keeps using keep surfacing, dormant ones fade
- CJK text is tokenized into character bigrams, so Chinese queries work
  without a segmentation dependency

## Model-free core

The extraction module only builds prompts and parses responses; the host
executes the model call. Everything here is unit-tested without network
access using `ScriptedModel`-style doubles.
