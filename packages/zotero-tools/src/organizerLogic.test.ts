import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COLLECTION_TAG_PREFIX,
  HEADING_PREFIX,
  OUTLINE_TAG,
  SENTINEL,
  buildHeadingLookup,
  cleanHeadingTitle,
  collectionKeyFromTag,
  extractSurroundingContext,
  flattenOutline,
  headingTag,
  headingTitleFromTag,
  isOutlineCollectionTag,
  normalizeHeadingKey,
  outlineCollectionTag,
  parseOutline,
  planAssignments,
  type OutlineNode,
} from "./organizerLogic";

describe("organizerLogic", () => {
  it("formats and parses heading tags and collection tags", () => {
    assert.equal(HEADING_PREFIX, "§");
    assert.equal(OUTLINE_TAG, "★outline");
    assert.equal(COLLECTION_TAG_PREFIX, "#flexannotate-outline-");
    assert.equal(headingTag("Introduction"), "§Introduction");
    assert.equal(headingTag("§Introduction"), "§Introduction");
    assert.equal(headingTag("  Methods  "), "§Methods");
    assert.equal(headingTag("  §Methods  "), "§Methods");
    assert.equal(headingTitleFromTag("§Introduction"), "Introduction");
    assert.equal(headingTitleFromTag("regular-tag"), null);

    const colKey = "COL123";
    const tag = outlineCollectionTag(colKey);
    assert.equal(tag, "#flexannotate-outline-COL123");
    assert.equal(isOutlineCollectionTag(tag), true);
    assert.equal(isOutlineCollectionTag("other-tag"), false);
    assert.equal(collectionKeyFromTag(tag), "COL123");
    assert.equal(collectionKeyFromTag("other-tag"), null);
  });

  it("parses outline trees from HTML note content with various tags and escaped entities", () => {
    const json = JSON.stringify({
      v: 1,
      roots: [
        { id: "1", title: "Intro", children: [] },
        {
          id: "2",
          title: "Main Part",
          children: [{ id: "3", title: "Theory & Practice", children: [] }],
        },
      ],
    });

    const escaped = json
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const htmlCode = `<h1>Outline</h1><pre><code>${SENTINEL}\n${escaped}</code></pre>`;
    const parsed1 = parseOutline(htmlCode);
    assert.equal(parsed1.length, 2);
    assert.equal(parsed1[0].title, "Intro");
    assert.equal(parsed1[1].title, "Main Part");
    assert.equal(parsed1[1].children[0].title, "Theory & Practice");

    // Zotero sometimes re-writes <pre><code> to <pre>
    const htmlPre = `<h1>Outline</h1><pre>${SENTINEL}\n${escaped}</pre>`;
    const parsed2 = parseOutline(htmlPre);
    assert.deepEqual(parsed2, parsed1);

    // Malformed HTML or JSON returns empty array
    assert.deepEqual(parseOutline(""), []);
    assert.deepEqual(parseOutline("Just random text"), []);
    assert.deepEqual(
      parseOutline(`<pre><code>${SENTINEL}\nnot json</code></pre>`),
      [],
    );
  });

  it("flattens outline hierarchy and creates path strings and heading lookups", () => {
    const roots: OutlineNode[] = [
      { id: "1", title: "Introduction", children: [] },
      {
        id: "2",
        title: "Main Part",
        children: [
          {
            id: "2.1",
            title: "Background",
            children: [{ id: "2.1.1", title: "History", children: [] }],
          },
          { id: "2.2", title: "Analysis", children: [] },
        ],
      },
      { id: "3", title: "Conclusion", children: [] },
    ];

    const flat = flattenOutline(roots);
    assert.equal(flat.length, 6);
    assert.deepEqual(flat[0], {
      id: "1",
      num: "1",
      title: "Introduction",
      path: "Introduction",
      depth: 0,
      tag: "§Introduction",
    });
    assert.deepEqual(flat[1], {
      id: "2",
      num: "2",
      title: "Main Part",
      path: "Main Part",
      depth: 0,
      tag: "§Main Part",
    });
    assert.deepEqual(flat[2], {
      id: "2.1",
      num: "2.1",
      title: "Background",
      path: "Main Part > Background",
      depth: 1,
      tag: "§Background",
    });
    assert.deepEqual(flat[3], {
      id: "2.1.1",
      num: "2.1.1",
      title: "History",
      path: "Main Part > Background > History",
      depth: 2,
      tag: "§History",
    });
    assert.deepEqual(flat[4], {
      id: "2.2",
      num: "2.2",
      title: "Analysis",
      path: "Main Part > Analysis",
      depth: 1,
      tag: "§Analysis",
    });
    assert.deepEqual(flat[5], {
      id: "3",
      num: "3",
      title: "Conclusion",
      path: "Conclusion",
      depth: 0,
      tag: "§Conclusion",
    });

    const lookup = buildHeadingLookup(roots);
    assert.ok(lookup.has("background"));
    assert.ok(lookup.has("§background"));
    assert.ok(lookup.has("2.1 background"));
    assert.ok(lookup.has("2.1. background"));
    assert.ok(lookup.has("2.1"));
    assert.equal(lookup.get("background")?.title, "Background");
    assert.equal(lookup.get("2.1 background")?.title, "Background");
    assert.equal(lookup.get("§background")?.title, "Background");
    assert.equal(lookup.get("background")?.tag, "§Background");
    assert.equal(
      lookup.get("history")?.path,
      "Main Part > Background > History",
    );
    assert.equal(lookup.get("main part > background")?.title, "Background");
    assert.equal(lookup.get("§main part > background")?.title, "Background");
  });

  it("extracts surrounding fulltext context centered around the quote", () => {
    const fulltext =
      "In this paper, we study language model agents. The empirical evaluation demonstrates substantial improvement across all benchmark tasks. Furthermore, ablation experiments confirm the hypothesis.";

    const quote =
      "The empirical evaluation demonstrates substantial improvement";
    const res = extractSurroundingContext(fulltext, quote, 80);
    assert.ok(res);
    assert.ok(res.context.includes(quote));
    assert.ok(res.context.includes("language model agents"));

    // Case-insensitive match
    const lowerQuote =
      "the empirical evaluation demonstrates substantial improvement";
    const res2 = extractSurroundingContext(fulltext, lowerQuote, 80);
    assert.ok(res2);

    // Whitespace difference match
    const wsQuote =
      "The  empirical\n  evaluation   demonstrates substantial improvement";
    const res3 = extractSurroundingContext(fulltext, wsQuote, 80);
    assert.ok(res3);

    // Non-matching quote
    assert.equal(
      extractSurroundingContext(fulltext, "completely missing quote"),
      null,
    );
    assert.equal(extractSurroundingContext("", "quote"), null);
    assert.equal(extractSurroundingContext(fulltext, ""), null);
  });

  it("plans assignments adhering to Flex Annotations Organizer rules", () => {
    const roots: OutlineNode[] = [
      { id: "1", title: "Introduction", children: [] },
      { id: "2", title: "Analysis", children: [] },
      { id: "3", title: "Conclusion", children: [] },
    ];

    const itemStates = new Map([
      [
        "ANN1",
        { key: "ANN1", tags: ["important"], editable: true, inScope: true },
      ],
      [
        "ANN2",
        { key: "ANN2", tags: ["§Introduction"], editable: true, inScope: true },
      ],
      [
        "ANN_UNKNOWN_HEADINGS",
        {
          key: "ANN_UNKNOWN_HEADINGS",
          tags: [],
          editable: true,
          inScope: true,
        },
      ],
      [
        "ANN_READONLY",
        { key: "ANN_READONLY", tags: [], editable: false, inScope: true },
      ],
      [
        "ANN_OUT_OF_SCOPE",
        { key: "ANN_OUT_OF_SCOPE", tags: [], editable: true, inScope: false },
      ],
    ]);

    const assignments = [
      { key: "ANN1", headings: ["Analysis", "§Conclusion"] }, // § prefix tolerated
      { key: "ANN2", headings: ["Introduction"] }, // Already assigned §Introduction
      { key: "ANN2", headings: ["Analysis"] }, // New heading
      { key: "ANN_EMPTY", headings: [] },
      { key: "ANN_UNKNOWN_HEADINGS", headings: ["NonExistentHeading"] },
      { key: "ANN_READONLY", headings: ["Analysis"] },
      { key: "ANN_OUT_OF_SCOPE", headings: ["Analysis"] },
      { key: "MISSING_ANN", headings: ["Analysis"] },
    ];

    const result = planAssignments(roots, assignments, itemStates);

    // ANN1 assigned §Analysis and §Conclusion
    const ann1 = result.assigned.find((a) => a.key === "ANN1");
    assert.ok(ann1);
    assert.deepEqual(ann1.added, ["§Analysis", "§Conclusion"]);
    assert.deepEqual(ann1.headings, ["Analysis", "Conclusion"]);

    // ANN2 first entry: already assigned
    const skippedAlready = result.skipped.find(
      (s) => s.key === "ANN2" && s.reason === "already assigned",
    );
    assert.ok(skippedAlready);

    // ANN2 second entry: assigned §Analysis
    const ann2 = result.assigned.find(
      (a) => a.key === "ANN2" && a.added.includes("§Analysis"),
    );
    assert.ok(ann2);
    assert.deepEqual(ann2.added, ["§Analysis"]);

    // Skipped checks
    assert.ok(
      result.skipped.some(
        (s) => s.key === "ANN_EMPTY" && s.reason === "no heading",
      ),
    );
    assert.ok(
      result.skipped.some(
        (s) =>
          s.key === "ANN_UNKNOWN_HEADINGS" && s.reason === "no valid heading",
      ),
    );
    assert.ok(
      result.skipped.some(
        (s) => s.key === "ANN_READONLY" && s.reason === "item not editable",
      ),
    );
    assert.ok(
      result.skipped.some(
        (s) =>
          s.key === "ANN_OUT_OF_SCOPE" && s.reason === "work not in collection",
      ),
    );
    assert.ok(
      result.skipped.some(
        (s) => s.key === "MISSING_ANN" && s.reason === "annotation not found",
      ),
    );

    // Unknown headings list
    assert.deepEqual(result.unknownHeadings, ["NonExistentHeading"]);
  });

  it("normalizes heading keys and cleans heading titles safely", () => {
    assert.equal(
      normalizeHeadingKey("  §1.1   Funktionen des Nachweises  "),
      "1.1 funktionen des nachweises",
    );

    // German words like Im or In should not be treated as Roman numerals
    assert.deepEqual(cleanHeadingTitle("Im Überblick"), {
      title: "Im Überblick",
    });
    assert.deepEqual(cleanHeadingTitle("In dieser Arbeit"), {
      title: "In dieser Arbeit",
    });

    // English titles starting with "A" without period should not be treated as outline letters
    assert.deepEqual(cleanHeadingTitle("A Framework for Analysis"), {
      title: "A Framework for Analysis",
    });

    // Delimited letters and numbers
    assert.deepEqual(cleanHeadingTitle("A. Grundlagen"), {
      num: "A",
      title: "Grundlagen",
    });
    assert.deepEqual(cleanHeadingTitle("1.1 Funktionen des Nachweises"), {
      num: "1.1",
      title: "Funktionen des Nachweises",
    });
    assert.deepEqual(cleanHeadingTitle("1. Funktionen des Nachweises"), {
      num: "1",
      title: "Funktionen des Nachweises",
    });
    assert.deepEqual(cleanHeadingTitle("I. Einleitung"), {
      num: "I",
      title: "Einleitung",
    });
    assert.deepEqual(cleanHeadingTitle("II Hauptteil"), {
      num: "II",
      title: "Hauptteil",
    });
  });
});
