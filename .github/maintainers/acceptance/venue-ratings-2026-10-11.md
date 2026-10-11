# Venue ratings acceptance — 2026-10-11

Original language: English.

[Acceptance archive](README.md) · [Current catalog contract](../venue-ratings.md)

This records an **unreleased working-tree change** on `codex/annotation-review`.
The ordinary development XPI retains the existing source version
`0.6.1-beta.1`. No version, published tag, Release or package was changed by this
work. A future publication requires a higher version and the full
[release procedure](../releases.md).

## Behavior

- Literature cards and list rows automatically show matched CCF 2026 and
  ICORE2026 ratings, edition years and actionable official source links.
- Local ShowJCR journal CSV imports supply JCR, CAS and Xinrui ratings. Expanded
  details retain all available categories, quartiles, partitions, Top flags,
  impact factors, positions and import filenames. CAS and Xinrui remain separate.
- Importing or removing a catalog refreshes existing candidate metadata without
  changing decisions, domain revisions, arrival cues, Zotero fields or tags.
  Catalogs persist across tasks and restarts. Same-system/year imports replace
  that edition; display uses the newest imported edition of each system.
- Matching is conservative: conflicting identities, unsupported tracks and
  unidentified venues stay unmatched. Catalog years describe the rating edition,
  not a paper's publication year or quality.

## Automated validation

- `npm test`: **1,371 tests passed**, with no failures, skips or cancellations,
  including 17 new venue-rating tests.
- `npm run typecheck`, `npm run lint` and `npm run build` passed.
- `npm run sync-skills:check`, `npm run sync-venue-catalogs:check` and
  `git diff --check` passed.
- New regressions cover exact names/ISSNs, reviewed conference aliases,
  proceedings prefixes, source/track scope, collisions, real-format CSV fields,
  invalid and conflicting years, bounded parsing, atomic/concurrent replacement,
  latest-edition selection, removal, restart and corrupted-import recovery.
- Shared-review regressions verify that changed metadata at an equal pool
  revision refreshes the view while preserving choices, view/filter/position,
  bulk selection and quiet arrival semantics. Older revisions remain ignored.

## Source verification

The pinned CCF community transcription was compared with the official
seventh-edition PDF: **681 of 681** names, abbreviations and A/B/C grades matched
after whitespace/punctuation normalization. The independently listed HotNets
workshop's official grade C was also visually checked.

The pinned CORE transcription was compared with the official ICORE2026 CSV:
**825 ranked entries** out of 987 exported rows had no missing, extra or mismatched
names, abbreviations or grades after whitespace normalization. Entries without a
supported rank were excluded.

Complete real ShowJCR UTF-8 files were parsed locally: JCR2025 (22,643 journal
entries), FQBJCR2025 (21,772) and XR2026 (22,299). These datasets remain in ignored
local output and are not bundled or committed. Automated and native fixtures use
fictional indicator values.

Anonymous live OpenAlex samples also checked metadata conversion and matching:
an arXiv preprint stayed unranked; an ICASSP conference paper matched CCF B; an
AAAI proceedings paper matched CCF A and CORE A*. Unidentified venues stayed
unmatched. These checks exercised live metadata, not model-generated answers.

## Native Zotero validation

Environment: **macOS 26.6.2 (ARM64), Zotero 10.0.6, Node.js 23.10.0**. Native
scripts ran sequentially using ordinary built XPIs in isolated profiles. The
personal Zotero profile and library were not used.

`node --import tsx scripts/live-venue-ratings.mjs` passed **7 check groups**:

- Cards and lists display grades, edition years and actionable source links.
- CSV file reads, parsing, storage and host events refresh the active card while
  retaining decisions, domain revisions and the native library.
- Expanded details retain all subject/major/minor partitions.
- Picker cancellation and invalid files preserve existing catalogs; removal
  immediately refreshes displayed results.
- Light/dark themes, 420px and 280px widths, enlarged 18px fonts and Gecko's native
  accessibility/high-contrast preference retain wrapping, scrolling and access
  to controls.
- English and Chinese labels, including localized partition labels, display
  correctly.
- Imports survive a real Zotero stop/relaunch and continue enriching candidates.

The final build also passed the existing native suites:
`scripts/live-annotation-review.mjs` (**128 checks**) and
`scripts/live-literature.mjs` (**37 check groups**), with no UI errors. These cover
shared annotation/candidate review, navigation, reminders, confirmation,
acquisition/import, receipts and restart recovery.

Tested ordinary XPI SHA-256:
`9cf3a5108e670a05c4aa94a99f7c966d42a6aff1f127a3dd2ddab9401771cb49`.

Raw reports, screenshots, downloaded source data and isolated profiles remain in
ignored `output/` and scaffold directories.

## Interface checklist and limits

- Ratings use shared workspace typography, neutral color variables and control
  sizes. They appear before long candidate reasons; source details use existing
  expansion controls and do not add reader decoration or grade-based colors.
- Regular/compact layouts, wrapping, horizontal overflow, scrolling, English and
  Chinese, light/dark themes and accessibility contrast were checked in native
  Zotero. Narrow panels remain scrollable rather than fitting every detail at
  once.
- Busy, disabled, empty, cancelled and error states, source-link focus and
  refresh retention were checked. Both user-guide and design-rule language
  versions were updated, and required tests/type checking passed.

The CSV picker selection was injected through the shared picker helper; the
interactive operating-system file dialog was not automated. File reading and
catalog persistence used the real host implementations. Native model/OpenAlex
transport used deterministic fixtures; online model responses were not tested.
Windows/Linux, other Zotero versions, installed-package upgrades and a new public
release were not tested. Historical per-paper-year lookup, arbitrary CSV schemas
and Xinrui conference imports are outside this implementation.

This acceptance record is evidence for this source/build only, not for a later
release.
