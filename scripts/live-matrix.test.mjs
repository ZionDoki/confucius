import assert from "node:assert/strict";
import { test } from "node:test";
import { matrixCases, liveArgs } from "./live-matrix.mjs";

test("matrix pins model, provider profile, window and budget into non-shell argv", () => {
  const entries = matrixCases({
    schemaVersion: 1,
    defaults: { maxIterations: 7, contextWindowTokens: 32768 },
    cases: [
      {
        id: "deepseek",
        baseUrl: "https://example.invalid/v1",
        model: "model;literal",
        modelRevision: "sha256:fixed",
        profile: { reasoningReplay: "reasoning_content" },
        maxToolCalls: 0,
      },
    ],
  });
  const args = liveArgs(entries[0], true);
  assert.ok(args.includes("--dry-run"));
  assert.equal(args[args.indexOf("--model") + 1], "model;literal");
  assert.equal(args[args.indexOf("--model-revision") + 1], "sha256:fixed");
  assert.equal(args[args.indexOf("--max-iterations") + 1], "7");
  assert.equal(args[args.indexOf("--max-tool-calls") + 1], "0");
  assert.deepEqual(JSON.parse(args[args.indexOf("--profile-json") + 1]), {
    reasoningReplay: "reasoning_content",
  });
});

test("matrix rejects ambiguous, secret-bearing, and malformed configuration", () => {
  const base = {
    id: "x",
    baseUrl: "https://example.invalid/v1",
    model: "fixture",
  };
  for (const cases of [
    [],
    [base, base],
    [{ ...base, apiKey: "secret" }],
    [{ ...base, baseUrl: "https://user:secret@example.invalid/v1" }],
    [{ ...base, baseUrl: "https://example.invalid/v1?key=secret" }],
    [{ ...base, maxIterations: -1 }],
    [{ ...base, maxIterations: "7" }],
    [{ ...base, profile: [] }],
  ])
    assert.throws(() => matrixCases({ schemaVersion: 1, cases }));
});
