# User feedback fixes — 2026-10-10

Original language: English. [Acceptance archive](README.md).

## Scope and delivery state

Implemented [later skill calls (#9)](https://github.com/ZionDoki/confucius/issues/9),
[user-language output (#8)](https://github.com/ZionDoki/confucius/issues/8), and
[unwanted annotation tags (#7)](https://github.com/ZionDoki/confucius/issues/7#issuecomment-6082836533)
in the existing working tree based on `5d19b03`. Pre-existing edits were retained.
The version remains `0.6.0-beta.1`. Source, synchronized built-ins, documentation,
and a local production XPI are prepared; this is not a published release.

Slash parsing now runs on accepted raw user messages before backend selection.
Loaded procedures remain available, the current explicit skill takes precedence,
and bare commands share a default instruction across initial execution and retry.
External runtimes advertise and dispatch the existing read-only `skill` tool.
Attachment content and host continuation prompts cannot activate a skill.
Existing source and write permission gates remain in force.

The shared language policy uses explicit output-language requests, current
substantive user language, recent effective conversation language, then interface
language. Bounded real user evidence survives recovery and context retirement.
Research children inherit that evidence, including retries of legacy children.
Titles, answers, progress, annotation comments, reports and revisions share the
policy; verbatim quotes and source identifiers remain unchanged. No language
detection service, extra classification request, or setting was added.

New native annotations have no automatic batch tags. Startup no longer rewrites
old tags. Ownership receipts, batch identity/time, creation provenance, color
baselines and compatibility fields remain available independently of tags.

## Automated validation

- `npm test`: **1,333 tests passed**, no failures, cancellations or skips.
- `npm run typecheck`: all workspaces passed.
- `npm run sync-skills:check`: generated built-ins match all seven skill sources.
- `npm run build`: production bundle/XPI and addon type checking passed.
- `git diff --check`: passed.

Regressions exercise native, Codex and Kimi prompt paths, existing external
sessions, successive skill changes, idempotent loading, pure invocation defaults,
retry/restored state, attachments, superseded submissions and the external
read-only skill tool. Preset tool and source-scope checks continue to pass.
Language cases include German, English, Chinese, French, Japanese and Arabic
evidence, explicit language choice, conversation changes, pure commands and
continuations, child inheritance and actual report-revision prompt construction.
Annotation tests cover tag-free ownership checks, cross-task edits/deletion,
legacy/user tag preservation, and internal batch time/provenance.

## Isolated Zotero validation

Environment: **macOS 26.6.2, ARM64; Zotero 10.0.6; Node 23.10.0**. Every live
script used a fresh profile/data directory and the locally built XPI. The normal
Zotero library was not used. Automatic updates and memory were disabled; the
feedback conversation also disabled automatic history retirement so all three
turns remained available for UI inspection.

| Script                                                            | Result           | Verified scope                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:live:user-feedback` with optional model preferences | 30 checks passed | Three submitted turns, second/third-turn mouse/Enter/Tab/Escape, leading whitespace, IME, actual loaded prompt bodies, bare command inheritance, unknown draft, preset reuse, restart, language probes and native German annotation |
| `node --import tsx scripts/live-annotation-batches.mjs`           | 21 checks passed | Real tag-free creation, color conflicts, cross-task/agent edit/delete, human ownership protection, exact old/user tag and modification-time preservation at startup, native filtering/search, receipts and batch continuity         |
| `npm run test:live:annotation-review`                             | 41 checks passed | Suggestion staging, acceptance/rejection, actual writes, partial/unlocatable outcomes, minimizing/list state, long lists, composition, task switching and restart without replay                                                    |

The language probes used the configured **`deepseek-flash`** endpoint through the
real native adapter. Four small requests checked titles, answers, comments and
report text: German with an English interface, English with a Chinese interface,
a pure skill command inheriting German, and an English request explicitly asking
for a German revision. The revision retained `The result is partial.` verbatim.
A generated German comment then passed through actual annotation review and was
saved to Zotero with no tags; its highlighted English passage matched source text.

Menu screenshots were inspected at 960px/light and 560px/dark. The menu remained
inside the workspace, received pointer hits and used shared styles. The existing
annotation review also passed compact dark geometry. No new palette, control
sizes or decorative reader dividers were introduced. Very narrow windows, larger
fonts, OS high-contrast mode, Windows and Linux were not retested on devices.

Codex/Kimi coverage here uses their real host prompt/tool dispatch paths with
controlled backend fixtures; authenticated external CLI execution was not rerun.
The language probes do not establish full-paper scientific report quality or
model compliance for every language. No tag, GitHub Release or update publication
was performed, and no issue reply was sent.

## Reproduce and inspect

Build first, then run the three commands in the table. The feedback script can
run its UI/recovery checks without model credentials. Set
`CONFUCIUS_FEEDBACK_PREFS` to a Zotero `prefs.js` for optional native model probes;
only endpoint/runtime preferences are copied into the isolated profile, without
copying library data. Credentials remain private and are not included in reports.

Raw JSON, logs and screenshots are ignored under `output/`. The model-enabled
feedback report is retained as
`output/user-feedback-acceptance/report-with-model.json`; the other results are
under `output/annotation-batches-acceptance/` and
`output/annotation-review-minimize-acceptance/`. Historical acceptance records
were not rewritten as evidence for this patch.
