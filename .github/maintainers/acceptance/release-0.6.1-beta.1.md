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

At this preparation stage no tag or public Release has been created. Publication
and original-old-package online upgrades require separate acceptance.
