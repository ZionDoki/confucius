# Native composer editing — 2026-10-31

Original language: English.

## Reproduction and scope

The unchanged public **0.6.4-beta.4** package reproduced the user's report in
Zotero 10.0.7 on macOS using OS-level keyboard input. After typing `abcde` after
an inline reference, the caret moved from serialized offset 38 to 0 at the next
poll. Backspace then deleted nothing; subsequent typing appeared at the front.
The editor's own text nodes had not been replaced.

The sidebar mounted its HTML contenteditable directly in Zotero's XUL library
document. Replacing an unrelated text node, including a usage/status label,
reset that editor's selection. Updating one label could not protect against
other workspace or Zotero changes. A plain chrome iframe also let native window
navigation take focus after an arrow key. The detached chrome window exhibited
the latter problem with OS-level input.

Both layouts now host the existing workspace document in a non-remote content
browser, following Zotero's note-editor hosting model. This separates HTML
editing and native command handling from chrome. Snapshot capture, hot-update
restoration and disposal resolve the embedded document, while the outer window
retains library ownership. Nested unload events cannot dispose the outer view.
Source identities, stored drafts, visual styles and permission rules are unchanged.

Earlier acceptance records retain their original results. Their scripted ranges,
`execCommand` calls and synthesized key events in a detached window did not
establish the native sidebar behavior reported here.

## Candidate

This is an **unpublished local 0.6.4-beta.5 candidate**, not a replacement for the
published beta.4 asset. Changes remain under CHANGELOG's Unreleased heading.
The ordinary XPI is **886,554 bytes**, SHA-256:

`86c64c9416bc416660c0b9af368b6f4c05376a7c62ca84b9aeb245123a4f58f1`

The root/workspace/lockfile/protocol versions, XPI manifest and Beta update file
agree. Its SHA-512 update hash was verified. A subsequent full production build
had identical contents in all 25 uncompressed XPI entries.

The exact candidate was then installed into the existing local Zotero profile
through the native Plugins Manager. It showed version **0.6.4-beta.5** enabled;
the installed file matched the candidate SHA-256 byte for byte. The previously
open task and both unsent inline references survived the hot update. The old
beta.4 XPI was backed up locally. No prompts were submitted from that profile.

## Validation

- **1,689 automated tests passed**, with no failures, skips or cancellations;
  type checking, lint, production build and workspace version checks passed on
  Node.js 22.23.2. The window lifecycle test also covers a child unload using the
  same document URL as its owning window.
- OS-level keyboard input passed in both sidebar and detached layouts: typing,
  idle caret retention, Backspace, forward Delete, arrow movement, insertion in
  the middle, Shift+Enter, backward selection and selection replacement.
  Native @ selection, atomic reference deletion, PDF autobinding while reading,
  Backspace unbinding and Cmd+Z restoration were checked in an isolated library.
- Editing regression: **16 groups per layout**, including unrelated workspace
  and Zotero chrome mutations. Inline source interaction: **17 groups per
  layout**, covering PDF/@ identity, locks, clipboard events, persistence and
  actual requests to a deterministic local model fixture.
- Hot-update UI acceptance: **8 checks** from the unchanged public beta.4,
  including repeated updates, both layouts, unsaved Chinese drafts, selected
  tasks, open Update settings, existing preferences and a closed workspace.
  Input lifecycle acceptance separately covered an unsaved draft hot update,
  three close/reopen cycles and three disable/enable cycles without accumulated
  menu or input listeners.
- Ordinary-package data upgrade: **27 checks** from public beta.4, including
  drafts, sources, notes, annotations, artifacts, write receipts, settings,
  budgets and repeated process restarts.
- Attachment acceptance: **12 checks**, including file extraction, visible sent
  attachments, task switching, rejected submissions and process restart.
  Typography acceptance covered **96 layout cases** plus responsive font changes,
  keyboard navigation, high contrast and the docked sidebar.

The design checklist retained the shared palette, sizing and source style.
Light/dark, compact layouts, large bilingual text and native high contrast were
checked in real Gecko. The live suites now resolve the embedded document while
resizing and closing its owning window.

Native keyboard verification used UI automation on macOS, not a human-operated
IME. Composition coverage still uses injected events. Windows, Linux, other
Zotero versions, screen readers and live model providers were not tested. Raw
traces, screenshots and synthetic test profiles remain in ignored output.

No tag or GitHub Release was created and no public package was overwritten.
