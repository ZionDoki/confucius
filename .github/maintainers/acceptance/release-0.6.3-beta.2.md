# Release 0.6.3-beta.2 acceptance — 2026-10-29 UTC

Original language: English.

## Source and candidate

The release source is identified by `v0.6.3-beta.2`. It includes
[@justanotherjurastudent's Flex Annotations contribution](https://github.com/ZionDoki/confucius/pull/12),
the approval/review follow-up `1b008f7`, and the two reviewed work groups:
`c0d0531` (prompt execution budgets and write recovery) and `ecc1c5c`
(literature retrieval, ranking, cancellation and child query snapshots).
Master was fast-forwarded to the two commits without rewriting their hashes or
authors. All contributor commits remain ancestors. The unrelated local Yufeng
configuration files are excluded and unchanged.

Root/workspace packages, the root lockfile and `CONFUCIUS_VERSION` agree on
0.6.3-beta.2. Dependencies did not change. No manual data migration is required.
Existing custom execution limits and explicit update-channel choices remain.
MCP clients coming from 0.6.2 still need the separate read-only token introduced
by Beta 1; Beta 1 users do not need another credential change.

The locally tested ordinary XPI is **860,876 bytes**, SHA-256:
`d89a583e4d3fbdcaab909cfce8076b1b39ecddc3fbf9febc71f477a4cad5584a`.
Its manifest identifies `confucius@zotero.plugin`, version 0.6.3-beta.2 and the
unchanged compatibility range `6.999` through `10.*`. Only Zotero 10.0.6 was
exercised here. The clean build contains `confucius.xpi` and `update-beta.json`,
with no stable `update.json`. The update record matches the manifest, the
versioned Beta download URL and the XPI's SHA-512. Generated files were not
hand-edited; CI archive bytes need their own size/digest verification.

## Source checks

Environment: macOS 26.6.2 (ARM64), Zotero 10.0.6, Node.js 22.23.2.

- `npm test`: **1,652 passed**, zero failures, skips or cancellations.
- Type checking, lint, production build and release validation: passed.
- Version consistency, skill synchronization and pinned venue catalogs: passed.
- Published-release overwrite guard: passed; the version/tag was unused.
- Regressions cover retained interrupted-write receipts after allowance renewal,
  newest-query cache reuse after refresh, mixed reranked/unreranked pages,
  consistent impact units, cancellation while queued or projecting results,
  and child-owned query membership with frozen acquisition/source snapshots.
- New tests accompany both work groups. Existing continuation, child lifecycle,
  approval and PDF evidence tests also pass.

## Ordinary-package installation and upgrades

The original public packages used for upgrades were unchanged:

| Version      | SHA-256                                                            |
| ------------ | ------------------------------------------------------------------ |
| 0.6.2        | `d3bcd2c4f9254a0b6160c70803f53b37dc1bb6e3fd71ec111990868e1d616a81` |
| 0.6.3-beta.1 | `2bc9f761022e7e2a8eeee43a82001dec233b54061bbafb99ed49e230edcb6d62` |

`live-release-upgrade.mjs` installed each old package normally, populated a
synthetic library, then installed the candidate through AddonManager. All
**21 checks from 0.6.2** and **27 checks from Beta 1** passed. These are local
package upgrades, not claims of public online-update acceptance.

Task/request identity, Chinese drafts, sources, notes, annotations, artifact
revisions, memory/proposals, budgets and explicit channel/automatic-check
preferences survive the upgrade and repeated restarts. The Beta 1 scenario
also preserves its literature pool and completed child's trace. All **28**
stable-source and **40** Beta-source history/working-note bodies remain
byte-identical. Upgrade does not restart model execution. Automatic continuation
consumes the existing allowance and reuses the committed note without a duplicate.

`live-update-window.mjs` passed **eight checks** with the ordinary Beta 1 and
candidate packages. Open settings hot updates preserve the selected task,
immediate Chinese draft, collapsed task list and Update tab; open preferences
reload, sidebar installation remounts one sidebar, and an already closed
workspace stays closed. Completed installation reports the actual new version
with `restartRequired=false`. Staged-until-restart message rendering is simulated,
not a claim that this run exercised an actual staged installation.

## Feature acceptance on the candidate

- `live-prompt-budget.mjs`: **seven checks**. A real collection write is saved
  before an injected interrupted checkpoint. Automatic continuation retains
  exhaustion; a typed continuation renews counters, retains cumulative usage,
  replays the saved write receipt, performs a fresh native read and completes
  with only one real collection.
- `live-literature-ranking.mjs`: **eight checks**. Installed service/provider
  paths preserve refreshed caches, reranked cohorts and consistent impact units;
  cancelled waiters remain cancelled. Child archives reload with query-scoped
  shortlists/pagination, preserve their acquisition snapshot and reject a
  parent-only query.
- `live-literature.mjs`: passed all assertions in **37 reported entries**
  (including environment metadata). Real Zotero/PDF/import flows, literature
  selection, child execution, continuation, restart, light/dark and narrow
  layouts pass with deterministic network/model fixtures and no captured UI errors.
- `live-organizer.mjs`: **17 checks** with the real Flex Annotations **3.0.0**
  plugin. API/stored-outline parity, collection isolation, unassigned queries,
  approval-before-write, per-item rejection, PDF links, explicit preview without
  writes and scoped unassignment pass. Shared controls remain usable at
  1100/420/300 px, in light/dark/high-contrast and keyboard-focus states.

## Limits and publication state

At the release commit, the checks above establish local preparation and installed
candidate behavior. Tag CI, original public asset verification, three consecutive
anonymous release-list reads, API/browser downloads and unchanged-old-package
online updates are pending publication. Record their actual results in a
follow-up section without moving the release tag or replacing public artifacts.

All device checks use isolated profiles and synthetic libraries. Model/OpenAlex
responses are deterministic fixtures; no personal library or paid model account
was used. Windows, Linux, other Zotero versions, live model providers, publisher
PDF access, external CLI authentication and manual desktop drag gestures were not
retested. Historical results are not presented as new Beta 2 validation.
Raw logs, machine paths, synthetic traces and test profiles remain in ignored
`output/`; they are not part of the release source or artifacts.
