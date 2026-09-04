import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fallbackTaskTitle,
  isPlaceholderTaskTitle,
  sanitizeGeneratedTaskTitle,
  temporaryTaskTitle,
} from "./taskTitle";

describe("task title policy", () => {
  it("cleans slash commands, Markdown, and links from the temporary title", () => {
    assert.equal(
      temporaryTaskTitle(
        "/paper-deep-reading **精读** [这篇论文](https://example.com) 并总结方法。",
      ),
      "精读 这篇论文 并总结方法",
    );
  });

  it("accepts one-line same-language generated titles", () => {
    assert.equal(
      sanitizeGeneratedTaskTitle(
        "“检验 Alpha 论文的核心证据”",
        "请精读这篇论文",
      ),
      "检验 Alpha 论文的核心证据",
    );
    assert.equal(
      sanitizeGeneratedTaskTitle("Evidence review", "请精读这篇论文"),
      null,
    );
    assert.equal(
      sanitizeGeneratedTaskTitle("证据审查", "Review the evidence"),
      null,
    );
    assert.equal(sanitizeGeneratedTaskTitle("one\ntwo", "review"), null);
  });

  it("uses a deterministic fallback and recognizes historical placeholders", () => {
    assert.equal(fallbackTaskTitle("", "A useful answer."), "A useful answer");
    assert.equal(isPlaceholderTaskTitle("未命名研究任务"), true);
    assert.equal(isPlaceholderTaskTitle("My project"), false);
  });
});
