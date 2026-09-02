import assert from "node:assert/strict";
import test from "node:test";
import { countMindMapNodes, parseMindMapOutline } from "./mindmap";

test("parses headings and indented Markdown bullets into a tree", () => {
  const roots = parseMindMapOutline(`
# Research topic
- Question
  - Hypothesis A
  - Hypothesis B
## Evidence
1. Paper one
2. Paper two
`);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].label, "Research topic");
  assert.equal(roots[0].children[0].label, "Question");
  assert.deepEqual(
    roots[0].children[0].children.map((node) => node.label),
    ["Hypothesis A", "Hypothesis B"],
  );
  assert.equal(roots[0].children[1].label, "Evidence");
  assert.equal(countMindMapNodes(roots), 7);
});

test("keeps plain article-outline lines visible and strips inline markdown", () => {
  const roots = parseMindMapOutline(
    "**Claim**\n[Evidence](https://example.com)",
  );
  assert.deepEqual(
    roots.map((node) => node.label),
    ["Claim", "Evidence"],
  );
});
