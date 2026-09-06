import { ToolTimeout } from "../tools/Deadline";
import type {
  PreparedOperation,
  ToolExecutionContext,
  ToolExecutionScope,
  ToolResult,
  ToolFailure,
} from "@confucius/protocol";
import { validateArgs, type ToolProvider } from "@confucius/harness";
import {
  ResourceLocks,
  runtimeJsonStorage,
  type JsonStorage,
} from "./RuntimeStorage";
import {
  OperationStore,
  freezePreparedOperation,
  type OperationRecord,
  type OperationQuery,
  type OperationRepository,
} from "./OperationStore";
import {
  createExecutionScope,
  runInScope,
  throwIfScopeExpired,
  type OwnedExecutionScope,
} from "./ExecutionScope";

export type {
  OperationRecord,
  OperationQuery,
  OperationReader,
  OperationRepository,
} from "./OperationStore";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
const failure = (
  name: string,
  message: string,
  code: ToolFailure["code"] = "unavailable",
): ToolFailure => ({
  ok: false,
  toolName: name,
  code,
  message,
  effect: "none",
  retryable: false,
});
const durable = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function durableContext(context: ToolExecutionContext): ToolExecutionContext {
  const {
    onProgress: _progress,
    replayResult: _replay,
    signal: _signal,
    executionScope: _scope,
    preparedOperation: _intent,
    ...saved
  } = context;
  return durable(saved);
}
function replaceArgs(
  target: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>,
) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, durable(source));
}

interface Prepared {
  context: ToolExecutionContext;
  request: string;
  intent: PreparedOperation;
  scope: OwnedExecutionScope;
  replay?: ToolResult;
}
export interface OperationDomain {
  reconcile(
    intent: PreparedOperation,
    operation: OperationRecord,
    scope: ToolExecutionScope,
  ): Promise<ToolResult | null>;
}
interface ExecutionOptions {
  readWarning?: () => string | undefined;
  /** Compatibility hook. History/UI projection persistence does not belong here. */
  beforeWrite?: () => Promise<void>;
  timeoutMs?: number;
}

/** One executor and canonical operation store serve Native, ACP, UI and nested calls. */
export class ToolExecutionService implements OperationRepository {
  private locks = new ResourceLocks();
  private inFlight = new Set<string>();
  private readonly store: OperationStore;
  private readonly domains = new Map<string, OperationDomain>();
  constructor(
    storage: JsonStorage = runtimeJsonStorage(),
    private reconcile?: (
      operation: OperationRecord,
    ) => Promise<ToolResult | null>,
    private options: ExecutionOptions = {},
  ) {
    this.store = new OperationStore(storage);
  }

  registerDomain(name: string, domain: OperationDomain): void {
    if (!name) throw new Error("Operation domain name is required");
    this.domains.set(name, domain);
  }
  setLegacyReconciler(
    reconcile: (operation: OperationRecord) => Promise<ToolResult | null>,
  ): void {
    this.reconcile = reconcile;
  }
  getOperation(id: string) {
    return this.store.getOperation(id);
  }
  listOperations(query: OperationQuery = {}) {
    return this.store.listOperations(query);
  }
  importLegacyOperation(operation: OperationRecord) {
    return this.store.importLegacyOperation(operation);
  }
  recoverStorage() {
    return this.store.recover();
  }

  async unresolvedForTask(
    taskId: string,
    options?: {
      runId?: string;
      includeLegacy?: boolean;
      operationIds?: readonly string[];
    },
  ): Promise<string[]> {
    const unresolved: string[] = [];
    const scope = createExecutionScope({ timeoutMs: this.options.timeoutMs });
    try {
      const entries = await runInScope(scope, () =>
        this.store.listOperations({ taskId }),
      );
      for (const entry of entries) {
        if (
          options &&
          !(
            (options.runId !== undefined &&
              entry.context.runId === options.runId) ||
            (options.includeLegacy && !entry.context.runId) ||
            options.operationIds?.includes(entry.id)
          )
        )
          continue;
        if (entry.result && entry.result.effect !== "unknown") continue;
        try {
          await this.locks.run(
            entry.resources,
            async () => {
              const current = (await this.store.getOperation(entry.id))!;
              if (current.result && current.result.effect !== "unknown") return;
              if (!(await this.resolve(current, scope)))
                unresolved.push(entry.id);
            },
            scope,
          );
        } catch {
          unresolved.push(entry.id);
        }
      }
      return unresolved;
    } finally {
      scope.dispose();
    }
  }

  private async resolve(
    operation: OperationRecord,
    scope: ToolExecutionScope,
  ): Promise<ToolResult | null> {
    if (this.inFlight.has(operation.id)) return null;
    const domain =
      operation.intent && this.domains.get(operation.intent.domain);
    const resolved = await runInScope(scope, () =>
      domain && operation.intent
        ? domain.reconcile(operation.intent, operation, scope)
        : (this.reconcile?.(operation) ?? Promise.resolve(null)),
    );
    if (!resolved || resolved.effect === "unknown") return null;
    const result = { ...resolved, operationId: operation.id };
    await this.store.save({ ...operation, result, finishedAt: Date.now() });
    return result;
  }

  wrap(inner: ToolProvider, base: ToolExecutionContext = {}): ToolProvider {
    const prepared = new Map<string, Prepared>();
    const prepare = async (
      name: string,
      args: Record<string, unknown>,
      context: ToolExecutionContext = {},
    ): Promise<ToolFailure | null> => {
      const merged: ToolExecutionContext = { ...base, ...context };
      const parent = merged.executionScope;
      const scope = createExecutionScope({
        signal: parent?.signal ?? merged.signal,
        deadlineAt: parent?.deadlineAt,
        timeoutMs: this.options.timeoutMs,
      });
      merged.signal = scope.signal;
      merged.executionScope = scope;
      const meta = inner.getMeta(name);
      if (!meta) {
        scope.dispose();
        return failure(name, "Unknown or unavailable tool", "not_found");
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        scope.dispose();
        return failure(
          name,
          "Tool arguments must be a JSON object",
          "invalid_args",
        );
      }
      try {
        // Normalization happens on an isolated copy. A timed-out prepare cannot
        // later mutate the request the user reviewed or the intent we persist.
        const normalized = durable(args);
        const shapeError = validateArgs(
          name,
          inner.getSchema(name),
          normalized,
        );
        const request = canonical(normalized);
        const write = meta.mutatesState || meta.effectClass === "unknown";
        const previous =
          write && merged.operationId
            ? await runInScope(scope, () =>
                this.store.getOperation(merged.operationId!),
              )
            : null;
        if (previous) {
          if (
            previous.name !== name ||
            (request !== previous.request &&
              request !== canonical(previous.args))
          )
            throw new Error(
              "Operation ID was already used with different arguments",
            );
          const intent =
            previous.intent ??
            freezePreparedOperation({
              schemaVersion: 1,
              domain: meta.catalog,
              name,
              args: previous.args,
              resources: previous.resources,
              recovery: durableContext(previous.context) as Record<
                string,
                unknown
              >,
            });
          const saved = {
            ...previous.context,
            ...merged,
            ...durableContext(previous.context),
            signal: scope.signal,
            executionScope: scope,
            preparedOperation: intent,
          };
          replaceArgs(args, previous.args);
          Object.assign(context, saved);
          if (previous.result && previous.result.effect !== "unknown")
            context.replayResult = previous.result;
          prepared.get(previous.id)?.scope.dispose();
          prepared.set(previous.id, {
            context: saved,
            request,
            intent,
            scope,
            replay: previous.result,
          });
          return null;
        }
        const invalid = await runInScope(scope, () =>
          inner.prepare
            ? inner.prepare(name, normalized, merged)
            : Promise.resolve(shapeError),
        );
        if (invalid) {
          scope.dispose();
          return invalid;
        }
        const invalidFinal = validateArgs(
          name,
          inner.getSchema(name),
          normalized,
        );
        if (invalidFinal) {
          scope.dispose();
          return invalidFinal;
        }
        const supplied = merged.preparedOperation;
        if (
          supplied &&
          (supplied.name !== name ||
            canonical(supplied.args) !== canonical(normalized))
        )
          throw new Error(
            "Prepared operation does not match the normalized request",
          );
        const intent = freezePreparedOperation(
          supplied ?? {
            schemaVersion: 1,
            domain: meta.catalog,
            name,
            args: normalized,
            // Older providers are conservatively serialized by declared catalog.
            // Domains own precise resource identities; the executor never guesses.
            resources: merged.resources?.length
              ? [...new Set(merged.resources)].sort()
              : [`catalog:${meta.catalog}`],
            recovery: durableContext(merged) as Record<string, unknown>,
          },
        );
        merged.preparedOperation = intent;
        replaceArgs(args, normalized);
        Object.assign(context, merged);
        if (merged.operationId) {
          prepared.get(merged.operationId)?.scope.dispose();
          prepared.set(merged.operationId, {
            context: merged,
            request,
            intent,
            scope,
          });
        } else scope.dispose();
        return null;
      } catch (error) {
        scope.abort();
        scope.dispose();
        return failure(
          name,
          `Preparation did not complete; no write was started: ${String(error)}`,
          error instanceof ToolTimeout
            ? "timeout"
            : /different arguments/.test(String(error))
              ? "invalid_args"
              : "unavailable",
        );
      }
    };
    return {
      listTools: () => inner.listTools(),
      getMeta: (name) => inner.getMeta(name),
      getSchema: (name) => inner.getSchema(name),
      prepare,
      recordDenied: async (name, args, context = {}) => {
        const merged = { ...base, ...context };
        const id = merged.operationId;
        if (!id)
          throw new Error(
            "A denied operation must retain its prepared operation ID",
          );
        const existing = await this.store.getOperation(id);
        // A delayed approval response cannot erase an actual or uncertain effect.
        if (existing) return;
        const preparation = prepared.get(id);
        const meta = inner.getMeta(name);
        if (!meta) return;
        const intent =
          preparation?.intent ??
          freezePreparedOperation(
            merged.preparedOperation ?? {
              schemaVersion: 1,
              domain: meta.catalog,
              name,
              args,
              resources: merged.resources?.length
                ? merged.resources
                : [`catalog:${meta.catalog}`],
              recovery: durableContext(merged) as Record<string, unknown>,
            },
          );
        try {
          await this.store.save({
            id,
            name,
            intent,
            request: preparation?.request ?? canonical(args),
            args: durable(intent.args),
            resources: [...intent.resources],
            context: durableContext(preparation?.context ?? merged),
            startedAt: Date.now(),
            finishedAt: Date.now(),
            result: {
              ...failure(
                name,
                "The user denied this operation",
                "permission_denied",
              ),
              operationId: id,
            },
          });
        } finally {
          preparation?.scope.dispose();
          prepared.delete(id);
        }
      },
      call: async (name, args, signal, context = {}) => {
        const id =
          context.operationId ??
          base.operationId ??
          `${base.taskId ?? "local"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
        const previousPreparation = prepared.get(id);
        let merged: ToolExecutionContext = {
          ...base,
          ...previousPreparation?.context,
          ...context,
          operationId: id,
        };
        signal ??= context.signal ?? base.signal;
        if (signal) merged.signal = signal;
        const edited =
          previousPreparation &&
          canonical(previousPreparation.intent.args) !== canonical(args);
        if (edited) {
          // Re-prepare edited content against the original reviewed before-state.
          // A changed target produces a different domain resource footprint.
          merged.expectedAfter = {};
          delete merged.preparedOperation;
          prepared.delete(id);
        }
        if (!prepared.has(id)) {
          const invalid = await prepare(name, args, merged);
          if (invalid) {
            previousPreparation?.scope.dispose();
            return { ...invalid, operationId: id };
          }
        }
        const preparation = prepared.get(id)!;
        prepared.delete(id);
        const scope = preparation.scope;
        if (
          edited &&
          canonical(previousPreparation.intent.resources) !==
            canonical(preparation.intent.resources)
        ) {
          scope.dispose();
          previousPreparation.scope.dispose();
          return {
            ...failure(
              name,
              "The edited request changed its target; prepare the new target for review",
              "invalid_args",
            ),
            operationId: id,
          };
        }
        merged = {
          ...merged,
          ...preparation.context,
          operationId: id,
          onProgress: context.onProgress ?? preparation.context.onProgress,
        };
        if (preparation.replay && preparation.replay.effect !== "unknown") {
          scope.dispose();
          return preparation.replay;
        }
        const abort = () => scope.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) scope.abort();
        const meta = inner.getMeta(name)!;
        const write = meta.mutatesState || meta.effectClass === "unknown";
        const keys = [...preparation.intent.resources];
        const run = async (): Promise<ToolResult> => {
          throwIfScopeExpired(scope);
          let operation: OperationRecord | undefined;
          if (write) {
            try {
              await runInScope(scope, () => this.recoverStorage());
              const entries = await runInScope(scope, () =>
                this.store.listOperations(),
              );
              const previous = entries.find((entry) => entry.id === id);
              if (previous) {
                if (
                  previous.name !== name ||
                  canonical(previous.args) !==
                    canonical(preparation.intent.args)
                )
                  return {
                    ...failure(
                      name,
                      "Operation ID was already used with different arguments",
                      "invalid_args",
                    ),
                    operationId: id,
                  };
                if (previous.result && previous.result.effect !== "unknown")
                  return previous.result;
              }
              for (const pending of entries)
                if (
                  (!pending.result || pending.result.effect === "unknown") &&
                  (pending.resources.some((key) => keys.includes(key)) ||
                    (!pending.intent &&
                      inner.getMeta(pending.name)?.catalog === meta.catalog))
                ) {
                  if (!(await this.resolve(pending, scope)))
                    return {
                      ...failure(
                        name,
                        "A previous write has an unknown outcome; its owning domain must reconcile the affected objects before another write.",
                      ),
                      effect: id === pending.id ? "unknown" : "none",
                      operationId: id,
                      details: {
                        blockedByOperationId: pending.id,
                        priorEffect: "unknown",
                        nextAction:
                          "Reconcile the previous operation against current native objects",
                      },
                    };
                }
              const recovered = await this.store.getOperation(id);
              if (recovered?.result) return recovered.result;
              if (this.options.beforeWrite)
                await runInScope(scope, this.options.beforeWrite);
              operation = {
                id,
                name,
                request: preparation.request,
                intent: preparation.intent,
                args: durable(preparation.intent.args),
                context: durableContext(merged),
                resources: keys,
                startedAt: Date.now(),
              };
              const savingIntent = this.store.save(operation);
              try {
                await runInScope(scope, () => savingIntent);
              } catch (error) {
                const result = {
                  ...failure(
                    name,
                    `Unable to persist operation intent; no write was started: ${String(error)}`,
                    error instanceof ToolTimeout ? "timeout" : "unavailable",
                  ),
                  operationId: id,
                };
                // Even an IO operation that finishes after its deadline records
                // that dispatch never happened, rather than becoming a fake unknown.
                void savingIntent
                  .catch(() => undefined)
                  .then(() =>
                    this.store.save({
                      ...operation!,
                      result,
                      finishedAt: Date.now(),
                    }),
                  )
                  .catch(() => undefined);
                return result;
              }
            } catch (error) {
              return {
                ...failure(
                  name,
                  `Unable to prepare execution; no new write was started: ${String(error)}`,
                  error instanceof ToolTimeout ? "timeout" : "unavailable",
                ),
                operationId: id,
              };
            }
          }
          const startedAt = Date.now();
          let stage = "executing",
            timedOut = false,
            dispatched = false;
          const callback = merged.onProgress;
          merged.onProgress = (event) => {
            if (timedOut) return;
            stage = event.stage;
            try {
              callback?.(event);
            } catch {
              /* observational only */
            }
          };
          merged.signal = scope.signal;
          merged.executionScope = scope;
          merged.preparedOperation = preparation.intent;
          const normalize = (result: ToolResult): ToolResult => ({
            ...result,
            operationId: id,
            effect:
              result.effect ??
              (write
                ? result.ok
                  ? "applied"
                  : ["internal", "timeout"].includes(result.code)
                    ? "unknown"
                    : "none"
                : "none"),
            retryable: result.retryable ?? false,
            diagnostics: {
              stage,
              elapsedMs: Date.now() - startedAt,
              retryCount: 0,
              persistence: write ? "saved" : "not_required",
            },
          });
          const persist = async (result: ToolResult) => {
            const receipt = { ...result };
            if (receipt.ok) delete receipt.transientMedia;
            await this.store.save({
              ...operation!,
              stage,
              elapsedMs: Date.now() - startedAt,
              result: durable(receipt),
              finishedAt: Date.now(),
            });
          };
          let receiptSaved: Promise<void> = Promise.resolve();
          const actual = Promise.resolve()
            .then(() => {
              throwIfScopeExpired(scope);
              dispatched = true;
              return inner.call(
                name,
                durable(preparation.intent.args),
                scope.signal,
                merged,
              );
            })
            .catch((error): ToolResult => ({
              ...failure(
                name,
                String(error),
                error instanceof ToolTimeout ? "timeout" : "internal",
              ),
              effect: write && dispatched ? "unknown" : "none",
            }))
            .then(normalize);
          if (write) {
            this.inFlight.add(id);
            void actual
              .then(async (result) => {
                if (timedOut) {
                  await receiptSaved.catch(() => undefined);
                  await persist(result);
                }
              })
              .catch(() => {
                /* OperationStore retains the dirty known receipt. */
              })
              .finally(() => this.inFlight.delete(id));
          }
          let result: ToolResult;
          try {
            result = await runInScope(scope, () => actual);
          } catch (error) {
            timedOut = true;
            scope.abort();
            result = normalize({
              ...failure(name, String(error), "timeout"),
              effect: write && dispatched ? "unknown" : "none",
            });
          }
          if (write) {
            receiptSaved = persist(result);
            try {
              await runInScope(scope, () => receiptSaved);
            } catch (error) {
              if (result.diagnostics)
                result.diagnostics.persistence = "pending";
              result.warnings = [
                ...(result.warnings ?? []),
                `Operation outcome is known but its receipt is not yet confirmed saved: ${String(error)}`,
              ];
              void receiptSaved.catch(() => undefined);
            }
          }
          const warning = !write ? this.options.readWarning?.() : undefined;
          if (warning) result.warnings = [...(result.warnings ?? []), warning];
          return result;
        };
        try {
          return write
            ? await this.locks.run([...keys, `operation:${id}`], run, scope)
            : await run();
        } catch (error) {
          return {
            ...failure(
              name,
              `Tool did not start: ${String(error)}`,
              error instanceof ToolTimeout ? "timeout" : "internal",
            ),
            operationId: id,
          };
        } finally {
          signal?.removeEventListener("abort", abort);
          scope.dispose();
          if (previousPreparation?.scope !== scope)
            previousPreparation?.scope.dispose();
        }
      },
    };
  }
}
