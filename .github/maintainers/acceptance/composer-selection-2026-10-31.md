# Composer selection regression — 2026-10-31

Original language: English.

This record covers the initial local candidate at commit `190f4fa`. Subsequent
review and release acceptance are recorded separately in
[Release 0.6.4-beta.4](release-0.6.4-beta.4.md).

## Reproduction and fix

The unchanged public 0.6.4-beta.3 XPI reproduced the reported caret jump in
isolated Zotero 10.0.7 on macOS. In an empty workspace, a multiline draft's
collapsed selection moved from offset **22 to 0** after polling. The text
itself remained intact. `refreshSessions` writes the cached draft every 800 ms;
the inline editor's value setter rebuilt its children even for identical text.

The setter now preserves the existing DOM when its serialized text is unchanged.
Reference synchronization also skips unchanged titles and label text. Native
caret, selection direction, scroll and composition survive these background
refreshes. Explicitly changed values and task resets still update the editor.
Shared visual rules, source identity rules and storage formats did not change.

The local candidate uses **0.6.4-beta.4** to distinguish it from the immutable
published beta.3. Root/workspace packages, the lockfile and protocol version
agree. The XPI is **885,945 bytes**, SHA-256
`628a844f395d95f0910404c174ab4c4486735267530043e39ee3faf305283950`.
This is a local candidate, not a published release; its changes remain under
CHANGELOG's Unreleased heading.

## Validation

- `npm test`: **1,689 passed**, zero failures, skips or cancellations.
- `npm run typecheck`, `npm run lint`, `npm run build` and workspace version
  consistency passed with Node.js 22.23.2.
- `live-composer-selection.mjs`: **10 groups passed** in real Gecko, covering
  empty-workspace polling, subsequent typing at the retained position, backward
  selections, long-draft scrolling, composition and its completion, saved-task
  reference refresh, selection across references, external focus and deliberate
  task switching. Each idle check spans three polling intervals and verifies no
  child/text mutation in the unchanged editor.
- `live-inline-composer.mjs`: **17 groups passed**, including source deletion,
  undo/redo, PDF switching, persisted drafts, actual model request contents,
  Chinese/light, narrow English/dark with 28px text, and native high contrast.
  An initial run raced the source lock after host completion. The harness now
  waits for the workspace's next poll to restore its idle controls before
  attempting a cut; the repeated run passed. The source lock remains intact.
- `live-release-upgrade.mjs`: **27 checks passed** from the unchanged public
  beta.3 XPI to this candidate, including drafts, source bindings, notes,
  annotations, research artifacts, memory, budgets, write receipts and update
  settings across repeated restarts.

The exact tested candidate was installed through the native Plugins Manager in
the existing local Zotero profile. The enabled version is 0.6.4-beta.4, installed
bytes match the candidate above, and the open workspace retains its existing
draft references. No tag or GitHub Release was created and no published package
was overwritten.

Both native suites use isolated profiles and synthetic material. Composition
uses injected events, not a human-operated IME. Windows, Linux, other Zotero
versions, screen readers and live provider accounts were not tested. Raw logs,
screenshots and fixture profiles remain outside the committed record.
