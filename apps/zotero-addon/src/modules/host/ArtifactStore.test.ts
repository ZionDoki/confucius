import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArtifactStore, type ArtifactFileSystem } from "./ArtifactStore";
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
    assert.equal(await reader.get("art_corrupt"), null);
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
      /Do not call this just to finish a turn/,
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
});
