# Evals

Golden traces for `@confucius/harness`. Every `*.json` here is executed by
`packages/harness/src/evals.test.ts` on each test run — each file carries its
own model script, approval decision, and the exact event sequence the loop
must emit.

| Case | File | What it locks |
|---|---|---|
| Read-only search | `read-only-search.json` | Tool JSON result, then a delivery |
| Write approval | `write-approval.json` | `ask` → structured deny/allow, never a fake success |
| Budget stop | `budget-exhausted.json` | Loop ends after `maxIterations` model calls |

To add a case: drop a JSON file with `modelScript` (scripted model turns),
optional `approval`, and `expectedEventTypes`, and the runner picks it up
automatically.
