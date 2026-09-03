import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeHtml, renderMarkdownHtml } from "./markdown";

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

  it("renders zotero links and blocks dangerous schemes", () => {
    const html = renderMarkdownHtml(
      "Read [paper](zotero://select/library/items/ABC123) and " +
        "[ann](zotero://open-pdf/library/items/PDF9KEY?annotation=ANN1KEY) " +
        "and [bad](javascript:alert(1)).",
    );
    assert.match(html, /href="zotero:\/\/select\/library\/items\/ABC123"/);
    assert.match(
      html,
      /data-href="zotero:\/\/select\/library\/items\/ABC123"/,
    );
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
