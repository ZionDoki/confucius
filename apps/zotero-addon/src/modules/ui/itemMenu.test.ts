import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasPdfForMenu, type MenuProbeItem } from "./itemMenu";

function attachment(contentType: string): MenuProbeItem {
  return { isAttachment: () => true, attachmentContentType: contentType };
}

describe("hasPdfForMenu", () => {
  it("finds a PDF among a regular item's attachments", () => {
    const byId = new Map<number, MenuProbeItem>([
      [1, attachment("text/html")],
      [2, attachment("application/pdf")],
    ]);
    const item: MenuProbeItem = { getAttachments: () => [1, 2] };
    assert.equal(
      hasPdfForMenu(item, (id) => byId.get(id)),
      true,
    );
  });

  it("single selection without a PDF hides the deep-read entry", () => {
    const byId = new Map<number, MenuProbeItem>([[1, attachment("text/html")]]);
    const item: MenuProbeItem = { getAttachments: () => [1] };
    assert.equal(
      hasPdfForMenu(item, (id) => byId.get(id)),
      false,
    );
  });

  it("treats a selected PDF attachment itself as deep-readable", () => {
    assert.equal(
      hasPdfForMenu(attachment("application/pdf"), () => undefined),
      true,
    );
  });

  it("notes never count", () => {
    const item: MenuProbeItem = { isNote: () => true };
    assert.equal(
      hasPdfForMenu(item, () => undefined),
      false,
    );
  });

  it("survives unloaded items where getAttachments returns false", () => {
    const item: MenuProbeItem = { getAttachments: () => false };
    assert.equal(
      hasPdfForMenu(item, () => undefined),
      false,
    );
  });

  it("regular item with no attachments at all", () => {
    assert.equal(
      hasPdfForMenu({}, () => undefined),
      false,
    );
    assert.equal(
      hasPdfForMenu({ getAttachments: () => [] }, () => undefined),
      false,
    );
  });
});
