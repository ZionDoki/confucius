# Context and history

English · [简体中文](context-system.zh-CN.md)

[User guide](README.md)

## Why a long task can keep working

The model has a limited working window. Confucius saves original conversation
and tool records locally, then carries the current request, sources, progress,
next action and selected evidence into a new window when needed.

A context switch preserves saved reports, write receipts, approvals and consumed
budget. It waits for safe tool/approval boundaries. If preparation or persistence
fails, the old context and recovery state remain available.

A complete handoff needs no extra organizing model call. Missing information may
use one supplemental call, sharing a limit of two maintenance requests per user
turn with research-memory extraction and distillation. External runtimes may have
internal work or usage they do not report.

## Check what was actually covered

Ask: “List each source, what you have read and the next unread page.”

A search hit, a returned page and a checked factual claim are different things.
The Agent can retrieve archived passages, but important claims still need source
verification. A saved collection does not by itself prove every member was read.

## How long history is kept

| State    | Default policy                                                                        |
| -------- | ------------------------------------------------------------------------------------- |
| Recent   | Target: 10 ended tasks, 30 days and 50 MiB; excess moves to local archives.           |
| Archived | Remains searchable, readable and exportable; target retention is 90 days and 500 MiB. |
| Cleaned  | Original content is no longer available. Saved status cannot restore it.              |

Actually reading archive text or continuing its task renews use. Search,
background maintenance and diagnostic export do not. Active tasks, recovery work
and unresolved operations can protect records and temporarily exceed targets.

**Automatic history cleanup** is separate from **Maintain work memory
automatically**. Turning off cleanup keeps archives. Memory extraction does not
authorize deleting source history. Reports, native Zotero objects and authoritative
write receipts are separate from disposable history.

Selection-question side conversations use their own recent/archive retention
under the same cleanup setting. See [selection questions](selection-questions.md).

## If work pauses

- **Insufficient handoff information:** ask to save the current findings, next step
  and source references, then continue.
- **Maintenance allowance exhausted:** existing material remains; avoid repeatedly
  requesting a context switch.
- **Context capacity exceeded:** reduce input or choose a larger-context model.
  More model steps do not increase context size.
- **Earlier requirements missed:** restate them and ask to reread the relevant
  history and original evidence.

History is not a permanent backup. [Export and back up](tasks-and-data.md) material
you need to retain.
