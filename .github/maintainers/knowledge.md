# Knowledge and research memory

English · [简体中文](knowledge.zh-CN.md)

[Maintainer guide](README.md) · [User guide](../../docs/knowledge.md)

## Ownership

| Content                                 | Authority                                      |
| --------------------------------------- | ---------------------------------------------- |
| Final report saved to a note            | Native Zotero note                             |
| Drafts and report revisions             | Task artifact store                            |
| Topics, preferences and ordinary memory | Existing memory Markdown files                 |
| Knowledge search results                | Derived index of source locations and excerpts |
| Legacy knowledge-base/entry files       | Existing read-only sources                     |

`KnowledgeIndex` reads live sources. It does not create another report store.
Notes must not be trashed, and neither may their parents. Load title/body data
on demand across libraries; do not assume primary item data contains them.
Open reads the source, so deletion never resurrects old indexed content.

Memory refresh shares the write queue with changes, rescans disk, preserves
explicit-access bookkeeping and excludes unreadable files rather than returning
stale content. Search does not renew retention or rewrite source files.

New report writeback targets a Zotero note and reuses its association. Export is
an independent HTML copy. Legacy knowledge writes are removed from the catalogue
and rejected by the host; compatibility reads and historical receipts remain.

## Research extraction

`ResearchMemory` uses `MemoryEngine` and the existing automatic-memory setting.
After a successful ordinary conversation, the current model may propose at most
three changes within the shared maintenance allowance.

Require evidence from the current user's words. Do not infer enduring interests
from one paper question or read cross-topic memory for source-restricted presets.
Topic state includes goals, qualified findings, question status and next steps.
The host supplies source-task links and checks provided memory IDs.

Current user instructions take precedence over stored memory.

## Concurrency and protection

Persist an attempt and model result before applying changes with stable IDs.
Recheck execution ownership, setting state, target revisions and protection at
the serialized write boundary. Cancellation, user correction or deletion fences
late automatic results.

A conflicting batch is not marked complete. Refresh its snapshot and retry only
within the remaining allowance. Replay uses content, status and source-task
evidence; reordering results must not reuse another topic's identity.

Corrected/protected content cannot be overwritten automatically. Forget stores an
identity digest, suppresses the normalized name and excludes its source tasks
from later archive distillation. This does not delete source conversations or
provide semantic suppression across renamed topics.

Active research topics avoid ordinary inactivity expiry but still consume
capacity. Full capacity preserves existing records and reports maintenance failure.

## Main implementation and checks

- Host: `KnowledgeIndex.ts`, `ResearchMemory.ts`, `MemoryTools.ts`, `AgentHost.ts`.
- Storage: `packages/memory/src/engine.ts` and `store.ts`.
- UI: `knowledgeLibrary.ts`, `knowledgeExport.ts`, `artifactWriteback.ts`.

Test live-source refresh, trash/restore, legacy reads, pagination, evidence checks,
stable replay, concurrent merges and correction/forget races. Run `npm test` and
`npm run typecheck`. Real-model extraction quality and native Zotero checks need
separate evidence; see the [historical archive](acceptance/README.md).
