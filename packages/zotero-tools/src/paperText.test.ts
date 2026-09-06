import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findSection,
  parseSections,
  requireItemRef,
  splitPages,
} from "./paperText";
import { TOOL_DEFINITIONS, WRITE_TOOL_NAMES } from "./catalog";

describe("paperText", () => {
  it("splits form-feed pages", () => {
    const pages = splitPages("page one\fpage two");
    assert.equal(pages.pageCount, 2);
    assert.equal(pages.pages[1]?.text, "page two");
  });

  it("preserves blank pages and reports indexed text without separators as unpaged", () => {
    assert.deepEqual(
      splitPages("one\f\fthree").pages.map((page) => page.page),
      [1, 2, 3],
    );
    const unpaged = splitPages("x".repeat(10000));
    assert.equal(unpaged.pageCount, null);
    assert.equal(unpaged.pages[0]?.page, null);
    assert.equal(unpaged.pages.length, 1);
  });

  it("finds an introduction section", () => {
    const sections = parseSections("Abstract\nHello\n1. Introduction\nBody\n");
    const intro = findSection(sections, "introduction");
    assert.ok(intro);
    assert.equal(intro?.content.includes("Body"), true);
  });

  it("rejects key-only item refs", () => {
    const result = requireItemRef({ key: "ABCD1234" });
    assert.equal(result.ok, false);
  });
});

describe("catalog", () => {
  it("includes create_collection as a write tool", () => {
    assert.equal(WRITE_TOOL_NAMES.has("create_collection"), true);
    assert.ok(
      TOOL_DEFINITIONS.some((tool) => tool.name === "create_collection"),
    );
  });
});
