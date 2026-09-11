import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupIDForLibrary, markdownToNoteHtml } from "../tools/ZoteroToolHost";
import {
  collectTagChanges,
  writebackBodyForTarget,
  markdownWithCitationLinks,
} from "./ArtifactWriteback";

it("exports paired passages and collapsed help as visible note text with working citations and math", () => {
  const markdown = markdownWithCitationLinks(
    ":::parallel\n> Source [cite:p]\n\nExplanation $qk$.\n:::\n\n:::details Background\nEssential supplement [cite:p].\n:::",
    [
      {
        id: "p",
        itemLibraryID: 1,
        itemKey: "PAPER",
        attachmentKey: "PDF",
        page: 4,
      },
    ],
    () => undefined,
  );
  const html = markdownToNoteHtml(markdown);
  assert.doesNotMatch(html, /<details|<summary|:::|\[cite:p\]/);
  assert.match(html, /<blockquote>Source/);
  assert.match(html, /Essential supplement/);
  assert.equal(
    [
      ...html.matchAll(
        /href="zotero:\/\/open-pdf\/library\/items\/PDF\?page=4"/g,
      ),
    ].length,
    2,
  );
  assert.match(html, /<span class="math">\$qk\$<\/span>/);
});

it("exports page, annotation and abstract references with the correct Zotero library scope", () => {
  const text = markdownWithCitationLinks(
    "摘要 [cite:p]；标注 [cite:a]；相关文献 [cite:b]；`[cite:p]`",
    [
      {
        id: "p",
        itemLibraryID: 3,
        itemKey: "PAPER",
        attachmentKey: "PDF",
        page: 4,
      },
      {
        id: "a",
        itemLibraryID: 3,
        itemKey: "PAPER",
        attachmentKey: "PDF",
        page: 4,
        annotationKey: "MARK",
      },
      { id: "b", itemLibraryID: 1, itemKey: "RELATED", title: "Abstract only" },
    ],
    (id) => (id === 3 ? 88 : undefined),
  );
  assert.match(text, /zotero:\/\/open-pdf\/groups\/88\/items\/PDF\?page=4/);
  assert.match(text, /annotation=MARK&page=4/);
  assert.match(text, /zotero:\/\/select\/library\/items\/RELATED/);
  assert.match(text, /`\[cite:p\]`/);
});

it("writes personal-library citations without asking Zotero for a nonexistent group", () => {
  const previous = Reflect.get(globalThis, "Zotero");
  Reflect.set(globalThis, "Zotero", {
    Libraries: { userLibraryID: 1 },
    Groups: {
      getGroupIDFromLibraryID: (id: number) => {
        if (id === 1) throw new Error("Group with libraryID 1 does not exist");
        assert.equal(id, 3);
        return 88;
      },
    },
  });
  try {
    const text = markdownWithCitationLinks(
      "[cite:personal] [cite:shared]",
      [
        { id: "personal", itemLibraryID: 1, itemKey: "PAPER" },
        { id: "shared", itemLibraryID: 3, itemKey: "SHARED" },
      ],
      groupIDForLibrary,
    );
    assert.match(text, /zotero:\/\/select\/library\/items\/PAPER/);
    assert.match(text, /zotero:\/\/select\/groups\/88\/items\/SHARED/);
  } finally {
    Reflect.set(globalThis, "Zotero", previous);
  }
});

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
