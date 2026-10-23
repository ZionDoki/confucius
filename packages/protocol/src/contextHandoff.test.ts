import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { restoreContextHandoff, type ContextHandoff } from "./contextHandoff";
import type { ExecutionBinding, WorkSnapshot } from "./run";
import { coverageSummary, type SourceCoverage } from "./sourceCoverage";

const binding: ExecutionBinding = {
  runId: "run_1",
  intentRevision: 1,
  sourceFingerprint: "fingerprint-1",
};

function coverage(overrides: Partial<SourceCoverage> = {}): SourceCoverage {
  return {
    version: 1,
    binding,
    enumeration: "bound-items",
    entries: [
      {
        sourceId: "1:KEY",
        title: "Paper",
        bindingVersion: "v1",
        pagesObserved: [1, 2],
        truncatedPages: [],
        read: "partial",
        analysis: "unreported",
        verification: "unknown",
        evidence: [{ ref: "h:task:window:item" }],
      },
    ],
    ...overrides,
  };
}

function handoff(work: Partial<WorkSnapshot> = {}): ContextHandoff {
  return {
    version: 1,
    id: "handoff_1",
    taskId: "task_1",
    binding,
    createdAt: 1,
    work: {
      completed: [],
      missing: [],
      unknownOperationIds: [],
      ...work,
    },
    nextAction: "Continue the review",
    notes: [],
    evidence: [],
    supplemented: false,
  };
}

describe("restoreContextHandoff coverage", () => {
  it("restores a structurally valid coverage snapshot", () => {
    const restored = restoreContextHandoff(handoff({ coverage: coverage() }));
    assert.equal(restored?.work.coverage?.entries.length, 1);
    assert.deepEqual(restored?.work.coverage?.entries[0].pagesObserved, [1, 2]);
  });

  it("rejects damaged coverage before the later projection crashes", () => {
    const entry = coverage().entries[0];
    const damaged: unknown[] = [
      {},
      { ...coverage(), version: 2 },
      { ...coverage(), binding: { runId: "run_1" } },
      { ...coverage(), enumeration: "unknown" },
      { ...coverage(), entries: {} },
      { ...coverage(), entries: [{}] },
      { ...coverage(), entries: [{ ...entry, pagesObserved: [1, "2"] }] },
      { ...coverage(), entries: [{ ...entry, evidence: [{ ref: "bad" }] }] },
    ];
    for (const value of damaged) {
      assert.throws(
        () =>
          restoreContextHandoff(handoff({ coverage: value as SourceCoverage })),
        /Saved context handoff is damaged/,
      );
    }
  });

  it("reports a damaged coverage snapshot explicitly instead of zero sources", () => {
    const summary = coverageSummary({
      enumeration: "bound-items",
    } as unknown as SourceCoverage);
    assert.ok("damaged" in summary);
    assert.equal(summary.damaged, true);
    assert.equal("expected" in summary, false);
  });
});
