# @confucius/memory

English · [简体中文](README.zh-CN.md)

[Development guide](../../.github/maintainers/development.md) ·
[User guide: knowledge and memory](../../docs/knowledge.md)

This package stores local Markdown memories and supports offline retrieval,
conversation history, and retention. The Zotero host owns model calls, user
permissions, research-topic extraction, and the unified knowledge index.

## Storage

The host's memory root is `<Zotero data directory>/confucius/memory/`:

```text
MEMORY.md             # Derived, readable catalogue
memories/<id>.md      # Source content and frontmatter metadata
access/<id>.json      # Usage metadata from explicit reads
```

Source files are authoritative; `MEMORY.md` can be rebuilt. A record contains
its title, type, tags, timestamps, protection, source references, confidence,
and body. Protected records can retain revision history; ordinary maintenance
does not build an indefinite revision archive.

Tasks and current conversation history live separately in the local Zotero
profile's `confucius/runtime-v1/`. Backups need both locations plus the Zotero
library. See [tasks and data](../../docs/tasks-and-data.md).

## Main APIs

| API                                      | Purpose                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `MemoryEngine`                           | Serialize memory operations, enforce capacity, and coordinate retrieval      |
| `FileMemoryStore`                        | Read/write Markdown sources and rebuild the catalogue                        |
| `search` / `list`                        | Find records without renewing retention                                      |
| `read`                                   | Read the current source and persist explicit usage                           |
| `refresh`                                | Reconcile external edits/deletions in the write queue                        |
| `save` / `update` / `delete`             | Mutate records; host authorization still applies                             |
| `applyOrdinaryOps`                       | Apply bounded automatic changes without modifying protected/research records |
| `maintain`                               | Remove eligible expired or over-budget ordinary records                      |
| `MemoryFileSystem`                       | Host filesystem interface; `InMemoryFileSystem` supports tests               |
| `HistoryStore` / `ConversationLogEngine` | Host-configured history and legacy log access                                |

Writes refresh source state before choosing replacements or retention victims.
Explicit reads write access metadata separately from Markdown content, so a
usage update cannot restore a deleted source or overwrite an external edit.

## Retrieval and retention

Retrieval combines BM25 lexical matches, CJK bigrams, recency, access
reinforcement, confidence, and tag matches. It needs no embeddings or network.

Ordinary/research memory shares a limit of 200 records and roughly 16,000 body
tokens, including retained revisions. Ordinary entries expire after 90 days
without an explicit read. Protected records and active research topics are
excluded from automatic eviction but still count toward capacity. If those
records fill the budget, the caller must resolve capacity rather than discard
them. Legacy knowledge documents are outside this memory budget.

Search, index refresh, prompt assembly, and diagnostics do not renew retention.
The current host does not automatically pin frequently retrieved memories or
promote every repeatedly read history excerpt into permanent memory. Some
legacy helper exports remain for compatibility; they are not current product
settings.

## Integration and checks

Use the host's [knowledge contracts](../../.github/maintainers/knowledge.md)
for protection, correction, forgetting, and research-topic rules. Context
handoff and history retention are described in
[context and memory](../../.github/maintainers/context-memory-refactor.md).

Run `npm test` and `npm run typecheck` from the repository root.
Tests use in-memory files and scripted model responses; they do not require a
live provider.
