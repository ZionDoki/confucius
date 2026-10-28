import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildWorkCitation } from "./workCitation";

interface FakeWork {
  getDisplayTitle?(): string;
  getField?(field: string): unknown;
  getCreators?(): Array<{
    firstName?: string;
    lastName?: string;
    name?: string;
  }>;
  firstCreator?: string;
}

function fakeWork(overrides: Partial<FakeWork> = {}): FakeWork {
  return {
    getDisplayTitle: () => "Some Title",
    getField: (field) => (field === "title" ? "Some Title" : ""),
    getCreators: () => [{ firstName: "Alice", lastName: "Smith" }],
    ...overrides,
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Zotero;
});

describe("buildWorkCitation", () => {
  it("derives title and a Creator (Year) citation from a work", () => {
    const { title, citation } = buildWorkCitation(
      fakeWork({
        getField: (field) => (field === "title" ? "Some Title" : "2020"),
        getCreators: () => [
          { firstName: "Alice", lastName: "Smith" },
          { firstName: "Bob", lastName: "Jones" },
        ],
      }),
    );
    assert.equal(title, "Some Title");
    assert.equal(citation, "Alice Smith, Bob Jones (2020)");
  });

  it("falls back to title when there are no creators", () => {
    const { citation } = buildWorkCitation(
      fakeWork({ getCreators: () => [] }),
    );
    assert.equal(citation, "Some Title");
  });

  it("uses the creators fallback for works without a display title", () => {
    const { title } = buildWorkCitation(
      fakeWork({ getDisplayTitle: undefined, getField: () => "" }),
    );
    assert.equal(title, "");
  });

  it("prefers the QuickCopy format when Zotero is available", () => {
    (globalThis as Record<string, unknown>).Zotero = {
      QuickCopy: {
        lastActiveURL: "http://www.zotero.org/styles/chicago-note-bibliography",
        getFormatFromURL: () => ({ name: "chicago" }),
        getContentFromItems: () => ({ text: "QuickCopy citation" }),
      },
    };
    const { title, citation } = buildWorkCitation(fakeWork());
    assert.equal(title, "Some Title");
    assert.equal(citation, "QuickCopy citation");
  });

  it("tolerates nullish input", () => {
    const { title, citation } = buildWorkCitation(undefined);
    assert.equal(title, "");
    assert.equal(citation, "");
  });
});
