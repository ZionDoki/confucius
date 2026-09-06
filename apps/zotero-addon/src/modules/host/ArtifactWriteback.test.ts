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
        ["tag_remove", "tag_add"],
      );
      assert.deepEqual(
        collection.operations.map((operation) => operation.op),
        ["add"],
      );
    }
  });
});

it("restores receipts after interruption without pretending a partial batch is complete", async () => {
  const { recoverPendingWriteback } = await import("./ArtifactWriteback");
  const previous = {
    state: "pending" as const,
    target: "zotero_annotations" as const,
    revision: 2,
    operationId: "new",
    receipts: [{ revision: 1, operationId: "old" }],
  };
  const operation = {
    id: "new",
    name: "commit_annotations",
    args: {},
    context: {},
    resources: [],
    startedAt: 1,
    result: {
      ok: true as const,
      toolName: "commit_annotations",
      effect: "partial" as const,
      data: {
        libraryID: 1,
        attachmentKey: "PDF",
        committed: [{ annotationKey: "ANN" }],
        failed: [{ id: "missing" }],
      },
    },
  };
  const recovered = recoverPendingWriteback(previous, operation);
  assert.equal(recovered.state, "partial");
  assert.equal(recovered.targetRef, "1:PDF");
  assert.deepEqual(recovered.operationIds, ["old", "new"]);
  assert.equal("receipts" in recovered, false);
  assert.equal(recovered.entries, undefined);
  assert.equal(recoverPendingWriteback(previous, null).state, "none");
  assert.equal(
    recoverPendingWriteback({ ...previous, operationId: undefined }, null)
      .state,
    "unknown",
  );
  assert.equal(
    recoverPendingWriteback(previous, { ...operation, result: undefined })
      .state,
    "unknown",
  );
});
