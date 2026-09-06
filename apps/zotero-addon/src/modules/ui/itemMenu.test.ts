import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasPdfForMenu,
  registerItemMenu,
  unregisterItemMenu,
  type MenuProbeItem,
} from "./itemMenu";

function attachment(contentType: string): MenuProbeItem {
  return { isAttachment: () => true, attachmentContentType: contentType };
}

it("removes the popup listener before a window is reloaded", () => {
  const previousAddon = Reflect.get(globalThis, "addon");
  const previousToolkit = Reflect.get(globalThis, "ztoolkit");
  Reflect.set(globalThis, "addon", { data: {} });
  Reflect.set(globalThis, "ztoolkit", { log() {} });
  const nodes = new Map<string, unknown>();
  const showing = new Set<EventListener>();
  const menu = {
    appendChild(node: { id: string }) {
      nodes.set(node.id, node);
    },
    addEventListener(_type: string, handler: EventListener) {
      showing.add(handler);
    },
    removeEventListener(_type: string, handler: EventListener) {
      showing.delete(handler);
    },
  };
  nodes.set("zotero-itemmenu", menu);
  const win = {
    document: {
      getElementById: (id: string) => nodes.get(id),
      createXULElement() {
        return {
          id: "",
          setAttribute() {},
          addEventListener() {},
          remove() {
            nodes.delete(this.id);
          },
        };
      },
    },
  } as unknown as Window;
  try {
    registerItemMenu(win);
    registerItemMenu(win);
    assert.equal(showing.size, 1);
    assert.equal(nodes.size, 9);
    unregisterItemMenu(win);
    assert.equal(showing.size, 0);
    assert.equal(nodes.size, 1);
    registerItemMenu(win);
    assert.equal(showing.size, 1);
    unregisterItemMenu(win);
    assert.equal(showing.size, 0);
  } finally {
    Reflect.set(globalThis, "addon", previousAddon);
    Reflect.set(globalThis, "ztoolkit", previousToolkit);
  }
});

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
