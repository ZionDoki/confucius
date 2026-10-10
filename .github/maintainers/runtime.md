# Execution and recovery contracts

English · [简体中文](runtime.zh-CN.md)

[Maintainer guide](README.md) · [Development setup](development.md)

## One request, one recoverable run

Native, Codex and Kimi share `RunCoordinator`. The provider finishing a turn
does not establish that the user's request is complete.

| Record               | Responsibility                                                            |
| -------------------- | ------------------------------------------------------------------------- |
| `RunState`           | Current request, intent revision, sources, generation and consumed budget |
| `RunExecutor` result | One execution's stop reason, text and recovery material                   |
| `WorkSnapshot`       | Current run's artifacts, candidates, operations and missing work          |
| Checkpoint           | Paired messages, protocol replay state and context recovery               |
| Operation journal    | Prepared intent and authoritative effects/receipts                        |

Continue keeps the intent revision and consumed budget; new requirements can
create a new intent revision. Old proposals do not automatically become new
obligations. Delayed callbacks must match the current generation.

A plain answer may finish directly. Known incomplete artifacts or candidates
continue within the remaining budget. Repeated identical content or revision
bumps do not count as progress. Do not implement a separate preset stage machine.

## Sources and permissions

New tasks have no implicit current-PDF source. Explicit attachment and confirmed
literature acquisition establish sources. Ordinary attached sources are not
automatically an exclusive read scope; source-restricted presets enforce scope at
tool admission and completion checks.

Prepared writes declare immutable arguments, resource targets and verification
data. The host validates schemas, coordinates resource locks and records effects.
An approval must be well formed, explicitly allow the action and match the
pending request ID. Invalid replies must not consume the pending request.

Tool grants do not replace protected-memory confirmation or annotation review.
Literature import/download has its own exact-batch confirmation boundary.

## Side effects and replay

- Record batch effects individually. A known successful write replays its receipt.
- Reconcile unknown outcomes with authoritative Zotero state before retrying.
  A manual deletion after a committed annotation must not recreate it.
- Unrelated unknown operations do not block the entire application; same-resource
  writes still require reconciliation.
- A history/index/UI save failure cannot turn an applied native write into an
  unapplied one.
- Preserve prepared native keys and initialize Zotero item state correctly.
  Do not remove preallocated IDs to bypass native initialization.

`ExecutionScope` shares the remaining deadline across preparation, locks and
execution. Waiting for user approval pauses that deadline, but cancellation
remains effective and targets must be checked again after approval.

External MCP capabilities belong to one executor dispatch. Resume rotates leases
and namespaces; stale requests cannot borrow a new run's identity. Recheck
ownership at admission, preparation and approval boundaries.

## Protocol and context

Only complete streamed tool calls may execute. Distinguish normal completion,
tool calls, truncation, filtering, abnormal EOF and cancellation. Protocol replay
data is restored only with the matching profile.

Ajv validates tool input before preparation; annotation batches retain per-item
domain checks. Zotero's sandbox needs injected timers and safe logging rather
than assumptions about Node globals.

Context switching preserves originals, write receipts and budgets. History
cleanup is independent of memory distillation. See [context contracts](context-memory-refactor.md).

Ready reports can receive one independent revision within the current request's
remaining budget. A failed revision preserves the saved report and does not
create an artificial completion gate. See [report contracts](research-reports.md).

## Persistence and lifecycle

Runtime JSON lives under the local profile's `confucius/runtime-v1/`.
Task schema v4 supports older data; operations are stored separately and derived
indexes can be rebuilt. Native library objects stay in Zotero.

Missing-index recovery first preserves and verifies surviving data, then rebuilds
readable tasks. Newer local state and deletion markers take precedence. Recovered
history does not restore old tool grants, checkpoints or queued writes. IO failure
keeps recovery resumable instead of marking it active prematurely.

After restart, active tasks become interrupted and require explicit continuation.
Shutdown releases UI hooks, saves recovery state and prevents late callbacks from
rewriting task state.

## Diagnostics and validation

`task/trace` exports retained public events, histories, notes, operations,
annotation candidates and artifact versions. Export does not call models or
reconcile writes. It respects task scope, redacts known credentials and reports
missing/cleaned data; it cannot expose private CLI internals or recreate deleted text.

Run the [development checks](development.md). Tests must exercise lifecycle and
domain behavior, including partial writes, stale approval, cancellation, replay,
failed persistence and recovery. Use isolated profiles for native tests.
Historical results and their limits are in the [acceptance archive](acceptance/README.md).
