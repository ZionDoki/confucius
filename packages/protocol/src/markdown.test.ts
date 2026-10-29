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

  it("renders multiline display formulas without parsing TeX as prose", () => {
    const tex =
      "\\begin{aligned}\na&=b\\\\\nc&=d\\text{[cite:math]}\n\\end{aligned}";
    const source = `Before [cite:before]\n\n$$\n${tex}\n$$\n\nAfter $x$ [cite:after]`;
    const html = renderMarkdownHtml(source);
    assert.match(html, /data-display="1"/);
    assert.ok(html.includes(`data-tex="${escapeHtml(tex)}"`));
    assert.equal((html.match(/class="tui-math"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /data-citation-id="math"/);
    const ids: string[] = [];
    mapMarkdownCitations(source, (id, marker) => {
      ids.push(id);
      return marker;
    });
    assert.deepEqual(ids, ["before", "after"]);
  });

  it("leaves unclosed display math and formulas inside code readable", () => {
    for (const source of [
      "$$\nunclosed [cite:visible]",
      "$$\n```tex\n$$\nx=y\n$$\n```",
    ]) {
      const html = renderMarkdownHtml(source);
      assert.doesNotMatch(html, /tui-math/);
      assert.match(html, /\$\$/);
    }
    assert.match(
      renderMarkdownHtml("$$\nunclosed [cite:visible]"),
      /data-citation-id="visible"/,
    );
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

  it("keeps currency ranges as prose and still parses real inline math", () => {
    const source =
      "The API costs $5 per call [cite:e1] and $10 per review, while $x+y$ stays math.";
    const html = renderMarkdownHtml(source);
    assert.match(html, /\$5 per call/);
    assert.match(html, /\$10 per review/);
    assert.match(html, /data-citation-id="e1"/);
    assert.equal((html.match(/class="tui-math"/g) ?? []).length, 1);
    assert.match(html, /data-tex="x\+y"/);
    const ids: string[] = [];
    mapMarkdownCitations(source, (id, marker) => {
      ids.push(id);
      return marker;
    });
    assert.deepEqual(ids, ["e1"]);

    const compact = renderMarkdownHtml(
      "The cost is $5 [cite:e2]-$10 per item.",
    );
    assert.match(compact, /\$5/);
    assert.match(compact, /\$10 per item/);
    assert.match(compact, /data-citation-id="e2"/);
    assert.equal((compact.match(/class="tui-math"/g) ?? []).length, 0);

    const compactIds: string[] = [];
    const mapped = mapMarkdownCitations(
      "The cost is $5 [cite:e2]-$10 per item.",
      (id, marker) => {
        compactIds.push(id);
        return marker;
      },
    );
    assert.deepEqual(compactIds, ["e2"]);
    assert.equal(mapped, "The cost is $5 [cite:e2]-$10 per item.");
  });

  it("treats bare numeric amounts as formulas while keeping prices as prose", () => {
    const html = renderMarkdownHtml("Value $1.2$ and Base-$10$ log.");
    assert.equal((html.match(/class="tui-math"/g) ?? []).length, 2);
    assert.match(html, /data-tex="1\.2"/);
    assert.match(html, /data-tex="10"/);

    const price = "The API costs $5 per call [cite:e3] and $10 per review.";
    const priceHtml = renderMarkdownHtml(price);
    assert.equal((priceHtml.match(/class="tui-math"/g) ?? []).length, 0);
    assert.match(priceHtml, /data-citation-id="e3"/);
    const ids: string[] = [];
    mapMarkdownCitations(price, (id, marker) => {
      ids.push(id);
      return marker;
    });
    assert.deepEqual(ids, ["e3"]);
  });

  it("expands math source in link labels instead of leaking slot tokens", () => {
    const html = renderMarkdownHtml(
      "See [formula $x+y$](https://example.com).",
    );
    assert.doesNotMatch(html, /[\u0000\u0001]/);
    assert.match(html, /<a [^>]*>formula \$x\+y\$<\/a>/);
    assert.doesNotMatch(html, /tui-math/);
  });

  it("keeps literal internal math-token text from being consumed or replaced", () => {
    const html = renderMarkdownHtml(
      "Literal %%MATH0%% stays, and $x+y$ is the only formula.",
    );
    assert.match(html, /Literal %%MATH0%% stays/);
    assert.equal((html.match(/class="tui-math"/g) ?? []).length, 1);
    assert.match(html, /data-tex="x\+y"/);
  });

  it("renders math source in a details title without leaking slot tokens", () => {
    const html = renderMarkdownHtml(
      ":::details Costs $x+y$\nBackground text.\n:::",
    );
    assert.doesNotMatch(html, /\u0000/);
    assert.match(html, /<summary>Costs \$x\+y\$<\/summary>/);
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
