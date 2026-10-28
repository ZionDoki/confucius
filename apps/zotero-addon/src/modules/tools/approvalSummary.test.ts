import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeCallForApproval, type TitleResolver } from "./approvalSummary";
import { describeOrganizerApproval } from "./organizerApprovalSummary";

const resolve: TitleResolver = (libraryID, key) =>
  key === "KNOWN" ? { title: `Item ${libraryID}:${key}` } : null;

describe("describeCallForApproval", () => {
  it("combines a resolved item title with the highlight batch", () => {
    assert.equal(
      describeCallForApproval(
        "propose_highlights",
        {
          libraryID: 1,
          key: "KNOWN",
          highlights: [{ text: "first quote", page: 1 }],
        },
        resolve,
      ),
      "Item 1:KNOWN · 1 annotation · “first quote”",
    );
  });

  it("summarizes canonical text and image annotations", () => {
    assert.equal(
      describeCallForApproval(
        "propose_annotations",
        {
          libraryID: 1,
          key: "KNOWN",
          annotations: [
            { type: "underline", quote: "read this closely", page: 2 },
          ],
        },
        resolve,
      ),
      "Item 1:KNOWN · 1 annotation · “read this closely”",
    );
    assert.equal(
      describeCallForApproval("propose_annotations", {
        annotations: [
          {
            type: "image",
            page: 3,
            rect: [10, 20, 30, 40],
            comment: "Figure establishes the baseline",
          },
        ],
      }),
      "1 annotation · “Figure establishes the baseline”",
    );
  });

  it("summarizes a batch by count instead of repeating its first quote", () => {
    const args = {
      libraryID: 1,
      key: "KNOWN",
      annotations: [
        { type: "highlight", quote: "ALPHA", page: 1 },
        { type: "underline", quote: "BETA", page: 2 },
        { type: "highlight", quote: "GAMMA", page: 3 },
      ],
    };
    assert.equal(
      describeCallForApproval("commit_annotations", args, resolve),
      "Item 1:KNOWN · 3 annotations",
    );
    assert.equal(
      describeCallForApproval("commit_annotations", args, resolve, "zh-CN"),
      "Item 1:KNOWN · 3 条标注",
    );
  });

  it("shows a query as the acted-on object", () => {
    assert.equal(
      describeCallForApproval("search_items", { query: "alpha" }, resolve),
      "“alpha”",
    );
  });

  it("shows a collection or note name verbatim", () => {
    assert.equal(
      describeCallForApproval("create_collection", { name: "RLHF" }, resolve),
      "RLHF",
    );
    assert.equal(
      describeCallForApproval(
        "propose_note",
        {
          title: "Confucius · draft",
          markdown: "# body",
        },
        resolve,
      ),
      "Confucius · draft",
    );
  });

  it("resolves a bare item ref into a title, not a key", () => {
    assert.equal(
      describeCallForApproval(
        "add_to_collection",
        {
          libraryID: 1,
          key: "KNOWN",
          collectionKey: "C1",
        },
        resolve,
      ),
      "Item 1:KNOWN",
    );
  });

  it("clips long text and collapses whitespace", () => {
    const summary = describeCallForApproval(
      "memory_save",
      { content: "x".repeat(120) },
      resolve,
    );
    assert.equal(summary?.length, 62);
    assert.ok(summary?.includes("…"));
  });

  it("falls back to the first meaningful string for unknown tools", () => {
    assert.equal(
      describeCallForApproval("mcp.custom", { payload: "hello" }, resolve),
      "“hello”",
    );
  });

  it("returns undefined when nothing meaningful is available", () => {
    assert.equal(
      describeCallForApproval(
        "add_to_collection",
        { libraryID: 1, key: "GONE", collectionKey: "C1" },
        resolve,
      ),
      undefined,
    );
    assert.equal(describeCallForApproval("noop", {}, resolve), undefined);
  });
});

describe("describeCallForApproval — Flex Annotations organizer delegation", () => {
  it("summarizes assign via canonical name and alias", () => {
    const args = {
      collection: "COL",
      assignments: [{ key: "A1", headings: ["Background"] }],
    };
    assert.equal(
      describeCallForApproval("organizer_assign_annotations", args),
      "Assign 1 annotation to Flex Annotations outline",
    );
    assert.equal(
      describeCallForApproval("annotations_assign", args),
      "Assign 1 annotation to Flex Annotations outline",
    );
  });

  it("counts multiple assignments without repeating quote text", () => {
    const args = {
      collection: "COL",
      assignments: [{ key: "A1" }, { key: "A2" }, { key: "A3" }],
    };
    assert.equal(
      describeCallForApproval("annotations_assign", args),
      "Assign 3 annotations to Flex Annotations outline",
    );
  });

  it("summarizes unassign from keys and singular key", () => {
    assert.equal(
      describeCallForApproval("organizer_unassign_annotations", {
        collection: "COL",
        keys: ["A1", "A2"],
      }),
      "Unassign 2 annotations from Flex Annotations outline",
    );
    assert.equal(
      describeCallForApproval("annotations_unassign", {
        collection: "COL",
        key: "A1",
      }),
      "Unassign 1 annotation from Flex Annotations outline",
    );
  });

  it("localizes organizer summaries (zh-CN via delegation, de directly)", () => {
    const args = {
      collection: "COL",
      assignments: [{ key: "A1", headings: ["Background"] }],
    };
    assert.equal(
      describeCallForApproval("annotations_assign", args, resolve, "zh-CN"),
      "分配 1 条标注至 Flex Annotations 大纲",
    );
    assert.equal(
      describeCallForApproval("annotations_unassign", args, resolve, "zh-CN"),
      "移除 1 条标注的大纲归类",
    );
    // Die deutsche Verzweigung ist an der describeCallForApproval-Grenze nicht
    // getyppt; daher direkt an der reinen Funktion prüfen.
    assert.equal(
      describeOrganizerApproval("annotations_assign", args, "de" as any),
      "1 Annotation der Flex-Annotations-Gliederung zuweisen",
    );
    assert.equal(
      describeOrganizerApproval("annotations_unassign", args, "de" as any),
      "Gliederungszuweisung von 1 Annotation entfernen",
    );
    // Nicht-Organizer-Tool liefert undefined, damit describeCallForApproval
    // auf den gewohnten Pfad zurückfällt.
    assert.equal(
      describeOrganizerApproval("add_to_collection", args),
      undefined,
    );
  });

  it("delegates only organizer tools and stays undefined otherwise", () => {
    assert.equal(
      describeCallForApproval("organizer_assign_annotations", {
        collection: "COL",
      }),
      "Assign 0 annotations to Flex Annotations outline",
    );
    // Kein Organizer-Tool: fällt auf den bisherigen Pfad und liefert undefined
    assert.equal(describeCallForApproval("noop", {}, resolve), undefined);
  });
});
