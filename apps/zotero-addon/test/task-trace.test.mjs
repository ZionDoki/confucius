import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryStore, InMemoryFileSystem } from "@confucius/memory";
import { initialContextWindow } from "@confucius/protocol";
import { TaskTraceBuffer } from "../src/modules/host/TaskTrace.ts";
import {
  collectTaskTrace,
  redactTrace,
} from "../src/modules/host/TaskTraceReport.ts";
import {
  renderTaskTraceHtml,
  taskTraceFilename,
} from "../src/modules/ui/taskTraceReport.ts";
import { ZoteroToolHost } from "../src/modules/tools/ZoteroToolHost.ts";
import { memoryJsonStorage } from "../src/modules/host/RuntimeStorage.ts";

const task = {
  id: "task_a",
  title: "Research",
  backend: "native",
  status: "interrupted",
  updatedAt: 1,
};
const event = (id, sessionId = task.id) => ({
  id: `e_${id}`,
  sessionId,
  turnId: "turn_1",
  ts: id,
  type: "tool_progress",
  payload: { stage: "reading", text: `entry ${id}` },
});
const collect = (overrides) =>
  collectTaskTrace({
    task,
    snapshot: { record: task },
    retainedEvents: [],
    startedAt: 1,
    running: false,
    changed: () => false,
    secrets: [],
    sections: {},
    ...overrides,
  });

test("trace export follows durable arrival sequence across clock reversals and retained/journal overlap", async () => {
  const saved = { ...event(2), ts: 420000, sequence: 41 };
  const receipt = { ...event(3), ts: 1000, sequence: 42 };
  const report = await collect({
    retainedEvents: [receipt, saved, { ...event(1), ts: 900000 }],
  });
  assert.deepEqual(
    report.events.map((event) => event.id),
    ["e_1", "e_2", "e_3"],
  );
  assert.equal(
    report.events[2].ts,
    1000,
    "retain recorded wall time; never invent a corrected timestamp",
  );
});

test("trace export keeps full bodies across windows, previous notes, missing files and orphan bodies", async () => {
  const fs = new InMemoryFileSystem();
  const store = new HistoryStore(fs, "/history");
  store.register(task);
  const first = initialContextWindow(task.id, "native", 1);
  const second = { ...first, id: "window_2", number: 2 };
  await store.addWindow(task.id, first);
  await store.addWindow(task.id, second);
  const large = "完整证据".repeat(16000);
  await store.append({
    taskId: task.id,
    windowId: first.id,
    itemId: "first",
    role: "tool",
    sourceIds: [],
    content: large,
  });
  await store.append({
    taskId: task.id,
    windowId: second.id,
    itemId: "missing",
    role: "assistant",
    sourceIds: [],
    content: "lost",
  });
  await store.writeNote(task.id, "progress", "first note");
  await store.writeNote(task.id, "progress", "second note");
  await fs.deleteFile("/history/task_a/windows/window_2/missing.txt");
  await fs.writeFile(
    "/history/task_a/windows/window_2/orphan.txt",
    "receipt before index failure",
  );
  const before = fs.snapshot();
  const result = await store.exportTask(task.id);
  assert.equal(result.items[0].content, large);
  assert.match(result.items[1].error, /ENOENT/);
  assert.deepEqual(
    result.notes.map((n) => [n.revision, n.current, n.content]),
    [
      [1, false, "first note"],
      [2, true, "second note"],
    ],
  );
  assert.equal(result.unindexed[0].content, "receipt before index failure");
  assert.equal(result.windows.length, 2);
  assert.deepEqual(
    fs.snapshot(),
    before,
    "export must not write or repair storage",
  );
});

test("damaged history index still exports original bodies without activating an empty state", async () => {
  const fs = new InMemoryFileSystem({
    "/history/task_a/index.json": "{bad",
    "/history/task_a/windows/w_1/body.txt": "recover this",
    "/history/task_a/notes/progress_1.txt": "working note",
  });
  const store = new HistoryStore(fs, "/history");
  store.register(task);
  const result = await store.exportTask(task.id);
  assert.ok(result.issues.some((issue) => issue.startsWith("History index:")));
  assert.equal(result.unindexed[0].content, "recover this");
  assert.equal(result.notes[0].content, "working note");
});

test("event batches survive restart and UI retention limits; pending batches are exported too", async () => {
  const fs = new InMemoryFileSystem();
  const store = new HistoryStore(fs, "/history");
  store.register(task);
  const window = initialContextWindow(task.id, "native", 1);
  await store.addWindow(task.id, window);
  const buffer = new TaskTraceBuffer();
  for (let i = 1; i <= 1200; i++) buffer.record(event(i), window);
  for (const batch of buffer.drain())
    for (const item of batch.items) await store.append(item);
  assert.deepEqual(buffer.snapshot(), []);
  assert.equal(
    (await store.search({ taskId: task.id })).total,
    0,
    "diagnostic batches must not consume model retrieval or context",
  );
  buffer.record(event(1201), window);
  const reopened = new HistoryStore(fs, "/history");
  reopened.register(task);
  const result = await collect({
    retainedEvents: [event(1200)],
    sections: {
      history: () => reopened.exportTask(task.id),
      pendingHistory: async () => buffer.snapshot(task.id),
    },
  });
  assert.equal(result.events.length, 1201);
  assert.equal(result.events[0].id, "e_1");
  assert.equal(result.events.at(-1).id, "e_1201");
  assert.equal(
    buffer.snapshot(task.id).length,
    1,
    "export must not consume pending records",
  );
});

test("partial report isolates failed stores and cannot include another task trace", async () => {
  const result = await collect({
    running: true,
    changed: () => true,
    retainedEvents: [event(1), event(2, "other")],
    sections: {
      operations: async () => {
        throw new Error("disk full");
      },
      history: async () => ({ items: [], notes: [], issues: [] }),
      environment: async () => ({ version: "test" }),
    },
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.capture.changedDuringExport, true);
  assert.match(result.sections.operations.error, /disk full/);
  assert.deepEqual(result.sections.environment.data, { version: "test" });
});

test("credentials in fields, URLs, headers, text and encoded JSON are redacted; domain identities survive", () => {
  const input = {
    key: "ABC12345",
    operationId: "op_1",
    usage: { inputTokens: 123 },
    apiKey: "old-secret",
    headers: { Authorization: "Bearer old-token" },
    text: "configured-secret http://name:password@example.test/?token=url-secret api_key=raw-secret",
    nested: JSON.stringify({
      client_secret: "nested-secret",
      comment: "Bearer hidden-secret",
    }),
    image: { mimeType: "image/png", data: "binary-payload" },
  };
  const result = redactTrace(input, ["configured-secret"]);
  const text = JSON.stringify(result.value);
  for (const secret of [
    "configured-secret",
    "old-secret",
    "old-token",
    "url-secret",
    "raw-secret",
    "nested-secret",
    "hidden-secret",
    "binary-payload",
  ])
    assert.ok(!text.includes(secret), secret);
  assert.equal(result.value.key, "ABC12345");
  assert.equal(result.value.operationId, "op_1");
  assert.equal(result.value.usage.inputTokens, 123);
  assert.equal(result.counts.binaryPayloads, 1);
  assert.deepEqual(redactTrace({ scope: { source: "1_PDFKEY" } }).value, {
    scope: { source: "1_PDFKEY" },
  });
});

test("short local credentials do not corrupt literature numbers or entity identifiers", () => {
  const result = redactTrace(
    {
      apiKey: "1",
      authorization: "Bearer 1",
      token: "abc",
      value: "abc",
      key: "ART1KEY7",
      text: "Table 1: 38.1 / 41.8, page 8",
      nested: JSON.stringify({ password: "1", itemId: "tool_123" }),
    },
    ["1", "abc"],
  );
  assert.equal(result.value.apiKey, "[REDACTED]");
  assert.equal(result.value.authorization, "[REDACTED]");
  assert.equal(result.value.value, "[REDACTED]");
  assert.equal(result.value.key, "ART1KEY7");
  assert.equal(result.value.text, "Table 1: 38.1 / 41.8, page 8");
  assert.deepEqual(JSON.parse(result.value.nested), {
    password: "[REDACTED]",
    itemId: "tool_123",
  });
});

test("repeated executor event IDs across turns do not overwrite trace batches", async () => {
  const buffer = new TaskTraceBuffer();
  const window = initialContextWindow(task.id, "native", 1);
  buffer.record(event(1), window);
  const first = buffer.drain();
  buffer.record({ ...event(1), turnId: "turn_2", ts: 2 }, window);
  const second = buffer.drain();
  assert.notEqual(first[0].items[0].itemId, second[0].items[0].itemId);
  const result = await collect({
    sections: { pendingHistory: async () => [...first, ...second] },
  });
  assert.deepEqual(
    result.events.map((e) => e.turnId),
    ["turn_1", "turn_2"],
  );
});

test("direct-child filesystem and malformed index entries preserve independent history bodies", async () => {
  const memory = new InMemoryFileSystem({
    "/history/task_a/index.json": JSON.stringify({
      version: 1,
      windows: [null, { id: "../outside" }],
      notes: [null],
      items: [null, { taskId: task.id, windowId: "../outside", itemId: "bad" }],
    }),
    "/history/task_a/windows/w_1/body.txt": "keep evidence",
    "/history/task_a/notes/progress_1.txt": "keep note",
    "/outside/bad.txt": "must not read",
  });
  const fs = {
    readFile: (path) => memory.readFile(path),
    listFiles: async (dir) => {
      const prefix = dir.replace(/\/$/, "") + "/";
      return [
        ...new Set(
          (await memory.listFiles(dir)).map(
            (p) => prefix + p.slice(prefix.length).split("/")[0],
          ),
        ),
      ];
    },
  };
  const store = new HistoryStore(fs, "/history");
  store.register(task);
  const result = await store.exportTask(task.id);
  assert.equal(result.unindexed[0].content, "keep evidence");
  assert.equal(result.notes[0].content, "keep note");
  assert.ok(result.issues.length >= 3);
  assert.equal(JSON.stringify(result).includes("must not read"), false);
  const report = await collect({ sections: { history: async () => result } });
  assert.ok(report.issues.length >= 3);
});

test("report embeds lossless JSON safely even when task text contains HTML or script terminators", async () => {
  const title = '</script><img src=x onerror="window.unsafe=true">';
  const result = await collect({
    task: { ...task, title },
    retainedEvents: [{ ...event(1), payload: { text: title } }],
  });
  const html = renderTaskTraceHtml(result);
  const embedded =
    /<script type="application\/json" id="confucius-trace-data">([\s\S]*?)<\/script>/.exec(
      html,
    )[1];
  assert.deepEqual(JSON.parse(embedded), result);
  assert.equal(html.includes("<img src=x"), false);
  assert.match(html, /default-src 'none'/);
  assert.ok(!taskTraceFilename("../task:bad", 0).includes("../"));
});

test("proposal diagnostics filter by task and do not read PDFs or rewrite proposals", async () => {
  const storage = memoryJsonStorage();
  await storage.write("1_PDFKEY", {
    version: 2,
    latest: {},
    proposals: {
      one: { id: "one", taskId: task.id, entries: [] },
      other: { id: "other", taskId: "other", entries: [] },
    },
  });
  const host = new ZoteroToolHost(storage);
  const result = await host.exportTaskProposals(task.id);
  assert.deepEqual(
    result.records[0].proposals.map((p) => p.id),
    ["one"],
  );
  assert.equal(
    Object.keys((await storage.read("1_PDFKEY")).proposals).length,
    2,
  );
});
