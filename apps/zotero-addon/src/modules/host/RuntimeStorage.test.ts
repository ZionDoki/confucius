import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { posix, win32 } from "node:path";
import { createHash } from "node:crypto";
import {
  migrateRuntimeStorage,
  clearMigratedContextCopies,
  ResourceLocks,
  writeRuntimeText,
  runtimeIoPath,
  runtimeLogicalPath,
  type AtomicWriter,
  type MigrationFs,
} from "./RuntimeStorage";
import { createExecutionScope } from "./ExecutionScope";
import { HistoryStore, type MemoryFileSystem } from "@confucius/memory";
import {
  migrateSessionRecord,
  type ResearchTaskRecord,
  type ConfuciusEvent,
} from "@confucius/protocol";
import { ArtifactStore } from "./ArtifactStore";

describe("Windows IO paths", () => {
  it("preserves logical file identity while supporting long drive and UNC paths", () => {
    for (const path of [
      String.raw`C:\profile\${"long".repeat(80)}.txt`,
      String.raw`\\server\share\history\body.txt`,
    ]) {
      const io = runtimeIoPath(path);
      assert.ok(io.startsWith("\\\\?\\"));
      assert.equal(runtimeIoPath(io), io);
      assert.equal(runtimeLogicalPath(io), path);
    }
    assert.equal(
      runtimeIoPath("/home/profile/history"),
      "/home/profile/history",
    );
    assert.equal(
      runtimeIoPath("C:/profile/history"),
      String.raw`\\?\C:\profile\history`,
    );
  });
});

describe("resource wait cancellation", () => {
  it("expires a queued waiter without letting later work overtake its predecessor", async () => {
    const locks = new ResourceLocks();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starts: string[] = [];
    const first = locks.run(["item"], async () => {
      starts.push("first");
      await gate;
    });
    const scope = createExecutionScope({ timeoutMs: 10 });
    await assert.rejects(
      locks.run(
        ["item"],
        async () => {
          starts.push("expired");
        },
        scope,
      ),
      /timed out/,
    );
    scope.dispose();
    const last = locks.run(["item"], async () => {
      starts.push("last");
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(starts, ["first"]);
    release();
    await Promise.all([first, last]);
    assert.deepEqual(starts, ["first", "last"]);
  });
});

describe("atomic runtime writes", () => {
  it("retries sharing violations five times with bounded backoff and unique temporary files", async () => {
    const waits: number[] = [],
      temps: string[] = [];
    let attempts = 0;
    const fs: AtomicWriter = {
      mkdir: async () => {},
      parent: posix.dirname,
      wait: async (ms) => {
        waits.push(ms);
      },
      write: async (_path, _body, temp) => {
        temps.push(temp);
        if (++attempts < 5) throw new Error("NS_ERROR_FILE_ACCESS_DENIED");
      },
    };
    await writeRuntimeText("/runtime/index.json", "body", fs);
    assert.equal(attempts, 5);
    [100, 250, 500, 1000].forEach((expected, i) =>
      assert.ok(waits[i] >= expected * 0.9 && waits[i] <= expected * 1.1),
    );
    const first = temps[0];
    await writeRuntimeText("/runtime/index.json", "next", fs);
    assert.notEqual(temps.at(-1), first);
  });
  it("does not retry disk-full errors and serializes writes to the same path", async () => {
    let attempts = 0,
      active = 0,
      maximum = 0;
    const fs: AtomicWriter = {
      mkdir: async () => {},
      parent: posix.dirname,
      wait: async () => {},
      write: async () => {
        attempts++;
        throw new Error("ENOSPC");
      },
    };
    await assert.rejects(
      writeRuntimeText("/runtime/state.json", "body", fs),
      /ENOSPC/,
    );
    assert.equal(attempts, 1);
    fs.write = async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    };
    await Promise.all([
      writeRuntimeText("/runtime/state.json", "a", fs),
      writeRuntimeText("/runtime/state.json", "b", fs),
    ]);
    assert.equal(maximum, 1);
  });
  it("stops after repeated permission denial and succeeds after permissions recover", async () => {
    let locked = true,
      attempts = 0;
    const fs: AtomicWriter = {
      mkdir: async () => {},
      parent: posix.dirname,
      wait: async () => {},
      write: async () => {
        attempts++;
        if (locked) throw new Error("EACCES");
      },
    };
    await assert.rejects(
      writeRuntimeText("/runtime/state.json", "body", fs),
      /EACCES/,
    );
    assert.equal(attempts, 5);
    locked = false;
    await writeRuntimeText("/runtime/state.json", "body", fs);
  });
});
function migrationFixture(windows = false) {
  const paths = windows ? win32 : posix;
  const source = windows ? "D:\\wps云盘\\docs\\confucius" : "/synced/confucius";
  const destination = windows
    ? "C:\\Users\\test\\Local\\confucius\\runtime-v1"
    : "/local/confucius/runtime-v1";
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  let copies = 0;
  let failAt = 0;
  const mkdir = (path: string) => {
    dirs.add(path);
    const parent = paths.dirname(path);
    if (parent !== path) mkdir(parent);
  };
  const put = (path: string, value: string) => {
    mkdir(paths.dirname(path));
    files.set(path, value);
  };
  const fs: MigrationFs = {
    join: (base, ...parts) => {
      assert.ok(
        paths.isAbsolute(base),
        "PathUtils.join requires an absolute base",
      );
      return paths.join(base, ...parts);
    },
    basename: paths.basename,
    exists: async (path) => files.has(path) || dirs.has(path),
    directory: async (path) => dirs.has(path),
    children: async (path) => [
      ...new Set(
        [...dirs, ...files.keys()].filter(
          (child) => child !== path && paths.dirname(child) === path,
        ),
      ),
    ],
    mkdir: async (path) => {
      mkdir(path);
    },
    read: async (path) => {
      if (!files.has(path)) throw new Error("missing file");
      return files.get(path)!;
    },
    write: async (path, text) => {
      put(path, text);
    },
    copy: async (from, to) => {
      if (++copies === failAt) throw new Error("interrupted copy");
      put(to, files.get(from)!);
    },
    digest: async (path) =>
      createHash("sha256").update(files.get(path)!).digest("hex"),
    remove: async (path) => {
      files.delete(path);
    },
  };
  put(
    paths.join(source, "state.json"),
    JSON.stringify({ tasks: [], schemaVersion: 3 }),
  );
  put(
    paths.join(source, "history", "task", "index.json"),
    JSON.stringify({
      version: 1,
      items: [{ windowId: "window", itemId: "message" }],
      windows: [{ id: "window" }],
      notes: [{ name: "working", revision: 1 }],
    }),
  );
  put(
    paths.join(source, "history", "task", "windows", "window", "message.txt"),
    "original conversation",
  );
  put(
    paths.join(source, "history", "task", "notes", "working_1.txt"),
    "working notes",
  );
  put(paths.join(source, "memory", "user.md"), "user knowledge remains here");
  return {
    fs,
    source,
    destination,
    paths,
    files,
    fail: (count: number) => {
      failAt = count;
    },
  };
}

function recoveredState(f: ReturnType<typeof migrationFixture>) {
  return JSON.parse(
    f.files.get(f.paths.join(f.destination, "state.json"))!,
  ) as {
    tasks: Array<{
      record: ResearchTaskRecord;
      events: ConfuciusEvent[];
      messages: unknown[];
      sessionGrants: string[];
    }>;
  };
}

function recoveredHistory(f: ReturnType<typeof migrationFixture>) {
  const native = (path: string) =>
    f.paths.normalize(path).replace(/[\\/]+$/, "");
  const fs: MemoryFileSystem = {
    readFile: (path) => f.fs.read(native(path)),
    writeFile: (path, text) => f.fs.write(native(path), text),
    deleteFile: (path) => f.fs.remove!(native(path)),
    listFiles: async (path) =>
      (await f.fs.children(native(path))).map((child) =>
        child.replace(/\\/g, "/"),
      ),
    makeDirectory: (path) => f.fs.mkdir(native(path)),
  };
  const history = new HistoryStore(fs, f.paths.join(f.destination, "history"));
  for (const { record } of recoveredState(f).tasks) history.register(record);
  return history;
}

describe("recoverable migration", () => {
  for (const windows of [false, true]) {
    const platform = windows ? "Windows" : "POSIX";
    it(`accepts empty history directories left by cleanup in a new profile (${platform})`, async () => {
      const f = migrationFixture(windows);
      await migrateRuntimeStorage(f.source, f.destination, f.fs);
      await clearMigratedContextCopies(f.destination, f.fs);
      assert.ok(
        (await f.fs.children(f.paths.join(f.source, "history"))).length,
        "cleanup leaves the old directory tree behind",
      );
      const before = new Map(f.files);
      const destination = `${f.destination}-new-profile`;

      await migrateRuntimeStorage(f.source, destination, f.fs);

      const manifestPath = f.paths.join(destination, "migration.json");
      const manifest = JSON.parse(f.files.get(manifestPath)!);
      assert.equal(manifest.state, "active");
      assert.deepEqual(manifest.files, {});
      assert.deepEqual(
        new Map([...f.files].filter(([path]) => path !== manifestPath)),
        before,
        "starting a new profile preserves the source and previous profile",
      );
      await migrateRuntimeStorage(f.source, destination, f.fs);
    });

    it(`ignores abandoned temporary files when checking for saved history (${platform})`, async () => {
      const f = migrationFixture(windows);
      await migrateRuntimeStorage(f.source, f.destination, f.fs);
      await clearMigratedContextCopies(f.destination, f.fs);
      const temporary = f.paths.join(
        f.source,
        "history",
        "task",
        "index.json.interrupted.tmp",
      );
      await f.fs.write(temporary, "incomplete write");
      const destination = `${f.destination}-new-profile`;

      await migrateRuntimeStorage(f.source, destination, f.fs);

      assert.equal(
        JSON.parse(f.files.get(f.paths.join(destination, "migration.json"))!)
          .state,
        "active",
      );
      assert.equal(f.files.get(temporary), "incomplete write");
      assert.equal(
        f.files.has(
          f.paths.join(
            destination,
            "history",
            "task",
            f.paths.basename(temporary),
          ),
        ),
        false,
      );
    });

    it(`automatically recovers orphaned history indexes and deeply nested bodies (${platform})`, async () => {
      for (const relative of [
        ["index.json"],
        ["windows", "window", "message.txt"],
        ["notes", "working_1.txt"],
      ]) {
        const f = migrationFixture(windows);
        const retained = f.paths.join(f.source, "history", "task", ...relative);
        for (const path of f.files.keys())
          if (path !== retained && !path.includes("memory"))
            f.files.delete(path);
        const before = new Map(f.files);

        await migrateRuntimeStorage(f.source, f.destination, f.fs);

        for (const [path, body] of before)
          assert.equal(f.files.get(path), body);
        const { tasks } = recoveredState(f);
        assert.deepEqual(
          tasks.map((task) => task.record.id),
          ["task"],
        );
        const exported = await recoveredHistory(f).exportTask("task");
        assert.deepEqual(exported.issues, []);
        if (relative[0] === "windows")
          assert.equal(exported.items[0].content, "original conversation");
        if (relative[0] === "notes")
          assert.equal(exported.notes[0].content, "working notes");
        const backup = f.paths.join(
          f.destination,
          "recovery",
          "missing-task-index",
          "source",
          "history",
          "task",
          ...relative,
        );
        assert.equal(f.files.get(backup), before.get(retained));
        await clearMigratedContextCopies(f.destination, f.fs);
        for (const [path, body] of before)
          assert.equal(f.files.get(path), body);
      }
    });
  }

  it("restores titles, drafts, conversation and reports without replaying old authority", async () => {
    const f = migrationFixture();
    f.files.delete(f.paths.join(f.source, "state.json"));
    const saved = migrateSessionRecord({
      id: "task",
      title: "原来的研究",
      createdAt: 10,
      updatedAt: 20,
      mode: "agent",
      context: {},
      permissionMode: "auto_allow",
    });
    saved.draft = { text: "未发送的草稿", references: [] };
    await f.fs.write(
      f.paths.join(f.source, "state.json.pre-v4-backup"),
      JSON.stringify({
        tasks: [
          {
            record: saved,
            sessionGrants: ["all"],
            events: [
              {
                id: "old_request",
                sessionId: "task",
                turnId: "old_turn",
                ts: 11,
                type: "tool_requested",
                payload: { toolName: "delete_item", args: {} },
              },
            ],
          },
        ],
      }),
    );
    const root = f.paths.join(f.source, "history", "task");
    await f.fs.write(
      f.paths.join(root, "windows", "window", "user_turn.txt"),
      "研究这个问题",
    );
    await f.fs.write(
      f.paths.join(root, "windows", "window", "answer_turn.txt"),
      "已保存的完整回答",
    );
    const artifacts = new ArtifactStore(
      f.paths.join(f.source, "artifacts"),
      {
        read: f.fs.read,
        exists: f.fs.exists,
        makeDirectory: f.fs.mkdir,
        writeAtomic: f.fs.write,
      },
      () => 20,
      () => "art_saved",
    );
    await artifacts.upsert(
      {
        taskId: "task",
        kind: "report",
        title: "原始报告",
        body: { type: "markdown", markdown: "完整报告正文" },
      },
      "native",
    );
    const before = new Map(f.files);

    await migrateRuntimeStorage(f.source, f.destination, f.fs);

    const task = recoveredState(f).tasks[0];
    assert.equal(task.record.title, saved.title);
    assert.equal(task.record.draft?.text, saved.draft.text);
    assert.equal(task.record.permissionMode, "ask");
    assert.equal(task.record.run, undefined);
    assert.equal(task.record.recoverableTurn, undefined);
    assert.deepEqual(task.sessionGrants, []);
    assert.deepEqual(task.messages, []);
    assert.deepEqual(task.record.artifactIds, ["art_saved"]);
    assert.ok(
      task.events.some(
        (event) =>
          event.type === "turn_started" &&
          event.payload.userText === "研究这个问题",
      ),
    );
    assert.ok(
      task.events.some(
        (event) =>
          event.type === "text_delta" &&
          event.payload.text === "已保存的完整回答",
      ),
    );
    assert.ok(task.events.every((event) => event.type !== "tool_requested"));
    const exported = await recoveredHistory(f).exportTask("task");
    assert.deepEqual(exported.issues, []);
    assert.equal(exported.notes[0].content, "working notes");
    for (const [path, body] of before) assert.equal(f.files.get(path), body);
    const snapshot = new Map(f.files);
    await migrateRuntimeStorage(f.source, f.destination, f.fs);
    assert.deepEqual(f.files, snapshot);
  });

  it("recovers damaged per-task indexes and skips missing bodies without blocking healthy tasks", async () => {
    const f = migrationFixture();
    f.files.delete(f.paths.join(f.source, "state.json"));
    await f.fs.write(
      f.paths.join(f.source, "history", "broken", "index.json"),
      "{broken",
    );
    await f.fs.write(
      f.paths.join(
        f.source,
        "history",
        "broken",
        "windows",
        "window",
        "answer_old.txt",
      ),
      "仍然存在的回答",
    );
    f.files.delete(
      f.paths.join(f.source, "history", "task", "notes", "working_1.txt"),
    );

    await migrateRuntimeStorage(f.source, f.destination, f.fs);

    assert.deepEqual(
      recoveredState(f).tasks.map((task) => task.record.id),
      ["broken", "task"],
    );
    const history = recoveredHistory(f);
    assert.deepEqual((await history.exportTask("task")).issues, []);
    const broken = await history.exportTask("broken");
    assert.deepEqual(broken.issues, []);
    assert.equal(broken.items[0].content, "仍然存在的回答");
    assert.equal(
      f.files.get(f.paths.join(f.source, "history", "broken", "index.json")),
      "{broken",
    );
    assert.equal(
      f.files.get(
        f.paths.join(
          f.destination,
          "recovery",
          "missing-task-index",
          "source",
          "history",
          "broken",
          "index.json",
        ),
      ),
      "{broken",
    );
  });

  it("keeps newer local tasks and their history when old library copies collide", async () => {
    const f = migrationFixture();
    f.files.delete(f.paths.join(f.source, "state.json"));
    const record = migrateSessionRecord({
      id: "task",
      title: "newer title",
      createdAt: 10,
      updatedAt: 50,
      mode: "agent",
      context: {},
      permissionMode: "ask",
    });
    const current = { record, events: [], messages: [], sessionGrants: [] };
    await f.fs.write(
      f.paths.join(f.destination, "state.json"),
      JSON.stringify({ tasks: [current] }),
    );
    const indexPath = f.paths.join(
      f.destination,
      "history",
      "task",
      "index.json",
    );
    const index = JSON.stringify({
      version: 1,
      windows: [],
      items: [],
      notes: [],
    });
    await f.fs.write(indexPath, index);

    await migrateRuntimeStorage(f.source, f.destination, f.fs);

    assert.deepEqual(
      recoveredState(f).tasks,
      JSON.parse(JSON.stringify([current])),
    );
    assert.equal(f.files.get(indexPath), index);
  });

  it("rebuilds a trace-only conversation without losing the full answer behind commentary or a partial delta", async () => {
    const f = migrationFixture();
    f.files.delete(f.paths.join(f.source, "state.json"));
    const directory = f.paths.join(
      f.source,
      "history",
      "task",
      "windows",
      "window",
    );
    await f.fs.write(
      f.paths.join(directory, "trace_old.txt"),
      JSON.stringify({
        kind: "confucius-trace-events",
        events: [
          {
            id: "title",
            sessionId: "task",
            type: "session_updated",
            ts: 10,
            payload: { title: "原来的标题" },
          },
          {
            id: "start",
            sessionId: "task",
            turnId: "old",
            type: "turn_started",
            ts: 11,
            payload: { userText: "原来的问题" },
          },
          {
            id: "comment",
            sessionId: "task",
            turnId: "old",
            type: "text_delta",
            ts: 12,
            payload: { text: "正在读取", phase: "commentary" },
          },
          {
            id: "partial",
            sessionId: "task",
            turnId: "old",
            type: "text_delta",
            ts: 13,
            payload: { text: "只有前半句", phase: "final_answer" },
          },
          {
            id: "foreign",
            sessionId: "other_task",
            type: "session_updated",
            ts: 14,
            payload: { title: "不能导入其他任务" },
          },
        ],
      }),
    );
    await f.fs.write(
      f.paths.join(directory, "answer_old.txt"),
      "完整的最终回答",
    );

    await migrateRuntimeStorage(f.source, f.destination, f.fs);

    const task = recoveredState(f).tasks[0];
    assert.equal(task.record.title, "原来的标题");
    assert.ok(
      task.events.some(
        (event) =>
          event.type === "turn_started" &&
          event.payload.userText === "原来的问题",
      ),
    );
    assert.deepEqual(
      task.events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.payload.text),
      ["正在读取", "完整的最终回答"],
    );
    assert.ok(task.events.every((event) => event.sessionId === "task"));
  });

  it("respects deleted and pruned histories instead of resurrecting backup content", async () => {
    for (const deleted of [false, true]) {
      const f = migrationFixture();
      f.files.delete(f.paths.join(f.source, "state.json"));
      const indexPath = f.paths.join(f.source, "history", "task", "index.json");
      const index = JSON.parse(f.files.get(indexPath)!);
      await f.fs.write(
        indexPath,
        JSON.stringify({
          ...index,
          ...(deleted ? { deleted: true } : { prunedAt: 10 }),
        }),
      );

      await migrateRuntimeStorage(f.source, f.destination, f.fs);

      if (deleted) assert.deepEqual(recoveredState(f).tasks, []);
      else {
        const exported = await recoveredHistory(f).exportTask("task");
        assert.deepEqual(exported.items, []);
        assert.deepEqual(exported.notes, []);
      }
    }
  });

  it("resumes interrupted recovery without duplicating tasks or replacing a saved draft", async () => {
    for (const phase of ["copy", "state", "activate"]) {
      const f = migrationFixture();
      f.files.delete(f.paths.join(f.source, "state.json"));
      const before = new Map(f.files);
      const write = f.fs.write;
      f.fs.write = async (path, text) => {
        if (
          (phase === "state" &&
            path === f.paths.join(f.destination, "state.json")) ||
          (phase === "activate" &&
            path === f.paths.join(f.destination, "migration.json") &&
            JSON.parse(text).state === "active")
        )
          throw new Error("interrupted recovery");
        await write(path, text);
      };
      if (phase === "copy") f.fail(3);
      await assert.rejects(
        migrateRuntimeStorage(f.source, f.destination, f.fs),
        /interrupted/,
      );
      assert.equal(
        JSON.parse(f.files.get(f.paths.join(f.destination, "migration.json"))!)
          .state,
        "copying",
      );
      if (phase === "activate") {
        const state = recoveredState(f);
        state.tasks[0].record.draft = {
          text: "new draft after recovery",
          references: [],
        };
        await write(
          f.paths.join(f.destination, "state.json"),
          JSON.stringify(state),
        );
      }
      f.fail(0);
      f.fs.write = write;

      await migrateRuntimeStorage(f.source, f.destination, f.fs);

      const state = recoveredState(f);
      assert.deepEqual(
        state.tasks.map((entry) => entry.record.id),
        ["task"],
      );
      if (phase === "activate")
        assert.equal(
          state.tasks[0].record.draft?.text,
          "new draft after recovery",
        );
      const exported = await recoveredHistory(f).exportTask("task");
      assert.equal(
        exported.windows.filter((window) => window.id.includes("_recovered_"))
          .length,
        1,
      );
      assert.equal(exported.items[0].content, "original conversation");
      assert.equal(exported.notes[0].content, "working notes");
      for (const [path, body] of before) assert.equal(f.files.get(path), body);
    }
  });

  it("does not treat an unreadable history directory as empty, and can retry", async () => {
    const f = migrationFixture();
    await migrateRuntimeStorage(f.source, f.destination, f.fs);
    await clearMigratedContextCopies(f.destination, f.fs);
    const destination = `${f.destination}-new-profile`;
    const children = f.fs.children;
    f.fs.children = async (path) => {
      if (path === f.paths.join(f.source, "history", "task", "notes"))
        throw new Error("EACCES");
      return children(path);
    };
    const before = new Map(f.files);

    await assert.rejects(
      migrateRuntimeStorage(f.source, destination, f.fs),
      /EACCES/,
    );
    assert.deepEqual(f.files, before);

    f.fs.children = children;
    await migrateRuntimeStorage(f.source, destination, f.fs);
    assert.equal(
      JSON.parse(f.files.get(f.paths.join(destination, "migration.json"))!)
        .state,
      "active",
    );
  });

  it("bounds the empty-directory scan and rejects unsafe history paths", async () => {
    for (const unsafe of [false, true]) {
      const f = migrationFixture();
      await migrateRuntimeStorage(f.source, f.destination, f.fs);
      await clearMigratedContextCopies(f.destination, f.fs);
      const destination = `${f.destination}-new-profile`;
      if (unsafe) {
        f.fs.children = async (path) => [`${path}/..`];
      } else {
        await f.fs.mkdir(
          f.paths.join(
            f.source,
            "history",
            ...Array<string>(32).fill("nested"),
          ),
        );
      }
      const before = new Map(f.files);

      await assert.rejects(
        migrateRuntimeStorage(f.source, destination, f.fs),
        unsafe
          ? /Unsafe runtime migration path/
          : /nesting exceeds migration limit/,
      );
      assert.deepEqual(f.files, before);
    }
  });

  it("keeps all originals when a migrated body is missing or damaged", async () => {
    for (const damaged of [false, true]) {
      const f = migrationFixture();
      await migrateRuntimeStorage(f.source, f.destination, f.fs);
      const body = f.paths.join(
        f.destination,
        "history",
        "task",
        "notes",
        "working_1.txt",
      );
      if (damaged) f.files.set(body, "damaged");
      else f.files.delete(body);
      await assert.rejects(
        clearMigratedContextCopies(f.destination, f.fs),
        /originals retained/,
      );
      assert.ok(f.files.has(f.paths.join(f.source, "state.json")));
      assert.equal(
        f.files.get(
          f.paths.join(f.source, "history", "task", "notes", "working_1.txt"),
        ),
        "working notes",
      );
    }
  });
  it("retries old-copy cleanup after interruption without touching user knowledge or artifacts", async () => {
    const f = migrationFixture();
    const artifact = f.paths.join(f.source, "artifacts", "report.md");
    f.files.set(artifact, "saved report");
    await migrateRuntimeStorage(f.source, f.destination, f.fs);
    const remove = f.fs.remove!;
    let count = 0;
    f.fs.remove = async (path) => {
      await remove(path);
      if (++count === 2) throw new Error("interrupted cleanup");
    };
    await assert.rejects(
      clearMigratedContextCopies(f.destination, f.fs),
      /interrupted cleanup/,
    );
    f.fs.remove = remove;
    await clearMigratedContextCopies(f.destination, f.fs);
    await clearMigratedContextCopies(f.destination, f.fs);
    assert.equal(f.files.has(f.paths.join(f.source, "state.json")), false);
    assert.equal(
      f.files.has(
        f.paths.join(f.source, "history", "task", "notes", "working_1.txt"),
      ),
      false,
    );
    assert.equal(
      f.files.get(
        f.paths.join(
          f.destination,
          "history",
          "task",
          "notes",
          "working_1.txt",
        ),
      ),
      "working notes",
    );
    assert.equal(f.files.get(artifact), "saved report");
    assert.ok(f.files.has(f.paths.join(f.source, "memory", "user.md")));
  });
  for (const windows of [false, true])
    it(`resumes a verified copy without moving user knowledge (${windows ? "Windows" : "POSIX"})`, async () => {
      const f = migrationFixture(windows);
      f.fail(3);
      await assert.rejects(
        migrateRuntimeStorage(f.source, f.destination, f.fs),
        /interrupted/,
      );
      assert.equal(
        JSON.parse(f.files.get(f.paths.join(f.destination, "migration.json"))!)
          .state,
        "copying",
      );
      f.fail(0);
      await migrateRuntimeStorage(f.source, f.destination, f.fs);
      assert.equal(
        JSON.parse(f.files.get(f.paths.join(f.destination, "migration.json"))!)
          .state,
        "active",
      );
      const body = f.paths.join(
        "history",
        "task",
        "windows",
        "window",
        "message.txt",
      );
      assert.equal(
        f.files.get(f.paths.join(f.destination, body)),
        "original conversation",
      );
      assert.equal(
        f.files.get(f.paths.join(f.source, body)),
        "original conversation",
      );
      assert.equal(
        f.files.has(f.paths.join(f.destination, "memory", "user.md")),
        false,
      );
      f.files.set(
        f.paths.join(f.source, "state.json"),
        "old directory edited later",
      );
      await migrateRuntimeStorage(f.source, f.destination, f.fs);
      assert.notEqual(
        f.files.get(f.paths.join(f.destination, "state.json")),
        "old directory edited later",
      );
    });
  it("rejects missing history bodies and damaged state without activating empty records", async () => {
    const f = migrationFixture();
    f.files.delete(
      f.paths.join(f.source, "history", "task", "notes", "working_1.txt"),
    );
    await assert.rejects(
      migrateRuntimeStorage(f.source, f.destination, f.fs),
      /History body missing/,
    );
    assert.equal(
      JSON.parse(f.files.get(f.paths.join(f.destination, "migration.json"))!)
        .state,
      "copying",
    );
    const bad = migrationFixture();
    bad.files.set(bad.paths.join(bad.source, "state.json"), '{"wrong":[]}');
    await assert.rejects(
      migrateRuntimeStorage(bad.source, bad.destination, bad.fs),
      /Invalid saved task index/,
    );
  });
});
