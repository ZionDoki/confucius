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

  it("keeps featured preset drafts concise and editable", () => {
    for (const template of FEATURED_TASK_TEMPLATES) {
      assert.doesNotMatch(template.prompt, /artifact_upsert|approval dialog/i);
      assert.doesNotMatch(template.prompt, /locked context|sensible defaults/i);
    }
    assert.doesNotMatch(
      taskTemplate("deep-read")!.prompt,
      /commit_annotations/,
    );
    assert.match(taskTemplate("deep-read")!.prompt, /unless I specify/i);
  });

  it("validates staged context only when the user sends", () => {
    const empty = emptyLockedContext(1);
    assert.deepEqual(
      validateTemplateContext(taskTemplate("deep-read")!, empty),
      {
        ok: false,
        reason: "single_required",
        message:
          "This task needs exactly one paper. The draft was kept so you can update the task context and send again.",
      },
    );
    const selectionRequired = validateTemplateContext(
      taskTemplate("explain-selection")!,
      empty,
    );
    assert.equal(selectionRequired.ok, false);
    if (!selectionRequired.ok) {
      assert.equal(selectionRequired.reason, "selection_required");
    }

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
    const multiRequired = validateTemplateContext(
      taskTemplate("compare")!,
      onePaper,
    );
    assert.equal(multiRequired.ok, false);
    if (!multiRequired.ok) {
      assert.equal(multiRequired.reason, "multi_required");
    }

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
