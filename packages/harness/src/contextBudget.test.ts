import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHARS_PER_TOKEN,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MIN_HISTORY_TOKENS,
  SYSTEM_AND_TOOLS_RESERVE_TOKENS,
  SAFETY_RESERVE_TOKENS,
  COMPACT_RATIO,
  estimateTokens,
  historyBudgetChars,
} from "./contextBudget";

describe("historyBudgetChars", () => {
  it("scales with the model's context window instead of a fixed cap", () => {
    const small = historyBudgetChars({ contextWindowTokens: 8_192 });
    const mid = historyBudgetChars({ contextWindowTokens: 32_768 });
    const large = historyBudgetChars({ contextWindowTokens: 131_072 });
    assert.ok(small < mid);
    assert.ok(mid < large);
    // A 128k window must be allowed to keep far more than the old 80k-char cap.
    assert.ok(large > 80_000);
  });

  it("reserves system, tools, and output tokens before assigning history", () => {
    const window = 32_768;
    const output = 2_048;
    const expectedUsable =
      window -
      (SYSTEM_AND_TOOLS_RESERVE_TOKENS + output + SAFETY_RESERVE_TOKENS);
    const expected = Math.floor(
      expectedUsable * COMPACT_RATIO * CHARS_PER_TOKEN,
    );
    assert.equal(
      historyBudgetChars({
        contextWindowTokens: window,
        maxOutputTokens: output,
      }),
      expected,
    );
  });

  it("never drops below a usable floor on tiny windows", () => {
    const budget = historyBudgetChars({
      contextWindowTokens: 4_096,
      maxOutputTokens: 4_096,
    });
    assert.equal(
      budget,
      Math.floor(MIN_HISTORY_TOKENS * COMPACT_RATIO * CHARS_PER_TOKEN),
    );
    assert.ok(budget >= 1_000);
  });

  it("treats a zero maxTokens as the default output reserve", () => {
    const withDefault = historyBudgetChars({
      contextWindowTokens: 32_768,
    });
    const withZero = historyBudgetChars({
      contextWindowTokens: 32_768,
      maxOutputTokens: 0,
    });
    const explicit = historyBudgetChars({
      contextWindowTokens: 32_768,
      maxOutputTokens: DEFAULT_OUTPUT_RESERVE_TOKENS,
    });
    assert.equal(withDefault, withZero);
    assert.equal(withZero, explicit);
  });
});

describe("estimateTokens", () => {
  it("rounds characters up using the mixed CJK/Latin ratio", () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(3.5), 1);
    assert.equal(estimateTokens(4), 2);
  });
});
