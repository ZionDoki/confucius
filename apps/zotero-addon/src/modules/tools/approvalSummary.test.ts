import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeCallForApproval, type TitleResolver } from "./approvalSummary";

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
      "Item 1:KNOWN · 1 × “first quote”",
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
      "Item 1:KNOWN · 1 × “read this closely”",
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
      "1 × “Figure establishes the baseline”",
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
