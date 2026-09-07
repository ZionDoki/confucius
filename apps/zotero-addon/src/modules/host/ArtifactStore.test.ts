import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArtifactStore, type ArtifactFileSystem } from "./ArtifactStore";
import {
  createHarness,
  session,
} from "../../../../../packages/harness/src/test-kit";
import { ToolExecutionService } from "./ReliableToolProvider";
import { memoryJsonStorage } from "./RuntimeStorage";
import { registerHostOperationDomains } from "./HostOperationDomains";
import { truncateToolResult } from "../../../../../packages/harness/src/truncate";
import type { ToolExecutionContext, ConfuciusEvent } from "@confucius/protocol";
import {
  deepReadReviewNextAction,
  deepReadReviewState,
} from "./DeepReadReview";
import {
  ARTIFACT_UPSERT_DEFINITION,
  ArtifactToolProvider,
  artifactBodyShapeHint,
  normalizeArtifactBodyArgument,
} from "./ArtifactToolProvider";

class MemoryFileSystem implements ArtifactFileSystem {
  readonly files = new Map<string, string>();
  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("not found");
    return value;
  }
  async writeAtomic(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async makeDirectory(): Promise<void> {}
}

class BlockingFileSystem extends MemoryFileSystem {
  private blockNext = false;
  private blockedWrite: Promise<void> | null = null;
  private releaseBlockedWrite: (() => void) | null = null;
  private markWriteStarted: (() => void) | null = null;

  blockNextWrite(): { started: Promise<void>; release: () => void } {
    this.blockNext = true;
    const started = new Promise<void>((resolve) => {
      this.markWriteStarted = resolve;
    });
    this.blockedWrite = new Promise<void>((resolve) => {
      this.releaseBlockedWrite = resolve;
    });
    return {
      started,
      release: () => {
        this.releaseBlockedWrite?.();
        this.releaseBlockedWrite = null;
      },
    };
  }

  override async writeAtomic(path: string, content: string): Promise<void> {
    if (this.blockNext) {
      this.blockNext = false;
      this.markWriteStarted?.();
      this.markWriteStarted = null;
      await this.blockedWrite;
      this.blockedWrite = null;
    }
    await super.writeAtomic(path, content);
  }
}

const reportMarkdown =
  "# 示例论文研究报告\n\n## 一分钟速读\n方法在全部任务上成功。\n\n## 方法\n先检索候选，再检查证据。\n\n## 关键证据\n| 指标 | 结果 | 来源 |\n|---|---|---|\n| 完成任务 | 100/100 | [p.2](zotero://open-pdf/library/items/PAPER?page=2) |\n\n## 局限\n尚未验证新领域。\n";
async function editableReport(
  review = false,
  fs = new MemoryFileSystem(),
  markdown = reportMarkdown,
) {
  const store = new ArtifactStore(
    "artifacts",
    fs,
    () => 100,
    () => "report",
  );
  const binding = {
    runId: "run",
    intentRevision: 1,
    sourceFingerprint: "sources",
  };
  const events: ConfuciusEvent[] = [];
  const provider = new ArtifactToolProvider(
    store,
    "task",
    "native",
    ["item:1:PAPER"],
    (artifact) => {
      events.push({
        id: `saved-${artifact.revision}`,
        sessionId: "task",
        turnId: "turn",
        ts: 100,
        type: "artifact_upserted",
        payload: { artifact },
      });
    },
    () => binding,
    review
      ? (artifact) => deepReadReviewState(artifact, binding, events)
      : undefined,
  );
  assert.equal(
    (
      await provider.call("artifact_upsert", {
        kind: review ? "deep_read" : "report",
        title: "示例论文研究报告",
        body: { type: "markdown", markdown },
        status: review ? "draft" : "ready",
        citations: [
          {
            id: "e1",
            itemLibraryID: 1,
            itemKey: "PAPER",
            page: 2,
            quote: "50 of 100 tasks were completed.",
          },
        ],
      })
    ).ok,
    true,
  );
  return { provider, store, fs, events };
}

describe("editable research reports", () => {
  it("patches the overview and evidence together, preserving identity, citations, sources and other sections", async () => {
    const { provider, store, fs } = await editableReport();
    const previous = (await store.get("report"))!;
    const result = await provider.call("artifact_patch", {
      id: "report",
      expectedRevision: 1,
      edits: [
        {
          oldText: "方法在全部任务上成功。",
          newText: "方法只完成部分任务；新领域的表现尚未验证。",
        },
        { oldText: "| 完成任务 | 100/100 |", newText: "| 完成任务 | 50/100 |" },
      ],
    });
    assert.equal(result.ok, true);
    const revised = (await store.get("report"))!;
    assert.equal(revised.revision, 2);
    assert.equal(revised.id, previous.id);
    assert.deepEqual(revised.citations, previous.citations);
    assert.deepEqual(revised.sourceContextIds, previous.sourceContextIds);
    assert.deepEqual(revised.revisions[0], previous.revisions[0]);
    assert.equal(
      revised.body.type === "markdown" && revised.body.markdown,
      reportMarkdown
        .replace(
          "方法在全部任务上成功。",
          "方法只完成部分任务；新领域的表现尚未验证。",
        )
        .replace("100/100", "50/100"),
    );
    assert.equal(fs.files.size, 1);
    assert.equal(
      result.ok &&
        (result.data as { artifact: { body?: unknown; revisions?: unknown } })
          .artifact.body,
      undefined,
    );
    assert.equal(
      result.ok && (result.data as { citationCount: number }).citationCount,
      1,
    );
  });

  it("rejects stale, missing, ambiguous and overlapping edits atomically", async () => {
    const { provider, store } = await editableReport();
    const before = await store.get("report");
    const first = { oldText: "100/100", newText: "50/100" };
    for (const edits of [
      [first, { oldText: "absent text", newText: "x" }],
      [first, { oldText: "方法", newText: "x" }],
      [first, { oldText: "| 完成任务 | 100/100 |", newText: "x" }],
      [first, { oldText: "", newText: "x" }],
    ]) {
      const result = await provider.call("artifact_patch", {
        id: "report",
        expectedRevision: 1,
        edits,
      });
      assert.equal(!result.ok && result.code, "invalid_args");
      assert.equal(result.effect, "none");
      assert.deepEqual(await store.get("report"), before);
    }
    for (const fields of [{}, { title: "  " }]) {
      const result = await provider.call("artifact_patch", {
        id: "report",
        expectedRevision: 1,
        ...fields,
      });
      assert.equal(!result.ok && result.code, "invalid_args");
      assert.equal(result.effect, "none");
      assert.deepEqual(await store.get("report"), before);
    }
    const args = { id: "report", expectedRevision: 1, edits: [first] };
    const prepared: ToolExecutionContext = {};
    assert.equal(
      await provider.prepare("artifact_patch", args, prepared),
      null,
    );
    await store.upsert(
      {
        ...before!,
        body: { type: "markdown", markdown: "Human correction" },
        status: "ready",
      },
      "native",
    );
    const stale = await provider.call(
      "artifact_patch",
      args,
      undefined,
      prepared,
    );
    assert.equal(!stale.ok && stale.code, "invalid_args");
    assert.match(!stale.ok ? stale.message : "", /revision changed/);
    assert.deepEqual((await store.get("report"))?.body, {
      type: "markdown",
      markdown: "Human correction",
    });
  });

  it("does not overwrite an edit made between the snapshot read and write preparation", async (t) => {
    for (const throughGateway of [false, true]) {
      const { provider, store } = await editableReport();
      const get = store.get.bind(store);
      let interleave = true;
      const mocked = t.mock.method(
        store,
        "get",
        async (id: string, refresh?: boolean) => {
          const snapshot = await get(id, refresh);
          if (interleave) {
            interleave = false;
            await store.upsert(
              {
                ...snapshot!,
                body: { type: "markdown", markdown: "Human correction" },
                status: "ready",
              },
              "native",
            );
          }
          return snapshot;
        },
      );
      const tools = throughGateway
        ? new ToolExecutionService(memoryJsonStorage()).wrap(provider)
        : provider;
      const result = await tools.call("artifact_patch", {
        id: "report",
        expectedRevision: 1,
        edits: [{ oldText: "100/100", newText: "50/100" }],
      });
      mocked.mock.restore();
      assert.equal(result.ok, false);
      assert.equal(result.effect, "none");
      const current = (await get("report"))!;
      assert.equal(current.revision, 2);
      assert.deepEqual(current.body, {
        type: "markdown",
        markdown: "Human correction",
      });
    }
  });

  it("replaces citations only when supplied, including an explicit empty list", async () => {
    const { provider, store } = await editableReport();
    const citations = [
      { id: "e2", itemLibraryID: 1, itemKey: "PAPER", page: 3 },
    ];
    assert.equal(
      (
        await provider.call("artifact_patch", {
          id: "report",
          expectedRevision: 1,
          title: "核对后的报告",
          citations,
        })
      ).ok,
      true,
    );
    const replaced = (await store.get("report"))!;
    assert.equal(replaced.title, "核对后的报告");
    assert.deepEqual(replaced.citations, citations);
    assert.deepEqual(replaced.body, {
      type: "markdown",
      markdown: reportMarkdown,
    });
    const cleared = await provider.call("artifact_patch", {
      id: "report",
      expectedRevision: 2,
      citations: [],
    });
    assert.equal(cleared.ok, true);
    assert.equal(
      cleared.ok && (cleared.data as { citationCount: number }).citationCount,
      0,
    );
    const current = (await store.get("report"))!;
    assert.deepEqual(current.citations, []);
    assert.deepEqual(current.revisions[1].citations, citations);
    assert.deepEqual(current.sourceContextIds, ["item:1:PAPER"]);
  });

  it("reads bounded current text and citations without exposing another task or historical revisions", async () => {
    const { provider, store } = await editableReport();
    let offset: number | null = 0;
    let text = "";
    while (offset !== null) {
      const read = await provider.call("artifact_read", {
        id: "report",
        expectedRevision: 1,
        offset,
        limit: 31,
      });
      assert.equal(read.ok, true);
      assert.equal(read.effect, "none");
      if (read.ok) {
        const data = read.data as {
          content: string;
          nextOffset: number | null;
          artifact: { revision: number };
        };
        assert(data.content.length <= 31);
        assert.equal(data.artifact.revision, 1);
        assert.deepEqual(truncateToolResult(read, 10), read);
        text += data.content;
        offset = data.nextOffset;
      }
    }
    assert.equal(text, reportMarkdown);
    const citations = await provider.call("artifact_read", {
      id: "report",
      part: "citations",
    });
    assert.equal(
      citations.ok && (citations.data as { content: string }).content,
      JSON.stringify((await store.get("report"))?.citations, null, 2),
    );
    const other = new ArtifactToolProvider(
      store,
      "other-task",
      "native",
      [],
      () => assert.fail("Cross-task write"),
    );
    for (const tool of ["artifact_read", "artifact_patch"])
      assert.equal(
        (await other.call(tool, { id: "report", expectedRevision: 1 })).ok,
        false,
      );
    await provider.call("artifact_patch", {
      id: "report",
      expectedRevision: 1,
      title: "Changed title",
    });
    const stale = await provider.call("artifact_read", {
      id: "report",
      expectedRevision: 1,
      offset: 31,
    });
    assert.equal(!stale.ok && stale.code, "invalid_args");
    assert.equal(
      (await provider.call("artifact_read", { id: "report", offset: 10000 }))
        .ok,
      false,
    );
  });

  it("finalizes the same reviewed draft without resending the body, and never treats artifact reads as source evidence", async () => {
    const reviewedText = reportMarkdown
      .replace("方法在全部任务上成功。", "方法只完成一半任务。")
      .replace("100/100", "50/100");
    const { provider, store, events } = await editableReport(
      true,
      new MemoryFileSystem(),
      reviewedText,
    );
    const final = { id: "report", expectedRevision: 1, status: "ready" };
    const read = await provider.call("artifact_read", { id: "report" });
    events.push({
      id: "read-draft",
      sessionId: "task",
      ts: 100,
      type: "tool_result",
      payload: { callId: "read", result: read },
    });
    assert.equal((await provider.call("artifact_patch", final)).ok, false);
    for (const name of ["get_pages", "get_annotations"])
      events.push({
        id: name,
        sessionId: "task",
        ts: 100,
        type: "tool_result",
        payload: {
          callId: name,
          result: {
            ok: true,
            toolName: name,
            data: {
              libraryID: 1,
              key: "PAPER",
              pages: [{ page: 2, text: "50 of 100 tasks were completed." }],
              annotations: [],
            },
          },
        },
      });
    assert.equal((await provider.call("artifact_patch", final)).ok, true);
    const saved = (await store.get("report"))!;
    assert.equal(saved.status, "ready");
    assert.equal(saved.revision, 2);
    assert.equal(
      saved.body.type === "markdown" && saved.body.markdown,
      reviewedText,
    );
    assert.equal(saved.citations.length, 1);
    // A later corrected draft must establish its own evidence-read boundary.
    assert.equal(
      (
        await provider.call("artifact_patch", {
          id: "report",
          expectedRevision: 2,
          status: "draft",
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await provider.call("artifact_patch", {
          id: "report",
          expectedRevision: 3,
          status: "ready",
        })
      ).ok,
      false,
    );
  });

  it("keeps compact requests in checkpoints and replays a patch without a second revision", async (t) => {
    const markdown =
      reportMarkdown + "\nAdditional unchanged discussion. ".repeat(400);
    const { provider, store } = await editableReport(
      false,
      new MemoryFileSystem(),
      markdown,
    );
    const execution = new ToolExecutionService(memoryJsonStorage());
    const args = {
      id: "report",
      expectedRevision: 1,
      edits: [
        { oldText: "方法在全部任务上成功。", newText: "方法只完成一半任务。" },
        { oldText: "100/100", newText: "50/100" },
      ],
      status: "ready",
    };
    const call = { id: "patch", name: "artifact_patch", args };
    const harness = createHarness({
      toolProvider: execution.wrap(provider),
      script: [{ toolCalls: [call] }, { text: "已修订报告" }],
    });
    const result = await harness.loop.run({
      session: session("task"),
      turnId: "patch-turn",
      userText: "修正结果",
    });
    assert.equal(result.phase, "done");
    assert.deepEqual(
      result.messages.find((m) => m.toolCalls)?.toolCalls?.[0].args,
      args,
    );
    const checkpoint = harness.checkpoints.latest("patch-turn")!;
    assert.deepEqual(checkpoint.toolExecutions[0].requestedArgs, args);
    const operation = (await execution.listOperations({ taskId: "task" }))[0];
    assert.deepEqual(operation.args, args);
    assert(
      (operation.intent?.recovery.artifactInput as { body?: unknown })?.body,
    );
    const receipt = result.messages.find((m) => m.role === "tool")!.content;
    const artifact = (await store.get("report"))!;
    const replacementBytes = Buffer.byteLength(
      JSON.stringify({
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        body: artifact.body,
        status: "ready",
        citations: artifact.citations,
        sourceContextIds: artifact.sourceContextIds,
      }),
    );
    t.diagnostic(
      JSON.stringify({
        fixture:
          "synthetic report with 400 unchanged discussion lines; UTF-8 bytes, not model tokens",
        fullReplacementArgs: replacementBytes,
        patchArgs: Buffer.byteLength(JSON.stringify(args)),
        statusOnlyArgs: Buffer.byteLength(
          JSON.stringify({
            id: "report",
            expectedRevision: 1,
            status: "ready",
          }),
        ),
        patchReceipt: Buffer.byteLength(receipt),
      }),
    );
    assert(
      Buffer.byteLength(JSON.stringify(args)) <
        Buffer.byteLength(markdown) / 10,
    );
    assert(Buffer.byteLength(receipt) < Buffer.byteLength(markdown) / 10);
    const replay = createHarness({
      toolProvider: execution.wrap(provider),
      script: [{ toolCalls: [call] }, { text: "完成" }],
    });
    await replay.loop.run({
      session: session("task"),
      turnId: "resume",
      userText: "继续",
      resume: checkpoint,
    });
    assert.equal((await store.get("report"))?.revision, 2);
  });

  it("reconciles an interrupted patch from its exact persisted operation, including a status-only edit", async () => {
    class LostReceiptFS extends MemoryFileSystem {
      loseNext = false;
      override async writeAtomic(path: string, text: string) {
        await super.writeAtomic(path, text);
        if (this.loseNext) {
          this.loseNext = false;
          throw new Error("Receipt lost after disk write");
        }
      }
    }
    const fs = new LostReceiptFS();
    const { provider, store } = await editableReport(false, fs);
    const storage = memoryJsonStorage();
    const before = new ToolExecutionService(storage);
    fs.loseNext = true;
    const result = await before
      .wrap(provider)
      .call(
        "artifact_patch",
        { id: "report", expectedRevision: 1, status: "draft" },
        undefined,
        { taskId: "task", operationId: "patch-op" },
      );
    assert.equal(result.effect, "unknown");
    const after = new ToolExecutionService(storage);
    registerHostOperationDomains(after, {
      artifacts: store,
      history: {
        listNotes: async () => [],
        readNote: async () => {
          throw Error("Unused");
        },
      },
      tools: { reconcile: async () => null },
    });
    assert.deepEqual(await after.unresolvedForTask("task"), []);
    const recovered = (await after.getOperation("patch-op"))?.result;
    assert.equal(recovered?.effect, "applied");
    const artifact = (await store.get("report"))!;
    assert.equal(artifact.revision, 2);
    assert.equal(artifact.status, "draft");
    assert.equal(artifact.revisions[1].operationId, "patch-op");
    assert(!JSON.stringify(recovered).includes("revisions"));
  });

  it("does not reconcile an identical body saved by a different operation", async (t) => {
    const { provider, store, fs } = await editableReport();
    const write = fs.writeAtomic.bind(fs);
    const mocked = t.mock.method(
      fs,
      "writeAtomic",
      async (path: string, content: string) => {
        await write(path, content);
        throw new Error("Receipt lost after disk write");
      },
    );
    const storage = memoryJsonStorage();
    const before = new ToolExecutionService(storage);
    const result = await before
      .wrap(provider)
      .call(
        "artifact_patch",
        { id: "report", expectedRevision: 1, status: "draft" },
        undefined,
        { taskId: "task", operationId: "pending-patch" },
      );
    mocked.mock.restore();
    assert.equal(result.effect, "unknown");
    const current = (await store.get("report", true))!;
    current.revisions[1].operationId = "another-operation";
    await store.save(current);
    const after = new ToolExecutionService(storage);
    registerHostOperationDomains(after, {
      artifacts: store,
      history: {
        listNotes: async () => [],
        readNote: async () => {
          throw Error("Unused");
        },
      },
      tools: { reconcile: async () => null },
    });
    const unresolved = await after.unresolvedForTask("task");
    assert.deepEqual(unresolved, ["pending-patch"]);
    assert.equal((await store.get("report"))?.revision, 2);
  });
});

describe("ArtifactStore", () => {
  it("keeps append-only revisions in an independent JSON file", async () => {
    const fs = new MemoryFileSystem();
    let now = 10;
    const store = new ArtifactStore(
      "artifacts",
      fs,
      () => now++,
      () => "art_1",
    );
    const first = await store.upsert(
      {
        taskId: "task_1",
        kind: "report",
        title: "Report",
        body: { type: "markdown", markdown: "v1" },
      },
      "native",
      ["item:1:A"],
    );
    const second = await store.upsert(
      {
        id: first.id,
        taskId: "task_1",
        kind: "report",
        title: "Report",
        body: { type: "markdown", markdown: "v2" },
      },
      "codex",
    );
    assert.equal(second.revision, 2);
    assert.deepEqual(
      second.revisions.map((entry) => entry.revision),
      [1, 2],
    );
    assert.equal(second.revisions[0].body.type, "markdown");
    assert.equal(fs.files.size, 1);
  });

  it("prevents an artifact id from crossing task capabilities", async () => {
    const store = new ArtifactStore(
      "artifacts",
      new MemoryFileSystem(),
      () => 1,
      () => "art_shared",
    );
    await store.upsert(
      {
        taskId: "task_a",
        kind: "report",
        title: "A",
        body: { type: "markdown", markdown: "A" },
      },
      "native",
    );
    await assert.rejects(
      store.upsert(
        {
          id: "art_shared",
          taskId: "task_b",
          kind: "report",
          title: "B",
          body: { type: "markdown", markdown: "B" },
        },
        "kimi",
      ),
      /another task/,
    );
  });

  it("keeps one artifact kind across its entire revision history", async () => {
    const store = new ArtifactStore(
      "artifacts",
      new MemoryFileSystem(),
      () => 1,
      () => "art_stable_kind",
    );
    await store.upsert(
      {
        taskId: "task_a",
        kind: "report",
        title: "Report",
        body: { type: "markdown", markdown: "v1" },
      },
      "native",
    );
    await assert.rejects(
      store.upsert(
        {
          id: "art_stable_kind",
          taskId: "task_a",
          kind: "evidence_audit",
          title: "Audit",
          body: { type: "evidence_audit", claims: [] },
        },
        "codex",
      ),
      /kind cannot change/,
    );
  });

  it("rejects malformed nested bodies and citations before persistence", async () => {
    const fs = new MemoryFileSystem();
    const store = new ArtifactStore(
      "artifacts",
      fs,
      () => 1,
      () => "art_bad",
    );
    await assert.rejects(
      store.upsert(
        {
          taskId: "task_a",
          kind: "evidence_audit",
          body: { type: "evidence_audit" } as never,
          title: "Bad body",
        },
        "native",
      ),
      /does not match/,
    );
    await assert.rejects(
      store.upsert(
        {
          taskId: "task_a",
          kind: "report",
          body: { type: "markdown", markdown: "ok" },
          title: "Bad citation",
          citations: [{ itemLibraryID: 1, itemKey: "", page: 0 }],
        },
        "native",
      ),
      /citations are invalid/,
    );
    assert.equal(fs.files.size, 0);
  });

  it("fails closed when an artifact JSON file is malformed", async () => {
    const fs = new MemoryFileSystem();
    const writer = new ArtifactStore(
      "artifacts",
      fs,
      () => 1,
      () => "art_corrupt",
    );
    await writer.upsert(
      {
        taskId: "task_a",
        kind: "report",
        title: "Report",
        body: { type: "markdown", markdown: "safe" },
      },
      "native",
    );
    const path = "artifacts/art_corrupt.json";
    const corrupted = JSON.parse(fs.files.get(path) ?? "{}") as Record<
      string,
      unknown
    >;
    corrupted.body = { type: "evidence_audit", claims: [] };
    fs.files.set(path, JSON.stringify(corrupted));

    const reader = new ArtifactStore("artifacts", fs);
    await assert.rejects(reader.get("art_corrupt"), /damaged/);
  });

  it("keeps the target but clears stale commit metadata on a new revision", async () => {
    const store = new ArtifactStore(
      "artifacts",
      new MemoryFileSystem(),
      () => 10,
      () => "art_committed",
    );
    const first = await store.upsert(
      {
        taskId: "task_a",
        kind: "report",
        title: "Report",
        body: { type: "markdown", markdown: "v1" },
      },
      "native",
    );
    first.writeback = {
      state: "committed",
      target: "zotero_note",
      targetRef: "1:NOTE",
      revision: 1,
      committedAt: 9,
    };
    await store.save(first);
    const revised = await store.upsert(
      {
        id: first.id,
        taskId: "task_a",
        kind: "report",
        title: "Report",
        body: { type: "markdown", markdown: "v2" },
      },
      "codex",
    );
    assert.deepEqual(revised.writeback, {
      state: "none",
      target: "zotero_note",
      targetRef: "1:NOTE",
    });
  });

  it("does not lose an in-flight revision when writeback metadata merges", async () => {
    const fs = new BlockingFileSystem();
    let now = 10;
    const store = new ArtifactStore(
      "artifacts",
      fs,
      () => now++,
      () => "art_race",
    );
    const first = await store.upsert(
      {
        taskId: "task_a",
        kind: "report",
        title: "Report",
        body: { type: "markdown", markdown: "v1" },
      },
      "native",
    );
    const gate = fs.blockNextWrite();
    const revisionWrite = store.upsert(
      {
        id: first.id,
        taskId: "task_a",
        kind: "report",
        title: "Report",
        body: { type: "markdown", markdown: "v2" },
      },
      "codex",
    );
    await gate.started;
    const metadataWrite = store.update(first.id, (latest) => ({
      ...latest,
      status: latest.revision === 1 ? "committed" : latest.status,
      writeback: {
        state: "committed",
        target: "zotero_note",
        targetRef: "1:NOTE",
        revision: 1,
        committedAt: 20,
      },
      updatedAt: 20,
    }));
    gate.release();
    await Promise.all([revisionWrite, metadataWrite]);

    const final = await store.get(first.id);
    assert.equal(final?.revision, 2);
    assert.deepEqual(
      final?.revisions.map((entry) => entry.revision),
      [1, 2],
    );
    assert.equal(final?.status, "ready");
    assert.equal(final?.writeback?.revision, 1);
  });
});

describe("artifact_upsert contract", () => {
  it("identifies missing text quotes in the advertised annotation schema before preparing a write", async () => {
    const store = new ArtifactStore("artifacts", new MemoryFileSystem());
    const provider = new ArtifactToolProvider(store, "task", "native", [], () =>
      assert.fail("must not save"),
    );
    const args = {
      kind: "annotation_set",
      title: "Marks",
      body: {
        type: "annotation_set",
        item: { libraryID: 1, key: "PAPER" },
        annotations: [{ type: "highlight", page: 2, comment: "explanation" }],
      },
    };
    const context: ToolExecutionContext = {};
    const invalid = await provider.prepare("artifact_upsert", args, context);
    assert.equal(invalid?.effect, "none");
    assert.match(invalid?.message || "", /annotations\[0\]\.quote/);
    assert.doesNotMatch(
      invalid?.message || "",
      /markdown=|\.claims|\.nodes|\.operations/,
    );
    assert.equal(context.preparedOperation, undefined);
    assert.equal("id" in args, false);
  });
  it("rejects unresolved citation markers atomically and preserves citations in later patches", async () => {
    const store = new ArtifactStore("artifacts", new MemoryFileSystem());
    const provider = new ArtifactToolProvider(
      store,
      "task",
      "native",
      [],
      () => {},
    );
    const input = {
      kind: "report",
      title: "Cited",
      body: { type: "markdown", markdown: "摘要 [cite:e1]" },
    };
    const failed = await provider.call(
      "artifact_upsert",
      structuredClone(input),
    );
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.message, /e1/);
    const citation = {
      id: "e1",
      itemLibraryID: 1,
      itemKey: "PAPER",
      attachmentKey: "PDF",
      annotationKey: "MARK",
      page: 3,
      title: "Paper",
      quote: "source",
    };
    assert.equal(
      (
        await provider.call("artifact_upsert", {
          ...structuredClone(input),
          citations: [citation, citation],
        })
      ).ok,
      false,
    );
    const saved = await provider.call("artifact_upsert", {
      ...structuredClone(input),
      citations: [citation],
    });
    assert(saved.ok);
    const record = (
      saved.data as { artifact: import("@confucius/protocol").ArtifactRecord }
    ).artifact;
    const patched = await provider.call("artifact_patch", {
      id: record.id,
      expectedRevision: 1,
      edits: [{ oldText: "摘要", newText: "修正摘要" }],
    });
    assert(patched.ok);
    assert.deepEqual((await store.get(record.id))?.citations, [citation]);
    const broken = await provider.call("artifact_patch", {
      id: record.id,
      expectedRevision: 2,
      citations: [],
    });
    assert.equal(broken.ok, false);
    assert.equal((await store.get(record.id))?.revision, 2);
  });
  it("advertises host-assigned creation and current-task revision without a taskId argument", () => {
    const properties = ARTIFACT_UPSERT_DEFINITION.inputSchema.properties;
    assert.equal(properties.taskId, undefined);
    assert.match(
      (properties.id as { description: string }).description,
      /omit id/i,
    );
    assert.match(
      ARTIFACT_UPSERT_DEFINITION.description,
      /returned.*this task/i,
    );
  });

  it("identifies a foreign artifact id as an argument error regardless of taskId", async () => {
    const store = new ArtifactStore("artifacts", new MemoryFileSystem());
    const foreign = await store.upsert(
      {
        id: "paper-deep-read",
        taskId: "previous-task",
        kind: "deep_read",
        title: "Previous report",
        body: { type: "markdown", markdown: "Keep this report" },
      },
      "native",
    );
    const provider = new ArtifactToolProvider(
      store,
      "current-task",
      "native",
      [],
      () => assert.fail("A foreign artifact must never be saved"),
    );
    for (const taskId of ["current-task", undefined, "previous-task"]) {
      const args = {
        id: foreign.id,
        ...(taskId === undefined ? {} : { taskId }),
        kind: "deep_read",
        title: "New report",
        body: { type: "markdown", markdown: "New research" },
      };
      const context: ToolExecutionContext = {};
      const result = await provider.prepare("artifact_upsert", args, context);
      assert.equal(result?.code, "invalid_args");
      assert.equal(result?.effect, "none");
      assert.equal(result?.retryable, false);
      assert.match(result?.message ?? "", /omit id/i);
      assert.match(result?.message ?? "", /taskId.*approval.*cannot/i);
      assert.equal(context.preparedOperation, undefined);
      assert.deepEqual(await store.get(foreign.id), foreign);
    }
  });

  it("creates independent same-title reports and ignores a legacy caller's taskId", async () => {
    const store = new ArtifactStore("artifacts", new MemoryFileSystem());
    const saved = [];
    for (const taskId of ["first-task", "second-task"]) {
      const provider = new ArtifactToolProvider(
        store,
        taskId,
        "native",
        [],
        () => {},
      );
      const result = await provider.call("artifact_upsert", {
        taskId: "a-model-supplied-task",
        kind: "report",
        title: "Same paper report",
        body: { type: "markdown", markdown: "Same evidence" },
      });
      assert.equal(result.ok, true);
      const { artifact } = result.data as {
        artifact: { id: string; taskId: string; revision: number };
      };
      assert.equal(artifact.taskId, taskId);
      assert.equal(artifact.revision, 1);
      saved.push(artifact.id);
    }
    assert.equal(new Set(saved).size, 2);
    assert.equal((await store.get(saved[0]))?.taskId, "first-task");
    assert.equal((await store.get(saved[1]))?.taskId, "second-task");
  });

  it("recovers a colliding report id without approval, retains the other task, and replays only the saved revision", async () => {
    const fs = new MemoryFileSystem();
    let nextId = 0;
    const store = new ArtifactStore(
      "artifacts",
      fs,
      () => 100,
      () => `art_${++nextId}`,
    );
    const body = {
      type: "markdown" as const,
      markdown: "A cited research report",
    };
    const otherTask = await store.upsert(
      {
        id: "paper-deep-read",
        taskId: "other-task",
        kind: "report",
        title: "Previous",
        body,
      },
      "native",
    );
    const execution = new ToolExecutionService(memoryJsonStorage());
    const provider = new ArtifactToolProvider(
      store,
      "task",
      "native",
      [],
      () => {},
    );
    const createArgs = { kind: "report", title: "Report", body };
    const createCall = {
      id: "create",
      name: "artifact_upsert",
      args: createArgs,
    };
    const reviseCall = {
      id: "revise",
      name: "artifact_upsert",
      args: {
        ...createArgs,
        id: "art_1",
        body: { type: "markdown", markdown: "Reviewed report" },
      },
    };
    const harness = createHarness({
      toolProvider: execution.wrap(provider),
      modeFor: () => "auto_allow",
      resolve: () =>
        assert.fail("Saving a task artifact needs no Zotero write approval"),
      script: [
        {
          toolCalls: [
            {
              id: "collision",
              name: "artifact_upsert",
              args: { ...createArgs, id: otherTask.id, taskId: "task" },
            },
          ],
        },
        { toolCalls: [createCall] },
        { toolCalls: [reviseCall] },
        { text: "已保存报告" },
      ],
    });
    const result = await harness.loop.run({
      session: session("task"),
      turnId: "turn",
      userText: "保存报告",
    });
    assert.equal(result.phase, "done");
    const results = harness.events.events
      .filter((e) => e.type === "tool_result")
      .map((e) => e.payload.result);
    assert.equal(results.length, 3);
    assert.equal(!results[0].ok && results[0].code, "invalid_args");
    assert.equal(results[1].ok, true);
    assert.equal(results[2].ok, true);
    assert(!harness.events.types().includes("approval_required"));
    assert.deepEqual(await store.get(otherTask.id), otherTask);
    assert.equal((await store.get("art_1"))?.taskId, "task");
    assert.equal((await store.get("art_1"))?.revision, 2);
    assert.equal(fs.files.size, 2);
    assert.deepEqual(
      (await execution.listOperations({ taskId: "task" })).map(
        (op) => op.args.id,
      ),
      ["art_1", "art_1"],
    );

    const resumed = createHarness({
      toolProvider: execution.wrap(provider),
      script: [{ toolCalls: [createCall, reviseCall] }, { text: "完成" }],
    });
    await resumed.loop.run({
      session: session("task"),
      turnId: "resume",
      userText: "继续",
      resume: harness.checkpoints.latest("turn")!,
    });
    assert.equal((await store.get("art_1"))?.revision, 2);
    assert.equal(fs.files.size, 2);
    assert.deepEqual(await store.get(otherTask.id), otherTask);
  });

  it("saves a deep read draft and requires fresh same-source evidence and comments before ready, including after recreation", async () => {
    const store = new ArtifactStore(
      "artifacts",
      new MemoryFileSystem(),
      () => 100,
      () => "review",
    );
    const execution = {
      runId: "run",
      intentRevision: 1,
      sourceFingerprint: "source",
    };
    const events: ConfuciusEvent[] = [];
    const provider = () =>
      new ArtifactToolProvider(
        store,
        "task",
        "native",
        ["item:1:PAPER"],
        (artifact) =>
          events.push({
            id: `saved-${artifact.revision}`,
            sessionId: "task",
            turnId: "turn",
            ts: 1000,
            type: "artifact_upserted",
            payload: { artifact },
          }),
        () => execution,
        (artifact) => deepReadReviewState(artifact, execution, events),
        (artifact) => deepReadReviewNextAction(artifact, execution, events),
      );
    const save = () => ({
      id: "review",
      kind: "deep_read",
      title: "报告",
      status: "ready",
      body: { type: "markdown", markdown: "A result to check" },
    });
    const initial = await provider().call("artifact_upsert", save());
    assert.equal(initial.ok, true);
    assert.equal((await store.get("review"))?.status, "draft");
    const read = (
      toolName: string,
      ts: number,
      key = "PAPER",
      ok = true,
    ): ConfuciusEvent => ({
      id: `${toolName}-${ts}-${key}`,
      sessionId: "task",
      turnId: "turn",
      ts,
      type: "tool_result",
      payload: {
        callId: "call",
        result: ok
          ? {
              ok: true,
              toolName,
              data: {
                libraryID: 1,
                key: toolName === "get_annotations" ? "PDF" : key,
                attachmentKey: key === "PAPER" ? "PDF" : "OTHERPDF",
                pages: [{ page: 2, text: "Source evidence" }],
                annotations: [],
              },
            }
          : {
              ok: false,
              toolName,
              code: "unavailable",
              message: "No evidence",
            },
      },
    });
    events.unshift(read("get_pages", 90), read("get_annotations", 90));
    events.push(
      read("get_pages", 110, "OTHER"),
      read("get_pages", 120, "PAPER", false),
    );
    assert.equal((await provider().call("artifact_upsert", save())).ok, false);
    assert.equal((await store.get("review"))?.revision, 1);
    events.push(read("get_pages", 130));
    const missingComments = await provider().call("artifact_upsert", save());
    assert.equal(missingComments.ok, false);
    if (!missingComments.ok) {
      assert.match(missingComments.message, /draft revision 1/);
      assert.match(
        missingComments.message,
        /missing successful get_annotations/,
      );
      assert.match(
        missingComments.message,
        /source-page read is already satisfied/,
      );
    }
    events.push(read("get_annotations", 140));
    // Saving a corrected draft is a new revision; the error must identify the
    // missing step for that revision instead of sending the model into a loop
    // of page reads or comment writes that cannot satisfy get_annotations.
    assert.equal(
      (
        await provider().call("artifact_upsert", {
          ...save(),
          status: "draft",
          body: { type: "markdown", markdown: "Corrected draft" },
        })
      ).ok,
      true,
    );
    const missingBoth = await provider().call("artifact_upsert", save());
    assert.equal(missingBoth.ok, false);
    if (!missingBoth.ok)
      assert.match(
        missingBoth.message,
        /draft revision 2: missing successful get_pages and get_annotations/,
      );
    events.push(read("get_pages", 150));
    const missingLatestComments = await provider().call(
      "artifact_upsert",
      save(),
    );
    assert.equal(missingLatestComments.ok, false);
    if (!missingLatestComments.ok) {
      assert.match(missingLatestComments.message, /draft revision 2/);
      assert.match(
        missingLatestComments.message,
        /missing successful get_annotations/,
      );
      assert.match(
        missingLatestComments.message,
        /Updating a comment does not replace/,
      );
    }
    events.push(read("get_annotations", 160));
    assert.equal((await provider().call("artifact_upsert", save())).ok, true);
    assert.equal((await store.get("review"))?.status, "ready");
    assert.equal(
      deepReadReviewState(
        await store.get("review"),
        { ...execution, runId: "next" },
        events,
      ),
      "draft_required",
    );
  });

  it("preserves a saved artifact when its UI callback fails and detects an intervening revision", async () => {
    const fs = new MemoryFileSystem();
    const store = new ArtifactStore(
      "artifacts",
      fs,
      () => 1,
      () => "stable_artifact",
    );
    const provider = new ArtifactToolProvider(
      store,
      "task",
      "native",
      [],
      () => {
        throw new Error("View unavailable");
      },
    );
    const context: ToolExecutionContext = {};
    const args = {
      kind: "report",
      title: "Report",
      body: { type: "markdown", markdown: "Original evidence" },
    };
    assert.equal(
      await provider.prepare("artifact_upsert", args, context),
      null,
    );
    const first = await provider.call(
      "artifact_upsert",
      args,
      undefined,
      context,
    );
    assert.equal(first.ok, true);
    assert.equal(first.effect, "applied");
    assert.match(first.warnings?.join(" ") ?? "", /saved.*view/i);
    assert.equal((await store.get("stable_artifact"))?.revision, 1);
    const update = {
      ...args,
      body: { type: "markdown", markdown: "Agent revision" },
    };
    const planned: ToolExecutionContext = {};
    await provider.prepare("artifact_upsert", update, planned);
    await store.upsert(
      {
        id: "stable_artifact",
        taskId: "task",
        kind: "report",
        title: "Report",
        body: { type: "markdown", markdown: "Human revision" },
      },
      "native",
    );
    const stale = await provider.call(
      "artifact_upsert",
      update,
      undefined,
      planned,
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.effect, "none");
    assert.deepEqual((await store.get("stable_artifact"))?.body, {
      type: "markdown",
      markdown: "Human revision",
    });
  });
  it("advertises every typed body and the non-obvious markdown mapping", () => {
    const body = ARTIFACT_UPSERT_DEFINITION.inputSchema.properties.body as {
      oneOf?: Array<Record<string, unknown>>;
    };
    assert.equal(body.oneOf?.length, 7);
    assert.deepEqual(
      (
        (body.oneOf?.[0].properties as Record<string, unknown>).type as Record<
          string,
          unknown
        >
      ).enum,
      ["markdown"],
    );
    assert.match(ARTIFACT_UPSERT_DEFINITION.description, /deep_read/);
    assert.match(
      ARTIFACT_UPSERT_DEFINITION.description,
      /Do not call this for an ordinary reply/,
    );
    assert.doesNotMatch(
      ARTIFACT_UPSERT_DEFINITION.description,
      /before finishing/,
    );
    assert.equal(
      artifactBodyShapeHint("deep_read"),
      '{"type":"markdown","markdown":"..."}',
    );
  });

  it("returns an actionable body hint instead of a generic mismatch", async () => {
    const provider = new ArtifactToolProvider(
      new ArtifactStore(
        "artifacts",
        new MemoryFileSystem(),
        () => 1,
        () => "art_hint",
      ),
      "task_a",
      "native",
      [],
      () => {},
    );
    const result = await provider.call("artifact_upsert", {
      kind: "deep_read",
      title: "Bad deep read",
      body: { type: "deep_read", markdown: "wrong discriminator" },
    });
    assert.equal(result.ok, false);
    assert.match(
      String(result.message),
      /Expected \{"type":"markdown","markdown":"\.\.\."\}/,
    );
    assert.match(String(result.message), /type="deep_read"/);
  });

  it("accepts a JSON-encoded nested body from compatible runtimes", async () => {
    const fs = new MemoryFileSystem();
    const provider = new ArtifactToolProvider(
      new ArtifactStore(
        "artifacts",
        fs,
        () => 1,
        () => "art_encoded",
      ),
      "task_a",
      "native",
      [],
      () => {},
    );
    const encoded = JSON.stringify({
      type: "markdown",
      markdown: "# Deep read\n\nEvidence.",
    });
    assert.deepEqual(normalizeArtifactBodyArgument(encoded), {
      type: "markdown",
      markdown: "# Deep read\n\nEvidence.",
    });

    const result = await provider.call("artifact_upsert", {
      kind: "deep_read",
      title: "Deep read",
      body: encoded,
    });
    assert.equal(result.ok, true);
    assert.equal(fs.files.size, 1);
  });

  it("normalizes MiniMax item-wrapped nested arrays", async () => {
    const fs = new MemoryFileSystem();
    const provider = new ArtifactToolProvider(
      new ArtifactStore(
        "artifacts",
        fs,
        () => 1,
        () => "art_minimax_audit",
      ),
      "task_a",
      "native",
      [],
      () => {},
    );
    const wrapped = {
      type: "evidence_audit",
      claims: {
        item: [
          {
            claim: "Reader annotations are visible",
            evidence: "The PDF contains a grounded highlight.",
            verdict: "supported",
            risk: "Requires visual confirmation.",
            citationIds: { item: ["cite-1"] },
          },
        ],
      },
    };
    assert.deepEqual(normalizeArtifactBodyArgument(wrapped), {
      type: "evidence_audit",
      claims: [
        {
          claim: "Reader annotations are visible",
          evidence: "The PDF contains a grounded highlight.",
          verdict: "supported",
          risk: "Requires visual confirmation.",
          citationIds: ["cite-1"],
        },
      ],
    });

    const result = await provider.call("artifact_upsert", {
      kind: "evidence_audit",
      title: "Audit",
      body: wrapped,
      citations: [
        {
          id: "cite-1",
          itemLibraryID: 1,
          itemKey: "ITEM",
        },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(fs.files.size, 1);
  });

  it("normalizes MiniMax numeric strings in annotation artifacts", async () => {
    const fs = new MemoryFileSystem();
    const provider = new ArtifactToolProvider(
      new ArtifactStore(
        "artifacts",
        fs,
        () => 1,
        () => "art_minimax_annotations",
      ),
      "task_a",
      "native",
      [],
      () => {},
    );
    const encoded = {
      type: "annotation_set",
      item: { libraryID: "1", key: "ITEM" },
      annotations: [
        {
          type: "highlight",
          page: "3",
          quote: "Grounded conclusion",
          color: "#ffd400",
        },
        {
          type: "image",
          page: "2",
          rect: ["100", "125.5", "300", "250"],
          comment: "Figure evidence",
          color: "#a28ae5",
        },
      ],
      legend: [
        {
          type: "highlight",
          color: "#ffd400",
          meaning: "Core conclusion",
        },
      ],
    };
    assert.deepEqual(normalizeArtifactBodyArgument(encoded), {
      type: "annotation_set",
      item: { libraryID: 1, key: "ITEM" },
      annotations: [
        {
          type: "highlight",
          page: 3,
          quote: "Grounded conclusion",
          color: "#ffd400",
        },
        {
          type: "image",
          page: 2,
          rect: [100, 125.5, 300, 250],
          comment: "Figure evidence",
          color: "#a28ae5",
        },
      ],
      legend: [
        {
          type: "highlight",
          color: "#ffd400",
          meaning: "Core conclusion",
        },
      ],
    });

    const result = await provider.call("artifact_upsert", {
      kind: "annotation_set",
      title: "Annotations",
      body: encoded,
    });
    assert.equal(result.ok, true);
    assert.equal(fs.files.size, 1);
  });
});
