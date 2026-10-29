import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FlatHeading } from "@confucius/zotero-tools";
import {
  buildOrganizerReview,
  isOrganizerReviewTool,
  type OrganizerReviewSource,
} from "./organizerReview";

/**
 * Eine Gliederungszeile, wie sie der Outline-Cache liefert. Notwendige
 * Felder für buildHeadingLookup: title, num, path, tag (id/depth optional).
 */
const backgroundHeading: FlatHeading = {
  id: "node_1_1",
  title: "Background",
  num: "1.1",
  path: "Introduction / Background",
  depth: 2,
  tag: "§Background",
};

/** Minimaler Duck-typed-Provider: nur die von buildOrganizerReview genutzten Pfade. */
function makeTools(overrides: Partial<OrganizerReviewSource> = {}): {
  tools: OrganizerReviewSource;
  calls: { outlineKey?: string };
} {
  const calls: { outlineKey?: string } = {};
  const tools: OrganizerReviewSource = {
    getCollectionByRef: (libraryID, ref) =>
      ({ key: "COL", name: ref, libraryID }) as unknown as Zotero.Collection,
    getTopmostCollection: (col) => col as Zotero.Collection,
    getOutlineCache: (_libraryID, colRef) => {
      calls.outlineKey = colRef ?? undefined;
      return { roots: [], headings: [backgroundHeading] };
    },
    getCachedAnnotation: (key) =>
      key === "A1"
        ? {
            key: "A1",
            text: "quote text",
            comment: "a comment",
            pageLabel: "10",
            color: "#ffd400",
            workTitle: "A Work",
            workCitation: "Smith (2020)",
            libraryID: 1,
          }
        : undefined,
    ...overrides,
  };
  return { tools, calls };
}

describe("isOrganizerReviewTool", () => {
  it("recognizes canonical names and aliases", () => {
    assert.equal(isOrganizerReviewTool("organizer_assign_annotations"), true);
    assert.equal(isOrganizerReviewTool("annotations_assign"), true);
    assert.equal(isOrganizerReviewTool("organizer_unassign_annotations"), true);
    assert.equal(isOrganizerReviewTool("annotations_unassign"), true);
  });

  it("rejects other tools", () => {
    assert.equal(isOrganizerReviewTool("organizer_get_outline"), false);
    assert.equal(isOrganizerReviewTool("add_to_collection"), false);
    assert.equal(isOrganizerReviewTool("propose_note"), false);
  });
});

describe("buildOrganizerReview", () => {
  it("returns undefined for non-organizer tools", async () => {
    const { tools } = makeTools();
    const review = await buildOrganizerReview(tools, "add_to_collection", {
      name: "C",
    });
    assert.equal(review, undefined);
  });

  it("builds a review from cached annotation and outline data", async () => {
    const { tools, calls } = makeTools();
    const review = await buildOrganizerReview(tools, "annotations_assign", {
      collection: "COL",
      assignments: [{ key: "A1", headings: ["Background"] }],
    });
    assert.ok(review);
    assert.equal(review.collectionTitle, "COL");
    assert.equal(review.totalAssignments, 1);
    assert.equal(review.items.length, 1);
    const item = review.items[0];
    assert.equal(item.key, "A1");
    // Quelle stammt aus dem Annotation-Cache, nicht aus Zotero (im Test nicht verfügbar).
    assert.equal(item.quote, "quote text");
    assert.equal(item.comment, "a comment");
    assert.equal(item.page, "10");
    assert.equal(item.color, "#ffd400");
    assert.equal(item.sourceTitle, "A Work");
    assert.equal(item.sourceCitation, "Smith (2020)");
    // Überschrift wird über den Outline-Cache zu kanonischen Feldern aufgelöst.
    assert.deepEqual(item.headings, [
      {
        title: "Background",
        num: "1.1",
        path: "Introduction / Background",
        tag: "§Background",
      },
    ]);
    assert.equal(calls.outlineKey, "COL");
  });

  it("accepts the flat keys/headings argument form and silent entries", async () => {
    const { tools } = makeTools();
    const review = await buildOrganizerReview(tools, "annotations_assign", {
      collection: "COL",
      keys: ["A1", "A2"],
      headings: ["Background"],
    });
    assert.ok(review);
    // A1 wird aus dem Cache aufgelöst; A2 hat keinen Cache-Eintrag und erscheint trotzdem.
    assert.equal(review.totalAssignments, 2);
    assert.equal(review.items[0].key, "A1");
    assert.equal(review.items[1].key, "A2");
  });

  it("returns undefined when there are no assignments", async () => {
    const { tools } = makeTools();
    const review = await buildOrganizerReview(tools, "annotations_assign", {
      collection: "COL",
    });
    assert.equal(review, undefined);
  });
});

it("does not show cached annotations from another library", async () => {
  const { tools } = makeTools();
  const review = await buildOrganizerReview(
    tools,
    "organizer_assign_annotations",
    {
      libraryID: 2,
      collection: "COL",
      assignments: [{ key: "A1", headings: ["Background"] }],
    },
  );
  assert.equal(review?.items[0].quote, undefined);
  assert.equal(review?.items[0].sourceCitation, undefined);
});
