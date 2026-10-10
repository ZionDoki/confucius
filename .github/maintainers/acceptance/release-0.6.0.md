# Confucius 0.6.0 stable acceptance

Original language: English. [Acceptance archive](README.md).

## Scope and environment

Prepared on 2026-10-10 UTC from the working tree based on `5d19b03`. This stable
release includes annotation review and legacy-index recovery from the intervening
Betas, the existing Unreleased fulltext/knowledge/memory changes, paired guides,
and the three [user-feedback fixes](user-feedback-2026-10-10.md). Existing source
edits were preserved. Unrelated deployment files are outside the release scope.

Environment: macOS 26.6.2, ARM64; Zotero 10.0.6; Node.js 23.10.0. Live checks use
ordinary XPI installations in isolated profiles and synthetic libraries. They do
not use the normal Zotero library. Native language probes use the configured
`deepseek-flash` endpoint; credentials stay private in the isolated profile.

## Local checks and artifacts

All **1,333 automated tests** passed without failures, cancellations or skips.
Workspace type checking, lint, version consistency, skill synchronization and
the production build passed. Root, eight workspace packages, lockfile entries
and `CONFUCIUS_VERSION` agree at `0.6.0`.

The previous Beta build was moved aside before building. `localAssets` in
`scripts/release-assets.mjs` verified the addon ID, stable version, unchanged
Zotero compatibility range `6.999–10.*`, both update channels, versioned download
URLs, and the actual XPI's SHA-512 in the update files.

| Candidate artifact |  Bytes | SHA-256                                                            |
| ------------------ | -----: | ------------------------------------------------------------------ |
| `confucius.xpi`    | 753263 | `a90078b1edc3136bbb1bc852d4941496d2b67f7765b651990baae1d3535f9164` |
| `update.json`      |    573 | `40dbf75c577a72f5c7bf3201c66724d53913c76944959d79dbc7c640e529e85b` |
| `update-beta.json` |    573 | `40dbf75c577a72f5c7bf3201c66724d53913c76944959d79dbc7c640e529e85b` |

CHANGELOG's 0.6.0 entry summarizes changes since stable 0.5.0, preserves historical
entries, and uses links pinned to `v0.6.0`. Public CI archives must be verified
independently; ZIP timestamps can change the digest without changing bundle files.

## Later slash skills and language

`npm run test:live:user-feedback` passed **30 checks** against the ordinary 0.6.0
candidate installation. The harness now runs the actual native turn loop and
HTTP adapter against a local deterministic completion service, recording the
actual model request rather than reconstructing a system prompt.

One task submitted `/paper-deep-reading`, `/annotation-pass`, then a bare
`/paper-deep-reading`. Each outgoing request included the selected skill body.
Second/third-turn mouse, Enter and Tab selection, Escape, leading whitespace,
Chinese composition, an unknown draft, preset reuse and restart recovery passed.
Loaded skills remain idempotent; bare commands inherit the conversation language.
Menu geometry and pointer hits passed at 960px/light and 560px/dark.

Four real-model probes passed German with an English interface, English with a
Chinese interface, inherited German for a bare skill command, and explicit German
revision of English source text. The revision kept `The result is partial.`
verbatim. A generated German comment was accepted through actual annotation review
and saved as a native Zotero annotation without tags, preserving its English quote.

Automated host regressions separately cover native/Codex/Kimi later turns,
existing external sessions, retry, restoration, skill list/dispatch, stale
submissions and attachment/host-text isolation. Sources and write permissions
remain enforced.

## Candidate data upgrade

The original public 0.5.0 and 0.6.0-beta.1 XPIs were checked against GitHub asset
sizes and SHA-256 digests before reuse. Their bytes and updater implementations
were not modified.

`scripts/live-release-upgrade.mjs` creates notes, annotations, report revisions,
multi-window history, memory, a pending memory proposal and consumed budgets with
the old package, installs the candidate normally, then tests full restarts and an
explicit continuation.

| Upgrade                                       | Checks | Original history/working-note files | Result |
| --------------------------------------------- | -----: | ----------------------------------: | ------ |
| 0.5.0 → 0.6.0                                 |     20 |                                  28 | Passed |
| 0.6.0-beta.1 → 0.6.0, explicit stable channel |     26 |                                  40 | Passed |

Original history bodies retained their hashes. Drafts, source identities, notes,
report revisions, memory proposals, creation grouping and budgets remained
available. Upgrade/restart did not invoke the model; continuing reused a confirmed
write without duplicating the note. Explicit channel and automatic-check choices
were preserved. Candidate installation does not establish public online discovery.

The Beta upgrade also preserved literature queries, candidate selections, child
research identities, results and public trace events. It passed with the Beta
preference explicitly off, and retained that choice through subsequent restarts.

`scripts/live-update-window.mjs` passed **seven** checks from the public Beta to
the candidate: selected task, latest Chinese draft, update settings, collapsed
list, sidebar remount and repeated installations remained intact. A previously
closed workspace stayed closed. Installation reported `restartRequired=false`;
the interface separately renders applied and staged-until-restart states.

`npm run release:check -- v0.6.0` and the unpublished-version guard passed. Source
preparation, build validation and candidate installation are complete.

## Limits and publication boundary

Windows, Linux, other Zotero versions and authenticated Codex/Kimi CLI execution
were not retested. The declared compatibility range is unchanged; this candidate's
device checks cover Zotero 10.0.6. Small language probes do not establish scientific
report quality or compliance in every language. Earlier fulltext and knowledge
benchmarks remain dated evidence in their own records, with unchanged limits.

This record distinguishes local preparation from tag CI, public assets and old
clients' real online upgrade. Those checks must complete before the release is
reported as publicly available. Raw logs, reports and original candidate/public
archives are retained under ignored `output/release-0.6.0/`.
