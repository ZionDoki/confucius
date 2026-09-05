import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyLockedContext } from "@confucius/protocol";
import { historySourceRefs } from "./HistorySources";

test("history keeps returned papers and recalled provenance beyond the selected paper", () => {
  const context = emptyLockedContext(1);
  context.items = [
    {
      id: "item_a",
      source: "library",
      libraryID: 1,
      key: "PAPERA01",
      title: "Paper A",
    },
  ];
  const result = JSON.stringify({
    arguments: { libraryID: 1, key: "PAPERA01" },
    result: {
      data: {
        items: [{ libraryID: 1, key: "PAPERB02" }],
        sourceIds: ["2:EARLY001"],
      },
    },
  });
  assert.deepEqual(historySourceRefs(context, result).sort(), [
    "1:PAPERA01",
    "1:PAPERB02",
    "2:EARLY001",
  ]);
});

test("uncited answers do not acquire source provenance from the selected task", () => {
  assert.deepEqual(
    historySourceRefs(undefined, "需要核验。时间 12:34，比例 1:2。"),
    [],
  );
  assert.deepEqual(
    historySourceRefs(undefined, "证据见 1:PAPERA01 和 2:PAPERB02。"),
    ["1:PAPERA01", "2:PAPERB02"],
  );
});
