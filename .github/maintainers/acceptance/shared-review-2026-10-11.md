# Shared candidate and annotation review — 2026-10-11

Original language: English.

This records an **unreleased working-tree change** after public 0.6.0. The
isolated development XPI still uses source version 0.6.0. The published tag,
Release and package remain unchanged; a future publication requires a higher
version and the full [release procedure](../releases.md).

## Behavior

Literature candidates and annotation proposals now use the same review panel,
view model and styles. Domain adapters retain annotation ownership/write
receipts and versioned candidate confirmation/fulltext acquisition.

- The first nonempty pool below ten entries starts as cards; ten or more starts
  as a list. The count is the entire review pool, including previously reviewed
  entries. Filtering does not change the default. Manual view choices survive
  arrivals, minimizing and task revisits.
- Both domains share filters, card navigation, list selection, full-height cards,
  edge gradients, first-live opening and later 6px/1.12× capsule reminders.
  Appended papers in an existing query notify once without changing the current
  view, filter, position or bulk selection. History, duplicate identities,
  metadata refreshes and write/acquisition receipts stay quiet.
- Candidate Include/Exclude decisions do not import papers. List checkboxes
  select the scope of a bulk decision. Confirmation still shows the exact
  versioned additions, removals and acquisition scope. Continue remains usable
  during abstract lookup, PDF import and background acquisition.
- The UI receives a coherent whole-pool metadata snapshot; model-facing paging
  remains unchanged. Shared list rows mount in chunks.

## Automated validation

- `npm test`: 1,354 tests passed, with no failures, skips or cancellations.
- `npm run typecheck`, `npm run lint`, `npm run sync-skills:check` and
  `npm run build --workspace @confucius/zotero-addon` passed.
- Added regressions cover 0/1/9/10/11-entry presentation defaults, preserving
  manual choices, candidate selection and same-query arrivals, cloned whole-pool
  snapshots, quiet metadata events, and initial-history/sequence arrival fences.

## Native Zotero validation

Environment: macOS 26.6.2 (ARM64), Zotero 10.0.6 and Node.js 23.10.0. Tests used
ordinary installed development XPIs in empty isolated profiles. The personal
Zotero profile and library were not used.

`node --import tsx scripts/live-annotation-review.mjs` passed **128 checks**:
57 annotation panel checks, 34 candidate adapter checks and 37 host/workspace
checks. These include first-live opening and later reminders, per-task view
memory, IME input, keyboard/edge/swipe/wheel navigation, long-text scrolling,
snapshot bulk selection, stale async results, candidate confirmation, native
annotation writes, uncertain receipt recovery and restart persistence.

`node --import tsx scripts/live-literature.mjs` passed **31 check groups** with no
UI errors. It exercised real candidate state and revision changes, confirmation,
abstract-only/current continuation, acquisition waits, reuse of an existing
library item, native PDF parsing/import, rejected HTML/forged PDFs, browser/manual
attachment flows, late-result focus protection and restart recovery. A historical
workspace stays minimized after reopening. Continue remains inside the overlay
at 420px and 280px; lists retain at least 48px of scrollable space.

OpenAlex responses, model responses and download transport were deterministic
fixtures. PDF verification, Zotero item/attachment imports and stored receipts
ran through their real implementations. No service keys, online models or live
OpenAlex requests were used. Native scripts ran sequentially so independent
Zotero windows did not compete for hover/focus.

The native resizing check initially measured before container styles settled;
it now waits two animation frames and retains its visibility/containment checks.
The final run passed. Temporary screenshots, profiles and raw reports remain in
ignored `output/`.

Tested development XPI SHA-256:
`db9e2325dcf6d905fa088b898a6c585ad2e2d1da0496a29fd7cd709d34204d34`.

## Interface checklist and scope

- Colors, typography and regular/compact buttons use shared workspace rules.
  Annotation colors still reflect data; literature metadata uses the same slots.
- English/Chinese labels, light/dark themes and 420px/280px native windows were
  checked for wrapping, button containment, scroll access and horizontal overflow.
  Annotation card geometry also passed at 680/480/320/280px widths.
- Empty/disabled states, filters, focus retention and keyboard menus passed.
  Shared Gecko media fixtures cover coarse pointers, reduced motion and high
  contrast; this is not an OS-level high-contrast device acceptance.
- Artifact reader decoration and typography were unchanged. Source opening
  distinguishes a PDF reader target from a library-item target.
- Both language versions of user guides, shared design rules and architecture
  were updated. Required tests and type checking passed.

This run does not cover Windows/Linux, Zotero 7/8/9, OS font scaling, real external
model processes or services, installed-package upgrades or a new public release.
