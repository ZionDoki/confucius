import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MCP_TASK_GATEWAY_INSTRUCTIONS,
  artifactUpsertGuidance,
} from "./artifactPrompt";

describe("artifact upsert guidance", () => {
  it("does not require an artifact on every turn", () => {
    const text = artifactUpsertGuidance();
    assert.match(text, /Call artifact_upsert only to save a cited/);
    assert.match(text, /Do not save an ordinary reply as an artifact/);
    assert.match(text, /state what changed/);
    assert.doesNotMatch(text, /Before completing/);
    assert.doesNotMatch(text, /Required artifact kind/);
    assert.doesNotMatch(text, /This task's template/);
    assert.doesNotMatch(text, /Saved files/);
  });

  it("names the template product without forcing a wrap-up artifact", () => {
    const text = artifactUpsertGuidance({ templateId: "deep-read" });
    assert.match(text, /This task uses the "Paper review" template/);
    assert.match(text, /kind deep_read/);
    assert.match(text, /kind annotation_set/);
    assert.match(text, /Follow-ups and clarifications do not need an artifact/);
    assert.doesNotMatch(text, /commit_annotations/);
    assert.doesNotMatch(text, /approval dialog/i);
    assert.doesNotMatch(text, /before completing/i);
  });

  it("ignores freeform as a required product kind", () => {
    const text = artifactUpsertGuidance({ templateId: "freeform" });
    assert.doesNotMatch(text, /This task's template/);
    assert.doesNotMatch(text, /kind report/);
  });

  it("lists existing artifacts for revision by id", () => {
    const text = artifactUpsertGuidance({
      templateId: "evidence-audit",
      artifacts: [
        {
          id: "art_audit",
          kind: "evidence_audit",
          title: "Claim audit",
          revision: 2,
        },
      ],
    });
    assert.match(text, /- art_audit \(evidence_audit, r2\): Claim audit/);
    assert.match(text, /call artifact_upsert with its id/);
    assert.match(text, /This task uses the "Evidence audit" template/);
  });

  it("keeps MCP task instructions from requiring a wrap-up upsert", () => {
    assert.match(
      MCP_TASK_GATEWAY_INSTRUCTIONS,
      /only to save a cited research file/,
    );
    assert.doesNotMatch(
      MCP_TASK_GATEWAY_INSTRUCTIONS,
      /before completing the task/,
    );
  });
});
