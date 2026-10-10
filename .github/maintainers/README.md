# Maintainer guide

English · [简体中文](README.zh-CN.md)

[User guide](../../docs/README.md) · [Project overview](../../README.md)

Start with [development setup](development.md) to build and preview the add-on.
These guides describe current source, including unreleased work. Published
behavior and validation belong to the corresponding version's release notes.

| Guide                                             | Covers                                                        |
| ------------------------------------------------- | ------------------------------------------------------------- |
| [Development setup](development.md)               | First build, Zotero preview, checks, repository map           |
| [Documentation rules](documentation.md)           | Audience, bilingual navigation, evidence boundaries           |
| [Knowledge and research memory](knowledge.md)     | Source ownership, indexing, personalization, protection       |
| [Task execution and recovery](runtime.md)         | Run state, permissions, persistence, interrupted writes       |
| [Context and memory](context-memory-refactor.md)  | Handoff, retrieval budgets, independent retention             |
| [Literature research](literature-research.md)     | Candidate confirmation, full-text acquisition, subagents      |
| [Research reports](research-reports.md)           | Revisions, citations, writeback, export                       |
| [Interface design rules](../../docs/design.md)    | Shared colors, spacing, controls, interaction checklist       |
| [Versioning and releases](releases.md)            | Versions, channels, artifacts, publication and upgrade checks |
| [Built-in skills](../../skills/README.md)         | Skill usage and bundle maintenance                            |
| [Scripted harness checks](../../evals/README.md)  | Local model-script fixtures                                   |
| [Memory package](../../packages/memory/README.md) | Storage and package APIs                                      |

## Historical evidence

The [acceptance archive](acceptance/README.md) lists dated release, feature,
platform, and migration records with their original language. Results apply
only to the recorded package and environment; they are not current validation.

Keep raw traces, machine paths, temporary plans, and test libraries under ignored
`output/`. Obsolete drafts remain available in Git history. Preserve published
Release evidence links pinned to old tags.

- [PDF 搜集修复与固定样本复测（2026-10-08）](acceptance/pdf-acquisition-2026-10-08.md)
