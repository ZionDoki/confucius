# Evals

Test traces for `@confucius/harness`. `packages/harness/src/evals.test.ts` runs
every `*.json` file. Each file contains a model script, an approval decision,
and the expected event sequence.

| Case             | File                    | Check                                           |
| ---------------- | ----------------------- | ----------------------------------------------- |
| Read-only search | `read-only-search.json` | Tool JSON result, then a delivery               |
| Write approval   | `write-approval.json`   | `ask` returns a structured deny or allow result |
| Budget stop      | `budget-exhausted.json` | Loop ends after `maxIterations` model calls     |

To add a case, create a JSON file with `modelScript`, optional `approval`, and
`expectedEventTypes`.
