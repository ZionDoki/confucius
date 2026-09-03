import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hrefFromEvent } from "./anchorFromEvent";

function anchor(href: string) {
  return {
    localName: "a",
    getAttribute(name: string) {
      return name === "href" ? href : null;
    },
  };
}

describe("hrefFromEvent", () => {
  it("reads href when the target is the anchor itself", () => {
    assert.equal(
      hrefFromEvent({
        target: anchor("zotero://select/library/items/ABC123"),
      }),
      "zotero://select/library/items/ABC123",
    );
  });

  it("walks out of a text node inside the anchor (Firefox XHTML)", () => {
    const link = anchor("zotero://open-pdf/library/items/PDF9KEY?page=3");
    const text = {
      nodeType: 3,
      parentElement: link,
      parentNode: link,
    };
    assert.equal(
      hrefFromEvent({ target: text }),
      "zotero://open-pdf/library/items/PDF9KEY?page=3",
    );
  });

  it("uses composedPath when target is an inner element", () => {
    const link = anchor("https://example.com/paper");
    const em = { localName: "em", parentElement: link, parentNode: link };
    assert.equal(
      hrefFromEvent({
        target: { localName: "#text" },
        composedPath: () => [em, link],
      }),
      "https://example.com/paper",
    );
  });

  it("uses closest() when the target is a descendant element", () => {
    const link = anchor("zotero://select/library/items/KEY1");
    const span = {
      localName: "span",
      closest(selector: string) {
        return selector === "a" ? link : null;
      },
    };
    assert.equal(
      hrefFromEvent({ target: span }),
      "zotero://select/library/items/KEY1",
    );
  });

  it("prefers data-href when href was stripped", () => {
    const link = {
      localName: "a",
      getAttribute(name: string) {
        if (name === "data-href") {
          return "zotero://select/library/items/ABC123";
        }
        return name === "href" ? "" : null;
      },
    };
    assert.equal(
      hrefFromEvent({ target: link }),
      "zotero://select/library/items/ABC123",
    );
  });

  it("returns empty when there is no anchor", () => {
    assert.equal(hrefFromEvent({ target: { localName: "div" } }), "");
    assert.equal(hrefFromEvent({}), "");
  });
});
