#!/usr/bin/env node
// Replay migration from a retained 0.3.8 test data directory, pause real IO after
// a copy/index write, kill the verified test process, and restart the same XPI.
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, cp } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
const phase = process.argv[2] ?? "copy";
assert.ok(["copy", "index"].includes(phase));
const old = JSON.parse(
  await readFile("output/windows-acceptance/upgrade.json", "utf8"),
);
assert.ok(
  resolve(old.data).startsWith(
    resolve("apps/zotero-addon/.scaffold/upgrade-acceptance-"),
  ),
);
const z = await IsolatedZotero.create({
  root: resolve("."),
  binary: "C:\\Program Files\\Zotero\\zotero.exe",
  xpi: resolve("apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: `windows-migration-${phase}-`,
});
await cp(old.data, z.data, { recursive: true });
async function hashes(root) {
  const out = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else
        out[relative(root, path)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    }
  }
  await walk(root);
  return out;
}
const source = join(z.data, "confucius"),
  before = await hashes(source);
const marker = join(z.directory, "fault.json");
const report = {
  phase,
  source,
  startedAt: new Date().toISOString(),
  sourceFiles: Object.keys(before).length,
};
try {
  await z.launch();
  report.instance = z.publicState();
  report.baseline = await z.rpc("task/load", { taskId: old.before.record.id });
  await z.rdp.evaluate(`const h=Zotero.Confucius.hooks.host;await h.shutdown();
 const root=PathUtils.join(PathUtils.localProfileDir,"confucius","runtime-v1");const backup=PathUtils.join(PathUtils.localProfileDir,"confucius","runtime-v1-initial-backup");
 if(PathUtils.profileDir!==${JSON.stringify(z.profile)}||!root.startsWith(PathUtils.profileDir+"\\\\")||!backup.startsWith(PathUtils.profileDir+"\\\\"))throw new Error("Unsafe test migration reset");
 await IOUtils.move(root,backup);h.storageReady=false;h.initializingStorage=undefined;
 const fs=Cu.getGlobalForObject(h).IOUtils;const write=fs.writeUTF8.bind(fs),copy=fs.copy.bind(fs);let paused=false;
 const pause=async(path)=>{if(paused)return;paused=true;await write(${JSON.stringify(marker)},JSON.stringify({phase:${JSON.stringify(phase)},path}));await new Promise(()=>{});};
 if(${JSON.stringify(phase)}==="copy")fs.copy=async(from,to,...rest)=>{const value=await copy(from,to,...rest);if(to.includes("runtime-v1")&&to.endsWith(".txt"))await pause(to);return value;};
 else fs.writeUTF8=async(path,text,...rest)=>{const value=await write(path,text,...rest);if(path.endsWith("migration.json")&&text.includes("history/")&&text.includes("index.json"))await pause(path);return value;};
 h.initializeStorage().catch(e=>globalThis.__migrationFaultError=String(e));return true;`);
  report.fault = await until(
    async () => JSON.parse(await readFile(marker, "utf8")),
    30000,
  );
  await z.stop();
  const runtime = join(z.profile, "confucius/runtime-v1");
  const manifest = JSON.parse(
    await readFile(join(runtime, "migration.json"), "utf8"),
  );
  assert.equal(manifest.state, "copying");
  report.stoppedState = manifest.state;
  assert.deepEqual(await hashes(source), before);
  await z.launch();
  const tasks = await z.rpc("task/list");
  const state = tasks.tasks.find((t) => t.id === old.before.record.id);
  assert.ok(state);
  assert.equal(state.status, report.baseline.status);
  assert.equal(state.contextWindow.id, report.baseline.contextWindow.id);
  assert.deepEqual(state.run, report.baseline.run);
  const done = JSON.parse(
    await readFile(join(runtime, "migration.json"), "utf8"),
  );
  assert.equal(done.state, "active");
  assert.deepEqual(await hashes(source), before);
  const trace = await z.rpc("task/trace", { taskId: state.id });
  assert.equal(trace.issues.length, 0);
  assert.equal(trace.sections.history.data.notes.length, 2);
  report.final = {
    state: done.state,
    taskId: state.id,
    status: state.status,
    traceIssues: trace.issues,
    workingNotes: trace.sections.history.data.notes.length,
  };
  report.status = "pass";
  console.log(phase, "PASS", JSON.stringify(report.final));
} catch (error) {
  report.status = "fail";
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    `output/windows-acceptance/migration-${phase}-verified.json`,
    JSON.stringify(report, null, 2),
  );
  await z.stop().catch(() => {});
}
