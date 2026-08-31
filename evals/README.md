# Evals

Golden traces for `@confucius/harness`. Cases are asserted in `packages/harness/src/turn-loop.test.ts`.

| Case | File | What it locks |
|---|---|---|
| Read-only search | `read-only-search.json` | Tool JSON result, then a delivery |
| Write approval | `write-approval.json` | `ask` → structured deny/allow, never a fake success |
| Budget stop | `budget-exhausted.json` | Loop ends after `maxIterations` model calls |
