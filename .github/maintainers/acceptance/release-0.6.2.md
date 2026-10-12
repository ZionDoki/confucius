# Release 0.6.2 acceptance — 2026-10-12 UTC

Original language: English.

## Source and candidate

The release starts from public 0.6.1 and its acceptance follow-up `1f999e8`.
Source is identified by `v0.6.2`; the old `v0.6.1` tag and public packages remain
unchanged. This patch fixes sent attachment summaries, font-independent task
icons, sidebar typography, pointer focus styling and workspace/input cleanup.
The final audit also fixes delayed task creation stealing selection and a
pending context update delaying selection or placing its failure on another task.

All workspace versions, the root lockfile and `CONFUCIUS_VERSION` are 0.6.2.
Dependency versions did not change. No migration or reconfiguration is required.

The ordinary local candidate is **811,465 bytes**, SHA-256:
`9ccd9f5fc4185ec3ce649b6ce9156c8f8c694210e0c288f645112551d4ed85fd`.
Its manifest names 0.6.2 and addon ID `confucius@zotero.plugin`. The unchanged
compatibility range is `6.999` through `10.*`; this record exercises 10.0.6 only.
Both generated update files name the versioned stable download address and have
the SHA-512 of the actual candidate. No generated manifest was edited by hand.
Original CI archive bytes need separate verification after publication.

## Source checks

Local environment: Node.js 23.10.0.

- `npm test`: **1,379 passed**, zero failures, skips or cancellations.
- `npm run typecheck`, full lint and full production build passed.
- Version consistency, skill synchronization and pinned CCF/ICORE catalog
  synchronization passed. The unused-release guard passed.
- Release notes come only from CHANGELOG; changed Markdown/scripts follow
  Prettier. The design checklist was completed for the changed surfaces.

## Ordinary-package feature and race checks

Environment: **macOS 26.6.2 (ARM64), Zotero 10.0.6**. Suites ran sequentially with
normally installed XPIs and isolated profiles, synthetic libraries and local
model responses. No personal profile or library was modified.

| Suite                          | Checks                         | Result |
| ------------------------------ | ------------------------------ | ------ |
| `live-chat-attachments.mjs`    | 12 groups; 16 SVG cases        | Passed |
| `live-sidebar-typography.mjs`  | 5 groups; 96 layout cases      | Passed |
| `live-sidebar-navigation.mjs`  | 29 groups; 615 clicks          | Passed |
| `live-appearance-settings.mjs` | 24 groups                      | Passed |
| `live-annotation-review.mjs`   | 131 checks                     | Passed |
| `live-input-lifecycle.mjs`     | 7 stages; 3 workspace remounts | Passed |
| `live-update-window.mjs`       | 8 checks                       | Passed |

Real PDF, Markdown and TXT extraction reaches the local model fixture. Durable
turn events save only public file summaries, without local paths or file bodies.
Messages retain name, kind, size and PDF page coverage after composer cleanup,
task revisits and full restart. Follow-ups do not inherit attachment chips.
Long Chinese/English and HTML-like names wrap as text at 28px in narrow themes.

Held real-host RPCs cover task creation, context updates and prompt submission:

- A late `task/new` result cannot select its task after the user switches;
  the original submission still reaches that new task with its PDF. The other
  task's draft remains intact. The earlier candidate reproduced selection theft
  before this correction; the final candidate passes the same regression.
- Context failures after a switch cannot appear on the newly selected task.
  Selection does not wait for an irrelevant pending reader-context update.
- Switching tasks retains submitted file leases until the host consumes them.
  Host events replace the pending bubble before a held prompt response returns.
- Failed submission removes the pending bubble and preserves draft/files.
- Existing delayed-save, retrieval-key, catalog-picker, task-load and review
  responses retain their documented ownership, ordering and retry boundaries.

The sidebar matrix covers both languages/themes, 12/17.5/24/28px, 1200/800/280px
windows and both grouping modes. Rows grow with text; titles use up to two lines
at large sizes. Buttons retain 34px targets and centered 20px SVGs. Drawer widths,
scroll padding and keyboard End navigation keep content within the viewport.
Font-only updates change dock/drawer mode without requiring resize or hiding an
open sidebar. Native high contrast and the docked Zotero sidebar also pass.
Screenshots of wide light, narrow dark and attachment layouts were inspected.

Settings regressions cover both entry points, installed fonts, fractional values,
custom light/dark palettes, Save/Cancel/Reset, delayed failures, readers/popups,
contrast and restart. Review sliders, selection checkboxes and filter radios
retain 2px keyboard focus without pointer outlines or shadows. Background-window
focus checks can temporarily lock Gecko pseudo classes. Native scripted keyboard
checks are distinct from manual desktop keyboard acceptance.

The typography fixture initially sampled an intermediate resize frame using a
fixed wait; it now waits for the actual responsive layout before asserting all
geometry. A context gate was also scoped to the original task so the fixture did
not block the task being selected. These test setup corrections retain the final
assertions and do not weaken the size, overflow or ownership checks.

Idle sampling over 3.3 seconds makes four normal task-list polls, **zero** unused
memory/log reads and **zero** endpoint-button mutations. Repeated pointer/key
events write the focus state only on real modality transitions. Three workspace
remounts retain one menu listener while open and zero while closed; three addon
disable/enable cycles remove their input listeners and do not accumulate callbacks.

## Candidate upgrades and hot updates

Original public old packages were retained unchanged:

| Old package  | Bytes  | SHA-256                                                            |
| ------------ | ------ | ------------------------------------------------------------------ |
| 0.6.1        | 810224 | `e3a8dc8e1c69f3f1d42ce91a930990fbf4c3c94c960483898a28eecc9de6de2d` |
| 0.6.1-beta.2 | 799485 | `3f35c4d98e4e3d90d07db7b431b8e8e2d16366c18db0eb5555d99d127166d56a` |

`live-release-upgrade.mjs` created data with these ordinary packages and normally
installed the final candidate. **21 checks** from 0.6.1 with explicit Beta channel
and **27 checks** from 0.6.1-beta.2 with explicit stable channel passed. All original
history/working-note files retained their hashes (28 and 40 files respectively).
Notes, source annotations, report revisions, memory/proposals, Chinese/emoji
drafts, creation grouping, consumed budgets and legacy appearance values survive.
The Beta's literature queries, papers, decisions, children/results and trace
events survive another restart. Upgrade/restart does not call the model or repeat
confirmed writes; explicit continuation reuses the receipt and consumed budget.

Eight hot-update checks restore the selected task, immediate draft, layout,
collapsed sidebar and Update tab without manual reopening. Open Zotero preferences
receive the new palette/version. Applied and staged-until-restart messages remain
distinct. Repeated hot installs and disable/enable do not reopen a workspace the
user already closed. These local install checks use a local transport fixture;
they do not establish public online update discovery.

## Limits and preparation state

Old messages that never saved file metadata cannot reconstruct attachment chips.
Summaries do not copy dropped files into Zotero or add file-opening actions.
The older public module retained input listeners until its document closed;
after upgrading from 0.6.1 or earlier, one Zotero restart clears those legacy
closures. The new module disposes its own listeners correctly on later cycles.
This is documented separately from Zotero's staged-install restart requirement.

Windows/Linux, other Zotero versions, online model responses, live external CLI
authentication, interactive OS file dialogs and manual desktop drag gestures were
not exercised. Native automation dispatches drop/input events while performing
real host parsing, storage and package installs. Runtime path persistence uses
external hosting disabled. Raw reports, screenshots, profiles and packages remain
in ignored output/scaffold directories.

Source checks, feature/race regressions, candidate upgrades and hot updates are
complete at tag preparation. CI, draft asset verification, public anonymous
discovery/download checks and unchanged-old-package online upgrades are distinct
post-publication steps and are not claimed by this preparation record.
