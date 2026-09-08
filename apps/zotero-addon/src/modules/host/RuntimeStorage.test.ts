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
describe("recoverable migration", () => {
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
