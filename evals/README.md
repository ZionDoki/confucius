# Scripted harness checks

English · [简体中文](README.zh-CN.md)

[Development guide](../.github/maintainers/development.md)

These JSON fixtures check the Native execution loop with scripted model
responses. They do not contact a real model or establish answer quality.

Run `npm test` from the repository root. The runner,
[evals.test.ts](../packages/harness/src/evals.test.ts), loads every `*.json`
in this directory.

| Fixture                                        | Check                                                          |
| ---------------------------------------------- | -------------------------------------------------------------- |
| [read-only-search.json](read-only-search.json) | Read tool request/result, then an answer                       |
| [write-approval.json](write-approval.json)     | A write waits for an allow-once decision before execution      |
| [budget-exhausted.json](budget-exhausted.json) | Exhausted model steps end with `iteration_budget`, not success |

To add a case, copy the nearest fixture and give it a unique `id`,
`userText`, and `modelScript`. Optional inputs are `maxIterations` and
`approval` (`allow` or `deny`). Assert the relevant outcome with
`expectedEventTypes`, `expectedToolRequests`, `expectedLastEvent`, or
`expectedStopReason`. Event comparisons exclude `model_request_progress`.

Use focused package tests for other contracts. Real-model, Zotero, and upgrade
checks need separate evidence in the [acceptance archive](../.github/maintainers/acceptance/README.md).
