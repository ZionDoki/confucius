# Release 0.6.4-beta.4 acceptance — 2026-10-31 UTC

Original language: English.

## Source and candidate

The release source is identified by `v0.6.4-beta.4`. Root/workspace package
versions, lockfile records and `CONFUCIUS_VERSION` agree. Dependencies and data
formats did not change. No library migration or model reconfiguration is needed.
The [earlier local candidate record](composer-selection-2026-10-31.md) documents
the initial polling fix; this final candidate also fixes selection displacement
when references change and restores the bound PDF before other materials.

The final ordinary candidate XPI is **885,924 bytes**, SHA-256:
`9e7b1a83581a8c54507cccc8bfb2073f8afa15fa19fe757e8a2ba027065b5038`.
It identifies `confucius@zotero.plugin`, version 0.6.4-beta.4. Manifest and update
metadata retain the existing Zotero range `6.999` through `10.*`. This acceptance
covers Zotero 10.0.7 only. Beta output contains `confucius.xpi` and
`update-beta.json`, without a stable `update.json`; version, compatibility,
download URL and SHA-512 must match the package. CI/public archive bytes require
separate verification. Generated files were not manually edited.

## Review and source checks

An unchanged-text assignment rebuilt the editable DOM during the 800 ms poll,
resetting an interior caret from offset 22 to 0 in public beta.3. Unchanged text
and reference labels now retain their nodes. The additional review reproduced
another case in the earlier local candidate: adding a reference before a prose
caret restored an obsolete serialized offset. Source reconciliation now leaves
the browser's native selection anchors intact. Retained materials are inserted
after the existing PDF prefix rather than in front of it.

- `npm test`: **1,689 passed**, zero failures, skips or cancellations.
- Type checking, lint, production build, workspace versions and skill
  synchronization passed using Node.js 22.23.2.
- Release notes use the single CHANGELOG entry for this version and compare
  against public beta.3. No published version, tag or package is overwritten.
- The shared interface checklist was reviewed. There are no palette, typography
  or spacing changes; selection and focus behavior preserve the existing design.

## Installed interaction acceptance

The final ordinary XPI passed **14 groups** in `live-composer-selection.mjs`:
idle polling in an empty workspace, continued typing, backward text selections,
long-draft scrolling, composition and its completion, saved-task source refresh,
selection across references, external focus, task switching, native line breaks
and blank lines, insertion-point preservation when adding a source, backward
selection preservation when removing an earlier source, and PDF prefix order
when retained materials return. Idle checks span three polling intervals and
observe child/text mutations as well as caret, selection, focus and scroll.

`live-inline-composer.mjs` passed **17 groups**, covering PDF auto-binding,
explicit unbinding, exact source identities, insertion and searchable replacement,
atomic deletion, undo/redo, IME-safe commands, ordinary whitespace, conversation
references, plain-text paste, restart, PDF switching, running-task source locks
and actual model request contents. Chinese/light at 14px and 1120px width,
English/dark at 28px and 430px width, and native high contrast were checked.
The test waits for the workspace to reflect host completion before editing
sources, matching the intentionally retained running-task lock.

Both suites use real Gecko in isolated macOS Zotero 10.0.7 with synthetic papers
and conversations. Model requests use a local deterministic HTTP fixture.
Composition events are injected; this does not establish human-operated IME or
screen-reader acceptance. Windows, Linux, other Zotero versions, separate native
reader windows, very large libraries and live provider accounts were not
retested. Draft undo history remains local to the composer session.

## Ordinary-package upgrade

`live-release-upgrade.mjs` passed **27 checks** from the unchanged public beta.3
XPI, SHA-256
`ad63d5b0c432ef30103150536e2ab2ef2d24907b0dada78b4f9e13d9340358b7`,
to the final candidate through AddonManager in an isolated profile. Tasks,
Chinese drafts, source identities, notes, annotations, research artifacts,
memory, literature decisions, subagent traces, budgets and update preferences
survive repeated restarts. Resuming an interrupted task reuses its completed
write instead of duplicating it. Historical source bodies and original notes
remain unchanged, and diagnostic export retains both working-note revisions.
Raw reports, profiles and screenshots remain in ignored output.

## Publication state at the release commit

Local preparation, installed interactions and ordinary-package upgrade are
complete. Tag CI, original public asset validation, three consecutive anonymous
release-list reads, both download paths and unchanged-old-package online upgrades
must run after publication. Record those results in a follow-up without moving
the tag or replacing published files. This Beta must not replace stable Latest.
