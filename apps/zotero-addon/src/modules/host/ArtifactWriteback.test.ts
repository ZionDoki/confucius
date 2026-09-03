import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectTagChanges, writebackBodyForTarget } from "./ArtifactWriteback";

const body = {
  type: "collection_diff" as const,
  name: "Review set",
  operations: [
    { op: "add" as const, item: { libraryID: 1, key: "A" } },
    {
      op: "tag_add" as const,
      item: { libraryID: 1, key: "A" },
      value: "keep",
    },
    {
      op: "tag_remove" as const,
      item: { libraryID: 1, key: "A" },
      value: "keep",
    },
    {
      op: "tag_add" as const,
      item: { libraryID: 1, key: "B" },
      value: "reviewed",
    },
  ],
};

describe("artifact writeback planning", () => {
  it("aggregates tags per item and resolves conflicts in operation order", () => {
    assert.deepEqual(collectTagChanges(body), [
      { libraryID: 1, key: "A", add: [], remove: ["keep"] },
      { libraryID: 1, key: "B", add: ["reviewed"], remove: [] },
    ]);
  });

  it("shows only operations that the selected writeback target will execute", () => {
    const tags = writebackBodyForTarget(body, "zotero_tags");
    const collection = writebackBodyForTarget(body, "zotero_collection");
    assert.equal(tags.type, "collection_diff");
    assert.equal(collection.type, "collection_diff");
    if (
      tags.type === "collection_diff" &&
      collection.type === "collection_diff"
    ) {
      assert.deepEqual(
        tags.operations.map((operation) => operation.op),
        ["tag_add", "tag_remove", "tag_add"],
      );
      assert.deepEqual(
        collection.operations.map((operation) => operation.op),
        ["add"],
      );
    }
  });
});
