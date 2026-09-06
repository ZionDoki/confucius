#!/usr/bin/env node
// Real providers, real papers and normal XPI installation in an isolated Windows profile.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { IsolatedZotero } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/windows-acceptance");
await mkdir(output, { recursive: true });
const xpi = join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi");
const instance = await IsolatedZotero.create({
  root,
  binary: "C:\\Program Files\\Zotero\\zotero.exe",
  xpi,
  sourcePreferences: join(root, "apps/zotero-addon/.scaffold/profile/prefs.js"),
});
const report = {
  startedAt: new Date().toISOString(),
  status: "running",
  xpiSha256: createHash("sha256")
    .update(await readFile(xpi))
    .digest("hex"),
  instance: instance.publicState(),
  engines: {},
};
async function save() {
  await writeFile(
    join(output, "real-engines.json"),
    JSON.stringify(report, null, 2),
  );
}
try {
  await instance.launch();
  report.instance = instance.publicState();
  await save();
  console.log("Isolated normal XPI ready", JSON.stringify(report.instance));
  report.runtimes = await instance.rpc("runtime/list");
  report.native = await instance.rdp.evaluate(
    `const c=await Zotero.Confucius.rpc("config/get"); return {activeEndpointId:c.activeEndpointId,endpoints:c.endpoints?.map(e=>({id:e.id,name:e.name,model:e.model,baseUrl:e.baseUrl,contextWindowTokens:e.contextWindowTokens,profile:e.profile}))};`,
  );
  for (const backend of ["native", "kimi", "codex"]) {
    const source = join(output, "papers/attention-is-all-you-need.pdf");
    const fixture = await instance.rdp.evaluate(
      `const item=new Zotero.Item("conferencePaper"); item.libraryID=Zotero.Libraries.userLibraryID; item.setField("title", "Attention Is All You Need — Windows acceptance ${backend}"); item.setField("date","2017"); item.setField("url","https://arxiv.org/abs/1706.03762"); await item.saveTx(); const attachment=await Zotero.Attachments.importFromFile({file:${JSON.stringify(source)},parentItemID:item.id}); return {libraryID:item.libraryID,key:item.key,attachmentKey:attachment.key,attachmentId:attachment.id};`,
    );
    const task = await instance.rpc("task/new", {
      title: `Windows real literature: ${backend}`,
      titleState: "fixed",
      backend,
      lockedContext: {
        version: 1,
        capturedAt: Date.now(),
        fingerprint: `windows-${backend}`,
        items: [
          {
            id: `item:${fixture.libraryID}:${fixture.key}`,
            libraryID: fixture.libraryID,
            key: fixture.key,
            attachmentKey: fixture.attachmentKey,
            title: "Attention Is All You Need",
            source: "library",
          },
        ],
      },
    });
    await instance.rpc("task/setPermissions", {
      taskId: task.id,
      permissionMode: "auto_allow",
    });
    if (backend !== "native") {
      const catalog = await instance.rpc("runtime/listModels", { backend });
      report.engines[backend] = { fixture, taskId: task.id, catalog };
      const model =
        catalog.models.find((m) => m.isDefault) ?? catalog.models[0];
      if (model)
        await instance.rpc("task/setModel", {
          taskId: task.id,
          modelId: model.id,
          reasoningEffort: model.defaultReasoningEffort,
        });
    } else report.engines[backend] = { fixture, taskId: task.id };
    const marker = `WIN-REAL-${backend.toUpperCase()}`;
    const prompt = `请实际阅读 Zotero 中的 Attention Is All You Need 原文，libraryID=${fixture.libraryID}，父条目 key=${fixture.key}，唯一 PDF attachmentKey=${fixture.attachmentKey}。本任务所有轮次的固定约束：中文报告；仅使用这篇原文；区分 Transformer base 与 big；不要创建笔记或删除条目。先读原文，再用 artifact_upsert 保存约 700–1000 字的 report（body.type=markdown），覆盖架构、scaled dot-product attention、训练设置、WMT14 两个方向的 base/big BLEU、局限。重要数字必须注明 PDF 页码并给简短英文原句。然后在该 PDF 上提议并真实提交恰好两条 highlight：架构动机和翻译结果各一条，comment 包含 ${marker}，引用必须可定位。已授权这两条写入。最后核查真实批注，并报告 artifact ID、实际 annotation keys 和任何未完成项。后续不重复已完成批注。`;
    report.engines[backend].prompt = prompt;
    await save();
    await instance.rpc("task/prompt", { taskId: task.id, text: prompt });
    console.log("Started", backend, task.id);
  }
  const end = Date.now() + 20 * 60_000;
  while (Date.now() < end) {
    let active = 0;
    for (const [backend, entry] of Object.entries(report.engines)) {
      const state = await instance.rpc("task/load", { taskId: entry.taskId });
      entry.state = state;
      const record = state.task ?? state.session ?? state;
      entry.status = record.status;
      if (
        ["running", "queued", "awaiting_approval", "pending"].includes(
          record.status,
        )
      )
        active++;
    }
    await save();
    console.log(
      new Date().toISOString(),
      Object.fromEntries(
        Object.entries(report.engines).map(([k, v]) => [k, v.status]),
      ),
    );
    if (!active) break;
    await delay(10_000);
  }
  report.status = "literature-runs-ended";
  await save();
  console.log(
    "Literature tasks ended; isolated instance remains open for follow-up acceptance.",
  );
  instance.rdp.close();
  instance.child.unref();
} catch (error) {
  report.status = "error";
  report.error = String(error);
  report.instance = instance.publicState();
  await save();
  console.error(error);
  instance.rdp?.close();
  instance.child?.unref();
  process.exitCode = 1;
}
