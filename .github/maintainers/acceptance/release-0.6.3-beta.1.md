# Release 0.6.3-beta.1 acceptance — 2026-10-23 UTC

Original language: English.

## Source and candidate

The release starts from public 0.6.2 and its acceptance follow-up `39797c9`.
Source is identified by `v0.6.3-beta.1`. It includes the reviewed runtime,
research, memory, UI and MCP credential changes, plus four review corrections:
retrying definitively failed resumed writes, verifying recovered PDF identity,
preserving explicit Zotero URI scope, and retrying token-rate limits.

All workspace versions, the root lockfile and `CONFUCIUS_VERSION` agree on
0.6.3-beta.1. Dependency versions did not change. MCP clients must replace their
pairing token with the separate read-only token in Confucius preferences.
No manual data migration is required; older versions may discard new memory
provenance metadata when rewriting files.

The ordinary local candidate is **830,566 bytes**, SHA-256:
`b770eed1f09f35fb46652923365d4e0c071d794f6b6cf61327498f594116776c`.
Its manifest has addon ID `confucius@zotero.plugin` and version 0.6.3-beta.1.
The unchanged declared compatibility range is `6.999` through `10.*`; only
Zotero 10.0.6 was exercised here. A clean production build contains the XPI and
`update-beta.json`, with no stable `update.json`. The update record has the
versioned Beta download URL and the actual XPI's SHA-512. Generated artifacts
were not hand-edited. Original CI archive bytes require separate verification.

## Source checks

Environment: macOS 26.6.2 (ARM64), Node.js 23.10.0, npm 10.9.2.

- `npm test`: **1,557 passed**, zero failures, skips or cancellations.
- `npm run typecheck`, `npm run lint` and `npm run build`: passed.
- Version consistency, skill synchronization and pinned venue catalogs: passed.
- Release validation and the published-release overwrite guard: passed.
- Focused regression tests failed before the corresponding fixes and passed
  afterward. They cover both failed and started checkpoints with final failure
  receipts, valid/missing/supplementary/wrong-paper PDF attachments, unavailable
  identity inspection, missing library/group scopes and personal-key collisions,
  and explicit/text-only rate limits in streaming and non-streaming responses.
- Release notes come only from CHANGELOG. Raw logs and synthetic test state stay
  in ignored `output/`, outside the committed acceptance record.

## Ordinary-package installation and upgrade

The unchanged public 0.6.2 XPI has SHA-256
`d3bcd2c4f9254a0b6160c70803f53b37dc1bb6e3fd71ec111990868e1d616a81`.
`live-release-upgrade.mjs` installed that package normally in an isolated Zotero
10.0.6 profile, populated synthetic research data, and installed the candidate
through AddonManager. All **21 checks passed**.

Task identity, current request, Chinese drafts, source associations, notes,
annotations, report revisions, memory/proposals, budgets and explicit Beta/
automatic-check preferences survive the upgrade and repeated restarts. All
28 original history and working-note bodies remain byte-identical. Upgrade does
not resume model execution. Explicit continuation consumes the original budget
and reuses the completed write instead of duplicating the Zotero note.

`live-appearance-settings.mjs` passed **24 groups**, including six layout/theme
scenarios, with an ordinary candidate installation. It checks both settings
entry points, decimal typography, independent light/dark palettes, high contrast,
English/Chinese labels, regular/compact/narrow layouts, delayed saves, keyboard
focus and restart persistence. The design checklist was completed for the
changed settings and workspace surfaces using these checks and source review;
there is no new palette or button-size system.

`live-chat-attachments.mjs` passed **12 groups and 16 SVG geometry cases**.
Actual PDF/Markdown/TXT extraction reaches the local fixture; delayed task
creation, context updates and send failures preserve task/draft/file ownership.
Sent attachment summaries survive restarts, and long bilingual file names wrap
in narrow light/dark windows without duplicate messages.

`live-update-window.mjs` passed **eight checks**, using local candidate bytes
and an isolated 0.6.2 installation. Hot updates restore the selected task,
Chinese draft, collapsed sidebar and Update tab, replace open preferences,
remount one sidebar and report the actual new version. A previously closed
workspace remains closed. Completed and staged-installation messages are
distinct; staged status rendering is simulated, not an actual staged install.

## Limits and preparation state

This record describes actual local preparation. At the release commit, CI,
public assets, three consecutive anonymous release-list reads, API/browser
downloads and a genuine old-package online upgrade are still pending. Their
results belong in a follow-up section without moving the release tag.

All device checks use isolated profiles, synthetic libraries and local model
fixtures. No personal profile/library or paid model account was used. Windows,
Linux, other Zotero versions, real provider responses, live publisher PDF
acquisition, external CLI authentication and manual desktop drag gestures were
not retested. Native input checks use privileged automation; background focus
styling may use Gecko pseudo-class locks. Historical checks are not claimed as
new evidence for this Beta.

## CI and original public package

The immutable release commit is
`b38e492b11001f437c5f4781f1b753905771d732`. The
[tag workflow](https://github.com/ZionDoki/confucius/actions/runs/39915313547)
and [master workflow](https://github.com/ZionDoki/confucius/actions/runs/39915313503)
both completed successfully. Node.js 22 and 24 each passed **1,557 tests** with
no failures, skips or cancellations, plus type checking, lint and production
builds. The release job validated draft asset names, sizes and SHA-256 digests
before publication, then passed three consecutive anonymous release-list reads
and both anonymous XPI download routes at 07:06:46 UTC.

[Confucius v0.6.3-beta.1](https://github.com/ZionDoki/confucius/releases/tag/v0.6.3-beta.1)
was published at **2026-10-23 07:06:04 UTC**, release ID `421540690`, with
`prerelease: true` and `draft: false`. Latest remains `v0.6.2`. The title and body
match the tagged CHANGELOG exactly. Its only assets are:

| Original public asset |   Bytes | SHA-256                                                            |
| --------------------- | ------: | ------------------------------------------------------------------ |
| `confucius.xpi`       | 831,747 | `2bc9f761022e7e2a8eeee43a82001dec233b54061bbafb99ed49e230edcb6d62` |
| `update-beta.json`    |     587 | `b9d59be4d9e53e34d7f4bd94482c12a6c6c96c2489e1fd4c63584a016386755c` |

Both assets are uploaded and match GitHub's size/digest metadata. All **25 XPI
entries** have identical uncompressed bytes to the locally tested candidate;
only the archive bytes differ. The original downloaded package is retained for
post-publication checks instead of substituting a rebuild. The release tag and
published assets are unchanged by this acceptance follow-up.

## Original-old-package online upgrade

After publication, `live-legacy-update.mjs` passed **12 checks** from the unchanged
public 0.6.2 XPI to the original public 0.6.3-beta.1 XPI in isolated Zotero 10.0.6.
The installed old package's digest was verified before its own updater contacted
real GitHub endpoints. No updater code, reported version or response was replaced.

With prereleases disabled, the old package does not offer the Beta. Enabling
prereleases discovers, downloads, verifies and installs 0.6.3-beta.1. A full
restart loads the target version and the exact public XPI bytes. The task and
Chinese draft survive, explicit channel selection is retained, the current
version is not offered again, and disabling Betas cannot downgrade. Channel and
independent automatic-check settings survive another restart.

A separate local recheck of `release-assets.mjs --public` passed three consecutive
anonymous list reads and downloads through both the asset API and browser URL,
with sizes and SHA-256 matching the saved original public files.

The first local attempt received HTTP 403 because this network's anonymous
GitHub API quota was exhausted. It did not pass and was retained as a failed
attempt in ignored output. Requests were stopped until GitHub's advertised reset
at 07:14:38 UTC; both checks then passed without changing the package, updater or
network responses. The CI public-availability check had already passed from its
own environment. Publication and genuine old-client online-upgrade acceptance
are complete; the platform/provider limitations above still apply.
