import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectExistingReader } from "./linkNavigator";

describe("selectExistingReader", () => {
  it("finds the reader for an open attachment", () => {
    const readers = [
      { itemID: 10, tabID: "tab-a" },
      { itemID: 20, tabID: "tab-b" },
    ];
    assert.equal(selectExistingReader(readers, 20)?.tabID, "tab-b");
  });

  it("returns null when the attachment is not open", () => {
    assert.equal(selectExistingReader([{ itemID: 1 }], 99), null);
    assert.equal(selectExistingReader([], 1), null);
  });
});
