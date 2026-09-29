#!/usr/bin/env node
// Synthetic, isolated built-XPI acceptance. No personal library or model service.
// node --import tsx scripts/live-runtime-recovery.mjs [output-dir] [target.xpi] [old.xpi] [--public]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
import { resolveZoteroExecutable } from "../apps/zotero-addon/src/development/zoteroExecutable.ts";
import { ArtifactStore } from "../apps/zotero-addon/src/modules/host/ArtifactStore.ts";
import { migrateSessionRecord } from "@confucius/protocol";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.argv[2] ?? join(root, "output/runtime-migration-fix/live"),
);
await mkdir(join(output, "apps/zotero-addon/.scaffold"), { recursive: true });
const xpi = resolve(
  process.argv[3] ??
    join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
);
const oldXpi = process.argv[4] ? resolve(process.argv[4]) : undefined;
const publicMode = process.argv.includes("--public");
assert.ok(
  !publicMode || oldXpi,
  "Public recovery requires an original old XPI",
);
const version = JSON.parse(
  execFileSync("unzip", ["-p", xpi, "manifest.json"], { encoding: "utf8" }),
).version;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const z = await IsolatedZotero.create({
  root: output,
  xpi: oldXpi ?? xpi,
  binary: resolveZoteroExecutable().path,
  prefix: "runtime-recovery-",
});
const report = {
  xpiSha256: sha(await readFile(xpi)),
  oldXpiSha256: oldXpi ? sha(await readFile(oldXpi)) : undefined,
  publicMode,
  startedAt: new Date().toISOString(),
  checks: [],
};
const check = (name, value) => {
  report.checks.push({ name, pass: Boolean(value) });
  console.log(`${value ? "PASS" : "FAIL"} ${name}`);
  assert.ok(value, name);
};
const write = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
};
const source = join(z.data, "confucius");
const taskId = "ses_recovered";
const at = Date.now() - 60_000;
await write(join(source, "history", taskId, "index.json"), {
  version: 1,
  windows: [
    {
      id: "window",
      number: 1,
      createdAt: at,
      control: "host",
      usageSource: "estimated",
    },
  ],
  items: [
    {
      taskId,
      windowId: "window",
      itemId: "user_old",
      turnId: "old",
      role: "user",
      createdAt: at,
      sourceIds: [],
      characters: 9,
      excerpt: "原来的问题",
    },
    {
      taskId,
      windowId: "window",
      itemId: "answer_old",
      turnId: "old",
      role: "assistant",
      createdAt: at + 1,
      sourceIds: [],
      characters: 9,
      excerpt: "原来的回答",
    },
  ],
  notes: [{ name: "working", revision: 1, updatedAt: at, characters: 6 }],
});
await write(
  join(source, "history", taskId, "windows/window/user_old.txt"),
  "原来的问题：比较两篇文献",
);
await write(
  join(source, "history", taskId, "windows/window/answer_old.txt"),
  "原来的回答：保留完整历史正文",
);
await write(
  join(source, "history", taskId, "notes/working_1.txt"),
  "原来的工作笔记",
);
const saved = migrateSessionRecord({
  id: taskId,
  title: "原来的研究任务",
  createdAt: at,
  updatedAt: at + 1,
  mode: "agent",
  context: {},
  permissionMode: "ask",
});
saved.draft = { text: "还没发送的草稿", references: [] };
await write(join(source, "state.json.pre-v4-backup"), {
  tasks: [{ record: saved, events: [] }],
});
await write(join(source, "history/ses_damaged/index.json"), "{broken");
await write(
  join(source, "history/ses_damaged/windows/window/answer_partial.txt"),
  "缺少索引但仍可读的回答",
);
await write(join(source, "history/ses_deleted/index.json"), {
  version: 1,
  deleted: true,
  items: [],
  windows: [],
  notes: [],
});
await mkdir(join(source, "history/empty/windows/window"), { recursive: true });
const artifacts = new ArtifactStore(
  join(source, "artifacts"),
  {
    read: (path) => readFile(path, "utf8"),
    writeAtomic: write,
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    makeDirectory: (path) => mkdir(path, { recursive: true }),
  },
  () => at,
  () => "art_recovered",
);
await artifacts.upsert(
  {
    taskId,
    kind: "report",
    title: "原来的报告",
    body: { type: "markdown", markdown: "原报告完整正文" },
  },
  "native",
);
async function hashes(dir, prefix = "") {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      Object.assign(
        result,
        await hashes(join(dir, entry.name), relative + "/"),
      );
    else result[relative] = sha(await readFile(join(dir, entry.name)));
  }
  return result;
}
const before = await hashes(source);
let requests = 0;
const server = http.createServer(async (req, res) => {
  for await (const _chunk of req) {
    /* Drain the synthetic request. */
  }
  requests++;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "RECOVERY_TEST_OK" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }),
  );
});
const evaluate = (script) =>
  z.rdp.evaluate(
    `if(PathUtils.profileDir!==${JSON.stringify(z.profile)}||Zotero.DataDirectory.dir!==${JSON.stringify(z.data)})throw new Error("Wrong isolated profile");const h=Zotero.Confucius.hooks.host;${script}`,
    30_000,
  );
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  await z.launch();
  if (oldXpi) {
    report.oldEnvironment = z.environment;
    check(
      "original old XPI is installed normally with unchanged bytes",
      !z.environment.temporary &&
        sha(
          await readFile(
            join(z.profile, "extensions/confucius@zotero.plugin.xpi"),
          ),
        ) === report.oldXpiSha256,
    );
    report.oldStorageError = await evaluate(
      "return !h.storageReady ? h.stateStorageFailure?.message : null;",
    );
    check(
      "old installation reproduces the missing-task-index error",
      report.oldStorageError?.includes("Existing history has no task index"),
    );
    if (publicMode) {
      const stable = await z.rpc("update/setPrerelease", { enabled: false });
      check(
        "failed storage does not block checking the stable channel",
        stable.state !== "error" && !stable.availableVersion?.includes("-"),
      );
      const available = await z.rpc("update/setPrerelease", { enabled: true });
      report.discovery = available;
      check(
        "original updater discovers the recovery Beta despite failed storage",
        available.state === "available" &&
          available.availableVersion === version &&
          available.canInstall,
      );
      const installed = await z.rpc("update/install", {}, 180_000);
      check(
        "original updater downloads, verifies and installs the public recovery XPI",
        installed.state === "ready" &&
          typeof installed.restartRequired === "boolean",
      );
    } else {
      await evaluate(
        `const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");const file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(${JSON.stringify(xpi)});await(await AddonManager.getInstallForFile(file)).install();return true;`,
      );
    }
    await until(() =>
      evaluate(
        `return Zotero.Confucius?.data.initialized && h.health().version === ${JSON.stringify(version)};`,
      ),
    );
    await z.stop({ graceful: true });
    await z.launch();
  }
  report.environment = z.environment;
  check(
    "target XPI is a normal installation with verified bytes",
    z.environment.version === version &&
      !z.environment.temporary &&
      sha(
        await readFile(
          join(z.profile, "extensions/confucius@zotero.plugin.xpi"),
        ),
      ) === report.xpiSha256,
  );
  check(
    "startup recovers storage without user intervention",
    await evaluate("return h.storageReady && !h.stateStorageFailure;"),
  );
  const tasks = (await z.rpc("task/list")).tasks;
  check(
    "saved and damaged conversations appear once; tombstone and empty shells stay absent",
    tasks.length === 2 &&
      tasks.some((t) => t.id === taskId) &&
      tasks.some((t) => t.id === "ses_damaged"),
  );
  const restored = await z.rpc("task/load", { taskId });
  check(
    "saved title and unsent Chinese draft survive",
    restored.title === saved.title && restored.draft.text === saved.draft.text,
  );
  const archive = await evaluate(
    `return h.history.exportTask(${JSON.stringify(taskId)});`,
  );
  check(
    "history bodies and working notes are readable",
    archive.issues.length === 0 &&
      archive.items.length === 2 &&
      archive.notes[0].content === "原来的工作笔记",
  );
  const artifact = await z.rpc("artifact/get", { id: "art_recovered" });
  check(
    "saved report remains linked and readable",
    restored.artifactIds.includes("art_recovered") &&
      JSON.stringify(artifact).includes("原报告完整正文"),
  );
  check("automatic recovery makes no model request", requests === 0);
  for (const [relative, digest] of Object.entries(before))
    assert.equal(sha(await readFile(join(source, relative))), digest);
  check("all original legacy files retain their hashes", true);
  const backup = join(
    z.environment.localProfile,
    "confucius/runtime-v1/recovery/missing-task-index/source",
  );
  assert.deepEqual(await hashes(backup), before);
  check("every original has a byte-identical recovery backup", true);
  await z.rpc("config/set", {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: "recovery-fixture",
    apiKey: "fixture-only",
    streamResponses: false,
    memoryConsent: "off",
    maxTokens: 256,
    contextWindowTokens: 32768,
    maxIterations: 4,
    maxToolCalls: 4,
  });
  const fresh = await z.rpc("task/new", {
    title: "新任务可以直接使用",
    backend: "native",
  });
  await evaluate(
    `h.sessions.get(${JSON.stringify(fresh.id)}).record.titleState="fixed";await h.persistNow();return true;`,
  );
  await z.rpc("task/prompt", {
    taskId: fresh.id,
    text: "Reply with RECOVERY_TEST_OK. Do not use tools.",
  });
  await until(
    async () =>
      (await z.rpc("task/load", { taskId: fresh.id })).status === "completed",
    30_000,
  );
  check("a new task sends a model request and completes", requests > 0);
  await z.rpc("task/draft", {
    taskId: fresh.id,
    text: "重启后仍保留的新草稿",
    references: [],
  });
  await evaluate("await h.persistNow();return true;");
  await z.stop({ graceful: true });
  await z.launch();
  const after = (await z.rpc("task/list")).tasks;
  check(
    "full restart does not reimport tasks",
    after.length === 3 && new Set(after.map((t) => t.id)).size === 3,
  );
  check(
    "new work survives restart",
    (await z.rpc("task/load", { taskId: fresh.id })).draft.text ===
      "重启后仍保留的新草稿",
  );
  check(
    "recovered history remains readable after restart",
    (await evaluate(`return h.history.exportTask(${JSON.stringify(taskId)});`))
      .items.length === 2,
  );
  await z.rpc("task/delete", { taskId: "ses_damaged" });
  for (const [relative, digest] of Object.entries(before))
    assert.equal(sha(await readFile(join(source, relative))), digest);
  assert.deepEqual(await hashes(backup), before);
  check(
    "deleting a recovered task retains its original and recovery backup",
    true,
  );
  report.status = "pass";
} catch (error) {
  report.status = "fail";
  report.error = String(error.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(report, null, 2),
  );
  await z.stop().catch((error) => console.error("Isolated shutdown:", error));
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
