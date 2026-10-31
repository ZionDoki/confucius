# Release 0.6.4-beta.2 acceptance — 2026-10-31 UTC

Original language: English.

## Source and candidate

The release source is identified by `v0.6.4-beta.2`. This Beta adds explicit
native API protocol selection and confirmed edits of historical user messages.
Protocol selection is independent of models.dev metadata. A confirmed edit
rebuilds the retained conversation, clears discarded history and checkpoints,
and starts the revised prompt with recoverable attachment text. Completed
library writes and accepted memories are not rolled back.

Root/workspace packages, the lockfile and `CONFUCIUS_VERSION` agree on
0.6.4-beta.2. Dependencies did not change. No manual library migration is
required. Existing endpoints retain automatic protocol detection; generic
gateway URLs continue using Chat Completions until another protocol is chosen.
Unrelated local deployment/site configuration is excluded.

The locally tested ordinary XPI is **878,901 bytes**, SHA-256:
`92a07874a4c9a9563c4c4908619a1a2f436619f86a3a2e7b22200d1140df5b84`.
The manifest identifies `confucius@zotero.plugin`, version 0.6.4-beta.2, with
the existing compatibility range `6.999` through `10.*`. This acceptance covers
Zotero 10.0.7 only. A clean build produced `confucius.xpi` and `update-beta.json`,
without a stable `update.json`. Update version, compatibility, download URL and
SHA-512 match the actual XPI. Generated artifacts were not edited manually.
CI archive bytes and public downloads require separate verification.

## Source checks

Environment: macOS 26.6.2 (ARM64), Zotero 10.0.7, Node.js 22.23.2.

- `npm test`: **1,681 passed**, zero failures, skips or cancellations.
- `npm run typecheck`, `npm run lint` and `npm run build`: passed.
- Workspace versions, skill synchronization and pinned venue catalogs passed.
  The catalogs contain 681 CCF2026 and 825 ICORE2026 records.
- `npm run release:check -- v0.6.4-beta.2`: passed, including the single CHANGELOG
  entry, version alignment and comparison against the previous public Beta.
- Changed documentation has 152 valid local file links; source whitespace and
  the credential-pattern check passed.
- Focused regressions cover stale and duplicate edit confirmations, running
  tasks, legacy event IDs, failed storage commits, interrupted cleanup recovery,
  removal of later searchable evidence and recovery of original attachments.
- Protocol fixtures cover routing, authentication, model catalogs, streaming,
  tools, page images, reasoning replay, cancellation, incomplete responses,
  structured quota failures and retry delays.

## Installed candidate and interface

Two isolated Zotero checks used the ordinary final candidate XPI, without a
temporary development addon or personal library. The chat check passed seven
groups: bubble copy, Gecko pointer selection and Cmd+C, edit/Enter/IME/cancel,
confirmed truncation and actual model request contents, selection during streamed
public reasoning, restart and compact English/dark layout, and native contrast
colors. Empty submissions and repeated confirmation do not execute extra
requests. The archive and next model request contain the retained prefix and
edited prompt, without the discarded suffix.

The protocol check passed eight groups: legacy Auto selection, real models.dev
imports preserving the endpoint route, workspace save, Zotero preference save,
restart and compact English/dark layout, and synthetic streamed tool exchanges
through Zotero's Responses, Anthropic and Gemini adapters. Chinese/light and
English/dark layouts include a 540px window with 20px text and no horizontal
overflow. The native contrast preference activates shared system colors for
the chat editor; its primary action uses `Highlight`. Screenshots were inspected.

The design checklist was reviewed against shared buttons, colors, focus,
spacing, readable wrapping and scrolling. Tests inject pointer and keyboard
events into actual Gecko windows; they do not establish human manual interaction
or other-platform acceptance. High-contrast protocol settings were not retested.

Before candidate preparation, a live Responses gateway completed streamed text
and a two-step synthetic tool exchange using `gpt-6.1-sol`, `max` effort and a
128,000-token output limit. Credentials and raw traces remain outside the
repository. Anthropic and Gemini have deterministic protocol/host coverage,
not live provider-account acceptance. Provider-hosted tools, audio/video
generation, Gemini Interactions and cloud-specific OAuth/AWS signing are outside
this change.

## Ordinary-package upgrade

`live-release-upgrade.mjs` passed **27 checks** from the unchanged public
0.6.4-beta.1 XPI, SHA-256:
`461f8c63e5bbfe57c7df9d261c0925939c78b27b08d60169be5514a920423b89`.
It installed the final local candidate through AddonManager in an isolated
profile. This establishes local package acceptance, not public online updates.

Tasks, Chinese/emoji drafts, notes, native annotations, research artifacts,
memory, pending review, literature decisions, subagents, execution receipts and
explicit update preferences survive the upgrade and repeated restarts.
Continuing a paused task reuses its completed write without creating a duplicate
note and preserves the consumed execution and maintenance budgets. Diagnostic
export retains both working-note revisions. The candidate digest matches the
package above.

Windows, Linux, other Zotero versions, manual pointer gestures and live publisher
PDF acquisition were not retested. Raw reports, synthetic libraries, screenshots
and machine paths remain in ignored `output/`.

## Publication state

At the release commit these results establish local preparation and installed
candidate behavior. Tag CI, original public asset verification, three consecutive
anonymous release-list reads, both XPI download paths and unchanged-old-package
online upgrade checks are pending publication. Record those results in a follow-up
without moving the tag or replacing published artifacts. This version must remain
a prerelease and must not replace the stable Latest release.
