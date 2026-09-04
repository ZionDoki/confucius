import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { droppedFilePaths, droppedFilename, hasDroppedFiles } from "./fileDrop";

describe("file drop payloads", () => {
  it("reads standard Zotero File.path and mozFullPath values", () => {
    assert.deepEqual(
      droppedFilePaths({
        files: {
          0: { path: "C:\\Research\\paper.pdf" },
          1: { mozFullPath: "C:\\Research\\notes.md" },
          length: 2,
        },
      }),
      ["C:\\Research\\paper.pdf", "C:\\Research\\notes.md"],
    );
  });

  it("falls back to Gecko's application/x-moz-file payload and deduplicates", () => {
    const path = "C:\\Research\\paper.pdf";
    assert.deepEqual(
      droppedFilePaths({
        files: { 0: { path }, length: 1 },
        mozItemCount: 1,
        mozGetDataAt: () => ({ path: path.toLocaleLowerCase() }),
      }),
      [path],
    );
  });

  it("detects file drags before drop and formats cross-platform names", () => {
    assert.equal(hasDroppedFiles({ types: { 0: "Files", length: 1 } }), true);
    assert.equal(
      hasDroppedFiles({
        types: { 0: "application/x-moz-file", length: 1 },
      }),
      true,
    );
    assert.equal(droppedFilename("C:\\Research\\notes.txt"), "notes.txt");
    assert.equal(droppedFilename("/tmp/paper.pdf"), "paper.pdf");
  });
});
