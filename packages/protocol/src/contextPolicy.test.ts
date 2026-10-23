import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextTextSlice } from "./contextPolicy";

describe("contextTextSlice", () => {
  it("advances through a page and terminates on the last page", () => {
    const first = contextTextSlice("abcdef", 1);
    assert.equal(first.content, "abc");
    assert.equal(first.nextOffset, 3);
    const last = contextTextSlice("abcdef", 1, first.nextOffset!);
    assert.equal(last.content, "def");
    assert.equal(last.nextOffset, null);
  });

  it("returns no next offset when the budget cannot hold one character", () => {
    for (const maxTokens of [0, -1, Number.NaN]) {
      const english = contextTextSlice("abc", maxTokens);
      assert.equal(english.content, "");
      assert.equal(english.nextOffset, null, `maxTokens=${maxTokens}`);
    }
    for (const maxTokens of [0, -1, 1]) {
      const chinese = contextTextSlice("中文内容", maxTokens);
      assert.equal(chinese.content, "");
      assert.equal(chinese.nextOffset, null, `maxTokens=${maxTokens}`);
    }
    assert.equal(contextTextSlice("abc", 0, 1).nextOffset, null);
  });

  it("never splits a surrogate pair at an offset", () => {
    const result = contextTextSlice("😀abc", 1.6);
    assert.equal(result.content, "😀");
    assert.equal(result.nextOffset, 2);
    assert.equal(contextTextSlice("😀abc", 10, 1).content, "😀abc");
  });
});
