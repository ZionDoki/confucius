import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  libraryMentionTokenAtCaret,
  replaceLibraryMention,
} from "./libraryMention";

describe("library mentions", () => {
  it("finds an @ query at the caret, including a multi-word query", () => {
    assert.deepEqual(libraryMentionTokenAtCaret("Compare @deep learning"), {
      start: 8,
      end: 22,
      query: "deep learning",
    });
  });

  it("accepts punctuation boundaries but ignores email addresses", () => {
    assert.equal(libraryMentionTokenAtCaret("分析：@论文")?.query, "论文");
    assert.equal(libraryMentionTokenAtCaret("分析@论文")?.query, "论文");
    assert.equal(libraryMentionTokenAtCaret("name@example.com"), null);
  });

  it("does not reopen a completed mention", () => {
    assert.equal(libraryMentionTokenAtCaret("@[A paper] continue"), null);
  });

  it("replaces only the active token and preserves text after the caret", () => {
    assert.deepEqual(
      replaceLibraryMention(
        "Compare @map with this",
        { start: 8, end: 12, query: "map" },
        "MapReduce [revisited]",
      ),
      {
        value: "Compare @[MapReduce revisited] with this",
        caret: 31,
      },
    );
  });
});
