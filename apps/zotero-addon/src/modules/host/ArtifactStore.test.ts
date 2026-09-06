import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArtifactStore, type ArtifactFileSystem } from "./ArtifactStore";
import {
  createHarness,
  session,
} from "../../../../../packages/harness/src/test-kit";
import { ToolExecutionService } from "./ReliableToolProvider";
import { memoryJsonStorage } from "./RuntimeStorage";
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
