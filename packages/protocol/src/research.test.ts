import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  annotationsFromBody,
  artifactBodyMatchesKind,
  isArtifactRecord,
  isCitation,
  isLockedContextSnapshot,
  legacyContextSnapshot,
  lockedContextFingerprint,
  mergeLockedContexts,
  summarizeArtifact,
  withLockedContextFingerprint,
} from "./research";

describe("locked research context", () => {
  it("has a stable fingerprint independent of item order and titles", () => {
    const first = withLockedContextFingerprint({
      version: 1,
      capturedAt: 1,
      items: [
        { id: "b", libraryID: 1, key: "B", title: "old", source: "library" },
        { id: "a", libraryID: 1, key: "A", title: "A", source: "library" },
      ],
    });
    const second = withLockedContextFingerprint({
      version: 1,
      capturedAt: 2,
      items: [
        {
          id: "a2",
          libraryID: 1,
          key: "A",
          title: "renamed",
          source: "library",
        },
        { id: "b2", libraryID: 1, key: "B", title: "B", source: "library" },
      ],
    });
    assert.equal(first.fingerprint, second.fingerprint);
  });

  it("changes when a reader selection changes", () => {
    const base = {
      items: [],
      selection: {
        id: "selection:1",
        text: "claim A",
        pageLabel: "3",
        pageIndex: 2,
      },
    };
    assert.notEqual(
      lockedContextFingerprint(base),
      lockedContextFingerprint({
        ...base,
        selection: { ...base.selection, text: "claim B" },
      }),
    );
  });

  it("adds sources without mutating the locked snapshot", () => {
    const locked = legacyContextSnapshot(
      { item: { libraryID: 1, key: "A" } },
      1,
    );
    const incoming = legacyContextSnapshot(
      { item: { libraryID: 1, key: "B" } },
      2,
    );
    const merged = mergeLockedContexts(locked, incoming);
    assert.deepEqual(
      locked.items.map((item) => item.key),
      ["A"],
    );
    assert.deepEqual(
      merged.items.map((item) => item.key),
      ["A", "B"],
    );
    assert.equal(merged.capturedAt, 2);
  });

  it("rejects malformed snapshots at the RPC and persistence boundary", () => {
    assert.equal(
      isLockedContextSnapshot({ version: 1, capturedAt: 1, items: null }),
      false,
    );
    assert.equal(
      isLockedContextSnapshot({
        version: 1,
        capturedAt: 1,
        fingerprint: "stale",
        items: [
          {
            id: "item:1:A",
            libraryID: 1,
            key: "A",
            title: "Paper",
            source: "library",
          },
        ],
      }),
      true,
    );
  });
});

describe("artifact bodies", () => {
  it("accepts all current annotation types and normalizes legacy highlights", () => {
    assert.equal(
      artifactBodyMatchesKind("annotation_set", {
        type: "annotation_set",
        item: { libraryID: 1, key: "PAPER" },
        annotations: [
          {
            type: "highlight",
            page: 1,
            quote: "critical result",
          },
          {
            type: "underline",
            page: 2,
            quote: "read carefully",
            color: "#123aBC",
          },
          {
            type: "image",
            page: 3,
            rect: [100, 200, 300, 250],
            comment: "Figure evidence",
          },
        ],
        legend: [
          {
            type: "highlight",
            color: "#ffd400",
            meaning: "Very important",
          },
        ],
      }),
      true,
    );
    assert.deepEqual(
      annotationsFromBody({
        type: "annotation_set",
        item: { libraryID: 1, key: "PAPER" },
        highlights: [{ page: 4, quote: "legacy" }],
      }),
      [{ type: "highlight", page: 4, quote: "legacy" }],
    );
  });

  it("rejects malformed annotation colors and normalized regions", () => {
    const base = {
      type: "annotation_set",
      item: { libraryID: 1, key: "PAPER" },
    } as const;
    assert.equal(
      artifactBodyMatchesKind("annotation_set", {
        ...base,
        annotations: [
          { type: "underline", page: 1, quote: "x", color: "blue" },
        ],
      }),
      false,
    );
    assert.equal(
      artifactBodyMatchesKind("annotation_set", {
        ...base,
        annotations: [
          {
            type: "image",
            page: 1,
            rect: [900, 10, 200, 100],
            comment: "outside page",
          },
        ],
      }),
      false,
    );
    assert.equal(
      artifactBodyMatchesKind("annotation_set", {
        ...base,
        annotations: [
          { type: "image", page: 1, rect: [0, 0, 1, 1], comment: "" },
        ],
      }),
      false,
    );
  });

  it("rejects a body that does not match the declared kind", () => {
    assert.equal(
      artifactBodyMatchesKind("evidence_audit", {
        type: "markdown",
        markdown: "wrong shape",
      }),
      false,
    );
  });

  it("validates nested rows instead of trusting only the body discriminator", () => {
    assert.equal(
      artifactBodyMatchesKind("evidence_audit", {
        type: "evidence_audit",
      }),
      false,
    );
    assert.equal(
      artifactBodyMatchesKind("triage_table", {
        type: "triage_table",
        rows: [
          {
            item: { libraryID: 1, key: "A" },
            title: "Paper",
            decision: "maybe",
            reason: "Malformed decision",
          },
        ],
      }),
      false,
    );
    assert.equal(
      artifactBodyMatchesKind("collection_diff", {
        type: "collection_diff",
        operations: [
          {
            op: "tag_add",
            item: { libraryID: 1, key: "A" },
            value: "reviewed",
          },
        ],
      }),
      true,
    );
    assert.equal(
      artifactBodyMatchesKind("evidence_audit", {
        type: "evidence_audit",
        claims: [
          {
            claim: "Claim",
            evidence: "Grounded evidence",
            verdict: "supported",
            risk: "Residual risk",
            citationIds: ["c1"],
          },
        ],
      }),
      true,
    );
  });

  it("validates persisted citation locations", () => {
    assert.equal(
      isCitation({ itemLibraryID: 1, itemKey: "A", page: 3, quote: "x" }),
      true,
    );
    assert.equal(isCitation({ itemLibraryID: 1, itemKey: "", page: 0 }), false);
  });

  it("validates persisted revisions and keeps event summaries lightweight", () => {
    const artifact = {
      id: "art_1",
      sessionId: "task_1",
      taskId: "task_1",
      kind: "report",
      title: "Report",
      body: { type: "markdown", markdown: "Full body" },
      status: "ready",
      revision: 1,
      citations: [],
      sourceContextIds: [],
      revisions: [
        {
          revision: 1,
          body: { type: "markdown", markdown: "Full body" },
          citations: [],
          sourceContextIds: [],
          createdAt: 1,
          backend: "native",
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    };
    assert.equal(isArtifactRecord(artifact), true);
    if (!isArtifactRecord(artifact)) throw new Error("fixture is invalid");
    const summary = summarizeArtifact(artifact);
    assert.equal(summary.revision, 1);
    assert.equal("body" in summary, false);
    assert.equal("revisions" in summary, false);
    assert.equal(
      isArtifactRecord({ ...artifact, revision: 2 }),
      false,
      "the current revision must match the latest persisted revision",
    );
    assert.equal(
      isArtifactRecord({
        ...artifact,
        body: { type: "markdown", markdown: "not the latest body" },
      }),
      false,
      "the current body must match the latest persisted revision",
    );
    assert.equal(
      isArtifactRecord({
        ...artifact,
        revision: 2,
        revisions: [
          artifact.revisions[0],
          { ...artifact.revisions[0], revision: 3 },
        ],
      }),
      false,
      "revision history must be contiguous",
    );
  });
});
