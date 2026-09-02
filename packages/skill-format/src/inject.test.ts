import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSkillMarkdown } from "./index";
import type { ConfuciusSkill } from "./types";
import {
  DEFAULT_SKILL_USER_TEXT,
  formatInvokedUserText,
  formatSkillPromptSection,
  parseSkillInvocation,
  slashMenuToken,
  SKILL_TOOL_NAME,
} from "./inject";

function skill(
  slug: string,
  extras: Partial<ConfuciusSkill> = {},
): ConfuciusSkill {
  return {
    slug,
    name: extras.name ?? slug,
    description: extras.description ?? `${slug} description`,
    allowedTools: extras.allowedTools ?? [],
    triggers: extras.triggers ?? [],
    body: extras.body ?? `${slug} body`,
    path: extras.path ?? `builtin://${slug}`,
  };
}

const catalog = [
  skill("paper-deep-reading", {
    name: "Paper Deep Reading",
    description: "Read one paper carefully.",
    triggers: ["deep reading", "精读"],
    allowedTools: ["get_outline", "get_pages"],
    body: "Tie claims to sections.",
  }),
  skill("library-triage", {
    name: "Library Triage",
    triggers: ["triage"],
  }),
];

describe("slashMenuToken", () => {
  it("opens on a leading slash and hides once arguments start", () => {
    assert.equal(slashMenuToken("hello"), null);
    assert.equal(slashMenuToken("/"), "");
    assert.equal(slashMenuToken("/pap"), "pap");
    assert.equal(slashMenuToken("/paper-deep-reading"), "paper-deep-reading");
    assert.equal(slashMenuToken("/paper-deep-reading "), null);
    assert.equal(slashMenuToken("/paper-deep-reading please"), null);
  });
});

describe("parseSkillInvocation", () => {
  it("loads a skill by slug and keeps trailing arguments", () => {
    assert.deepEqual(parseSkillInvocation("/paper-deep-reading", catalog), {
      slug: "paper-deep-reading",
      rest: "",
    });
    assert.deepEqual(
      parseSkillInvocation("/paper-deep-reading read the PDF", catalog),
      { slug: "paper-deep-reading", rest: "read the PDF" },
    );
  });

  it("maps a unique trigger to the skill", () => {
    assert.equal(
      parseSkillInvocation("/精读", catalog).slug,
      "paper-deep-reading",
    );
    assert.equal(
      parseSkillInvocation("/triage incoming", catalog).slug,
      "library-triage",
    );
    assert.equal(
      parseSkillInvocation("/triage incoming", catalog).rest,
      "incoming",
    );
  });

  it("does not treat reserved composer commands as skills", () => {
    assert.equal(parseSkillInvocation("/plan", catalog).slug, null);
    assert.equal(
      parseSkillInvocation("/compact keep citations", catalog).slug,
      null,
    );
  });

  it("ignores unknown slashes so they stay ordinary prompts", () => {
    assert.equal(parseSkillInvocation("/not-a-skill", catalog).slug, null);
    assert.equal(parseSkillInvocation("read this paper", catalog).slug, null);
  });
});

describe("formatSkillPromptSection", () => {
  it("always lists the catalog and only then loaded bodies", () => {
    const catalogText = formatSkillPromptSection({
      skills: catalog,
      loaded: [],
    });
    assert.match(catalogText, /call the `skill` tool/);
    assert.match(catalogText, /paper-deep-reading: Read one paper carefully/);
    assert.match(catalogText, /Use when: deep reading; 精读/);
    assert.equal(catalogText.includes("Tie claims to sections."), false);
    assert.equal(catalogText.includes("Loaded skill instructions"), false);
    assert.equal(SKILL_TOOL_NAME, "skill");
  });

  it("injects the full body of loaded skills without sandboxing tools", () => {
    const text = formatSkillPromptSection({
      skills: catalog,
      loaded: [catalog[0]],
    });
    assert.match(text, /Loaded skill instructions/);
    assert.match(text, /Tie claims to sections/);
    assert.match(text, /Preferred tools: get_outline, get_pages/);
    assert.match(text, /Other tools remain available/);
    assert.equal(text.includes("only these tools"), false);
    assert.equal(text.includes("do not use other tools"), false);
  });
});

describe("formatInvokedUserText", () => {
  it("keeps arguments and supplies a default when the slash is bare", () => {
    assert.equal(
      formatInvokedUserText("paper-deep-reading", "read this"),
      "The user invoked /paper-deep-reading.\n\nread this",
    );
    assert.match(
      formatInvokedUserText("paper-deep-reading", ""),
      new RegExp(DEFAULT_SKILL_USER_TEXT),
    );
  });
});

describe("parseSkillMarkdown still feeds injection", () => {
  it("round-trips a SKILL.md into catalog + loaded body", () => {
    const parsed = parseSkillMarkdown(
      "paper-deep-reading",
      "builtin://paper-deep-reading",
      `---
name: Paper Deep Reading
description: Read one paper carefully.
allowed-tools:
  - get_outline
triggers:
  - 精读
---

Use section-level evidence.
`,
    );
    assert.ok(parsed);
    const section = formatSkillPromptSection({
      skills: [parsed!],
      loaded: [parsed!],
    });
    assert.match(section, /Use when: 精读/);
    assert.match(section, /Use section-level evidence/);
  });
});
