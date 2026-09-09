#!/usr/bin/env node
// Explicit real-engine acceptance in an isolated Zotero profile. Never runs in npm test.
// node scripts/live-reading-companion.mjs --pdf /absolute/paper.pdf --backend codex --output output/reading-live
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const root = resolve(import.meta.dirname, "..");
const output = resolve(
  flag("output", "output/reading-guide-implementation/live"),
);
const pdf = flag("pdf");
if (!pdf)
  throw new Error(
    "--pdf is required; this test imports it only into a fresh test library",
  );
const backend = flag("backend", "codex");
await mkdir(output, { recursive: true });
const instance = await IsolatedZotero.create({
  root,
  binary: flag("zotero", "/Applications/Zotero.app/Contents/MacOS/zotero"),
  xpi: join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  sourcePreferences: flag("prefs"),
  prefix: "reading-companion-",
});
const summary = {
  checks: [],
  backend,
  source: flag("source", "User-specified acceptance paper"),
  environment: null,
};
const check = (text) => {
  summary.checks.push(text);
  console.log("PASS " + text);
};
const evaluate = (code) =>
  instance.rdp.evaluate(
    `const h=Zotero.Confucius.hooks.host;const qa=Zotero.__readingQA;\n${code}`,
    30000,
  );
const emitState = async () =>
  writeFile(
    join(output, "run.json"),
    JSON.stringify(
      {
        rdpPort: instance.rdpPort,
        profile: instance.profile,
        directory: instance.directory,
        ...summary,
      },
      null,
      2,
    ),
  );
async function waitTask(taskId) {
  let last = 0;
  const terminal = await until(
    async () => {
      const state = await evaluate(
        `const s=h.sessions.get(${JSON.stringify(taskId)});return {record:s.record,active:!!s.activeTurnId,approvals:[...h.pendingApprovals.keys()],recent:s.events.slice(-8).map(e=>({type:e.type,tool:e.payload?.toolName,ok:e.payload?.result?.ok}))};`,
      );
      for (const id of state.approvals) {
        const request = await evaluate(
          `return h.sessions.get(${JSON.stringify(taskId)}).events.find(e=>e.type==='approval_required'&&e.payload.request.id===${JSON.stringify(id)})?.payload.request;`,
        );
        if (
          request &&
          /^(commit_annotations|update_annotation_comment|update_annotation|delete_annotation)$/.test(
            request.toolName,
          )
        )
          await instance.rpc("approval/resolve", {
            id,
            verdict: "allow",
            scope: "once",
          });
        else if (request)
          throw new Error(`Unexpected approval ${request.toolName}`);
      }
      if (Date.now() - last > 20000) {
        console.log(
          JSON.stringify({
            stage: summary.stage,
            status: state.record.status,
            active: state.active,
            recent: state.recent,
          }),
        );
        last = Date.now();
      }
      if (state.active) return false;
      await writeFile(
        join(output, summary.stage + "-task.json"),
        JSON.stringify(await instance.rpc("task/trace", { taskId }), null, 2),
      );
      return state.record;
    },
    12 * 60_000,
    1000,
  );
  assert.equal(
    terminal.status,
    "completed",
    terminal.run?.stopReason ?? terminal.status,
  );
  return terminal;
}
try {
  summary.environment = await instance.launch();
  await emitState();
  if (flag("executable"))
    await evaluate(
      `Zotero.Prefs.set('extensions.zotero.confucius.'+${JSON.stringify(backend === "codex" ? "codexExecutable" : "kimiExecutable")},${JSON.stringify(flag("executable"))},true);return true;`,
    );
  const refs = await evaluate(
    `const item=new Zotero.Item('journalArticle');item.setField('title',${JSON.stringify(flag("title", "Attention Is All You Need"))});await item.saveTx();const pdf=await Zotero.Attachments.importFromFile({file:${JSON.stringify(resolve(pdf))},parentItemID:item.id});Zotero.__readingQA={item,pdf};return {libraryID:item.libraryID,key:item.key,attachmentKey:pdf.key,title:item.getDisplayTitle()};`,
  );
  const record = await instance.rpc("task/new", {
    title: "Reading companion acceptance",
    backend,
    templateId: "deep-read",
    context: {
      version: 1,
      capturedAt: Date.now(),
      items: [
        {
          id: `item:${refs.libraryID}:${refs.key}`,
          libraryID: refs.libraryID,
          key: refs.key,
          title: refs.title,
          source: "library",
          attachmentKey: refs.attachmentKey,
        },
      ],
    },
  });
  summary.taskId = record.id;
  summary.stage = "guide";
  await emitState();
  await instance.rpc("task/prompt", {
    taskId: record.id,
    text: "请精读这篇论文，生成陪读路线和重点 checkpoint，初学者需要读懂方法与关键实验，也想了解作者怎样组织论证。覆盖方法、图表和结论边界；按论文内容决定密度，不凑数量。先交付陪读，暂不生成研究报告。保存精选原生高亮与简短批注。",
  });
  const completed = await waitTask(record.id);
  const saved = (await instance.rpc("artifact/list", { taskId: record.id }))
    .artifacts;
  assert.equal(saved.length, 1);
  const artifact = saved[0];
  summary.artifactId = artifact.id;
  assert.equal(artifact.kind, "deep_read");
  assert.ok(artifact.body.readingGuide);
  assert.equal(artifact.body.markdown, "");
  assert.equal(completed.run.templateVersion, 3);
  await writeFile(
    join(output, "guide-artifact.json"),
    JSON.stringify(artifact, null, 2),
  );
  check(
    "Real engine delivered one reviewed guide without an unsolicited report",
  );
  const checkpoint = artifact.body.readingGuide.checkpoints.find(
    (cp) => cp.kind === "checkpoint",
  );
  assert.ok(checkpoint);
  const unopened = await instance.rpc("readingDiscussion/open", {
    artifactId: artifact.id,
    revision: artifact.revision,
    checkpointId: checkpoint.id,
    create: false,
  });
  assert.equal(unopened.discussion, null);
  const first = await instance.rpc("readingDiscussion/open", {
    artifactId: artifact.id,
    revision: artifact.revision,
    checkpointId: checkpoint.id,
    create: true,
  });
  const id = first.discussion.id;
  summary.discussionId = id;
  summary.stage = "discussion";
  await emitState();
  const sentinel = "READING_BRANCH_SENTINEL_7b43";
  await instance.rpc("readingDiscussion/prompt", {
    artifactId: artifact.id,
    discussionId: id,
    text: `这个阅读分支的练习代号是 ${sentinel}。请先读取原文对应页面，然后用一个小例子解释这处 checkpoint，区分原文陈述和解释性例子。`,
  });
  const answer = await until(
    async () => {
      const d = (
        await instance.rpc("readingDiscussion/events", {
          artifactId: artifact.id,
          discussionId: id,
        })
      ).discussion;
      return d.status === "running" ? false : d;
    },
    5 * 60_000,
    1000,
  );
  assert.equal(answer.status, "completed", answer.error);
  assert.ok(answer.messages.at(-1).text.length > 20);
  await writeFile(
    join(output, "discussion.json"),
    JSON.stringify(answer, null, 2),
  );
  const main = await evaluate(
    `const s=h.sessions.get(${JSON.stringify(record.id)});return {messages:s.messages,events:s.events,history:await h.history.exportTask(s.record.id)};`,
  );
  assert.ok(!JSON.stringify(main).includes(sentinel));
  check(
    "Real private question answered while main messages, events and history remained free of its sentinel",
  );
  summary.stage = "report";
  await emitState();
  const generated = await instance.rpc("artifact/generateReport", {
    artifactId: artifact.id,
    expectedRevision: artifact.revision,
  });
  assert.equal(generated.status, "running");
  const duplicate = await instance.rpc("artifact/generateReport", {
    artifactId: artifact.id,
    expectedRevision: artifact.revision,
  });
  assert.equal(duplicate.status, "running");
  await waitTask(record.id);
  const result = await instance.rpc("artifact/get", { id: artifact.id });
  assert.ok(result.artifact.body.markdown.length > 100);
  assert.deepEqual(
    result.artifact.body.readingGuide,
    artifact.body.readingGuide,
  );
  assert.ok(!JSON.stringify(result.artifact).includes(sentinel));
  assert.equal(
    (await instance.rpc("artifact/list", { taskId: record.id })).artifacts
      .length,
    1,
  );
  const reuse = await instance.rpc("readingDiscussion/open", {
    artifactId: artifact.id,
    revision: result.artifact.revision,
    checkpointId: checkpoint.id,
    create: false,
  });
  assert.equal(reuse.discussion.id, id);
  await writeFile(
    join(output, "report-artifact.json"),
    JSON.stringify(result.artifact, null, 2),
  );
  check(
    "On-demand report reused the artifact and discussion, preserved the guide, and excluded private Q&A",
  );
  summary.stage = "ready-for-ui";
  await emitState();
  console.log(
    "Ready for UI checks; profile will remain open for 15 minutes or until stopped.",
  );
  for (let i = 0; i < 900 && !args.includes("--close"); i++) await delay(1000);
} catch (error) {
  summary.error = String(error);
  console.error(summary.error);
  process.exitCode = 1;
} finally {
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  await emitState();
  await instance.stop({ graceful: true }).catch(() => {});
}
