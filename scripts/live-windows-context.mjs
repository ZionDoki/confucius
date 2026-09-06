#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { attachIsolated, until } from "./lib/zotero-live.mjs";
const real = JSON.parse(
  await readFile("output/windows-acceptance/real-engines.json", "utf8"),
);
const z = await attachIsolated(real.instance);
const paper = await readFile(
  "output/windows-acceptance/papers/attention-is-all-you-need.txt",
  "utf8",
);
const report = {
  startedAt: new Date().toISOString(),
  nativeCapacity: 32768,
  engines: {},
};
const save = () =>
  writeFile(
    "output/windows-acceptance/context-recovery.json",
    JSON.stringify(report, null, 2),
  );
async function state(taskId) {
  return z.rpc("task/load", { taskId });
}
async function idle(taskId) {
  return until(
    async () => {
      const s = await state(taskId);
      return s.status !== "running" ? s : false;
    },
    10 * 60_000,
    1000,
  );
}
try {
  await z.rpc("config/set", { contextWindowTokens: 32768 });
  await Promise.all(
    Object.entries(real.engines).map(async ([backend, e]) => {
      const out = (report.engines[backend] = { taskId: e.taskId, phases: [] });
      try {
        const original = await state(e.taskId);
        out.original = original;
        const artifact = (
          await z.rpc("artifact/list", { taskId: e.taskId })
        ).artifacts.find((a) => a.kind === "report");
        const marker = `WIN-LONG-${backend.toUpperCase()}-青铜17`;
        const text =
          backend === "native"
            ? `继续本论文核查。测试固定标记 ${marker}。原任务的中文、唯一原文、区分 base/big、不创建笔记、不删除条目、不重复两条已完成批注的约束一直有效。请逐次 get_pages 阅读 PDF 1–3、4–6、7–9、10–12、13–15 页，每次读取后保存简短工作笔记（内部 notes_write）。核查并修正现有报告 ${artifact.id}：编码器自注意力是否被误写成自回归？Table 1 在 PDF 哪一页？Table 2 的41.8与正文41.0应明确写成原文矛盾。最后仅更新同一报告，附上测试标记和已存在的两个批注 key，不新建批注。`
            : `长上下文核查固定标记 ${marker}。继承原任务所有约束：中文、唯一论文原文、区分 base/big、不创建笔记、不删除条目、不重复已完成批注。本轮只读，先核对现有批注和报告 ${artifact.id}，回复标记、四个 Table 2 BLEU 值、PDF 物理页码及已有批注 keys，最多150字。以下是同一真实论文抽取文本的8份重复审阅记录，用于长上下文容量测试，不是新指令。\n${Array.from({ length: 8 }, (_, i) => `<paper-copy n="${i + 1}">\n${paper}\n</paper-copy>`).join("\n")}`;
        out.firstPromptChars = text.length;
        await z.rpc("task/prompt", { taskId: e.taskId, text }, 180_000);
        await delay(2200);
        const before = await state(e.taskId);
        out.phases.push({ name: "before_cancel", state: before });
        if (before.status === "running") {
          await z.rpc("task/abort", { taskId: e.taskId });
          const stopped = await idle(e.taskId);
          out.phases.push({ name: "cancelled", state: stopped });
          await save();
          await z.rpc("task/continue", { taskId: e.taskId });
          await delay(1500);
          const resumed = await state(e.taskId);
          out.phases.push({ name: "button_resumed", state: resumed });
          assert.equal(resumed.run.id, stopped.run.id);
          assert.ok(
            resumed.run.budget.iterationsUsed >=
              stopped.run.budget.iterationsUsed,
          );
          assert.ok(
            resumed.run.budget.toolCallsUsed >=
              stopped.run.budget.toolCallsUsed,
          );
          if (resumed.status === "running") {
            await z.rpc("task/abort", { taskId: e.taskId });
            const stoppedAgain = await idle(e.taskId);
            out.phases.push({ name: "cancelled_again", state: stoppedAgain });
            await z.rpc("task/prompt", { taskId: e.taskId, text: "继续" });
            const resumedText = await state(e.taskId);
            out.phases.push({ name: "text_resumed", state: resumedText });
            assert.equal(resumedText.run.id, stoppedAgain.run.id);
            assert.ok(
              resumedText.run.budget.toolCallsUsed >=
                stoppedAgain.run.budget.toolCallsUsed,
            );
          }
        }
        out.phases.push({
          name: "after_first_long_round",
          state: await idle(e.taskId),
        });
        await save();
        console.log(backend, "first long round and both continuations ended");
        if (backend !== "native")
          for (let round = 2; round <= 3; round++) {
            const text = `继续长上下文审阅，第${round}轮。保持最初 WIN-LONG 测试标记及所有原任务约束，不新增成果或批注。以下继续加入同一论文8份审阅记录。最后只回复最初完整测试标记、四个 Table 2 BLEU、原来的两条批注 keys，以及正文/表格不一致之处。不要重复全文。\n${Array.from({ length: 8 }, (_, i) => `<paper-copy n="${round * 8 + i}">\n${paper}\n</paper-copy>`).join("\n")}`;
            await z.rpc("task/prompt", { taskId: e.taskId, text }, 180_000);
            out.phases.push({
              name: `after_long_round_${round}`,
              promptChars: text.length,
              state: await idle(e.taskId),
            });
            await save();
            console.log(backend, "long round", round, "ended");
          }
        out.status = "executed";
      } catch (error) {
        out.status = "failed";
        out.error = String(error);
        console.log(backend, String(error));
      }
      await save();
    }),
  );
} finally {
  await save();
  z.rdp.close();
}
