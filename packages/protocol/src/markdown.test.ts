import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  escapeHtml,
  renderMarkdownHtml,
  mapMarkdownCitations,
} from "./markdown";

it("renders source markers inside prose and tables but not code, math or links", () => {
  const source =
    "摘要 [cite:overview]\n\n| 结果 | 来源 |\n|---|---|\n| 30/60 | [cite:e1] |\n\n`[cite:code]` [cite:link](https://example.com) $[cite:math]$\n\n```\n[cite:fence]\n```";
  const html = renderMarkdownHtml(source);
  assert.deepEqual(
    [...html.matchAll(/data-citation-id="([^"]+)"/g)].map((m) => m[1]),
    ["overview", "e1"],
  );
  const ids: string[] = [];
  mapMarkdownCitations(source, (id, marker) => {
    ids.push(id);
    return marker;
  });
  assert.deepEqual(ids, ["overview", "e1"]);
  assert.doesNotMatch(
    renderMarkdownHtml('[cite:x"onclick="evil]'),
    /data-citation-id/,
  );
});

describe("renderMarkdownHtml", () => {
  it("renders GFM tables, emphasis, and code", () => {
    const html = renderMarkdownHtml(
      [
        "| Col | N |",
        "| --- | --- |",
        "| **a** | `1` |",
        "",
        "See [docs](https://example.com).",
      ].join("\n"),
    );
    assert.match(html, /<table>/);
    assert.match(html, /<th>/);
    assert.match(html, /<strong>a<\/strong>/);
    assert.match(html, /<code>1<\/code>/);
    assert.match(html, /href="https:\/\/example.com"/);
  });

  it("emits math placeholders and escapes raw HTML", () => {
    const html = renderMarkdownHtml("Energy $E=mc^2$ and <script>x</script>.");
    assert.match(html, /class="tui-math"/);
    assert.match(html, /data-tex="E=mc\^2"/);
    assert.equal(html.includes("<script>"), false);
    assert.match(html, /&lt;script&gt;/);
  });

  it("keeps fenced code from being parsed as markdown", () => {
    const html = renderMarkdownHtml("```\n**nope**\n$not math$\n```");
    assert.match(html, /<pre>/);
    assert.match(html, /\*\*nope\*\*/);
    assert.equal(html.includes("tui-math"), false);
  });

  it("never trusts source HTML disguised as generated math, and keeps inline code literal", () => {
    const html = renderMarkdownHtml(
      '<span class="tui-math" onclick="bad()"><img src=x></span> `$literal$` $x+y$',
    );
    assert.doesNotMatch(html, /<img|<span[^>]*onclick/);
    assert.match(html, /&lt;span class=/);
    assert.match(html, /<code>\$literal\$<\/code>/);
    assert.match(html, /data-tex="x\+y"/);
    assert.doesNotMatch(html, /%%MATH/);
  });

  it("renders zotero links and blocks dangerous schemes", () => {
    const html = renderMarkdownHtml(
      "Read [paper](zotero://select/library/items/ABC123) and " +
        "[ann](zotero://open-pdf/library/items/PDF9KEY?annotation=ANN1KEY) " +
        "and [bad](javascript:alert(1)).",
    );
    assert.match(html, /href="zotero:\/\/select\/library\/items\/ABC123"/);
    assert.match(html, /data-href="zotero:\/\/select\/library\/items\/ABC123"/);
    assert.match(
      html,
      /href="zotero:\/\/open-pdf\/library\/items\/PDF9KEY\?annotation=ANN1KEY"/,
    );
    assert.equal(/<a href="javascript:/.test(html), false);
  });
});

describe("escapeHtml", () => {
  it("escapes markup", () => {
    assert.equal(escapeHtml('<a "b">'), "&lt;a &quot;b&quot;&gt;");
  });
});

describe("reading report blocks", () => {
  const sample = [
    "Intro $a+b$.",
    ":::parallel",
    "> Original evidence [cite:e1]",
    "",
    "Explanation with $qk$ and [cite:e2].",
    ":::",
    ":::details Unpack <img src=x onerror=bad()>",
    "Background **reasoning**, $x^2$ and [cite:e3].",
    "",
    "```txt",
    "::: literal fence",
    "```",
    ":::",
    "",
    "Next paragraph.",
  ].join("\n");

  it("renders paired passages, collapsed help, math and citations with escaped text", () => {
    const html = renderMarkdownHtml(sample);
    assert.match(html, /class="confucius-reading-parallel"/);
    assert.match(
      html,
      /<details class="confucius-reading-help"><summary>Unpack &lt;img/,
    );
    assert.doesNotMatch(html, /<img|<details[^>]*open/);
    for (const id of ["e1", "e2", "e3"])
      assert.ok(html.includes(`data-citation-id="${id}"`));
    for (const tex of ["a+b", "qk", "x^2"])
      assert.ok(html.includes(`data-tex="${tex}"`));
    assert.match(html, /<code>::: literal fence/);
    assert.match(html, /<p>Next paragraph\.<\/p>/);
  });

  it("expands help and linearizes source pairs for note export without losing content", () => {
    const html = renderMarkdownHtml(sample, { expandReadingBlocks: true });
    assert.doesNotMatch(
      html,
      /<details|<summary|class="confucius-reading-parallel"/,
    );
    assert.match(html, /<blockquote>Original evidence/);
    assert.match(html, /Background <strong>reasoning<\/strong>/);
    assert.match(html, /Next paragraph/);
  });

  it("keeps unclosed, unknown and fenced directives readable without interpreting HTML", () => {
    for (const source of [
      ":::details Help\nUnclosed text",
      ":::parallel\nNo original quote\n:::",
      ":::unknown\nText\n:::",
    ]) {
      const html = renderMarkdownHtml(source);
      assert.doesNotMatch(html, /<details|class="confucius-reading-parallel"/);
      assert.match(html, /:::/);
    }
    const html = renderMarkdownHtml(
      "```\n:::details Not a control\nText\n:::\n```\n\n<details>Raw HTML</details>",
    );
    assert.doesNotMatch(html, /<details/);
    assert.match(html, /&lt;details&gt;/);
  });
});
