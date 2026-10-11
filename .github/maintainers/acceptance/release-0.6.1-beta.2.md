# Release 0.6.1-beta.2 acceptance — 2026-10-11

Original language: English.

## Source and package

The candidate follows public 0.6.1-beta.1 (source
`0771afc65555c68854c18064776882eeee22a83b`) and starts from its acceptance follow-up
`c755ae97394639305e51a8d7fe84d15369124004`. The new source is identified by
`v0.6.1-beta.2`; the tag and published bytes must never be replaced.

This Beta adds CCF 2026 and ICORE2026 venue ratings in literature cards and list
rows, with edition years and source links. Local ShowJCR journal CSV imports
supply JCR, CAS and Xinrui ratings with all available subject partitions. Import
and removal refresh existing results while retaining review choices and domain
revisions. Catalogs persist across tasks and restarts. No data migration or
reconfiguration is required. Stable Latest remains 0.6.0.

Local production XPI SHA-256:
`6b14b45e9e6a3359d28b3667b813ad6e3acf6e3af1d9b46dc4d8d71224a0b95b`
(798,629 bytes). Its manifest is 0.6.1-beta.2 with addon ID
`confucius@zotero.plugin`. Manifest and update metadata agree on the unchanged
compatibility range `6.999` through `10.*`; this run exercised Zotero 10.0.6 only.

The clean build contains `confucius.xpi` and `update-beta.json`, with no stable
`update.json`. The update address names the exact Beta tag and the SHA-512 matches
the XPI. `scripts/release-assets.mjs` verified those fields. Local and CI ZIP
bytes may differ; publication must verify the original CI artifacts separately.

## Automated checks

On Node.js 23.10.0:

- `npm test`: **1,371 passed**, zero failures, skips or cancellations.
- `npm run versions:check`, `npm run sync-skills:check`,
  `npm run sync-venue-catalogs:check`, `npm run typecheck`, `npm run lint`,
  `npm run build` and `npm run release:check -- v0.6.1-beta.2` passed.
- The unused-version guard passed before publication. Package and lockfile
  changes update product versions only; dependency versions remain unchanged.

The [venue-rating source acceptance](venue-ratings-2026-10-11.md) records official
CCF/CORE cross-checks, complete ShowJCR parsing, live anonymous OpenAlex metadata
samples and matching limitations. Those earlier checks retain their original
source/build scope; they are not new package installation results.

## Native candidate acceptance

Environment: **macOS 26.6.2 (ARM64), Zotero 10.0.6, Node.js 23.10.0**. Tests used
ordinary installed XPIs in isolated profiles. The personal Zotero profile and
library were not used. Native suites ran sequentially to avoid focus conflicts.

`scripts/live-venue-ratings.mjs` passed **seven check groups** using the candidate
with the local digest above:

- CCF/CORE grades, edition years and actionable official links in native cards
  and list rows.
- Real local CSV reads, parsing, persistence and host events refresh the active
  card without changing choices, revisions or library items.
- All subject/major/minor partitions remain available in expanded details.
- Cancellation and invalid CSVs preserve catalogs; removal refreshes results.
- Light/dark themes, 420px/280px widths, enlarged fonts and native Gecko
  accessibility/high-contrast media preserve wrapping and scroll access.
- English and Chinese labels, including localized partition labels.
- Catalogs and candidate choices survive a real Zotero stop/relaunch.

File-picker selection was injected through the shared helper; the interactive OS
dialog was not automated. Model/OpenAlex transport used deterministic fixtures,
and indicator values were fictional. Host file reads and storage were real.

The same ordinary candidate also passed the existing native suites:
`scripts/live-annotation-review.mjs` (**128 checks**) and
`scripts/live-literature.mjs` (**37 check groups**), with no UI errors. They cover
shared annotation/candidate review, first-live opening and later reminders,
navigation, confirmation, native PDF import, browser/manual attachment, local
drag feedback, cancellation, continuation, receipts and restart recovery.

## Candidate upgrades and hot updates

Unchanged original public old packages were checked against their stored and
current GitHub asset metadata before reuse:

| Old XPI      |  Bytes | SHA-256                                                            |
| ------------ | -----: | ------------------------------------------------------------------ |
| 0.6.0        | 754442 | `bec8acf2a0c31ed96cf0b60983cce5767d82136b86f87b850839124c97cdc3ec` |
| 0.6.1-beta.1 | 756682 | `48a850dd396021f390417ff019fe964bc6a196b4a5266c9c8ce449a410574084` |

`scripts/live-release-upgrade.mjs` created data using each old ordinary XPI,
installed the candidate normally, and tested full restarts and explicit resume.

| Upgrade                     | Checks | Original history/working-note files | Explicit channel | Result |
| --------------------------- | -----: | ----------------------------------: | ---------------- | ------ |
| 0.6.0 → 0.6.1-beta.2        |     20 |                                  28 | Beta enabled     | Passed |
| 0.6.1-beta.1 → 0.6.1-beta.2 |     26 |                                  40 | Beta disabled    | Passed |

History and working-note originals retained their hashes. Notes, source
annotations, report revisions, memory/proposals, Chinese/emoji drafts, consumed
budgets and creation grouping remained available. Upgrade/restart did not
request a model or replay confirmed writes. Explicit continuation reused the
saved write. The old Beta fixture retained literature queries, papers, candidate
decisions, child research identities/results and trace events through another
restart. Explicit channel and independent automatic-check choices survived,
including an explicit stable choice when manually installing a Beta.

The comparison excludes only the live `venueRatings`/`venueRatingStatus`
projection from persisted paper comparisons; it still compares all saved paper
and decision fields. The new projection's refresh/revision contract has separate
unit and native tests.

The first old-Beta fixture run timed out before installation because the local
test model matched a write marker quoted in the child's language-context system
message. The fixture now recognizes that marker only in actual user messages.
The unchanged old XPI was rerun successfully; no old updater or model-runtime code
was replaced. The failed raw report remains in ignored output.

`scripts/live-update-window.mjs` passed **seven checks** from public 0.6.1-beta.1
to the local candidate. Hot installation retained the selected task, immediate
Chinese draft, collapsed task list and Update tab, and reported the actual new
version with `restartRequired=false`. Sidebar remount and staged-state rendering
passed. Repeated installations did not reopen a workspace the user had closed.
This suite uses a local package server and fixture discovery; it does not prove
public old-client discovery.

## Scope and publication state

No Windows/Linux, other Zotero versions, live external Codex/Kimi processes,
online model responses or interactive OS file-picker acceptance was run.
Synthetic libraries and local deterministic model/download responses avoid
personal data and paid services. Raw logs, reports, screenshots, source data,
profiles and package copies remain in ignored `output/` and scaffold directories.

At tag preparation, local source checks, ordinary-package feature acceptance,
candidate data upgrades and hot-update acceptance are complete. CI publication,
anonymous discovery/download verification and original-old-package online
upgrades are separate steps and are not yet claimed by this preparation record.
