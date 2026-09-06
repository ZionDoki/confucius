#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { attachIsolated, IsolatedZotero, until } from "./lib/zotero-live.mjs";
const file = "output/windows-acceptance/real-engines.json";
const real = JSON.parse(await readFile(file, "utf8"));
let z = await attachIsolated(real.instance);
const report = {
  startedAt: new Date().toISOString(),
  before: {},
  afterRestart: {},
  afterContinue: {},
};
const save = () =>
  writeFile(
    "output/windows-acceptance/real-restart.json",
    JSON.stringify(report, null, 2),
  );
const xpi = resolve("apps/zotero-addon/.scaffold/build/confucius.xpi");
try {
  for (const [backend, e] of Object.entries(real.engines))
    await z.rpc("task/prompt", {
      taskId: e.taskId,
      text: "重启恢复核查。只用最初指定论文，分5次 get_pages 阅读1–3、4–6、7–9、10–12、13–15页，逐次记录内部工作笔记。最后给出原始 WIN-LONG 完整标记、Table 2 的 base/big 四个BLEU、已有两条批注key。不要创建、删除或重写任何笔记、报告或批注；仅内部工作笔记可更新。",
    });
  await delay(2000);
  await z.rdp.evaluate(
    "await Zotero.Confucius.hooks.host.persistNow();return true;",
  );
  for (const [backend, e] of Object.entries(real.engines))
    report.before[backend] = await z.rpc("task/load", { taskId: e.taskId });
  const pid = await z.rdp.evaluate("return Services.appinfo.processID;");
  const owned = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' | Select-Object Name,CommandLine | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  assert.equal(owned.Name.toLowerCase(), "zotero.exe");
  assert.ok(owned.CommandLine.includes(real.instance.profile));
  assert.ok(owned.CommandLine.includes(real.instance.data));
  assert.ok(report.before.native.status === "running");
  report.verifiedPid = pid;
  await save();
  z.rdp.close();
  // PID was just verified through RDP on the exact isolated profile and data path.
  process.kill(pid, "SIGKILL");
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 15000);
  await until(async () => {
    await copyFile(
      xpi,
      join(real.instance.profile, "extensions/confucius@zotero.plugin.xpi"),
    );
    return true;
  }, 15000);
  z = new IsolatedZotero({
    ...real.instance,
    root: resolve("."),
    binary: "C:\\Program Files\\Zotero\\zotero.exe",
    token: z.token,
  });
  await z.launch();
  real.instance = z.publicState();
  real.finalXpiSha256 = createHash("sha256")
    .update(await readFile(xpi))
    .digest("hex");
  await writeFile(file, JSON.stringify(real, null, 2));
  await delay(2000);
  for (const [backend, e] of Object.entries(real.engines)) {
    const s = await z.rpc("task/load", { taskId: e.taskId });
    report.afterRestart[backend] = s;
    assert.equal(s.status, "interrupted");
    assert.equal(s.run.id, report.before[backend].run.id);
    assert.ok(
      s.run.budget.toolCallsUsed >=
        report.before[backend].run.budget.toolCallsUsed,
    );
    assert.equal(
      s.run.budget.executorStarts,
      report.before[backend].run.budget.executorStarts,
    );
    assert.equal(s.run.request, report.before[backend].run.request);
  }
  await save();
  console.log(
    "All three real tasks restored interrupted with identical requests and no automatic executor restart",
  );
  for (const e of Object.values(real.engines))
    await z.rpc("task/continue", { taskId: e.taskId });
  await Promise.all(
    Object.entries(real.engines).map(async ([backend, e]) => {
      const s = await until(
        async () => {
          const s = await z.rpc("task/load", { taskId: e.taskId });
          return s.status !== "running" ? s : false;
        },
        10 * 60_000,
        1500,
      );
      report.afterContinue[backend] = s;
      await save();
      console.log(backend, s.status, s.run?.budget);
    }),
  );
  report.status = "executed";
  await save();
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  await save();
  console.error(error);
  process.exitCode = 1;
} finally {
  z.rdp?.close();
  z.child?.unref();
}
