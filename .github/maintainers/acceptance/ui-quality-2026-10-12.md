# UI, attachments and idle-work acceptance — 2026-10-12

Original language: English.

## Source and publication state

This records local development changes based on
`1f999e88d0e73c74f6afee7554b25c83e300d9a1`, after public 0.6.1. The working tree
contains these fixes; no new version, Git tag or GitHub Release was published.
The original `v0.6.1` source and public assets remain unchanged. User-visible
changes are recorded under [Unreleased](../../../CHANGELOG.md).

The tested ordinary local XPI retains the development version 0.6.1 and addon
ID `confucius@zotero.plugin`; it is not a replacement public package. SHA-256:
`fc723cf066b28075a7b884adf605cdb0ad8e042ed17c5ff4daa34dd70792e548`.

## Changes and review scope

- User messages persist the public metadata of submitted PDF, Markdown and TXT
  attachments. The shared timeline renderer displays file name, size, PDF page
  coverage and truncation metadata in both optimistic and durable messages.
  Composer and conversation use one file-label component and shared CSS.
- Submitted attachment snapshots remain leased until dispatch finishes, including
  during task switches. The arriving host event replaces the optimistic message;
  failed submissions preserve the draft and prepared files. Later messages do
  not inherit earlier attachments.
- Task action buttons use a fixed 20px SVG with three circles and `currentColor`,
  preserving existing menu actions, tooltips and accessible names.
- Pointer focus outlines are removed from settings/review sliders, checkboxes,
  radios, color swatches and select controls. Keyboard focus, selected states,
  color boundaries and invalid text-input outlines remain visible.
- Document input listeners are disposed on shutdown, and unchanged input
  modality does not rewrite attributes. Workspace close/remount removes menu
  and unload listeners. Disposed views stop polling and rendering.
- Removed unused memory/log state and its background fetches from the workspace.
  Knowledge views still use their own index/read operations and updates. Model
  button labels and accessibility attributes change only when their values change.

The review followed the UI send/drop path into attachment preparation, host
dispatch, persistence, event compaction and timeline projection. It also checked
task/view generations, lifecycle cleanup, review/reader interfaces, host write
queues, atomic runtime storage, memory serialization, model cancellation,
deadlines/retries and MCP discovery cleanup. The offline suite covers the
remaining execution/storage contracts; external CLI integrations were not run
live for this audit.

## Validation

Environment: macOS 26.6.2, ordinary installed XPIs in isolated Zotero 10.0.6
profiles. Personal libraries and preferences were not used. File-drop events
were synthesized through native DOM events; actual file reading and PDF text
extraction ran in Zotero. Model responses used a local deterministic HTTP
fixture. Background-window focus checks may lock Gecko pseudo classes.

| Check                               | Result                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                          | 1,379 tests passed; zero failures, skips or cancellations                                                                                                |
| `npm run typecheck`                 | Passed across all workspaces                                                                                                                             |
| `npm run lint`                      | Passed                                                                                                                                                   |
| `npm run build`                     | Passed; ordinary local XPI installed for native checks                                                                                                   |
| Appearance/Runtime settings         | 24 scenario groups passed, including both entry points, 12–28px, decimal typography, local fonts, independent palettes, contrast, save races and restart |
| Attachment and SVG regression       | 10 scenario groups passed, including actual model delivery, held requests, task switching, failed sends, follow-ups and process restart                  |
| SVG geometry                        | 16 cases: four font presets × two size limits × light/dark; icon remains 20×20, centered in the existing 26×28 task target                               |
| File-label layout                   | Long Chinese/English and HTML-like file names wrap safely at 28px in narrow light/dark windows; screenshots inspected                                    |
| Input-listener lifetime             | Initial binding plus three disable/enable cycles passed; disabled documents produce zero focus writes, enabled documents retain one binding              |
| Workspace menu lifetime             | Three close/reopen cycles: one active handler, zero after close, one after remount                                                                       |
| Shared annotation/literature review | 131 checks passed, including focus, selection, stale responses, ownership, native receipts and restart                                                   |

Protocol and host regressions also verify JSON-restored attachment metadata,
legacy text-only messages, independent follow-ups, submission matching and
metadata snapshotting before consumption. Timeline events expose no local file
paths or extracted bodies; model input still receives the extracted file text.

Native commands:

```sh
node scripts/live-chat-attachments.mjs
node scripts/live-input-lifecycle.mjs
node scripts/live-appearance-settings.mjs
node --import tsx scripts/live-annotation-review.mjs
```

The 131-check review run used the existing annotation/literature regression with
three additional native focus groups in an ignored temporary copy. The maintained
review command above covers the baseline 128 checks. Raw logs, profile data,
temporary probes and screenshots remain under ignored `output/`.

## Measured idle work

Two isolated empty-library samples observed four normal polling cycles in 3.3
seconds. The first sample preceded the removal of unused fetches and repeated
endpoint presentation writes; the second used the final source.

| Observed operation            | Before | After |
| ----------------------------- | -----: | ----: |
| Unused `memory/list` calls    |      4 |     0 |
| Unused `logs/list` calls      |      4 |     0 |
| Endpoint-button DOM mutations |     17 |     0 |
| Normal `task/list` polls      |      4 |     4 |

Each actual pointer/keyboard transition produces one focus attribute write;
another 50 events in the same modality produce zero writes. No CPU-time,
resident-memory or model-throughput improvement was quantified.

## Limits

- Older messages without saved attachment metadata keep their original display;
  this change does not reconstruct previously missing metadata.
- Sent-file chips retain summaries. Original dropped files are not copied into
  the library by this change, and the chips do not offer file-opening actions.
- Windows, Linux and Zotero 7/8/9 were not tested on real devices in this audit.
  Native tests used privileged automation rather than manual hardware drags.
- Listener cleanup was verified from a fresh candidate installation. Windows
  retaining handlers from an older package that lacked this cleanup need one
  Zotero restart to discard those old closures; the new code disposes its own
  handlers on subsequent shutdowns and remounts.
- Publication and old-client online upgrade acceptance have not been run for
  these development fixes; they require a new version under the release rules.
