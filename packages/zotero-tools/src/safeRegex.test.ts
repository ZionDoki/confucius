import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectMatches, compileSafeRegex } from "./safeRegex";

describe("compileSafeRegex", () => {
  it("compiles normal patterns and truncates the subject", () => {
    const result = compileSafeRegex("transformer", "a".repeat(600_000));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.subject.length, 500_000);
    }
  });

  it("rejects overlong patterns", () => {
    const result = compileSafeRegex("a".repeat(200), "subject");
    assert.equal(result.ok, false);
  });

  it("rejects nested quantifiers that enable catastrophic backtracking", () => {
    for (const pattern of ["(a+)+b", "(a*)*x", "(\\d+)+!", "((a|b)+)+c"]) {
      const result = compileSafeRegex(pattern, "subject");
      assert.equal(result.ok, false, pattern);
    }
  });

  it("accepts bounded alternations and plain quantifiers", () => {
    for (const pattern of ["\\d{2,4}", "ab+c", "(foo|bar)baz"]) {
      const result = compileSafeRegex(pattern, "subject");
      assert.equal(result.ok, true, pattern);
    }
  });

  it("reports invalid regex syntax", () => {
    const result = compileSafeRegex("([unclosed", "subject");
    assert.equal(result.ok, false);
  });
});

describe("collectMatches", () => {
  it("collects capped matches with snippets", () => {
    const compiled = compileSafeRegex("ab", "ab ab ab ab ab");
    assert.ok(compiled.ok);
    if (compiled.ok) {
      const hits = collectMatches(compiled.regex, compiled.subject, 3);
      assert.equal(hits.length, 3);
    }
  });

  it("terminates on patterns that match the empty string", () => {
    const compiled = compileSafeRegex("a*", "aaa bbb ccc");
    assert.ok(compiled.ok);
    if (compiled.ok) {
      const hits = collectMatches(compiled.regex, compiled.subject, 20);
      assert.ok(hits.length <= 20);
      assert.ok(hits.length > 0);
    }
  });
});
