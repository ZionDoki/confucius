import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionBinding } from "./run";
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
        truncatedPages: [2],
        read: "partial",
        analysis: "reported",
        verification: "unknown",
        failed: "page 3 unreadable",
        evidence: [{ ref: "h:task:window:item" }],
      },
    ],
    ...overrides,
  };
}

describe("coverageSummary", () => {
  it("counts a valid snapshot", () => {
    const summary = coverageSummary(coverage());
    assert.ok(!("damaged" in summary));
    assert.equal(summary.expected, 1);
    assert.equal(summary.observed, 1);
    assert.equal(summary.completeTextObserved, 0);
    assert.equal(summary.analysisReported, 1);
    assert.equal(summary.staleAnalysis, 0);
    assert.equal(summary.failed, 1);
  });

  it("keeps a genuinely empty snapshot at zero expected", () => {
    const summary = coverageSummary(coverage({ entries: [] }));
    assert.ok(!("damaged" in summary));
    assert.equal(summary.expected, 0);
    assert.equal(summary.observed, 0);
  });

  it("marks null and structurally damaged coverage as damaged rather than zero", () => {
    const damaged: Array<[string, unknown]> = [
      ["null", null],
      ["undefined", undefined],
      [
        "non-array entries",
        { ...coverage(), entries: {} } as unknown as SourceCoverage,
      ],
      [
        "entry missing pages",
        { ...coverage(), entries: [{}] } as unknown as SourceCoverage,
      ],
      [
        "entry with non-array pages",
        {
          ...coverage(),
          entries: [{ ...coverage().entries[0], pagesObserved: "1" }],
        } as unknown as SourceCoverage,
      ],
      [
        "unknown enumeration",
        {
          ...coverage(),
          enumeration: "unknown",
        } as unknown as SourceCoverage,
      ],
    ];
    for (const [label, value] of damaged) {
      const summary = coverageSummary(value as SourceCoverage);
      assert.ok("damaged" in summary, `${label} was summarized as valid`);
      assert.equal(summary.damaged, true, label);
      assert.doesNotMatch(JSON.stringify(summary), /"expected"|"observed"/);
    }
  });
});
