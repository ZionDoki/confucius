import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextSourceVersions,
  emptyLockedContext,
  executionBinding,
  type RunState,
} from "@confucius/protocol";
import { HistoryStore } from "./history";
import { InMemoryFileSystem } from "./fs";

function fixture() {
  const fs = new InMemoryFileSystem();
  const store = new HistoryStore(fs, "/history");
  const task = {
    id: "task",
    title: "Compare all papers",
    backend: "native" as const,
    status: "running" as const,
    updatedAt: 1,
  };
  store.register(task);
  const run: RunState = {
    version: 1,
    id: "run",
    generation: 1,
    intentRevision: 1,
    request: "Compare all 20 papers",
    status: "running",
    templateVersion: 1,
    requiredArtifactKinds: [],
    createdAt: 1,
    updatedAt: 1,
    sources: {
      ...emptyLockedContext(1),
      fingerprint: "sources",
      items: Array.from({ length: 20 }, (_, i) => ({
        id: `source${i}`,
        libraryID: 1,
        key: `PAPER${i}`,
        title: `Paper ${i}`,
        source: "library" as const,
      })),
    },
    budget: {
      maxIterations: 50,
      maxToolCalls: 100,
      iterationsUsed: 1,
      toolCallsUsed: 1,
      executorStarts: 1,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      modelRequestsObservable: true,
    },
  };
  async function read(
    i: number,
    pages: number[],
    fileVersion = "pdf_v1",
    truncated = false,
  ) {
    const ref = {
      taskId: "task",
      windowId: `window${i}`,
      itemId: `read_${i}_${fileVersion}_${pages.join("_")}`,
    };
    await store.append({
      ...ref,
      role: "tool",
      toolName: "get_pages",
      binding: executionBinding(run),
      sourceVersions: contextSourceVersions(run.sources),
      sourceIds: [`1:PAPER${i}`],
      content: JSON.stringify({
        ok: true,
        toolName: "get_pages",
        data: {
          libraryID: 1,
          key: `PAPER${i}`,
          pageCount: 2,
          sourceVersion: fileVersion,
          pages: pages.map((page) => ({
            page,
            text: `Evidence ${i}/${page}`,
            truncated,
          })),
        },
      }),
    });
    return `h:task:${ref.windowId}:${ref.itemId}`;
  }
  return { fs, store, task, run, read };
}

test("all-source ledger survives windows and restart without claiming observed text was reviewed", async () => {
  const f = fixture();
  const before = await f.store.sourceCoverage("task", f.run);
  assert.equal(before.entries.length, 20);
  assert.ok(before.entries.every((e) => e.read === "unread"));
  const ref = await f.read(0, [1, 2]);
  await f.read(1, [1], "pdf_v1", true);
  await f.store.writeNote(
    "task",
    "progress",
    "Paper zero limitations analyzed",
    ["1:PAPER0"],
    {
      version: 1,
      binding: executionBinding(f.run)!,
      sourceVersions: contextSourceVersions(f.run.sources),
      evidenceRefs: [],
      evidence: [{ ref }],
      sourceProgress: [
        {
          sourceId: "1:PAPER0",
          status: "analyzed",
          detail: "Two pages, one limitation",
        },
      ],
    },
  );
  // Reusing the progress note for the next paper must not erase paper zero's ledger row.
  await f.store.writeNote(
    "task",
    "progress",
    "Paper one failed analysis",
    ["1:PAPER1"],
    {
      version: 1,
      binding: executionBinding(f.run)!,
      sourceVersions: contextSourceVersions(f.run.sources),
      evidenceRefs: [],
      sourceProgress: [
        {
          sourceId: "1:PAPER1",
          status: "failed",
          detail: "Need untruncated text",
        },
      ],
    },
  );
  await f.store.archive("task", 10);
  const restored = new HistoryStore(f.fs, "/history");
  restored.register(f.task);
  const coverage = await restored.sourceCoverage("task", f.run);
  assert.equal(coverage.entries[0].read, "complete-text-observed");
  assert.equal(coverage.entries[0].analysis, "reported");
  assert.equal(coverage.entries[1].read, "partial");
  assert.deepEqual(coverage.entries[1].truncatedPages, [1]);
  assert.match(coverage.entries[1].failed!, /untruncated/);
  assert.ok(coverage.entries.every((e) => e.verification === "unknown"));
  assert.equal(coverage.entries.filter((e) => e.read === "unread").length, 18);
});

test("changed bindings invalidate affected rows; a new observed file version invalidates old pages and analysis", async () => {
  const f = fixture();
  const ref = await f.read(0, [1, 2]);
  await f.read(1, [1, 2]);
  await f.store.writeNote("task", "progress", "Done", undefined, {
    version: 1,
    binding: executionBinding(f.run)!,
    sourceVersions: contextSourceVersions(f.run.sources),
    evidenceRefs: [],
    evidence: [{ ref }],
    sourceProgress: [{ sourceId: "1:PAPER0", status: "analyzed" }],
  });
  f.run.sources = {
    ...f.run.sources,
    fingerprint: "changed",
    items: f.run.sources.items.map((i) =>
      i.key === "PAPER1" ? { ...i, attachmentKey: "replacement" } : i,
    ),
  };
  let coverage = await f.store.sourceCoverage("task", f.run);
  assert.equal(coverage.entries[0].analysis, "reported");
  assert.equal(coverage.entries[1].read, "unread");
  await f.read(0, [2], "pdf_v2");
  coverage = await f.store.sourceCoverage("task", f.run);
  assert.deepEqual(coverage.entries[0].pagesObserved, [2]);
  assert.equal(coverage.entries[0].analysis, "stale");
  f.run.intentRevision++;
  assert.equal(
    (await f.store.sourceCoverage("task", f.run)).entries[0].analysis,
    "unreported",
  );
});

test("model prose and unstamped legacy results do not create read receipts; collections stay explicitly incomplete", async () => {
  const f = fixture();
  const content = JSON.stringify({
    ok: true,
    toolName: "get_pages",
    data: {
      libraryID: 1,
      key: "PAPER0",
      pageCount: 1,
      pages: [{ page: 1, text: "claim" }],
    },
  });
  for (const role of ["assistant", "tool"] as const)
    await f.store.append({
      taskId: "task",
      windowId: "w",
      itemId: role,
      role,
      toolName: "get_pages",
      sourceIds: ["1:PAPER0"],
      content,
    });
  f.run.sources.collection = {
    id: "collection",
    libraryID: 1,
    key: "COLL",
    name: "All",
  };
  const coverage = await f.store.sourceCoverage("task", f.run);
  assert.equal(coverage.enumeration, "collection-members-unknown");
  assert.equal(coverage.entries[0].read, "unread");
});
