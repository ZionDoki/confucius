# Release 0.6.4-beta.1 acceptance — 2026-10-30 UTC

Original language: English.

## Source and candidate

The release source is identified by `v0.6.4-beta.1`. This Beta simplifies the
existing completion and review paths: it removes the automatic report-revision
pass, stops treating incidental drafts as unfinished requests, and avoids an
implicit saved proposal for direct annotation suggestions. Review notifications
reuse the existing panels and arrival tracking. No new persisted queue, workflow
entity or separate quality-review agent is introduced.

Root/workspace packages, the lockfile and `CONFUCIUS_VERSION` agree on
0.6.4-beta.1. Dependencies did not change. No manual data migration is required;
saved proposals, review entries, write receipts and explicit update choices
remain readable. Unrelated local deployment/site configuration is excluded.

The locally tested ordinary XPI is **866,302 bytes**, SHA-256:
`d3982498be2db24a792b30d4702cc33217633b1736ca03501423eaec62211d9e`.
Its manifest identifies `confucius@zotero.plugin`, version 0.6.4-beta.1 and the
existing compatibility range `6.999` through `10.*`. Only Zotero 10.0.7 was
exercised here. A clean build produced `confucius.xpi` and `update-beta.json`,
with no stable `update.json`. The update record matches the versioned download
URL, manifest compatibility and actual XPI SHA-512. Generated artifacts were
not hand-edited. CI packages need separate digest verification because ZIP
metadata can differ.

## Source checks

Environment: macOS 26.6.2 (ARM64), Zotero 10.0.7, Node.js 22.23.2.

- `npm test`: **1,640 passed**, zero failures, skips or cancellations.
- `npm run typecheck`, `npm run lint` and `npm run build`: passed.
- Workspace version consistency, skill synchronization and pinned venue catalogs:
  passed. The catalogs contain 681 CCF2026 and 825 ICORE2026 records.
- `npm run release:check -- v0.6.4-beta.1`: passed. The generated release body
  compares against the previous public version, 0.6.3.
- Changed Markdown/source formatting, 178 local documentation file links and
  `git diff --check`: passed.
- Focused regressions cover explicit versus incidental drafts, completion across
  all runtime adapters, direct versus saved annotation proposals, resolved-source
  quality notices, rejection within and across user requests, and literature
  selection revision/continuation behavior.

Removed tests covered the deleted automatic report-revision feature. Adapter
cancellation and settings-snapshot checks from the former test file are retained
in `analysis-adapter.test.mjs`.

## Native review and interface checks

`live-annotation-review.mjs` passed **142 checks** with the ordinary final XPI in
an isolated real Zotero profile. The real workspace receives a turn-start event,
keeps incoming annotation suggestions minimized while generation is running,
then opens the pending review when the turn-completion event arrives without
another annotation batch. The composer retains its draft and focus.

The shared-panel checks cover accumulating several arrivals, acknowledging a
manual review, required literature decisions during execution, and preventing
repeated reopening. Existing native-write acceptance, individual rejection,
restore, uncertain-write reconciliation, task switching and restart persistence
also pass. Quality notices survive staging and are visible before acceptance.

The design checklist was reviewed against the existing workspace toolbar,
timeline and composer. There are no new palettes, button sizes or decorative
reader dividers. Native checks cover keyboard focus, IME, light/dark and compact
layouts, high contrast, reduced motion, minimized counts and accessible
announcements. The compact dark screenshot was inspected visually. Automated
events do not establish manual pointer-gesture acceptance on other platforms.

## Ordinary-package upgrade

`live-release-upgrade.mjs` passed **21 checks** from the unchanged public 0.6.3
XPI, SHA-256:
`28e81ac9ca8b563ef5186ce7fef904e706d2e6d1560275ebff5e8d42af9096db`.
It installed the final local candidate through AddonManager in an isolated
profile. This is local package acceptance, not public online-update acceptance.

Tasks, Chinese/emoji drafts, notes, native annotations, research artifacts,
memory, pending review, write receipts and explicit update preferences survive
repeated restarts. Continuing a paused task reuses the committed receipt without
duplicating its note. The candidate digest matches the final package above.

## Native-model observations and limits

These exploratory samples used the built-in native adapter with `deepseek-flash`
and synthetic source passages. They are separate from the deterministic source
and installed-package tests. Credentials and source traces remain outside the
repository.

- A direct annotation request for exactly two comments completed in one review
  batch, with two pending entries, three model calls and two tool calls
  (`get_pages`, `commit_annotations`). It did not create a saved proposal or
  write native annotations. The final sample took about 13 seconds and preserved
  the distinct 30/60 and 30/80 denominators. The initial sample over-interpreted
  one result as an ability ceiling; the final shared guidance removed that
  wording in the rerun, but comments remained relatively long and interpretive.
- The report-delivery challenge passed its structural checks, including a single
  report, citations, annotation components, denominators and tested scope. It
  took about 57 seconds. A malformed tool argument was recovered within the
  normal loop. There was no host-triggered second revision pass.
- The recovery challenge retained the same report and passed its other
  structural checks, but **failed `noPageRefetch`**: after context rollover the
  model reread pages 1–3, explaining that it needed the actual quoted evidence.
  It took about 33 seconds. No automatic revision pass ran.

These single samples are not a controlled before/after latency comparison or a
semantic-quality certification. The release removes specific redundant work;
it does not guarantee that the model will never reread, generate extra text or
overstate an inference. Quality notices remain advisory and user acceptance is
still required for native annotation writes. No extra model judge was added.

Windows, Linux, other Zotero versions, manual pointer gestures and live publisher
PDF acquisition were not retested. Native package tests use synthetic libraries
and deterministic model fixtures. Raw logs, screenshots, machine paths and model
traces remain in ignored `output/`.

## Publication state

At the release commit these results establish local preparation and installed
candidate behavior. Tag CI, original public asset verification, three consecutive
anonymous release-list reads, API/browser downloads and an unchanged-old-package
online upgrade are pending publication. Record those results below without
moving the release tag or replacing public artifacts. This release must remain a
prerelease and must not replace the stable Latest release.
