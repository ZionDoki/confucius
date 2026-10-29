# Release 0.6.3 acceptance — 2026-10-29 UTC

Original language: English.

## Source and candidate

The release source is identified by `v0.6.3`. It includes the changes from both
0.6.3 Betas and the native PDF annotation presentation, independent typography,
four-corner popup resizing and header editing action developed in this cycle.
The unrelated local deployment/site configuration files are excluded.

Root/workspace packages, the lockfile and `CONFUCIUS_VERSION` agree on 0.6.3.
Dependencies did not change. No manual data migration is required. Saved
appearance, custom execution limits and explicit update choices are retained.
MCP clients coming from 0.6.2 need the separate read-only token introduced in
Beta 1; clients already configured for the Betas need no further token change.

The locally tested ordinary XPI is **870,096 bytes**, SHA-256:
`5f595aedeb8b129d2d96a24bf6a042589dc587a2f0a06eb00a51e1d260f1c8a4`.
Its manifest identifies `confucius@zotero.plugin`, version 0.6.3 and the existing
compatibility range `6.999` through `10.*`. Only Zotero 10.0.6 was exercised in
this acceptance. A clean build produced `confucius.xpi`, `update.json` and
`update-beta.json`. Both update files match the manifest, versioned stable URL
and actual XPI SHA-512. Generated artifacts were not hand-edited. CI packages
require their own size/digest verification because ZIP metadata can differ.

## Source checks

Environment: macOS 26.6.2 (ARM64), Zotero 10.0.6, Node.js 22.23.2.

- `npm test`: **1,655 passed**, zero failures, skips or cancellations.
- `npm run typecheck`, `npm run lint` and `npm run build`: passed.
- Workspace version consistency, skill synchronization and pinned venue catalogs:
  passed. The catalogs contain 681 CCF2026 and 825 ICORE2026 records.
- Published-release overwrite guard: passed; stable 0.6.3 was unused.
- `npm run release:check -- v0.6.3`: passed; the generated body compares against
  the previous stable version, 0.6.2.
- Changed source and Markdown formatting and `git diff --check`: passed.

## Native annotations and appearance

`live-native-annotations.mjs` passed **40 checks without Flex** and **43 with
the separately installed Flex Annotations 3.0.0**. Both runs used an ordinary
0.6.3 XPI in a real isolated Zotero profile, with no captured reader script errors.

Coverage includes Markdown/native inline formatting, inline and display math,
text selection/copy, original editor nodes, IME composition, saving and reopening,
empty/read-only comments, safe links, literal authored HTML and annotation
switching. The header Edit comment action remains immediately left of the native
menu; it and the corner handles cannot delete the selected annotation with
Backspace/Delete. Disabling removes owned previews, controls and styling, and
re-enabling restores exactly one preview in an already open reader.

Every corner resizes both dimensions while anchoring the opposite corner.
Minimum sizes, pane bounds, keyboard resizing, cancellation, native Escape
dismissal, retained per-reader size and editing during a resize pass. Independent
font size, line height and paragraph spacing apply to open popups, survive global
typography changes and return to inherited defaults when cleared.

The shared design checklist was reviewed: shared palette/button styles, preserved
annotation colors, native menus/tags, no decorative reading dividers, selectable
content, focus and disabled/read-only states. Real Zotero screenshots and layout
checks cover light/dark/system contrast, narrow panes, Chinese and English labels
and 28 px text. The narrow English header retains reachable Edit comment and
three-dot controls. The native locator/header output is preserved; these checks
do not establish that every Flex custom locator format is rendered by Zotero.

`live-appearance-settings.mjs` passed **26 checks** across workspace settings and
Zotero preferences. Save/cancel/reset, independent annotation drafts and validation,
theme/font controls, large and narrow layouts, persisted settings and restart
behavior pass. Fonts and colors remain shared with Confucius; annotation size,
line height and paragraph spacing can be overridden independently.

`live-organizer.mjs` passed **17 checks** with real Flex Annotations 3.0.0:
plugin API/stored-outline parity, collection isolation, unassigned queries,
approval-before-write, individual rejection, native PDF links, explicit preview
without writes and scoped removal. Review controls remain usable in 1100/420/300
px layouts, light/dark/system contrast and keyboard focus.

## Ordinary-package upgrades and hot updates

The original public packages used as upgrade sources were unchanged:

| Version      | SHA-256                                                            |
| ------------ | ------------------------------------------------------------------ |
| 0.6.2        | `d3bcd2c4f9254a0b6160c70803f53b37dc1bb6e3fd71ec111990868e1d616a81` |
| 0.6.3-beta.2 | `87f478ee4365b20f662cf76e360be659c23155a21890d1e1b1ec5ddb0f737972` |

`live-release-upgrade.mjs` normally installed each old XPI, populated a synthetic
library and installed the local candidate through AddonManager. All **21 checks
from 0.6.2** and **27 from Beta 2** passed. These are local package upgrades,
not public online-update acceptance.

Task/request identity, Chinese drafts, sources, notes, annotations, artifact
revisions, memory/proposals, budgets and explicit update preferences survive
repeated restarts. The Beta scenario also retains its literature pool and
completed child's trace. All **28 stable-source** and **41 Beta-source** history
and working-note bodies remain byte-identical. Upgrade does not restart model
execution. Continuing reuses committed write receipts without duplicate notes.

`live-update-window.mjs` passed **eight checks** using public Beta 2 and the
ordinary candidate. Hot updates preserve the selected task, immediate Chinese
draft, collapsed task list and Update tab. Open preferences reload, sidebar
installation remounts exactly one sidebar, and a closed workspace stays closed.
Completed installation reports version 0.6.3 and `restartRequired=false`.
The staged-until-restart message is simulated; this was not an actual staged
installation test.

## Limits and publication state

At the release commit these results establish local preparation and installed
candidate behavior. Tag CI, original public asset verification, three consecutive
anonymous release-list reads, API/browser downloads and unchanged-old-package
online upgrades are pending publication. Record actual publication results below
without moving the tag or replacing public artifacts.

All device tests use isolated profiles and synthetic libraries. Pointer and
keyboard events are automated; manual desktop dragging was not retested. Model
responses in the upgrade tests use deterministic fixtures. Windows, Linux, other
Zotero/Flex versions, live model providers and publisher PDF access were not
retested. Earlier Beta results are not counted as new stable validation. Raw
logs, screenshots, machine paths and synthetic traces stay in ignored `output/`.
