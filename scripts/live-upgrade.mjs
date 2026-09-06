#!/usr/bin/env node
// Actual released XPI -> candidate XPI acceptance in a fresh, isolated Zotero profile.
// No real model credentials or user library are used. Only this script's PID is stopped.
// node scripts/live-upgrade.mjs --old-xpi output/release-acceptance/v0.3.8/confucius.xpi
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const oldXpi = resolve(
  flag("old-xpi", "output/release-acceptance/v0.3.8/confucius.xpi"),
);
const newXpi = resolve(
  flag("new-xpi", "apps/zotero-addon/.scaffold/build/confucius.xpi"),
);
const binary = flag("zotero", "/Applications/Zotero.app/Contents/MacOS/zotero");
const expectedVersion = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
).version;
const output = resolve(flag("output", "output/upgrade-acceptance.json"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const scaffold = join(root, "apps/zotero-addon/.scaffold");
await mkdir(scaffold, { recursive: true });
const directory = await mkdtemp(join(scaffold, "upgrade-acceptance-"));
const profile = join(directory, "profile"),
  data = join(directory, "data");
await mkdir(join(profile, "extensions"), { recursive: true });
await mkdir(data, { recursive: true });
const installedXpi = join(profile, "extensions/confucius@zotero.plugin.xpi");
const report = {
  startedAt: new Date().toISOString(),
  status: "running",
  profile,
  data,
  versions: { from: "0.3.8", to: expectedVersion },
  packages: {
    old: { path: oldXpi, sha256: sha256(await readFile(oldXpi)) },
    candidate: { path: newXpi, sha256: sha256(await readFile(newXpi)) },
  },
  scope:
    "Released old package, actual Zotero entities, host execution and platform restart recovery; deterministic local model. This does not measure real Native/Kimi/Codex model quality or unexecuted platform fault scenarios.",
  checks: [],
};
const check = (name, details = {}) => {
  report.checks.push({ name, status: "pass", ...details });
  console.log(name);
};
async function until(work, timeout = 60000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const result = await work();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw last ?? new Error("Timed out waiting for acceptance state");
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

class Rdp {
  queue = [];
  listeners = new Set();
  buffer = Buffer.alloc(0);
  constructor(port) {
    this.socket = net.connect(port, "127.0.0.1");
    this.socket.on("error", () => {});
    this.socket.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      for (;;) {
        const colon = this.buffer.indexOf(":");
        if (colon < 0) return;
        const length = Number(this.buffer.subarray(0, colon));
        if (this.buffer.length < colon + 1 + length) return;
        const message = JSON.parse(
          this.buffer.subarray(colon + 1, colon + 1 + length),
        );
        this.buffer = this.buffer.subarray(colon + 1 + length);
        let delivered = false;
        for (const item of this.listeners)
          if (item.match(message)) {
            this.listeners.delete(item);
            item.resolve(message);
            delivered = true;
            break;
          }
        if (!delivered) this.queue.push(message);
      }
    });
  }
  async next(match) {
    const index = this.queue.findIndex(match);
    if (index >= 0) return this.queue.splice(index, 1)[0];
    let waiter;
    try {
      return await Promise.race([
        new Promise((resolve) => {
          waiter = { match, resolve };
          this.listeners.add(waiter);
        }),
        delay(15000).then(() => {
          throw new Error("RDP response timeout");
        }),
      ]);
    } finally {
      this.listeners.delete(waiter);
    }
  }
  async request(to, type, extra = {}) {
    const pending = this.next(
      (x) =>
        x.from === to &&
        ![
          "evaluationResult",
          "frameUpdate",
          "tabNavigated",
          "resources-available-array",
        ].includes(x.type),
    );
    const body = JSON.stringify({ to, type, ...extra });
    this.socket.write(Buffer.byteLength(body) + ":" + body);
    return pending;
  }
  async connect() {
    await this.next((x) => x.from === "root");
    const descriptor = await this.request("root", "getProcess", { id: 0 });
    const target = await this.request(
      descriptor.processDescriptor.actor,
      "getTarget",
    );
    this.actor = target.process.consoleActor;
  }
  async raw(text) {
    const receipt = await this.request(this.actor, "evaluateJSAsync", {
      text,
      disableBreaks: true,
    });
    const result = await this.next(
      (x) => x.type === "evaluationResult" && x.resultID === receipt.resultID,
    );
    if (result.hasException) throw new Error(result.exceptionMessage);
    return result.result;
  }
  async evaluate(source) {
    await this.raw(
      `globalThis.__confuciusUpgradeResult = null; (async () => {${source}\n})().then(value => globalThis.__confuciusUpgradeResult = JSON.stringify({ok:true,value}), error => globalThis.__confuciusUpgradeResult = JSON.stringify({ok:false,error:String(error),stack:error?.stack})); "scheduled";`,
    );
    const result = JSON.parse(
      await until(async () => {
        const value = await this.raw("globalThis.__confuciusUpgradeResult");
        return typeof value === "string" ? value : null;
      }, 120000),
    );
    if (!result.ok) throw new Error(`${result.error}\n${result.stack ?? ""}`);
    return result.value;
  }
  close() {
    this.socket.destroy();
  }
}

let modelMode = "initial",
  target,
  modelRequests = 0,
  replaySent = false,
  waitingAfterWrite = false;
const noteContent =
  "Confucius upgrade acceptance: preserve this note identity and never duplicate it.";
const model = createServer(async (request, response) => {
  if (request.url === "/v1/models") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ data: [{ id: "confucius-upgrade-fixture" }] }),
    );
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  modelRequests++;
  let message = {
    role: "assistant",
    content: "Upgrade fixture evidence and task complete.",
  };
  const writing = body.messages?.some(
    (m) =>
      typeof m.content === "string" && m.content.includes("UPGRADE_WRITE_ONCE"),
  );
  const hasResult = body.messages?.some(
    (m) => m.role === "tool" && m.tool_call_id === "call_upgrade_write",
  );
  if (writing && modelMode === "initial" && hasResult) {
    waitingAfterWrite = true;
    request.socket.on("close", () => response.destroy());
    return;
  }
  if (
    writing &&
    ((!hasResult && modelMode === "initial") ||
      (modelMode === "replay" && !replaySent))
  ) {
    if (modelMode === "replay") replaySent = true;
    message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_upgrade_write",
          type: "function",
          function: {
            name: "create_note",
            arguments: JSON.stringify({
              libraryID: target.libraryID,
              parentKey: target.key,
              content: noteContent,
            }),
          },
        },
      ],
    };
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      id: `upgrade_${modelRequests}`,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message,
          finish_reason: message.tool_calls ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 128, completion_tokens: 16, total_tokens: 144 },
    }),
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
const token = randomUUID(),
  httpPort = await freePort();
const preferences = {
  "extensions.zotero.firstRun2": false,
  "extensions.zotero.firstRunGuidance": false,
  "extensions.zotero.firstRun.skipFirefoxProfileAccessCheck": true,
  "extensions.zoteroMacWordIntegration.skipInstallation": true,
  "extensions.zoteroWinWordIntegration.skipInstallation": true,
  "extensions.zoteroOpenOfficeIntegration.skipInstallation": true,
  "extensions.zotero.httpServer.enabled": true,
  "extensions.zotero.httpServer.port": httpPort,
  "extensions.zotero.confucius.pairingToken": token,
  "extensions.autoDisableScopes": 0,
  "extensions.enabledScopes": 5,
  "extensions.update.enabled": false,
  "devtools.debugger.remote-enabled": true,
  "devtools.debugger.prompt-connection": false,
};
await writeFile(
  join(profile, "user.js"),
  Object.entries(preferences)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n"),
);
let processHandle, rdp, upgradeSourceFiles;
async function launch(xpi, version) {
  if (!(await stat(installedXpi).catch(() => null)))
    await copyFile(xpi, installedXpi);
  const port = await freePort();
  const log = await open(
    join(directory, `zotero-${Date.now()}.log`),
    "a",
    0o600,
  );
  processHandle = spawn(
    binary,
    [
      "--purgecaches",
      "-no-remote",
      "-profile",
      profile,
      "--dataDir",
      data,
      "-start-debugger-server",
      String(port),
    ],
    { stdio: ["ignore", log.fd, log.fd], windowsHide: true },
  );
  await log.close();
  await until(
    async () =>
      new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      }),
  );
  rdp = new Rdp(port);
  await rdp.connect();
  await until(async () =>
    rdp.evaluate(`
    if (!globalThis.Zotero?.Confucius?.hooks?.host) return false;
    globalThis.__upgradeHost = Zotero.Confucius.hooks.host;
    return !!(await __upgradeHost.rpc("task/list"));
  `),
  );
  const installedVersion = await rdp.evaluate(`
    const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    return (await AddonManager.getAddonByID("confucius@zotero.plugin")).version;
  `);
  if (installedVersion !== version) {
    await rdp.evaluate("await __upgradeHost.persistNow(); return true;");
    upgradeSourceFiles = await tree(join(data, "confucius"));
    await rdp.evaluate(`
      const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(${JSON.stringify(xpi)});
      const install = await AddonManager.getInstallForFile(file);
      if (!install || install.error) throw new Error("Candidate XPI could not be prepared: " + install?.error);
      await new Promise((resolve, reject) => {
        const listener = {onInstallEnded(){install.removeListener(listener);resolve();}, onInstallFailed(){reject(new Error("XPI installation failed: " + install.error));}, onInstallCancelled(){reject(new Error("XPI installation cancelled"));}};
        install.addListener(listener);
        Promise.resolve(install.install()).catch(reject);
      });
      return true;
    `);
    await until(async () =>
      rdp.evaluate(`
      if (!Zotero.Confucius?.hooks?.host || Zotero.Confucius.hooks.host.health().version !== ${JSON.stringify(version)}) return false;
      globalThis.__upgradeHost = Zotero.Confucius.hooks.host;
      return true;
    `),
    );
  }
  const actual = await rdp.evaluate(`
    const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID("confucius@zotero.plugin");
    if (Zotero.DataDirectory.dir !== ${JSON.stringify(data)} || PathUtils.profileDir !== ${JSON.stringify(profile)}) throw new Error("Unexpected profile; fixture writes refused");
    return {version:addon.version,zotero:Zotero.version,profile:PathUtils.profileDir,localProfile:PathUtils.localProfileDir};
  `);
  assert.equal(actual.version, version);
  report.environment = {
    zotero: actual.zotero,
    platform: process.platform,
    profile: actual.profile,
    localProfile: actual.localProfile,
  };
  return actual;
}
async function stop() {
  if (!rdp) {
    if (processHandle?.exitCode === null) processHandle.kill("SIGKILL");
    return;
  }
  const pid = await rdp.evaluate(
    `if(PathUtils.profileDir!==${JSON.stringify(profile)}||Zotero.DataDirectory.dir!==${JSON.stringify(data)})throw new Error("Wrong test profile");return Services.appinfo.processID;`,
  );
  rdp.close();
  rdp = undefined;
  process.kill(pid, "SIGKILL");
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}
let sequence = 0;
async function rpc(method, params = {}) {
  const response = await fetch(
    `http://127.0.0.1:${httpPort}/confucius/v1/rpc`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
      signal: AbortSignal.timeout(120000),
    },
  );
  const body = await response.json();
  if (!response.ok || body.error)
    throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body.result;
}
async function tree(path, prefix = "") {
  const files = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      Object.assign(files, await tree(join(path, entry.name), relative + "/"));
    else if (entry.isFile() && !entry.name.endsWith(".tmp"))
      files[relative] = sha256(await readFile(join(path, entry.name)));
  }
  return files;
}
async function snapshot(taskId) {
  return rdp.evaluate(`
    const state = __upgradeHost.sessions.get(${JSON.stringify(taskId)});
    const parent = Zotero.Items.getByLibraryAndKey(${target?.libraryID ?? 1}, ${JSON.stringify(target?.key ?? "")});
    const notes = await Zotero.Items.getAsync(parent.getNotes());
    const artifacts = await __upgradeHost.rpc("artifact/list", {taskId:state.record.id});
    return {record:state.record, checkpoint: {iteration:state.latestCheckpoint?.iteration, toolCallsUsed:state.latestCheckpoint?.toolCallsUsed, toolExecutions:state.latestCheckpoint?.toolExecutions}, artifacts:artifacts.artifacts, notes:notes.map(n=>({key:n.key, content:n.getNote()}))};
  `);
}
try {
  await launch(oldXpi, "0.3.8");
  check("released_old_xpi_loaded");
  await rpc("config/set", {
    baseUrl: modelUrl,
    apiKey: "upgrade-fixture-only",
    model: "confucius-upgrade-fixture",
    streamResponses: false,
    contextWindowTokens: 32768,
    maxTokens: 4096,
  });
  target = await rdp.evaluate(
    `const item = new Zotero.Item("journalArticle"); item.libraryID=Zotero.Libraries.userLibraryID; item.setField("title","Confucius isolated upgrade fixture"); await item.saveTx(); return {libraryID:item.libraryID,key:item.key};`,
  );
  const task = await rpc("task/new", {
    title: "Version upgrade fixture",
    titleState: "fixed",
    backend: "native",
    context: { libraryID: target.libraryID, itemKeys: [target.key] },
  });
  report.taskId = task.id;
  await rpc("task/setPermissions", {
    taskId: task.id,
    permissionMode: "auto_allow",
  });
  await rpc("task/draft", {
    taskId: task.id,
    text: "Preserve latest user constraint and draft across upgrade.",
  });
  await rdp.evaluate(
    `await __upgradeHost.history.writeNote(${JSON.stringify(task.id)}, "upgrade_progress", "original working note"); await __upgradeHost.history.writeNote(${JSON.stringify(task.id)}, "upgrade_progress", "revised working note"); return true;`,
  );
  await rpc("task/prompt", {
    taskId: task.id,
    text: "UPGRADE_READ_EVIDENCE: retain this original evidence.",
  });
  await until(
    async () =>
      (await rpc("task/list")).tasks.find((t) => t.id === task.id)?.status ===
      "completed",
  );
  const artifact = (
    await rpc("artifact/upsert", {
      taskId: task.id,
      kind: "report",
      title: "Upgrade report",
      body: {
        type: "markdown",
        markdown: "# First revision\nOriginal evidence.",
      },
      status: "ready",
    })
  ).artifact;
  await rpc("artifact/upsert", {
    id: artifact.id,
    taskId: task.id,
    kind: "report",
    title: "Upgrade report",
    body: {
      type: "markdown",
      markdown: "# Second revision\nRevised evidence.",
    },
    status: "ready",
  });
  await rpc("task/new-context", { taskId: task.id });
  await rpc("task/prompt", {
    taskId: task.id,
    text: "UPGRADE_WRITE_ONCE: create the fixture note once, preserve its key and finish after restart.",
  });
  await until(() => waitingAfterWrite);
  await rdp.evaluate("await __upgradeHost.persistNow(); return true;");
  const before = await snapshot(task.id);
  assert.equal(before.notes.length, 1);
  assert.equal(before.artifacts[0].revision, 2);
  assert.ok(before.record.contextWindow.number >= 2);
  assert.ok(
    before.checkpoint.toolExecutions.some(
      (x) =>
        x.toolName === "create_note" && x.status === "completed" && x.result.ok,
    ),
  );
  report.before = before;
  check("old_version_saved_real_write_history_notes_and_artifact_revisions", {
    noteKey: before.notes[0].key,
    window: before.record.contextWindow.number,
    iteration: before.checkpoint.iteration,
  });
  await stop();
  const source = join(data, "confucius");
  let oldFiles = await tree(source);
  report.oldFileCount = Object.keys(oldFiles).length;
  const requestsBeforeUpgrade = modelRequests;
  await launch(newXpi, expectedVersion);
  // The old package first restores the deliberately interrupted task, then the
  // normal AddonManager upgrade runs its shutdown. Preserve that latest source.
  for (const [name, hash] of Object.entries(oldFiles))
    if (name.startsWith("history/") && name.endsWith(".txt"))
      assert.equal(upgradeSourceFiles[name], hash);
  oldFiles = upgradeSourceFiles;
  await rdp.evaluate("await __upgradeHost.persistNow(); return true;");
  const migrated = await snapshot(task.id);
  assert.equal(migrated.record.schemaVersion, 4);
  assert.equal(migrated.record.status, "interrupted");
  assert.equal(migrated.record.run.status, "interrupted");
  assert.equal(migrated.record.draft.text, before.record.draft.text);
  assert.equal(
    migrated.record.contextWindow.id,
    before.record.contextWindow.id,
  );
  assert.deepEqual(migrated.notes, before.notes);
  assert.deepEqual(migrated.artifacts, before.artifacts);
  assert.deepEqual(
    migrated.checkpoint.toolExecutions,
    before.checkpoint.toolExecutions,
  );
  assert.ok(
    migrated.record.run.budget.iterationsUsed >= before.checkpoint.iteration,
  );
  assert.equal(
    modelRequests,
    requestsBeforeUpgrade,
    "upgrade must not restart model execution",
  );
  assert.deepEqual(
    await tree(source),
    oldFiles,
    "old runtime source files must remain byte-identical",
  );
  const runtime = join(report.environment.localProfile, "confucius/runtime-v1");
  const migration = JSON.parse(
    await readFile(join(runtime, "migration.json"), "utf8"),
  );
  assert.equal(migration.state, "active");
  assert.equal(
    sha256(await readFile(join(runtime, "state.json.pre-v4-backup"))),
    oldFiles["state.json"],
  );
  for (const [name, hash] of Object.entries(oldFiles))
    if (name.startsWith("history/") && name.endsWith(".txt"))
      assert.equal(sha256(await readFile(join(runtime, name))), hash);
  report.migrated = migrated;
  check("upgrade_preserved_ids_budgets_bodies_receipts_and_source_backups", {
    legacyFiles: Object.keys(oldFiles).length,
    modelRequestsDuringUpgrade: 0,
  });
  await stop();
  await launch(newXpi, expectedVersion);
  const restarted = await snapshot(task.id);
  assert.deepEqual(restarted.notes, before.notes);
  assert.equal(restarted.record.run.request, migrated.record.run.request);
  assert.deepEqual(restarted.checkpoint, migrated.checkpoint);
  assert.equal(modelRequests, requestsBeforeUpgrade);
  check("new_version_restart_preserved_interrupted_task_without_dispatch");
  modelMode = "replay";
  await rpc("task/continue", { taskId: task.id });
  await until(
    async () =>
      (await rpc("task/list")).tasks.find((t) => t.id === task.id)?.status ===
      "completed",
  );
  const completed = await snapshot(task.id);
  assert.equal(replaySent, true);
  assert.deepEqual(
    completed.notes,
    before.notes,
    "the same completed call must not create another note",
  );
  assert.ok(
    completed.record.run.budget.iterationsUsed >
      migrated.record.run.budget.iterationsUsed,
  );
  assert.deepEqual(await tree(source), oldFiles);
  check(
    "explicit_continue_reused_completed_write_and_preserved_consumed_budget",
    {
      noteCount: completed.notes.length,
      noteKey: completed.notes[0].key,
      iterations: completed.record.run.budget.iterationsUsed,
    },
  );
  await rdp.evaluate("await __upgradeHost.persistNow(); return true;");
  await stop();
  await launch(newXpi, expectedVersion);
  const final = await snapshot(task.id);
  assert.equal(final.record.status, "completed");
  assert.deepEqual(final.notes, before.notes);
  assert.deepEqual(final.artifacts, before.artifacts);
  const trace = await rpc("task/trace", { taskId: task.id });
  assert.equal(trace.task.id, task.id);
  assert.equal(trace.issues.length, 0);
  assert.equal(trace.sections.history.data.notes.length, 2);
  report.final = {
    taskStatus: final.record.status,
    noteKeys: final.notes.map((n) => n.key),
    artifactIds: final.artifacts.map((a) => a.id),
    artifactRevision: final.artifacts[0].revision,
    traceEvents: trace.events.length,
    historyItems: trace.sections.history.data.items.length,
    workingNoteRevisions: trace.sections.history.data.notes.length,
  };
  check(
    "completed_task_survived_second_restart_and_exported_complete_available_history",
    report.final,
  );
  report.status = "pass";
} catch (error) {
  report.status = "fail";
  report.error = String(error);
  report.stack = error.stack;
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await stop();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  report.finishedAt = new Date().toISOString();
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(`Upgrade report: ${output}`);
}
