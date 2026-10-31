# Release 0.6.4-beta.3 acceptance — 2026-10-31 UTC

Original language: English.

## Source and candidate

The release source is identified by `v0.6.4-beta.3`. This Beta replaces the
unreleased PDF card with inline text references. A new conversation binds the
current reader once; the PDF is a prefilled reference at the beginning of the
composer. `@` materials and conversation references share its appearance and
atomic deletion behavior. Explicit unbinding survives polling and restart.

Root/workspace package versions, lockfile records and `CONFUCIUS_VERSION` agree
on 0.6.4-beta.3. Dependencies did not change. Draft reference positions and
identities are optional metadata alongside the existing plain-text draft.
No manual library migration is required; older drafts retain their text and
unambiguous existing references become inline controls. Removing a reference
never deletes Zotero library data or earlier conversation messages.
Unrelated local deployment/site configuration is excluded.

The locally tested ordinary XPI is **885,889 bytes**, SHA-256:
`5ef1b318de1480ad93100daf87722093a1560f4cf158b8554a313899884ab07f`.
It identifies `confucius@zotero.plugin`, version 0.6.4-beta.3, with the existing
compatibility range `6.999` through `10.*`. This acceptance covers Zotero 10.0.7
only. The build contains `confucius.xpi` and `update-beta.json`, without a stable
`update.json`. Manifest/update version, compatibility, download URL and SHA-512
match the actual XPI. Generated artifacts were not edited manually.
CI and public archive bytes require separate verification.

## Source validation

- `npm test`: **1,689 passed**, zero failures, skips or cancellations.
- `npm run typecheck`, `npm run lint`, `npm run build`, skill synchronization
  and version consistency: passed with Node.js 22.23.2.
- Regression coverage includes one-time reader binding, exact attachment
  identity, same-PDF page/selection refresh, explicit source removal, no automatic
  rebinding after removal, running-task rejection, distinct libraries, and
  validation of persisted reference ranges without trusting display titles.
- The release-note and tag validator uses the single CHANGELOG entry for this
  version. Publication does not reuse or overwrite 0.6.4-beta.2.

## Installed interface acceptance

`scripts/live-inline-composer.mjs` passed **17 check groups** using the ordinary
candidate XPI in isolated Zotero 10.0.7 on macOS. It uses synthetic papers and
conversations plus a local deterministic HTTP model; no personal library or
paid model credentials are needed.

The checks exercise the reader prefix, removal of duplicate source bars,
Backspace unbinding, explicit refresh after unbinding, undo, inline insertion
positions and identities, searchable reference replacement, independent removal,
IME safety, ordinary whitespace deletion, conversation references, plain-text
paste and line breaks, restart restoration, PDF switching, source locking during
an actual request, actual request contents, and cut/undo/redo of all references.
A subsequent restart retains removed references and explicit unbinding. A legacy
plain-text `@[Title]` draft hydrates without duplicating or rewriting its text.

Chinese/light at 14px and 1120px width, English/dark at 28px and 430px width, and
Zotero's native high-contrast preference were checked. Reference targets remain
at least 34px high, long titles ellipsize with full accessible labels, and the
workspace has no horizontal overflow. Screenshots were inspected. The shared
interface checklist was reviewed; the text references reuse the shared palette
and preserve keyboard focus without cards or decorative reader dividers.

These checks inject events into real Gecko windows. They do not establish human
manual gestures or screen-reader software acceptance. Windows, Linux, other
Zotero versions, separate native PDF reader windows and very large libraries
were not retested. Draft undo history is local to the current composer session;
the saved draft and source bindings survive restart, but its undo stack does not.

## Ordinary-package upgrade

`live-release-upgrade.mjs` passed **27 checks** from the unchanged public
0.6.4-beta.2 XPI, SHA-256:
`50063361df2cf0138622aee68bf11302bc2913ad8eafe35ffcca054c32669c1d`.
The final local candidate was installed through AddonManager in an isolated
profile. This establishes installed-package compatibility, not public updates.

Tasks, Chinese drafts, source identities, notes, annotations, memory, review
state, research artifacts, literature decisions, subagent traces, consumed
budgets and explicit update preferences survive repeated restarts. Continuing
an interrupted task reuses its completed write without duplicating it. Original
history and working-note bodies remain byte-identical; diagnostic export keeps
both working-note revisions. Raw reports, fixture libraries and screenshots
remain in ignored `output/`.

## Publication state at the release commit

Local preparation, installed interaction acceptance and ordinary-package upgrade
are complete. Tag CI, original public asset validation, three consecutive
anonymous release-list reads, both download paths and genuine unchanged-old-XPI
online upgrades must run after publication. Record their results in a follow-up
without moving the tag or replacing published files. This version is a prerelease
and must not replace the stable Latest release.
