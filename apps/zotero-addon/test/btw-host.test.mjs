import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHost } from "../src/modules/host/AgentHost.ts";
import { emptyLockedContext } from "@confucius/protocol";

const pdf = {
  source: {
    kind: "pdf",
    libraryID: 1,
    attachmentKey: "PDF001",
    parentKey: "PAPER1",
    title: "Paper",
    pageIndex: 1,
    pageLabel: "2",
  },
  text: "Selected original",
  surroundingText: "",
  capturedAt: 10,
};
const state = (id, libraryID, key, updatedAt) => ({
  record: {
    id,
    title: id,
    backend: "native",
    updatedAt,
    createdAt: 1,
    lockedContext: {
      ...emptyLockedContext(),
      items: [{ id: `item:${libraryID}:${key}`, libraryID, key, title: key }],
    },
    artifactIds: [],
  },
  events: [],
});
function hostFixture() {
  const host = Object.create(AgentHost.prototype);
  host.sessions = new Map([
    ["old", state("old", 1, "PAPER1", 10)],
    ["latest", state("latest", 1, "PAPER1", 20)],
    ["other", state("other", 1, "OTHER", 30)],
    ["otherLibrary", state("otherLibrary", 2, "PAPER1", 40)],
  ]);
  host.readEndpointStore = () => ({ store: { activeEndpointId: "endpoint" } });
  return host;
}

test("PDF host resolution selects all and only article-associated tasks and freezes sources", async () => {
  const previous = globalThis.Zotero;
  globalThis.Zotero = {
    Items: {
      getByLibraryAndKey: (library, key) =>
        library === 1 && key === "PDF001"
          ? { parentItemKey: "PAPER1", isPDFAttachment: () => true }
          : undefined,
    },
  };
  try {
    const host = hostFixture();
    const resolved = await host.resolveBtwContext(pdf);
    assert.deepEqual(
      resolved.tasks.map((t) => t.record.id),
      ["latest", "old"],
    );
    assert.equal(resolved.sources.reader.attachmentKey, "PDF001");
    host.sessions.get("latest").record.title = "Changed after capture";
    assert.equal(resolved.tasks[0].record.title, "latest");
    await assert.rejects(
      host.resolveBtwContext({
        ...pdf,
        source: { ...pdf.source, parentKey: "OTHER" },
      }),
      /parent item changed/,
    );
  } finally {
    globalThis.Zotero = previous;
  }
});

test("report resolution pins the requested revision and refuses another task's report", async () => {
  const host = hostFixture();
  host.artifacts = {
    get: async () => ({
      id: "report",
      taskId: "old",
      revisions: [
        {
          revision: 1,
          body: { type: "markdown", markdown: "First version" },
          citations: [],
        },
        {
          revision: 2,
          body: { type: "markdown", markdown: "Second version" },
          citations: [],
        },
      ],
    }),
  };
  const selection = {
    ...pdf,
    source: {
      kind: "report",
      taskId: "old",
      artifactId: "report",
      revision: 1,
    },
  };
  const resolved = await host.resolveBtwContext(selection);
  assert.deepEqual(
    resolved.tasks.map((t) => t.record.id),
    ["old"],
  );
  assert.equal(resolved.report.text, "First version");
  await assert.rejects(
    host.resolveBtwContext({
      ...selection,
      source: { ...selection.source, taskId: "latest" },
    }),
    /does not belong/,
  );
});

test("btw external tool catalogs require a live lease for their exact independent run", async () => {
  const host = hostFixture();
  const run = {
    task: { id: "btw_run", run: { id: "btw_turn", generation: 0 } },
    turn: { id: "btw_turn" },
    abort: new globalThis.AbortController(),
    tools: { listTools: () => [{ name: "context_read" }] },
  };
  const lease = {
    taskId: "btw_run",
    turnId: "btw_turn",
    runId: "btw_turn",
    generation: 0,
  };
  host.btwManager = { run: (id) => (id === "btw_run" ? run : undefined) };
  host.pluginRuntime = { isCurrentLease: (value) => value === lease };
  assert.deepEqual(await host.taskToolList("btw_run", lease), {
    tools: [{ name: "context_read" }],
  });
  assert.throws(() => host.taskToolList("btw_run"), /capability expired/);
  assert.throws(
    () => host.taskToolList("btw_run", { ...lease, taskId: "old" }),
    /capability expired/,
  );
  run.abort.abort();
  assert.throws(
    () => host.taskToolList("btw_run", lease),
    /capability expired/,
  );
});
