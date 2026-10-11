# Release 0.6.1-beta.1 acceptance — 2026-10-11

Original language: English.

## Source and package

The candidate follows public 0.6.0 (tag source
`4482bbdd53883c0acf033a8f5e422eef613996a0`) and starts from its acceptance follow-up
`011b4ef597bbe902cbd74017b7c1e418459a2338`. The new source is identified by
`v0.6.1-beta.1`; the release tag and published bytes must never be replaced.

This Beta includes shared literature/annotation review, full-height cards and
edge navigation, first-live opening and later 6px/1.12× capsule reminders, local
file-drop feedback, and owner-window cleanup with independent host timers.
No data migration or new preference is required. Stable Latest remains 0.6.0.

Local production XPI SHA-256:
`e1ed70322757d4d07306a809af79ee2fc1daeb5aa70e1b598aca90e2524361c5`
(size 755,597 bytes). The package manifest is 0.6.1-beta.1 with addon ID
`confucius@zotero.plugin`. Manifest and update metadata agree on compatibility
`6.999` through `10.*`; this run only exercised Zotero 10.0.6.

The clean build contains `confucius.xpi` and `update-beta.json`, with no stable
`update.json`. The update address names the exact Beta tag and its SHA-512
matches the XPI. `scripts/release-assets.mjs` verified these fields.

## Automated checks

On Node.js 23.10.0:

- `npm test`: 1,354 passed; zero failures, skips or cancellations.
- `npm run versions:check`, `npm run sync-skills:check`, `npm run typecheck`,
  `npm run lint`, `npm run build` and
  `npm run release:check -- v0.6.1-beta.1`: passed.

## Native candidate acceptance

All checks below used the local ordinary 0.6.1-beta.1 package with the digest above.

| Suite                                                  | Result                           | Scope                                                                                                                                                  |
| ------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node --import tsx scripts/live-annotation-review.mjs` | 128 passed                       | 57 shared annotation panel, 34 candidate adapter, 37 real host/workspace checks                                                                        |
| `node --import tsx scripts/live-literature.mjs`        | 37 groups passed, zero UI errors | Candidate revisions, confirmation, native PDF import, browser/manual attachment, local drag feedback, cancellation, continuation and restart           |
| Main-window lifetime fixture                           | 15 passed                        | Owner closes workspace, saved draft, in-flight/background/SSE requests, retry, cancellation, model listing, debounced persistence, reopen and shutdown |

The shared review suite checked full-height cards, gradient edge navigation,
initial defaults, manual view retention, keyboard/IME and bulk selection. Actual
live events opened the first batch without taking composer focus; later arrivals
floated the capsule 6px and enlarged it to exactly 1.12× without forcing the
review open. History, duplicate events and write receipts did not replay it.

File-drop checks dispatched actual Gecko drag events. Paper drops highlighted
only the paper target and completed native PDF verification/import without chat
attachment preparation. Composer hints were bounded and opaque, without blur;
outside drops were ignored and Escape/end/leave/blur cleared feedback. A real
composer PDF attachment preserved the input draft. Light/Chinese and dark/English
screenshots, including 280px windows, retained visible surrounding content.

The lifetime fixture closed the actual isolated library window during an HTTP
request, confirmed both main window and Confucius workspace were absent, and
completed native requests, streaming, a 503 retry, cancellation and state saving.
Reopening restored the draft; closing again and shutting down also passed.

## Candidate upgrades and hot updates

The unchanged public old packages were verified against their original release
metadata before reuse:

| Old XPI      |  Bytes | SHA-256                                                            |
| ------------ | -----: | ------------------------------------------------------------------ |
| 0.6.0        | 754442 | `bec8acf2a0c31ed96cf0b60983cce5767d82136b86f87b850839124c97cdc3ec` |
| 0.6.0-beta.1 | 733937 | `c7dac01bc526ad637ab583082423f0e759dd9cb678fcbf5f6446725fb3e3b3c7` |

`scripts/live-release-upgrade.mjs` created data with each old ordinary XPI,
installed the candidate normally, then tested full restarts and explicit resume.

| Upgrade                     | Checks | Original history/working-note files | Explicit channel | Result |
| --------------------------- | -----: | ----------------------------------: | ---------------- | ------ |
| 0.6.0 → 0.6.1-beta.1        |     20 |                                  28 | Beta enabled     | Passed |
| 0.6.0-beta.1 → 0.6.1-beta.1 |     26 |                                  40 | Beta disabled    | Passed |

History and working-note originals kept their hashes. Notes, annotation sources,
report revisions, Chinese/emoji drafts, memory proposals, consumed run budgets
and creation grouping remained available. Upgrade/restart did not request a model
or replay writes; explicit resume reused the confirmed note. The old Beta fixture
also retained its literature queries/decisions and child research identities,
results and trace events through a second restart. Existing explicit channel
and automatic-check preferences were preserved, including an explicit stable
choice when manually installing a Beta.

`scripts/live-update-window.mjs` passed seven checks from original 0.6.0 to the
Beta candidate. The selected task, immediate Chinese draft, collapsed task list,
Update tab, actual new version and sidebar remount survived hot installation.
Repeated installations did not reopen a workspace closed by the user. Installation
reported `restartRequired=false`; the UI also rendered the distinct staged state.
This suite used a local package server and fixture discovery; it does not prove
public old-client update discovery.

The unpublished-version guard and release check passed. All local preparation,
package and candidate installation checks are complete.

## Test scope

Native tests use macOS 26.6.2 (ARM64), Zotero 10.0.6 and ordinary installed XPIs
in isolated profiles. Synthetic libraries, notes, PDFs and deterministic model,
OpenAlex and download responses avoid personal library data and paid services.
Native scripts run sequentially to avoid competing hover/focus windows.

No Windows/Linux or Zotero 7/8/9 device test, live external Codex/Kimi process,
authenticated model/research service, manual Finder/browser drag gesture,
OS font scaling or OS high-contrast device test was run. UI media fixtures cover
reduced motion and contrast behavior. Raw reports, private profiles, screenshots
and package copies remain in ignored `output/`.

At tag preparation, publication and original-old-package online upgrades were
not yet complete. The following follow-up records their separate acceptance.

## Public package acceptance

Release source: `0771afc65555c68854c18064776882eeee22a83b`.
[Tag CI](https://github.com/ZionDoki/confucius/actions/runs/38113220888) and
[master CI](https://github.com/ZionDoki/confucius/actions/runs/38113220998) passed
on Node.js 22 and 24. Both Node versions passed all 1,354 tests with zero failures,
skips or cancellations. Type checking, lint, skills/version checks and production
builds passed. The release job verified the complete uploaded draft before publication and passed three consecutive anonymous discovery reads
and both XPI download paths.

[Confucius v0.6.1-beta.1](https://github.com/ZionDoki/confucius/releases/tag/v0.6.1-beta.1)
was published at **2026-10-11T05:00:01Z**, release ID `409427369`, with
`draft=false`, `prerelease=true`. Title, tag and body match CHANGELOG-generated
notes. Stable Latest remains `v0.6.0`.

| Original public CI artifact |  Bytes | SHA-256                                                            |
| --------------------------- | -----: | ------------------------------------------------------------------ |
| `confucius.xpi`             | 756682 | `48a850dd396021f390417ff019fe964bc6a196b4a5266c9c8ce449a410574084` |
| `update-beta.json`          |    587 | `34b7ff4e43e62694896944497f0f8a32dcd1b3a176af625d172b46c5e1bab69e` |

The CI archive differs from the local candidate in ZIP metadata/compression.
All **19 unpacked files** (25 ZIP entries including directories) have identical
names and SHA-256 digests, including manifest, scripts, locales and styles. Original downloaded public files were
retained; they were not replaced with a local rebuild.

A separate local run of `scripts/release-assets.mjs --public` used those original
public files and also passed three consecutive anonymous release-list reads and
both asset-API/browser downloads with the recorded sizes and hashes. Manifest,
Beta-only update file, SHA-512 and versioned download address passed inspection.

## Original-old-package online upgrades

The following suites installed unchanged original public old XPIs in isolated
Zotero, with their original updater implementations and real GitHub endpoints.
No reported current version, release metadata, asset response or download bytes
were replaced. Every installed new XPI matched the original public CI digest
above after a full restart.

| Suite                                       | From         | Checks | Result |
| ------------------------------------------- | ------------ | -----: | ------ |
| `scripts/live-legacy-update.mjs`            | 0.6.0        |     12 | Passed |
| `scripts/live-legacy-update.mjs`            | 0.6.0-beta.1 |     12 | Passed |
| `scripts/live-release-upgrade.mjs --public` | 0.6.0        |     27 | Passed |
| `scripts/live-release-upgrade.mjs --public` | 0.6.0-beta.1 |     33 | Passed |

Old stable-only checks excluded the new Beta. Enabling prereleases discovered
0.6.1-beta.1 and downloaded, verified and installed it through each old updater.
The new version and Chinese draft survived a full restart. Explicit channel
choices and disabled automatic checks stayed independent; an already-current
package was not offered again. Disabling Betas did not downgrade and the stable
choice survived another restart.

The full data suites retained all original history/working-note hashes (28 files
from stable, 40 from old Beta), source annotations, notes, report revisions,
memory/proposals, drafts and run/maintenance budgets. Upgrade and restart did not
request a model or repeat a confirmed write. Explicit continuation reused the
saved write. The old Beta research fixture retained literature queries, candidate
choices, child research identities, results and trace events through two restarts.

Source preparation, ordinary-package feature tests, candidate data upgrades,
Node.js 22/24 CI, public assets/discovery/downloads and original-old-package online
upgrades are complete. No installed personal Zotero profile was changed. The
original tag, source and public artifacts remain unchanged.
