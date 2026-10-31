# Release 0.6.4 acceptance — 2026-10-31 UTC

Original language: English.

## Source and package

The tested product source is commit `801e2d9`, including the native editor
isolation from `1b56e12` and the fixes found in this release review. The release
tag adds this record and the stable CHANGELOG entry. Unrelated local deployment
configuration is excluded. Dependencies and stored data formats are unchanged.

Root/workspace package versions, lockfile entries and `CONFUCIUS_VERSION` agree
on **0.6.4**. No public beta.5 was created; that version was a local test package.
The local ordinary XPI is **886,604 bytes**, SHA-256:

`f0fa7fb237375b568956ffcc9c5b8cf20571d57486d8034fecc45b8967a2993e`

The addon ID is `confucius@zotero.plugin`. The existing compatibility declaration
is `6.999` through `10.*`; this run exercised Zotero 10.0.7. Both `update.json`
and `update-beta.json` point to the versioned stable download and contain the
actual XPI's SHA-512. Generated artifacts were not hand-edited. CI artifact
digests are verified separately because ZIP metadata can differ.

## Checks and defects resolved

Local environment: macOS ARM64, Zotero 10.0.7, Node.js 22.23.2.

- All **1,689 automated tests** passed, with no failures, skips or cancellations.
  Type checking, lint and the full production build passed after product fixes.
  Workspace versions, skill synchronization and pinned venue catalogs passed.
- Preferences still looked for Update controls in the outer window after the
  editor moved into a content browser. Both layouts now resolve the embedded
  document. The reader context-menu focus path uses the same resolver.
- At narrow widths, the literature Continue button could fall below the short
  review popup. Its shared action footer now remains visible while scrolling;
  compact layouts put actions before explanatory text. The original failing
  420px case and the 280px case passed after the fix.
- The literature drag fixture previously assigned prose over the whole editor
  and assumed its value excluded references. Diagnostic output showed both
  references and the complete prose were retained. The fixture now inserts text
  through the editor and asserts exact draft and reference identity retention.
- Settings tests now await completion of the disabled opening control before
  changing layouts. High-contrast tests compare shared system-color tokens,
  geometry and measured primary-button contrast: Gecko can resolve system colors
  differently in chrome and content documents. Ordinary palettes still require
  exact color parity. These were test assumptions, not lost user settings.

## Native interaction and appearance

The release review passed these suites with ordinary installed candidates:

| Area                                                   | Result                                                |
| ------------------------------------------------------ | ----------------------------------------------------- |
| Composer selection and polling                         | 16 groups in each layout                              |
| Inline PDF/@ sources                                   | 17 groups in each layout                              |
| Message selection, copy, edit and resend               | 7 groups                                              |
| Protocol settings and synthetic tool exchanges         | 8 groups                                              |
| Appearance, preferences and embedded Update links      | 27 groups                                             |
| Literature workflow, imports, continuation and restart | 37 checks                                             |
| Annotation review, arrivals, writes and restart        | 142 checks                                            |
| Chat attachments                                       | 12 checks                                             |
| Sidebar typography                                     | 96 layout cases plus 5 behavior groups                |
| Input listener lifecycle                               | 7 stages, hot update, close/reopen and disable/enable |

OS-level keyboard automation separately exercised typing, Backspace, forward
Delete, arrows, backward selections, multiline editing, Chinese plain-text
paste, atomic @ removal and undo in the actual sidebar and detached window.
Polling retained the native focus and caret. Both reader-menu registration paths
were invoked against real isolated workspaces: all four actions focused the
composer in each layout and retained the captured synthetic selection.

The native isolation behavior and its original beta.4 reproduction are described
in the [native composer record](native-composer-2026-10-31.md). That earlier
record remains evidence for its local beta.5 candidate, not a public release.

The shared design checklist passed: palette and button geometry, no decorative
reader dividers, visible focus and disabled states, light/dark/system contrast,
English/Chinese text, narrow windows and font sizes through 28px. Settings tests
include the reading-question popover and open embedded/detached readers. Final
review and settings suites were rerun after their relevant fixes.

## Candidate upgrade acceptance

Unchanged public 0.6.3 and 0.6.4-beta.4 XPIs were installed normally in isolated
profiles before candidate upgrades. The stable-source scenario passed **21
checks**; the Beta-source scenario passed **27**. Drafts, sources, notes,
annotations, artifacts, history bodies, memory, execution budgets and explicit
update choices survived repeated restarts. Already committed writes were not
replayed. The final candidate repeated the stable-source scenario.

The final candidate passed **8 hot-update checks** from public beta.4: both
layouts, repeated installations, immediate unsaved Chinese drafts, selected
tasks, open Update settings, existing preferences and a previously closed
workspace. Input lifecycle acceptance also upgraded the local beta.5 package.

## Scope and publication state

No personal library, credentials or paid model requests were used for acceptance.
Protocol requests used deterministic local fixtures, including real HTTP requests
through Zotero's network layer. Composition events were injected; a human-operated
IME, screen reader, Windows/Linux Zotero and other Zotero versions were not
retested. Provider-hosted tools, audio/video generation and cloud-specific OAuth
or AWS signing remain outside the native protocol scope.

This tagged record captures candidate acceptance. Publication, anonymous release
discovery, public asset digests and unchanged-old-client online upgrades are
recorded afterward without moving the release tag or replacing its packages.
Raw traces, screenshots and synthetic profiles remain in ignored output.

## Public release acceptance — 2026-10-31 UTC

This section was appended after publication; the tag and published artifacts
were not changed. Tag `v0.6.4` remains at release commit `1bd25f6`.
[CI run 41181342457](https://github.com/ZionDoki/confucius/actions/runs/41181342457)
passed all verification jobs on Node.js 22 and 24 and the release job.

[Confucius v0.6.4](https://github.com/ZionDoki/confucius/releases/tag/v0.6.4)
was published at **07:40:58 UTC**, with `draft: false`, `prerelease: false`,
and stable **Latest**. The title, tag and body match the CHANGELOG-generated
notes. Release ID: `429791385`.

The original public XPI is **887,882 bytes**, SHA-256:

`ae8f482148e3b9b5214bdb796ef1f85eb71b6fa5145160d51e8558fc37d5d66b`

The public archive and the locally tested candidate have the same 25 entries,
with identical uncompressed content in every entry. Only archive metadata
differs. Both update files contain the actual public XPI's SHA-512 and the
versioned stable URL. No artifacts were rebuilt or substituted for acceptance.

Both CI and a separate local recheck passed three consecutive anonymous reads
of the release list used by older clients. The uploaded asset sizes and digests
matched. Downloads through the asset API and browser URL delivered the same
verified public XPI.

Ordinary, unchanged public old packages then passed their own online discovery,
download, verification and installation flows against real GitHub endpoints:

| Starting package | Scenario                                     | Result    |
| ---------------- | -------------------------------------------- | --------- |
| 0.6.3            | Stable channel, original updater and restart | 13 checks |
| 0.6.4-beta.4     | Stable channel, original updater and restart | 13 checks |
| 0.6.3            | Prereleases enabled, complete research data  | 29 checks |
| 0.6.4-beta.4     | Prereleases enabled, complete research data  | 35 checks |

Installed bytes matched the public XPI after restart. Chinese drafts, source
identities, tasks, notes, annotations, research state, budgets, history and
explicit update preferences survived. Existing writes were not repeated. Both
channel settings found the stable target; the current version was not offered
again, and disabling prereleases did not cause a downgrade or reinstall.

Independent automatic-check acceptance also passed **5 checks each** on
unchanged public 0.6.3 and 0.6.4 installations. With Zotero global addon updates
disabled and Confucius automatic checks enabled, startup status was idle and
the normal timer fetched GitHub without a manual check. The old package offered
0.6.4; the current package reported up to date. Neither automatic check installed
anything or changed package bytes. All public upgrade and timer tests used
isolated synthetic libraries, with no live model-provider calls.
