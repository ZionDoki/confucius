import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryStore } from "./history";
import { InMemoryFileSystem } from "./fs";
import { indexPassages } from "./passages";

test("page chunks preserve exact escaped JSON offsets and distinguish two hits in one result", async () => {
  const store = new HistoryStore(new InMemoryFileSystem(), "/history");
  store.register({
    id: "task",
    title: "Research",
    backend: "native",
    status: "running",
    updatedAt: 1,
  });
  const ref = { taskId: "task", windowId: "w", itemId: "pages" };
  const content = JSON.stringify({
    ok: true,
    toolName: "get_pages",
    data: {
      pages: [
        { page: 1, text: "Intro ".repeat(4000) },
        {
          page: 17,
          text: "罕见局限性：小样本。\nA quoted } brace does not close the page.",
        },
        {
          page: 29,
          text: "罕见局限性：未做跨域验证。\n中文与 emoji 🧪 are preserved.",
        },
      ],
    },
  });
  await store.append({
    ...ref,
    role: "tool",
    toolName: "get_pages",
    sourceIds: ["1:A"],
    content,
  });
  const found = await store.search({ query: "罕见局限性" });
  assert.deepEqual(new Set(found.items.map((i) => i.page)), new Set([17, 29]));
  for (const hit of found.items) {
    assert.ok(hit.offset! > 20000);
    assert.equal(hit.excerpt, content.slice(hit.offset, hit.endOffset));
    assert.equal(
      (await store.read(ref, hit.offset, hit.endOffset! - hit.offset!)).content,
      hit.excerpt,
    );
  }
  const ranges = indexPassages(content).passages;
  assert.ok(ranges.every((p) => p.end > p.start && p.end - p.start <= 1800));
});

test("rare terms outrank a weak related hit and document titles remain searchable", async () => {
  const store = new HistoryStore(new InMemoryFileSystem(), "/history");
  for (let n = 0; n < 25; n++) {
    const id = `task${n}`;
    store.register({
      id,
      title: n === 24 ? "Unique study title" : "Research",
      backend: "native",
      status: "completed",
      updatedAt: 1,
    });
    await store.append({
      taskId: id,
      windowId: "w",
      itemId: "i",
      role: "tool",
      sourceIds: [],
      content:
        n === 24
          ? "quasar controlled experiment"
          : "retrieval routine baseline",
    });
  }
  const found = await store.search({
    query: "retrieval quasar",
    preferredTaskIds: ["task0"],
  });
  assert.equal(found.items[0].taskId, "task24");
  assert.equal(
    (await store.search({ query: "Unique study" })).items[0].taskId,
    "task24",
  );
});

test("legacy shard rebuild is restartable after metadata commit failure and counts derived bytes", async () => {
  class FailingFs extends InMemoryFileSystem {
    fail = false;
    override async writeFile(path: string, content: string) {
      if (this.fail && path.endsWith("/index.json"))
        throw new Error("disk full");
      return super.writeFile(path, content);
    }
  }
  const fs = new FailingFs();
  const task = {
    id: "task",
    title: "task",
    backend: "native" as const,
    status: "completed" as const,
    updatedAt: 1,
  };
  const store = new HistoryStore(fs, "/history");
  store.register(task);
  await store.append({
    taskId: "task",
    windowId: "w",
    itemId: "i",
    role: "tool",
    sourceIds: [],
    content: "early words\n\nlate decisive evidence",
  });
  // An older token-set shard is converted on first lexical search.
  await fs.writeFile(
    "/history/task/windows/w/terms.json",
    JSON.stringify({ i: ["early", "decisive", "evidence"] }),
  );
  const retry = new HistoryStore(fs, "/history");
  retry.register(task);
  fs.fail = true;
  await assert.rejects(retry.search({ query: "decisive" }), /disk full/);
  fs.fail = false;
  const restored = new HistoryStore(fs, "/history");
  restored.register(task);
  assert.match(
    (await restored.search({ query: "decisive" })).items[0].excerpt,
    /decisive/,
  );
  assert.equal(
    (await restored.retentionInfo("task")).bytes,
    Object.values(fs.snapshot()).reduce(
      (sum, body) => sum + new TextEncoder().encode(body).length,
      0,
    ),
  );
});
