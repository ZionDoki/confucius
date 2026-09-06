#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { attachIsolated, until } from "./lib/zotero-live.mjs";
const real = JSON.parse(
  await readFile("output/windows-acceptance/real-engines.json", "utf8"),
);
const platform = JSON.parse(
  await readFile("output/windows-acceptance/platform.json", "utf8"),
);
const z = await attachIsolated(real.instance);
const report = { startedAt: new Date().toISOString(), checks: [] };
async function locked(path, work) {
  const ready = resolve(`output/windows-acceptance/lock-${Date.now()}.ready`),
    release = ready + ".release";
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-File",
      resolve("scripts/lib/hold-windows-file.ps1"),
      "-Path",
      path,
      "-ReadyPath",
      ready,
      "-ReleasePath",
      release,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  try {
    await until(() => stat(ready).then(() => true), 10000);
    return await work();
  } finally {
    await writeFile(release, "release");
    await until(() => child.exitCode !== null, 10000);
  }
}
async function check(name, work) {
  try {
    const evidence = await work();
    report.checks.push({ name, status: "pass", evidence });
    console.log("PASS", name);
  } catch (error) {
    report.checks.push({ name, status: "fail", error: String(error) });
    console.log("FAIL", name, String(error));
  }
  await writeFile(
    "output/windows-acceptance/storage.json",
    JSON.stringify(report, null, 2),
  );
}
try {
  for (const [label, dir] of [
    [
      "local",
      join(real.instance.profile, "confucius/runtime-v1/file-lock-acceptance"),
    ],
    [
      "wps",
      join(
        process.env.USERPROFILE,
        "WPS Cloud/WPS Cloud Files",
        `Confucius-acceptance-${Date.now()}`,
      ),
    ],
  ]) {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "历史恢复.txt");
    await writeFile(path, "original durable body");
    await check(`${label}_exclusive_file_lock`, async () => {
      const failed = await locked(path, () =>
        z.rdp.evaluate(
          `const start=Date.now();try{await Zotero.Confucius.hooks.host.history.fs.writeFile(${JSON.stringify(path)},"replacement body");return {unexpectedSuccess:true};}catch(e){return {error:String(e),elapsedMs:Date.now()-start};}`,
        ),
      );
      assert.ok(failed.error);
      assert.equal(await readFile(path, "utf8"), "original durable body");
      const recovered = await z.rdp.evaluate(
        `await Zotero.Confucius.hooks.host.history.fs.writeFile(${JSON.stringify(path)},"replacement body");return {body:await Zotero.Confucius.hooks.host.history.fs.readFile(${JSON.stringify(path)}),runtime:PathUtils.join(PathUtils.localProfileDir,"confucius","runtime-v1")};`,
      );
      assert.equal(recovered.body, "replacement body");
      return { path, failed, recovered, cloudSyncStatus: "not_observed" };
    });
  }
  await check("locked_intent_zero_dispatch_then_single_note", async () => {
    let operationId = `windows_lock_${Date.now()}`;
    const taskId = platform.taskId;
    const f = platform.fixtures.ambiguous;
    const path = await z.rdp.evaluate(
      `const key=await Zotero.Confucius.hooks.host.execution.store.key(${JSON.stringify(`${taskId}:${operationId}`)});return PathUtils.join(PathUtils.localProfileDir,"confucius","runtime-v1","records",key+".json");`,
    );
    const call = async () => {
      const response = await z.rpc("task/toolCall", {
        taskId,
        operationId,
        callId: operationId,
        name: "create_note",
        arguments: {
          libraryID: 1,
          parentKey: f.key,
          content:
            "<p>Windows actual locked intent recovery — exactly once.</p>",
        },
      });
      return JSON.parse(response.content.find((c) => c.type === "text").text);
    };
    const notes = () =>
      z.rdp.evaluate(
        `return Zotero.Items.getByLibraryAndKey(1,${JSON.stringify(f.key)}).getNotes().map(id=>{const n=Zotero.Items.get(id);return {key:n.key,body:n.getNote()};});`,
      );
    const before = await notes();
    await writeFile(path, "acceptance placeholder held before intent");
    const failed = await locked(path, call);
    const afterFailure = await notes();
    assert.equal(failed.ok, false);
    assert.equal(failed.effect, "none");
    assert.deepEqual(afterFailure, before);
    const failedReceiptReplay = await call();
    assert.equal(failedReceiptReplay.ok, false);
    assert.deepEqual(await notes(), before);
    // The failed immutable call keeps its no-effect receipt. An explicit new
    // call retries the request after the filesystem becomes writable.
    operationId += "_retry";
    const recovered = await call();
    const after = await notes();
    assert.equal(recovered.ok, true);
    assert.equal(after.length, before.length + 1);
    const repeated = await call();
    assert.deepEqual(await notes(), after);
    return {
      path,
      failed,
      failedReceiptReplay,
      recovered,
      repeated,
      notes: after,
    };
  });
  await check("long_history_drained_and_readable", async () => {
    const result = await z.rdp.evaluate(
      `const h=Zotero.Confucius.hooks.host;await h.persistNow();return {failure:String(h.historyFailure),pending:h.pendingHistory.length};`,
    );
    assert.equal(result.pending, 0);
    assert.equal(result.failure, "null");
    return result;
  });
} finally {
  z.rdp.close();
}
