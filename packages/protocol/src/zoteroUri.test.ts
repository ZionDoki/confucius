import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenPdfUri, buildSelectUri, parseZoteroUri } from "./zoteroUri";

describe("parseZoteroUri", () => {
  it("parses select for user library", () => {
    assert.deepEqual(parseZoteroUri("zotero://select/library/items/ABC123"), {
      kind: "select",
      key: "ABC123",
    });
  });

  it("parses select for a group library", () => {
    assert.deepEqual(parseZoteroUri("zotero://select/groups/42/items/ABC123"), {
      kind: "select",
      groupID: 42,
      key: "ABC123",
    });
  });

  it("parses open-pdf with annotation", () => {
    assert.deepEqual(
      parseZoteroUri(
        "zotero://open-pdf/library/items/PDF9KEY?annotation=ANN1KEY",
      ),
      { kind: "open-pdf", attachmentKey: "PDF9KEY", annotationKey: "ANN1KEY" },
    );
  });

  it("accepts the historical zotero item shorthand", () => {
    assert.deepEqual(parseZoteroUri("zotero://item/XV9FJZNW"), {
      kind: "select",
      key: "XV9FJZNW",
      legacyItem: true,
    });
  });

  it("parses open-pdf with page", () => {
    assert.deepEqual(
      parseZoteroUri("zotero://open-pdf/library/items/PDF9KEY?page=12"),
      { kind: "open-pdf", attachmentKey: "PDF9KEY", page: 12 },
    );
  });

  it("parses legacy ZotFile form", () => {
    assert.deepEqual(parseZoteroUri("zotero://open-pdf/0_abcd1234/7"), {
      kind: "open-pdf",
      attachmentKey: "abcd1234",
      page: 7,
    });
  });

  it("rejects malformed input", () => {
    assert.equal(parseZoteroUri(""), null);
    assert.equal(parseZoteroUri("https://example.com"), null);
    assert.equal(parseZoteroUri("zotero://select/library"), null);
    assert.equal(parseZoteroUri("zotero://select/groups/x/items/K"), null);
  });
});

describe("build/parse roundtrip", () => {
  it("roundtrips select", () => {
    const uri = buildSelectUri("ABC123", 42);
    assert.equal(uri, "zotero://select/groups/42/items/ABC123");
    assert.deepEqual(parseZoteroUri(uri), {
      kind: "select",
      groupID: 42,
      key: "ABC123",
    });
  });

  it("roundtrips open-pdf", () => {
    const uri = buildOpenPdfUri("PDF9KEY", {
      annotationKey: "ANN1KEY",
      page: 7,
    });
    assert.equal(
      uri,
      "zotero://open-pdf/library/items/PDF9KEY?annotation=ANN1KEY&page=7",
    );
    assert.deepEqual(parseZoteroUri(uri), {
      kind: "open-pdf",
      attachmentKey: "PDF9KEY",
      annotationKey: "ANN1KEY",
      page: 7,
    });
  });
});
