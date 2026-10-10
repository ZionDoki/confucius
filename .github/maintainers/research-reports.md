# Report and revision contracts

English · [简体中文](research-reports.zh-CN.md)

[Maintainer guide](README.md) · [User guide](../../docs/reading-and-annotations.md)

## One report with revisions

Use `artifact_upsert` to create a task artifact or replace its body. Later edits
reuse its ID; `artifact_patch` applies targeted Markdown changes. Neither task
artifact operation needs Zotero write approval. Native note writes and annotation
review retain their separate confirmation flows.

A deep-reading report includes a brief opening summary, method explanation,
evidence and limitations. Preserve denominators, baselines and scope for numeric
claims. Source quotations keep their original language. `reportStyleGuidance`
combines layout, tone and focus; it is the shared style entry.

`ready` means deliverable, not independently fact-certified. Only incomplete
content stays draft. The host can make one independent revision after a ready
report changes in the current request, using the current model and remaining
budget. Inputs contain the current request/report and available source evidence,
not the drafting conversation or hidden reasoning.

Opening a report, saving a style or ordinary Q&A does not trigger revision.
Record the attempt against the request and report version; restart does not
replay it. Failure, cancellation, invalid output or conflict leaves the saved
report unchanged. No-change output creates no new revision.

## Reading, patching and citations

| Tool              | Contract                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `artifact_read`   | Read body or citations with revision and pagination. Continue with the same expected revision. |
| `artifact_patch`  | Require `id` and `expectedRevision`; edit body/title/status/citations atomically.              |
| `artifact_upsert` | Create or replace within the owning task; do not overwrite another task's artifact.            |

An edit's `oldText` must match exactly once in the original snapshot. Reject
overlapping edits, ambiguous matches and stale versions before any save.
Recheck the expected revision under the artifact lock; preparation must not
silently upgrade the expected version.

Omitted fields preserve values. Explicit citations replace the complete list;
an empty list clears it. Structured bodies use upsert for replacement.

Inline `[cite:e1]` references map to unique citation IDs. Native item/library,
attachment, physical-page and annotation identifiers must come from evidence.
An abstract-only source must not invent a PDF page. Note export converts references
to native Zotero links; legacy Markdown links stay readable.

## Persistence and replay

Store the full expected result in operation recovery material while keeping
model-visible patch parameters compact. Artifact revisions can carry
`operationId`; older revisions without it remain readable.

Replay requires matching task, expected revision, operation ID and content.
Another operation writing identical text does not prove this one succeeded.
A known committed operation returns its existing receipt.

## Report views and writeback

The report can live in the workspace or a separate native window. Reuse the same
renderer, palette, buttons and reading preferences; see [design rules](../../docs/design.md).
Deduplicate windows by artifact ID, including concurrent opens.

Latest view follows updates while preserving position; selected historical
revisions stay pinned. Text selection and writeback review pause replacement.
Writeback uses the displayed revision, not an unseen newer one.

A report's default durable destination is a Zotero note. Preview and confirmation
belong to that concrete request. Closing/cancelling rejects pending unconfirmed
requests, including late preparation results; an already confirmed write can finish.
Export creates an independent file; the knowledge library indexes sources.

The window registry belongs to the plugin, not the chat component. Closing the
chat keeps detached reports open; deleting the task or unloading the plugin closes
them and releases listeners. A branch has independent report snapshots and writeback targets.

## Validation

Test version conflicts, ambiguous/overlapping patches, citation preservation,
cross-task rejection, receipt replay, window lifecycle and confirmation races.
Synthetic correction cases establish tool behavior, not general writing quality
or token-cost savings. Real-model, layout and native writeback checks need
separate recorded evidence.

Historical report, style and window experiments are preserved in the
[acceptance archive](acceptance/README.md); they are not current-code guarantees.
