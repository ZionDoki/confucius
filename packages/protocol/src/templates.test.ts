import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FEATURED_TASK_TEMPLATES,
  TASK_TEMPLATES,
  taskTemplate,
  validateTemplateContext,
} from "./templates";
import { emptyLockedContext, withLockedContextFingerprint } from "./research";

describe("task templates", () => {
  it("keeps all 13 presets available independent of current context", () => {
    assert.equal(TASK_TEMPLATES.length, 13);
    assert.equal(new Set(TASK_TEMPLATES.map((item) => item.id)).size, 13);
    assert.deepEqual(taskTemplate("deep-read")?.additionalArtifactKinds, [
      "annotation_set",
    ]);
  });

  it("features only the three representative research modes", () => {
    assert.deepEqual(
      FEATURED_TASK_TEMPLATES.map((item) => item.id),
      ["deep-read", "evidence-audit", "synthesis"],
    );
  });

  it("validates staged context only when the user sends", () => {
    const empty = emptyLockedContext(1);
    assert.equal(
      validateTemplateContext(taskTemplate("deep-read")!, empty).ok,
      false,
    );
    assert.equal(
      validateTemplateContext(taskTemplate("explain-selection")!, empty).ok,
      false,
    );

    const onePaper = withLockedContextFingerprint({
      ...empty,
      items: [
        {
          id: "item:1:A",
          libraryID: 1,
          key: "A",
          title: "Paper A",
          source: "library",
        },
      ],
    });
    assert.equal(
      validateTemplateContext(taskTemplate("deep-read")!, onePaper).ok,
      true,
    );
    assert.equal(
      validateTemplateContext(taskTemplate("compare")!, onePaper).ok,
      false,
    );

    const selection = withLockedContextFingerprint({
      ...onePaper,
      selection: {
        id: "selection:A:0",
        text: "selected",
        pageLabel: "1",
        pageIndex: 0,
      },
    });
    assert.equal(
      validateTemplateContext(taskTemplate("explain-selection")!, selection).ok,
      true,
    );
  });
});
