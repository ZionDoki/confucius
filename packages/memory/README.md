# @confucius/memory

Plain-text memory for Confucius. It uses ideas from
[Mem0](https://github.com/mem0ai/mem0) but stores data in local Markdown files.

## Design

The model extracts add, update, delete, or no-op decisions from conversations.
Relevant memories are added to later model context.

| Mem0                    | Confucius memory                                             |
| ----------------------- | ------------------------------------------------------------ |
| Vector store            | One Markdown file per memory                                 |
| Embedding retrieval     | BM25 with CJK bigrams, recency, access count, and confidence |
| In-place updates        | Revision history and timestamps in each file                 |
| Embedding deduplication | Lexical Jaccard check before a model call                    |
| Library API             | Memory tools and post-turn extraction                        |
| No index file           | Generated `MEMORY.md` index                                  |

Storage layout under `<Zotero data>/confucius/memory/`:

```
MEMORY.md            # generated index
memories/
  mem_a1b2c3d4.md    # one memory: frontmatter metadata + body + history
```

Conversation logs are stored under `<Zotero data>/confucius/logs/`, with one
Markdown file per session. Context compaction does not delete these files.
`conversation_log_search` and `conversation_log_read` return excerpts. Repeatedly
retrieved excerpts can become memories tagged `promoted-from-log`. Frequently
used memories are tagged `confucius:pinned` and included in the system prompt.

History compaction reserves space for the system prompt, tool schemas, and model
output. It runs when the working transcript exceeds 70% of the remaining
context window.

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
- reinforcement: `log1p(accessCount)`, capped at 10 accesses
- CJK text is tokenized into character bigrams, so Chinese queries work
  without a segmentation dependency

## Model integration

The extraction module builds prompts and parses responses. The host executes
the model call. Tests use scripted model responses and do not need network
access.
