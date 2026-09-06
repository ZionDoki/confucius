import assert from "node:assert/strict";
import { it } from "node:test";
import { runtimeOutcome, RuntimeUsageCounter } from "./runtimeOutcome";

it("requires the explicit success marker and preserves limits and refusals", () => {
  for (const backend of ["codex", "kimi"] as const) {
    assert.equal(
      runtimeOutcome(backend, backend === "codex" ? "completed" : "end_turn")
        .stopReason,
      "completed",
    );
    for (const invalid of [
      undefined,
      null,
      "",
      "inProgress",
      "unexpected",
      backend === "codex" ? "end_turn" : "completed",
    ])
      assert.equal(runtimeOutcome(backend, invalid).stopReason, "incomplete");
    assert.equal(runtimeOutcome(backend, "max_tokens").stopReason, "length");
    assert.equal(
      runtimeOutcome(backend, "max_turn_requests").stopReason,
      "iteration_budget",
    );
    assert.equal(
      runtimeOutcome(backend, "refusal").stopReason,
      "content_filter",
    );
    assert.equal(runtimeOutcome(backend, "cancelled").stopReason, "aborted");
  }
});

it("counts only observed cumulative usage deltas and ignores duplicate updates", () => {
  const usage = new RuntimeUsageCounter();
  assert.deepEqual(
    usage.observe({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
    { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  );
  assert.equal(
    usage.observe({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
    undefined,
  );
  assert.deepEqual(
    usage.observe({ inputTokens: 130, outputTokens: 25, totalTokens: 155 }),
    { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
  );
  assert.equal(
    usage.observe({ inputTokens: 20, outputTokens: 10, totalTokens: 30 }),
    undefined,
  );
  assert.deepEqual(
    usage.observe({ inputTokens: 30, outputTokens: 15, totalTokens: 45 }),
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  );
});

it("establishes a baseline when resuming an opaque existing provider session", () => {
  const usage = new RuntimeUsageCounter(false);
  assert.equal(
    usage.observe({ inputTokens: 9000, outputTokens: 500, totalTokens: 9500 }),
    undefined,
  );
  assert.deepEqual(
    usage.observe({ inputTokens: 9030, outputTokens: 520, totalTokens: 9550 }),
    { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
  );
  assert.equal(
    usage.observe({ inputTokens: -1, outputTokens: 5, totalTokens: 4 }),
    undefined,
  );
  assert.equal(usage.observe({ used: 1000, size: 2000 }), undefined);
});
