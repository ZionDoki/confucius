/** Real Zotero file parsing, messaging and restart; isolated model HTTP fixture. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFile, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_ATTACHMENTS_OUTPUT ??
    join(root, "output/chat-attachments"),
);
await mkdir(output, { recursive: true });
const fileNames = [
  "手动拖入的研究论文 · A deliberately long file name with spaces and 中文.pdf",
  "笔记 <script> & research.md",
  "context.txt",
];
const files = fileNames.map((name) => join(output, name));
await copyFile(
  join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"),
  files[0],
);
await writeFile(files[1], "# Attachment fixture\nMarkdown source evidence.");
await writeFile(files[2], "Text source evidence.");
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      id: "attachment-fixture",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "附件验收完成。" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    }),
  );
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi:
    process.env.CONFUCIUS_ATTACHMENTS_XPI ??
    join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "chat-attachments-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\n',
);
const report = { checks: [], styleSamples: [] };
const check = (name) => {
  report.checks.push(name);
  console.log("PASS", name);
};
const evaluate = (code) =>
  instance.rdp.evaluate(
    `
  const host=Zotero.Confucius.hooks.host,qa=Zotero.__attachmentQA;
  const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml'),d=win?.document;
  ${code}`,
    30000,
  );
const wait = (code) => until(() => evaluate(code), 30000, 150);
const open = async () => {
  await evaluate(
    "const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;",
  );
  await wait("return !!d?.getElementById('confucius-prompt');");
  await evaluate(
    `win.addEventListener('error',event=>qa.errors.push(event.message));win.addEventListener('unhandledrejection',event=>qa.errors.push(String(event.reason)));return true;`,
  );
};
const select = async (taskId) => {
  await wait(
    `return !!d.querySelector('.confucius-task-row[data-task-id="'+${JSON.stringify(taskId)}+'"]');`,
  );
  await evaluate(
    `const row=d.querySelector('.confucius-task-row[data-task-id="'+${JSON.stringify(taskId)}+'"]'),group=row.closest('.confucius-task-group'),toggle=group?.querySelector('.confucius-article-toggle');if(toggle?.getAttribute('aria-expanded')==='false')toggle.click();row.querySelector('.confucius-task-open').click();return true;`,
  );
  await wait(
    `return d.querySelector('[data-entry-id^="overview:"]')?.dataset.entryId==='overview:'+${JSON.stringify(taskId)};`,
  );
};
const drop = async (paths) => {
  await evaluate(
    `const target=d.querySelector('.confucius-composer-card');for(const type of ['dragenter','dragover','drop']){const event=new win.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],files:${JSON.stringify(paths)}.map(path=>({path})),dropEffect:'none'}});target.dispatchEvent(event);}return true;`,
  );
  await wait(
    `return d.querySelectorAll('#confucius-attachment-tray .confucius-attachment-chip[data-status="ready"]').length===${paths.length};`,
  );
};
const send = async (text) => {
  await evaluate(
    `const input=d.getElementById('confucius-prompt');input.value=${JSON.stringify(text)};input.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  await wait(
    "const button=d.getElementById('confucius-send');return !button.disabled&&!!button.getClientRects().length;",
  );
  await evaluate("d.getElementById('confucius-send').click();return true;");
};
const messages = () =>
  evaluate(
    `return [...d.querySelectorAll('.confucius-user-message')].map(row=>({text:[...row.childNodes].filter(node=>node.nodeType===3).map(node=>node.textContent).join(''),files:[...row.querySelectorAll('.confucius-attachment-chip')].map(chip=>({id:chip.dataset.attachmentId,name:chip.querySelector('.confucius-attachment-name').textContent,meta:chip.querySelector('.confucius-attachment-meta').textContent,removable:!!chip.querySelector('button')}))}));`,
  );
const capture = async (name) => {
  const png = await evaluate(
    `const canvas=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');canvas.width=win.innerWidth;canvas.height=win.innerHeight;canvas.getContext('2d').drawWindow(win,0,0,canvas.width,canvas.height,win.getComputedStyle(d.body??d.documentElement).backgroundColor);return canvas.toDataURL('image/png');`,
  );
  await writeFile(
    join(output, name + ".png"),
    Buffer.from(png.split(",")[1], "base64"),
  );
};
const showSidebar = async () => {
  await wait("return win.innerWidth>900;");
  await evaluate(
    "if(!d.getElementById('confucius-session-pane').getClientRects().length)d.getElementById('confucius-toggle-sessions').click();return true;",
  );
  await wait(
    "return !!d.querySelector('.confucius-task-menu-trigger').getClientRects().length;",
  );
};
try {
  report.environment = await instance.launch();
  await instance.rpc("config/set", {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "local-fixture",
    model: "attachment-fixture",
    streamResponses: false,
    memoryConsent: "off",
  });
  await evaluate(
    `Zotero.__attachmentQA={errors:[],releaseBefore:null,releaseAfter:null,holdBefore:false,holdAfter:false};const original=host.rpc.bind(host);Zotero.__attachmentQA.original=original;host.rpc=async(method,params={})=>{const q=Zotero.__attachmentQA;if(method==='task/new'&&q.holdNew)await new Promise(done=>q.releaseNew=done);if(method==='task/setContext'&&params.taskId===q.holdContextTask){await new Promise(done=>q.releaseContext=done);throw new Error('Fixture context update refused');}if(method==='task/prompt'&&q.holdBefore){q.beforeParams=params;await new Promise(done=>q.releaseBefore=done);}const result=await original(method,params);if(method==='task/new')q.createdId=result.id;if(method==='task/prompt'&&q.holdAfter){q.afterAccepted=true;await new Promise(done=>q.releaseAfter=done);}return result;};return true;`,
  );
  await open();
  await drop([files[0]]);
  await evaluate("qa.holdNew=true;return true;");
  await send("新建过程中切换对话仍发送原 PDF");
  await wait("return !!qa.releaseNew;");
  const [taskA, taskB] = await evaluate(
    `const tasks=[];for(const title of ['附件发送验收','另一条对话'])tasks.push(await qa.original('task/new',{title,titleState:'fixed',backend:'native'}));return tasks.map(task=>task.id);`,
  );
  await select(taskB);
  await evaluate(
    "const input=d.getElementById('confucius-prompt');input.value='新建等待期间另一对话的草稿';input.dispatchEvent(new win.Event('input',{bubbles:true}));qa.holdNew=false;qa.releaseNew();return true;",
  );
  await wait(
    "return qa.createdId && host.sessions.get(qa.createdId)?.events.some(event=>event.type==='turn_started') && !host.sessions.get(qa.createdId).activeTurnId && !d.getElementById('confucius-send').disabled;",
  );
  assert.equal(
    await evaluate(
      "return d.querySelector('[data-entry-id^=\"overview:\"]')?.dataset.entryId;",
    ),
    "overview:" + taskB,
    "A late task/new response must preserve the selected conversation",
  );
  assert.equal(
    await evaluate("return d.getElementById('confucius-prompt').value;"),
    "新建等待期间另一对话的草稿",
  );
  const firstTask = await evaluate("return qa.createdId;");
  const firstEvents = await instance.rpc("task/events", { taskId: firstTask });
  assert.deepEqual(
    firstEvents.events
      .find((event) => event.type === "turn_started")
      .payload.attachments.map((attachment) => attachment.name),
    [fileNames[0]],
  );
  assert.equal((await messages()).length, 0);
  check(
    "Switching while task creation is held preserves selection/draft and sends files to the original new task",
  );
  await select(taskA);
  await drop(files);
  await evaluate("qa.holdBefore=true;return true;");
  await send("阅读这些附件");
  await wait("return !!qa.releaseBefore;");
  let rows = await messages();
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0].files.map((file) => file.name),
    fileNames,
  );
  assert.ok(rows[0].files.every((file) => !file.removable));
  check("Optimistic message preserves submitted PDF/Markdown/TXT metadata");
  await evaluate(
    "qa.holdAfter=true;qa.holdBefore=false;qa.releaseBefore();return true;",
  );
  await wait("return qa.afterAccepted && !!qa.releaseAfter;");
  await wait(
    `return !!d.querySelector('.confucius-user-message[data-entry-id]:not([data-entry-id="pending-user-message"])');`,
  );
  rows = await messages();
  assert.equal(
    rows.length,
    1,
    "Host events replace the pending message before RPC resolves",
  );
  assert.deepEqual(
    rows[0].files.map((file) => file.name),
    fileNames,
  );
  await evaluate("qa.holdAfter=false;qa.releaseAfter();return true;");
  await wait(
    "return !d.querySelector('#confucius-attachment-tray .confucius-attachment-chip') && !d.getElementById('confucius-send').disabled;",
  );
  assert.match((await messages())[0].files[0].meta, /\d+\/\d+ (?:页|pages)/u);
  check(
    "Sent files remain visible with page coverage after composer cleanup; no duplicates",
  );
  const events = await instance.rpc("task/events", { taskId: taskA });
  const started = events.events.find((event) => event.type === "turn_started");
  assert.deepEqual(
    started.payload.attachments.map((attachment) => attachment.name),
    fileNames,
  );
  assert.ok(!JSON.stringify(started).includes(output));
  assert.ok(!JSON.stringify(started).includes("Markdown source evidence"));
  assert.ok(
    requests.some(
      (request) =>
        JSON.stringify(request.messages).includes(
          "Confucius Tool Verification Paper",
        ) &&
        JSON.stringify(request.messages).includes("Markdown source evidence") &&
        JSON.stringify(request.messages).includes("Text source evidence"),
    ),
  );
  check(
    "Real extraction reaches the model; durable event contains summaries without local paths or file bodies",
  );
  await send("继续解释");
  await wait(
    "return d.querySelectorAll('.confucius-user-message').length===2 && !d.getElementById('confucius-send').disabled;",
  );
  rows = await messages();
  assert.equal(rows[0].files.length, 3);
  assert.equal(rows[1].files.length, 0);
  check("Follow-up messages do not inherit previous attachments");
  await drop([files[0]]);
  await evaluate("qa.holdBefore=true;qa.releaseBefore=null;return true;");
  await send("切换任务期间仍发送这个 PDF");
  await wait("return !!qa.releaseBefore;");
  await select(taskB);
  assert.equal((await messages()).length, 0);
  await evaluate(
    "const input=d.getElementById('confucius-prompt');input.value='另一条对话的草稿';input.dispatchEvent(new win.Event('input',{bubbles:true}));qa.holdBefore=false;qa.releaseBefore();return true;",
  );
  await wait(
    "return host.sessions.get(" +
      JSON.stringify(taskA) +
      ").events.filter(event=>event.type==='turn_started').length===3 && !host.sessions.get(" +
      JSON.stringify(taskA) +
      ").activeTurnId;",
  );
  assert.equal(
    await evaluate("return d.getElementById('confucius-prompt').value;"),
    "另一条对话的草稿",
  );
  await select(taskA);
  await wait(
    "return d.querySelectorAll('.confucius-user-message').length===3;",
  );
  rows = await messages();
  assert.deepEqual(
    rows[2].files.map((file) => file.name),
    [fileNames[0]],
  );
  check(
    "Switching tasks during send retains file leases and preserves the other task's draft",
  );
  await evaluate(`qa.holdContextTask=${JSON.stringify(taskA)};return true;`);
  await send("切换前等待上下文，失败仅属于原对话");
  await wait("return !!qa.releaseContext;");
  await select(taskB);
  await evaluate("qa.holdContextTask=null;qa.releaseContext();return true;");
  await wait("return !d.getElementById('confucius-send').disabled;");
  assert.equal((await messages()).length, 0);
  assert.equal(
    await evaluate(
      "return d.querySelector('.confucius-activity-shell').textContent.includes('Fixture context update refused');",
    ),
    false,
  );
  assert.equal(
    await evaluate("return d.getElementById('confucius-prompt').value;"),
    "另一条对话的草稿",
  );
  check(
    "A refused context update after a task switch cannot add an error to the newly selected conversation",
  );
  await select(taskA);
  await drop([files[2]]);
  await evaluate(
    "qa.originalPromptRpc=host.rpc;host.rpc=(method,params)=>method==='task/prompt'?Promise.reject(new Error('Fixture submission refused')):qa.originalPromptRpc(method,params);return true;",
  );
  await send("失败时保留输入和附件");
  await wait(
    "return d.querySelector('.confucius-activity-shell')?.textContent.includes('Fixture submission refused') && !d.getElementById('confucius-send').disabled;",
  );
  assert.equal((await messages()).length, 3);
  assert.equal(
    await evaluate("return d.getElementById('confucius-prompt').value;"),
    "失败时保留输入和附件",
  );
  assert.equal(
    await evaluate(
      "return d.querySelectorAll('#confucius-attachment-tray .confucius-attachment-chip[data-status=ready]').length;",
    ),
    1,
  );
  await evaluate(
    "host.rpc=qa.originalPromptRpc;d.querySelector('#confucius-attachment-tray .confucius-attachment-remove').click();return true;",
  );
  check(
    "Rejected submissions clear the pending message and retain the draft and prepared file",
  );
  let taskButtonSize;
  for (const theme of ["light", "dark"]) {
    await showSidebar();
    for (const font of ["sans", "serif", "mono", "cjk-serif"]) {
      for (const size of [12, 28]) {
        await instance.rpc("config/set", {
          uiTheme: theme,
          uiFont: font,
          uiFontSize: size,
        });
        await wait(
          `return win.getComputedStyle(d.querySelector('.confucius-workspace-root')).fontSize==='${size}px';`,
        );
        const sample = await evaluate(
          `const button=d.querySelector('.confucius-task-menu-trigger'),icon=button.querySelector('svg'),r=button.getBoundingClientRect(),s=icon.getBoundingClientRect();return {button:[r.width,r.height],icon:[s.width,s.height],centered:Math.abs(r.x+r.width/2-s.x-s.width/2)<1&&Math.abs(r.y+r.height/2-s.y-s.height/2)<1,dots:icon.querySelectorAll('circle').length,text:button.textContent,accessible:!!button.title&&!!button.getAttribute('aria-label'),hidden:icon.getAttribute('aria-hidden')==='true'};`,
        );
        taskButtonSize ??= sample.button;
        assert.deepEqual(sample.button, taskButtonSize);
        assert.deepEqual(sample.icon, [20, 20]);
        assert.ok(sample.centered && sample.accessible && sample.hidden);
        assert.equal(sample.dots, 3);
        assert.equal(sample.text, "");
        report.styleSamples.push({ theme, font, size, ...sample });
      }
    }
    await evaluate("win.resizeTo(380,780);return true;");
    await wait("return win.innerWidth<=400;");
    const layout = await evaluate(
      `const pane=d.querySelector('.confucius-timeline-pane'),chips=[...pane.querySelectorAll('.confucius-user-attachments .confucius-attachment-chip')];return {noOverflow:pane.scrollWidth<=pane.clientWidth+1,chips:chips.every(chip=>chip.scrollWidth<=chip.clientWidth+1),wrap:chips.every(chip=>win.getComputedStyle(chip.querySelector('.confucius-attachment-name')).whiteSpace==='normal'),safeText:!pane.querySelector('.confucius-user-attachments script')};`,
    );
    assert.deepEqual(layout, {
      noOverflow: true,
      chips: true,
      wrap: true,
      safeText: true,
    });
    await capture("attachments-" + theme + "-28px-narrow");
    await evaluate("win.resizeTo(1020,800);return true;");
  }
  check(
    "SVG icon geometry is stable across four font presets, both size limits and light/dark themes",
  );
  check(
    "Long bilingual/HTML-like names wrap safely at 28px in narrow light/dark windows",
  );
  await showSidebar();
  await evaluate(
    `const row=d.querySelector('.confucius-task-row[data-task-id="'+${JSON.stringify(taskA)}+'"]'),button=row.querySelector('.confucius-task-menu-trigger');button.focus();button.click();return true;`,
  );
  await wait("return !!d.getElementById('confucius-task-action-menu');");
  await evaluate(
    "d.getElementById('confucius-task-action-menu').dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true;",
  );
  await wait("return !d.getElementById('confucius-task-action-menu');");
  check("Task action menu still opens and closes from the SVG trigger");
  assert.deepEqual(await evaluate("return qa.errors;"), []);
  await instance.stop({ graceful: true });
  await instance.launch();
  await evaluate("Zotero.__attachmentQA={errors:[]};return true;");
  await open();
  await select(taskA);
  await wait(
    "return d.querySelectorAll('.confucius-user-message').length===3;",
  );
  assert.deepEqual(
    (await messages()).map((row) => row.files.map((file) => file.name)),
    [fileNames, [], [fileNames[0]]],
  );
  check("Sent attachment summaries survive a real Zotero process restart");
  report.modelRequestCount = requests.length;
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.error = String(error);
  report.diagnostics = await evaluate(
    "return {errors:qa?.errors,prompt:d?.getElementById('confucius-prompt')?.value,messages:d?.querySelectorAll('.confucius-user-message').length,sendVisible:!!d?.getElementById('confucius-send')?.getClientRects().length};",
  ).catch(() => null);
  process.exitCode = 1;
  console.error(error);
} finally {
  await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
  await instance.stop({ graceful: true });
  await new Promise((done) => server.close(done));
}
