# Release 0.6.1 acceptance — 2026-10-11 UTC

Original language: English.

## Source and package

The stable candidate starts from public 0.6.1-beta.2 and its acceptance follow-up
`657c97e`. Release source is identified by `v0.6.1`; the published tag and package
must never be replaced. This release also summarizes the changes since stable
0.6.0: shared annotation/candidate review, local file-drop feedback, workspace
lifetime fixes, venue ratings and local ShowJCR imports.

New appearance controls offer eight offline presets and actual installed fonts,
12–28 px sizes and 1.2–2.4 reading line heights. Independent light/dark palettes,
top settings tabs and the same Appearance/Runtime editors work in both entry
points. Save applies drafts without a preview; Cancel and Reset preserve their
documented boundaries. No data migration or reconfiguration is required.

The final ordinary local XPI is **809,812 bytes**, SHA-256:
`546b0eb94da66acd1011c89200d92b374c1363abe03a0f3af22b07e42901f389`.
Its manifest names version 0.6.1 and addon ID `confucius@zotero.plugin`.
Manifest and update files agree on the unchanged `6.999` through `10.*`
compatibility range. This acceptance exercised Zotero 10.0.6 only.

The clean build contains `confucius.xpi`, `update.json` and `update-beta.json`.
Both update files name the exact stable download address and have the SHA-512
of that XPI. `scripts/release-assets.mjs` verified filenames, manifests, versions,
compatibility and checksums. Local and CI ZIP bytes may differ; original public
CI artifacts require separate verification.

## Automated source checks

On Node.js 23.10.0:

- `npm test`: **1,376 passed**, zero failures, skips or cancellations.
- Version consistency, skill synchronization, pinned CCF/ICORE synchronization,
  type checking, full lint and full production build passed.
- All workspace versions, lockfile versions and `CONFUCIUS_VERSION` are 0.6.1.
  Dependency versions did not change. The unused-release guard passed.
- Release-note validation passed; publication uses only the body generated from
  CHANGELOG.

## Native feature and race acceptance

Environment: **macOS 26.6.2 (ARM64), Zotero 10.0.6**. Tests used ordinary installed
XPIs, isolated profiles and synthetic libraries. Native suites ran sequentially.
No personal Zotero profile or library was modified.

| Suite                                  |    Checks | Result |
| -------------------------------------- | --------: | ------ |
| `scripts/live-appearance-settings.mjs` | 24 groups | Passed |
| `scripts/live-venue-ratings.mjs`       |  8 groups | Passed |
| `scripts/live-annotation-review.mjs`   |       128 | Passed |
| `scripts/live-literature.mjs`          | 37 groups | Passed |
| `scripts/live-update-window.mjs`       |         8 | Passed |

The settings suite checks saved/cancelled/reset drafts, invalid-input atomicity,
real installed font search and keyboard selection, decimal values and restart.
Open embedded/detached readers and selection-question popups update together.
Maximum-size question inputs grow without clipping and remain within the reading
area. Confucius styles do not leak into other Zotero preference panes.

Style comparisons and screenshots cover warm, neutral and custom light/dark
palettes, English/Chinese, 12–28 px fonts and 280/420/620/1,000 px workspace widths.
Zotero preferences retain their actual 800 px minimum width. Controls, headings,
buttons and selected/error/hover/disabled states agree across both entry points;
native top tabs and Appearance actions remain visible while scrolling. Native
Gecko high contrast overrides custom colors; primary label and keyboard-focus
contrast measures 5.01:1 against the button background. Background-window focus
style checks temporarily use a Gecko pseudo-class lock, distinct from manual
OS-level keyboard testing.

Delayed real-host RPCs exercise these race boundaries:

- Pending saves freeze the submitted draft and block repeated submission,
  cancellation, dialog closing and draft replacement; controls recover on error.
- Initial retrieval reads preserve newly typed keys. Save/Clear/Test are serial;
  no real credentials or external connection tests are used.
- Catalog selection blocks duplicate imports, removal and refresh. Cancelling
  the held picker preserves all existing catalogs.
- Repeated Update-page opening shares one pending request and cannot toggle the
  settings dialog closed. Saved language updates Runtime and Update labels.
- Empty manual runtime paths focus an enabled input; first ArrowUp/ArrowDown
  selects the last/first font option correctly.

Annotation/literature regressions cover shared review, first-live opening, later
reminders, card/list navigation, candidate confirmation, native PDF import,
attachment/drop feedback, cancellation, continuation, receipts and restart.
Venue checks cover actual local CSV reads and persistence, category display,
import/removal refresh, retained review choices and restart.

## Candidate upgrades and hot updates

Original public old XPIs were retained unchanged and verified against their
GitHub asset metadata:

| Old package  |  Bytes | SHA-256                                                            |
| ------------ | -----: | ------------------------------------------------------------------ |
| 0.6.0        | 754442 | `bec8acf2a0c31ed96cf0b60983cce5767d82136b86f87b850839124c97cdc3ec` |
| 0.6.1-beta.2 | 799485 | `3f35c4d98e4e3d90d07db7b431b8e8e2d16366c18db0eb5555d99d127166d56a` |

`scripts/live-release-upgrade.mjs` created data with each old ordinary package,
installed the candidate normally and checked real restarts and explicit resume.

| Upgrade              | Checks | Explicit channel | Result |
| -------------------- | -----: | ---------------- | ------ |
| 0.6.0 → 0.6.1        |     21 | Beta enabled     | Passed |
| 0.6.1-beta.2 → 0.6.1 |     27 | Beta disabled    | Passed |

Original history and working-note files retained their hashes. Source
annotations, notes, report revisions, memory/proposals, Chinese/emoji drafts,
creation grouping and consumed budgets survived. Upgrade/restart did not request
a model or replay confirmed writes. Explicit continuation reused the saved
receipt. Old-Beta literature queries, papers, decisions, research-child identities,
results and trace events survived another restart. Channel and independent
automatic-check choices remained explicit and persistent.

Legacy serif font, integer size, dark theme and compact line height survived
upgrade; compact converts to its actual 1.45 multiplier. The first fixture run
incorrectly expected 1.4, failed that added assertion, and was corrected to the
existing protocol value. Both old packages then passed, and the final candidate
was tested again. No production migration change was needed for that failure.

Eight local hot-update checks retain the selected task, immediate draft,
collapsed task list, layout and Update tab without manual reopening. The actual
new version reports `restartRequired=false`. An already open Zotero preferences
window loads the new six tabs, editor, shared button styles and versioned palette.
Repeated hot installs and ordinary disable/enable do not reopen a workspace that
the user had already closed. Staged-restart feedback is tested separately.

## Scope and preparation state

Windows/Linux, other Zotero versions, live external Codex/Kimi authentication,
online model responses, interactive OS file dialogs and manual desktop drag
gestures were not exercised. Runtime path persistence uses external hosting
disabled. Picker fixtures still perform real host file reads/storage. Literature
and model transports are deterministic fixtures; journal indicators are fictional.
Rating edition and matching limitations remain as documented in the historical
[venue-rating acceptance](venue-ratings-2026-10-11.md).

Source checks, ordinary-package feature/regression tests, candidate upgrades and
hot updates are complete at tag preparation. CI publication, anonymous public
discovery/download verification and unchanged-old-package online upgrades are
separate post-publication acceptance steps and are not claimed by this preparation
record. Raw logs, reports, screenshots, libraries, profiles and package copies
remain in ignored output and scaffold directories.

## Public package acceptance

Release source: `9d5f06f7179540f61554d1df31ad4abb26671b50`.
[Tag CI](https://github.com/ZionDoki/confucius/actions/runs/38156992811) and
[master CI](https://github.com/ZionDoki/confucius/actions/runs/38156992737) passed
on Node.js 22 and 24. Each Node version passed all **1,376 tests** with zero
failures, skips or cancellations. Type checking, full lint, skill/version checks
and production builds passed. The release job verified complete uploaded draft
assets before publication, then passed consecutive anonymous discovery and both
XPI download paths.

[Confucius v0.6.1](https://github.com/ZionDoki/confucius/releases/tag/v0.6.1)
was published at **2026-10-11T16:51:04Z**, release ID `409795343`, with
`draft=false` and `prerelease=false`. It is the stable **Latest** release.
Title, tag and body match the notes generated from CHANGELOG.

| Original public CI artifact |  Bytes | SHA-256                                                            |
| --------------------------- | -----: | ------------------------------------------------------------------ |
| `confucius.xpi`             | 810224 | `e3a8dc8e1c69f3f1d42ce91a930990fbf4c3c94c960483898a28eecc9de6de2d` |
| `update.json`               |    573 | `3c87b5d85f9a9becd8a224dcddc6cc68c3bd4cc334e6a639e62ce235a7bb0b8b` |
| `update-beta.json`          |    573 | `3c87b5d85f9a9becd8a224dcddc6cc68c3bd4cc334e6a639e62ce235a7bb0b8b` |

All **19 unpacked files** have identical names and SHA-256 digests between the
tested local candidate and the original public CI XPI. ZIP metadata/compression
accounts for the archive-byte difference. Public artifacts were retained as
downloaded and were not substituted with a local rebuild.

A separate local run of `scripts/release-assets.mjs --public` used those original
public files and passed three consecutive anonymous release-list reads plus both
the asset-API and browser download paths. Uploaded states, display filenames,
sizes, SHA-256 digests, manifest, stable/Beta update metadata, SHA-512 and versioned
download addresses all passed inspection.

## Original-old-package online upgrades

`scripts/live-legacy-update.mjs` passed **13 checks each** from public 0.6.0 and
0.6.1-beta.2 to the original public 0.6.1 package. Tests used each old XPI's
unchanged updater and real GitHub endpoints in isolated Zotero, without replacing
reported versions, discovery responses, asset responses or download bytes.

Both old packages discovered and installed the higher stable release with Betas
disabled. A full restart confirmed version 0.6.1 and the exact public XPI digest.
Tasks, Chinese drafts and explicit channel choices survived; automatic checks
remained independent. Already-current checks did not reinstall, disabling Betas
did not downgrade, and the stable choice survived another restart.

The full `scripts/live-release-upgrade.mjs --public` data suites also used the
unchanged old updaters and original public new package:

| Suite                                       | From         | Checks | Explicit channel | Result |
| ------------------------------------------- | ------------ | -----: | ---------------- | ------ |
| `scripts/live-legacy-update.mjs`            | 0.6.0        |     13 | Stable           | Passed |
| `scripts/live-legacy-update.mjs`            | 0.6.1-beta.2 |     13 | Stable           | Passed |
| `scripts/live-release-upgrade.mjs --public` | 0.6.0        |     29 | Beta             | Passed |
| `scripts/live-release-upgrade.mjs --public` | 0.6.1-beta.2 |     35 | Stable           | Passed |

Every installed new XPI matched the original public CI digest after a full
restart. All original history/working-note hashes remained intact (28 files from
stable and 40 from the previous Beta). Source annotations, notes, report
revisions, memory/proposals, drafts, creation grouping and consumed budgets
survived. Upgrade/restart did not request a model or repeat a confirmed write;
explicit continuation reused the stored receipt. The old Beta's saved research
queries, papers, decisions, child identities/results and trace events survived
another restart. Legacy serif font, integer size, compact line height and dark
theme retained their values.

Source preparation, local ordinary-package feature/regression tests, candidate
upgrades, hot updates, Node.js 22/24 CI, public asset/discovery/download checks and
original-old-package online data upgrades are complete. The tag, release source
and public artifacts remain unchanged. No personal Zotero installation or
library was modified.
