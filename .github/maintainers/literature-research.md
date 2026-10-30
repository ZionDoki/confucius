# Literature and subagent contracts

English · [简体中文](literature-research.zh-CN.md)

[Maintainer guide](README.md) · [User guide](../../docs/literature-research.md)

## Pool and confirmation

`LiteratureService` is shared by UI RPC and `LiteratureToolProvider` across
Native, Codex and Kimi. Search updates task material; import/download requires
user confirmation. `literature_acquire` registers a wait, not self-authorization.

The pool separates fetched records, decisions, confirmed candidate revision,
queries and acquisition receipts. Deduplicate by OpenAlex IDs or normalized DOI;
similar titles alone do not merge. Preserve user choices and source provenance.
Only changes to the selected identities invalidate confirmation and continuation;
reason updates, evaluations and repeated choices keep the candidate revision.
Agents cannot overwrite user choices or reasons. Progress uses the separate pool
revision. API total hits are not the fetched pool size.

Confirm persists the authorized revision, then item receipts, source bindings and
the download queue. Reuse existing items and verified attachments. Removal only
unbinds sources introduced by this domain.

Changing sources is allowed while idle or at the current run's live confirmation
wait, matched by run ID and signal. A persisted waiting flag is insufficient.
Existing children keep their delegated source snapshot.

User-only continuation records `abstracts` or `current` for the candidate
revision and wakes host waits. It does not cancel already authorized background
downloads, but prevents new supplemental exploration. Candidate changes require
a new decision. No repeated model polling is needed.

The candidate and annotation adapters share `reviewPanel.ts`, `reviewModel.ts`
and `reviewStyles.ts`. `literature/review/list` supplies one coherent metadata
snapshot, separate from paged model-facing `literature/list`. List rows mount in
chunks; fewer than ten entries start as cards and ten or more as a list. Choices
use the existing candidate revision and confirmation APIs. Search events include
new work IDs only; identity duplicates, metadata refreshes and acquisition
receipts do not replay arrival cues. Appending a page within the same query still
updates without changing the current view, filter, position or bulk selection.
Arrivals accumulate during generation and notify together at completion. A live
blocking confirmation opens immediately; restored history remains minimized.

## Retrieval and model shortlist

OpenAlex requests use root-level field selection. The default search scope is
title/abstract/keywords; title/abstract, fulltext and semantic modes cover other
intents. Rerank is optional and costs additional credits. Known retracted works
and paratext are excluded unless explicitly included. Anonymous cursor
continuation fails locally instead of making a doomed request.

Equivalent queries reuse their newest saved result for five minutes; `refresh:true`
explicitly starts a new first-page query and `queryId` continues cursor paging.
Scores are stored per query, with `rerank_score` accepted only when
`meta.reranked=true`. Relevance is primary and normalized impact auxiliary;
date/citations lead only when explicitly requested. Venue and year are not a
paper-quality formula.

Reranking applies only to the first 100 hits. Later cursor pages retain that
cohort's scores and place unreranked results after it; probabilities are never
compared with raw text scores. Impact tiebreakers use one metric available for
the entire candidate set, otherwise raw citation counts. Cancellation is checked
after search-lock waits and asynchronous result projection, including cache hits.

Model search/list defaults to a query-scoped shortlist of 10 (at most 12), with
`nextOffset=null`; metadata remains available for concrete gaps. UI review,
candidate decisions and acquisition are unchanged. `LiteratureService.search`
still returns metadata for UI RPC, while provider and subagent projections limit
only what the model sees, not the durable pool.

Children archive their own query metadata, membership and scores. Their list
views and cursor continuations accept only owned query IDs. Repeated searches
retain the original source/acquisition snapshot; parent candidate decisions and
later attachment changes never replace it. These query snapshots survive retry
and restart with the child archive.

## Abstracts and full text

Abstract lookup tries exact local metadata, OpenAlex and Crossref within bounded
deadlines, preserving the matching DOI and provenance. Failure has a short
cooldown; cancellation is not cached. It does not import papers, change candidate
choices or establish full-text reading.

Full-text modules divide responsibilities:

| Module                    | Responsibility                                                            |
| ------------------------- | ------------------------------------------------------------------------- |
| `LiteratureAcquisition`   | Existing-file reuse, ordered acquisition, verified import and receipts    |
| `LiteratureResolvers`     | Native resolvers, translators and observed page links                     |
| `LiteratureRepositories`  | DOI-matched Europe PMC / PMC metadata                                     |
| `LiteratureNetwork`       | Public URL/DNS checks, redirects, credentials and response limits         |
| `LiteratureBrowser`       | Isolated cookie context, public-request guards and PDF capture            |
| `LiteraturePdf`           | PDF structure, parsing, first-page identity and explicit version evidence |
| `LiteratureFulltextAgent` | Observed-link IDs, bounded exploration, cache and session handoff         |

Try existing verified attachments, OA links, OpenAlex cache, source locations,
native resolvers and repository candidates before failure. Browser fallback is
feature-detected. HTML is limited to 5 MiB and PDFs to 100 MiB. Two workers
download concurrently; each acquisition has an approximately three-minute deadline.

Relative/malformed links and malformed records must not discard other valid
candidates. Missing version metadata stays unknown. File identity requires title
plus DOI or author, with supplement/review rejection; byte caches do not bypass
verification. Import only the verified temporary bytes and preserve the original.

Host-only transfer carries a page's isolated session or prepared PDF to download.
Never serialize cookies or browser objects to model output. Preserve durable
import receipts even when cancellation follows. Match identity aliases when a
paper merges during an in-flight import.

## Supplemental exploration and failure handling

Only failed, confirmed, unchanged candidates are eligible; cancelled or continued
batches cannot restart through AI tools. Capture invalidation before asynchronous
pool loading and abort active exploration on changes.

Limit each paper/revision to two searches, three download candidates and twelve
steps. Shared provider cooldowns do not consume per-paper attempts; source-only
listing is available. Recent failed URLs need fresh PDF/session evidence for a
bounded retry. Failed browser rendering is not immediately repeated.

Dispose session resources on success, cancel, revision change, removal or idle
expiry. Each cleanup must allow the rest to run. Malformed provider data and
resolver failures remain recorded fallback failures. Persistent storage failure
stops workers rather than restarting queued state forever; waiters must exit,
and a failed worker must not hide another still-active worker.

OpenAlex credentials go only to the allowed cache origin; authenticated search
requests refuse redirects. URL, DNS, redirect and browser-subresource checks
reject private targets. User-browser cookies and login automation are unavailable.

## UI, subagents and storage

One task owns one literature capsule and pool. Async UI results stay bound to that
task; closing a viewer does not cancel host work. Counts distinguish candidates,
fetched records, available PDFs and actually delivered reading evidence.

`SubagentManager` runs at most three children. Each receives explicit sources,
background, runtime/model settings and a parent run/intent binding. Host tools
enforce read-only scope; children cannot delegate, alter candidates or write
library/memory data. Parent cancellation/deletion fences queued and late work.

Child retries share consumed parent budgets. Completion requires both terminal
state and completed persistence. Unreported external usage remains unknown.

Pool revisions and child records live outside the main task index. A branch
copies the selected reply's literature revision and completed child results,
not running jobs. Deleting a task does not delete native library papers or PDFs.

See [development checks](development.md) and [historical evidence](acceptance/README.md).
