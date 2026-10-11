# Workspace lifetime acceptance — 2026-10-10

Original language: English.

This records an **unreleased working-tree fix**, after the public 0.6.0 release.
The isolated development package still used the source version 0.6.0; the
published tag, Release and XPI were not changed. Publication requires a higher
version and the full [release procedure](../releases.md).

## Cause and behavior

Closing the Zotero library left its detached Confucius workspace open. The next
native request failed before HTTP transport with
`can't access property "setTimeout", Zotero.getMainWindow() is null`. This was
reproduced using a local model fixture: the initial request completed, closing
the library left the workspace alive, and the next request failed without
reaching the fixture server.

The workspace now records the library window that opened it and closes with
that window, disposing the view and saving its draft. Another library's closing
does not close this workspace. Manual workspace closing, reopening and plugin
cleanup release the ownership listener. Initial `about:blank` document
replacement does not release ownership.

Host model deadlines, retries, transient-media waits, external runtime monitoring,
model listing/catalog deadlines and debounced persistence use Gecko's independent
timer module. Closing a view still does not cancel host tasks.

## Validation

- `npm test`: 1,345 tests passed, with no failures, skips or cancellations.
- `npm run typecheck`, `npm run lint`, `npm run sync-skills:check` and the Zotero
  add-on build passed.
- Added executable window-lifetime regression tests for ownership, a different
  library closing, nested-document unload, initial blank replacement, manual
  close, reopening, missing library and repeated cleanup. Hook tests confirm
  closing a library disposes its workspace without shutting down the host.
- Timer tests exercise cancellation after the main window disappears and a real
  model adapter's first-byte deadline. External-monitor and shutdown regressions
  retain their deadline and recovery-snapshot coverage without window timers.

Native acceptance used macOS 26.6.2 (ARM64), Zotero 10.0.6, an empty isolated
profile and an ordinary installed development XPI. A local HTTP/SSE model
fixture supplied synthetic replies; no user library or model credentials were
used. Fifteen checks passed:

- Normal request with a library window; closing the owner also closes Confucius.
- A request already in flight completes after closing the library.
- Later background requests, SSE, a 503 retry, stopping and requesting again
  work while both the library and workspace are absent.
- Endpoint model listing and debounced persistence complete without a library.
- Reopening the library and workspace restores the input draft and permits
  another request. Closing the reopened library closes its new workspace too.
- Host shutdown completes with the library absent.

An independent, unmounted report fixture kept a privileged debugger context
available during native testing; it was not the workspace being tested. Raw
reports and local process/profile details remain in ignored `output/`.

Tested XPI SHA-256:
`0eb708987b629175241c47260bb65958268e7237fa84188233fb33ad006ea5de`.

## Scope and limits

Ownership changes introduce no new colors, controls, spacing or typography.
Draft restoration and repeated owner closing were checked in actual Zotero;
multiple-library isolation and blank-document races have automated coverage.
This run did not test Windows/Linux, Zotero 7/8/9, real Codex/Kimi processes,
external model providers, or installed-package upgrades. It does not establish
that every unrelated symptom is repaired by this fix.
