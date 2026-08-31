import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSkillMarkdown } from "./index";

describe("parseSkillMarkdown", () => {
  it("reads name, allowed-tools, and body", () => {
    const skill = parseSkillMarkdown(
      "paper-deep-reading",
      "builtin://paper-deep-reading",
      `---
name: Paper Deep Reading
description: Read one paper carefully.
allowed-tools:
  - get_outline
  - get_paper_section
  - get_pages
triggers:
  - 精读
---

Use section-level evidence.
`,
    );
    assert.ok(skill);
    assert.equal(skill?.name, "Paper Deep Reading");
    assert.deepEqual(skill?.allowedTools, [
      "get_outline",
      "get_paper_section",
      "get_pages",
    ]);
    assert.equal(skill?.body.includes("section-level"), true);
  });
});
