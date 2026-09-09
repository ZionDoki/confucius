import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyLockedContext } from "@confucius/protocol";
import { HistoryStore, InMemoryFileSystem } from "@confucius/memory";
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

test("archived annotation pages remain readable in their PDF scope without admitting other papers", async () => {
  const store = new HistoryStore(new InMemoryFileSystem(), "/history");
  store.register({
    id: "task",
    title: "Paper",
    updatedAt: 1,
    status: "completed",
    backend: "native",
  });
  const page = {
    libraryID: 1,
    key: "PDFKEY01",
    attachmentKey: "PDFKEY01",
    annotations: [
      {
        libraryID: 1,
        key: "MARKKEY1",
        type: "highlight",
        pageLabel: "4",
        position: { pageIndex: 3 },
        text: "Original passage",
        comment: "Saved comment",
      },
    ],
  };
  const original = JSON.stringify({
    result: { ok: true, toolName: "get_annotations", data: page },
  });
  const ref = await store.append({
    taskId: "task",
    windowId: "first",
    itemId: "annotations",
    role: "tool",
    toolName: "get_annotations",
    content: original,
    sourceIds: historySourceRefs(undefined, original),
  });
  const allowed = ["1:PDFKEY01"];
  const read = await store.read(ref, 0, 8000, allowed);
  assert.equal(read.content, original);
  assert.deepEqual(read.item.sourceIds, allowed);
  const mixed = JSON.stringify({
    page,
    other: { libraryID: 1, key: "PAPERB02" },
  });
  const foreign = await store.append({
    taskId: "task",
    windowId: "first",
    itemId: "mixed",
    role: "tool",
    content: mixed,
    sourceIds: historySourceRefs(undefined, mixed),
  });
  await assert.rejects(store.read(foreign, 0, 8000, allowed), /source scope/);
});

test("annotation identities retain their PDF parent while ordinary notes remain separate sources", () => {
  assert.deepEqual(
    historySourceRefs(undefined, {
      libraryID: 1,
      itemType: "annotation",
      key: "MARKKEY1",
      parentKey: "PDFKEY01",
    }),
    ["1:PDFKEY01"],
  );
  assert.deepEqual(
    historySourceRefs(undefined, {
      libraryID: 1,
      type: "note",
      key: "NOTEKEY1",
      content: "Saved note",
    }),
    ["1:NOTEKEY1"],
  );
  assert.deepEqual(
    historySourceRefs(undefined, {
      libraryID: 1,
      type: "highlight",
      key: "MARKKEY1",
      pageLabel: "1",
      text: "Evidence from 2:PAPERB02",
    }),
    ["2:PAPERB02"],
  );
});
