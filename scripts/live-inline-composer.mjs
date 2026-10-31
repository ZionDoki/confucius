/** Real reader/PDF binding, picker, theme and persistence acceptance in an isolated profile. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_INLINE_OUTPUT ?? join(root, "output/inline-composer"),
);
await mkdir(output, { recursive: true });
const requests = [];
let holdModel = false,
  releaseModel;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  if (holdModel)
    await new Promise((done) => {
      releaseModel = done;
    });
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      id: "pdf-fixture",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "PDF binding verified." },
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
    process.env.CONFUCIUS_INLINE_XPI ??
    join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "inline-composer-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\nuser_pref("extensions.zotero.confucius.uiLanguage", "zh-CN");\n',
);
const report = { checks: [], styles: [] };
const check = (label) => {
  report.checks.push(label);
  console.log("PASS", label);
};
const evaluate = (code) =>
  instance.rdp.evaluate(
    `const host=Zotero.Confucius.hooks.host,qa=Zotero.__inlineQA;const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml'),d=win?.document;${code}`,
    30000,
  );
const wait = (code) => until(() => evaluate(code), 30000, 150);
const open = async () => {
  await evaluate(
    "const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;",
  );
  await wait("return !!d?.getElementById('confucius-prompt');");
};
const capture = async (name) => {
  const data = await evaluate(
    "const c=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=win.innerWidth;c.height=win.innerHeight;c.getContext('2d').drawWindow(win,0,0,c.width,c.height,win.getComputedStyle(d.body).backgroundColor);return c.toDataURL('image/png');",
  );
  await writeFile(
    join(output, name + ".png"),
    Buffer.from(data.split(",")[1], "base64"),
  );
};
const current = () =>
  evaluate(
    "const id=d.querySelector('[data-entry-id^=\"overview:\"]')?.dataset.entryId.slice(9);return host.sessions.get(id)?.record;",
  );
const key = (value, extra = {}) =>
  evaluate(
    `const p=d.getElementById('confucius-prompt');p.dispatchEvent(new win.KeyboardEvent('keydown',{key:${JSON.stringify(value)},bubbles:true,cancelable:true,...${JSON.stringify(extra)}}));return true;`,
  );
const text = (value) =>
  evaluate(
    `const p=d.getElementById('confucius-prompt');p.focus();d.execCommand('insertText',false,${JSON.stringify(value)});return p.value;`,
  );
const choosePaper = async (query) => {
  await text("@" + query);
  await wait("return !!d.querySelector('[data-mention-index=\"0\"]');");
  await key("Enter");
  await wait(
    "return !d.getElementById('confucius-mention-menu')&&!d.getElementById('confucius-send').disabled;",
  );
};
try {
  report.environment = await instance.launch();
  await instance.rpc("config/set", {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "isolated-fixture",
    model: "pdf-fixture",
    streamResponses: false,
    memoryConsent: "off",
  });
  const papers = await evaluate(
    `Zotero.__inlineQA={papers:[],errors:[]};for(const title of ['当前阅读的研究论文与长期记忆', 'Mention Paper Alpha · 中文标题', 'Mention Paper Beta · 中文标题']){const item=new Zotero.Item('journalArticle');item.setField('title',title);await item.saveTx();const pdf=await Zotero.Attachments.importFromFile({file:${JSON.stringify(join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"))},parentItemID:item.id});Zotero.__inlineQA.papers.push({id:item.id,key:item.key,pdfId:pdf.id,pdfKey:pdf.key,title});}await Zotero.Reader.open(Zotero.__inlineQA.papers[0].pdfId);return Zotero.__inlineQA.papers;`,
  );
  await wait(
    `return host.liveContext().reader?.attachmentKey==='${papers[0].pdfKey}';`,
  );
  await open();
  await evaluate(
    "win.addEventListener('error',e=>qa.errors.push(e.message));d.getElementById('confucius-new-session').click();return true;",
  );
  await wait("return !!d.getElementById('confucius-pdf-binding');");
  const task = await current();
  report.taskId = task.id;
  assert.equal(task.lockedContext.reader.attachmentKey, papers[0].pdfKey);
  assert.equal(
    await evaluate(
      "return d.getElementById('confucius-pdf-binding').parentElement.id;",
    ),
    "confucius-prompt",
  );
  assert.equal(
    await evaluate(
      "return !!d.querySelector('.confucius-pdf-context,.confucius-source-tray,#confucius-attached-sources,#confucius-task-sources');",
    ),
    false,
  );
  check(
    "Current PDF is an atomic inline prefix; duplicate source bars are absent",
  );
  await evaluate(
    "const p=d.getElementById('confucius-prompt');p.focus();p.setSelectionRange(0,0);return true;",
  );
  await key("Backspace");
  await wait(
    "return !d.getElementById('confucius-pdf-binding')&&!d.getElementById('confucius-send').disabled;",
  );
  assert.equal((await current()).pdfBinding, "manual");
  assert.equal((await current()).lockedContext.reader, undefined);
  await instance.rpc("task/setContext", {
    taskId: task.id,
    mode: "follow_reader",
    refresh: true,
  });
  assert.equal((await current()).lockedContext.reader, undefined);
  await key("z", { metaKey: true });
  await wait(
    "return !!d.getElementById('confucius-pdf-binding')&&!d.getElementById('confucius-send').disabled;",
  );
  assert.equal(
    (await current()).lockedContext.reader.attachmentKey,
    papers[0].pdfKey,
  );
  check(
    "Backspace persists unbinding, reader refresh cannot rebind, and undo restores the exact PDF",
  );
  await text("Compare ");
  await choosePaper("Mention Paper Alpha");
  await text(" with ");
  await choosePaper("Mention Paper Beta");
  await text(" — 请保留正文");
  assert.deepEqual(
    (await current()).lockedContext.items
      .filter((i) => i.source !== "reader")
      .map((i) => i.key)
      .sort(),
    papers
      .slice(1)
      .map((i) => i.key)
      .sort(),
  );
  const draft = await evaluate(
    "const p=d.getElementById('confucius-prompt');return {value:p.value,html:p.innerHTML};",
  );
  assert.match(draft.value, /Compare @\[Mention Paper Alpha/);
  assert.match(draft.value, / with @\[Mention Paper Beta/);
  assert.match(draft.value, /请保留正文/);
  assert.equal(
    await evaluate(
      "return d.querySelectorAll('#confucius-prompt .confucius-inline-reference').length;",
    ),
    3,
  );
  check(
    "@ materials retain insertion positions, plain-text prompt contents and distinct source identities",
  );
  await capture("light-inline");
  await evaluate(
    `d.querySelector('[data-composer-source="item:1:${papers[1].key}"]').click();return true;`,
  );
  await wait("return !!d.getElementById('confucius-reference-search');");
  await evaluate(
    "const s=d.getElementById('confucius-reference-search');s.value='Mention Paper Beta';s.dispatchEvent(new win.Event('input',{bubbles:true}));return true;",
  );
  await wait("return d.querySelectorAll('[data-mention-index]').length===1;");
  await evaluate(
    "d.getElementById('confucius-reference-search').dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true;",
  );
  await wait(
    `return !host.sessions.get('${task.id}').record.lockedContext.items.some(i=>i.key==='${papers[1].key}')&&!d.getElementById('confucius-send').disabled;`,
  );
  await key("z", { metaKey: true });
  await wait(
    `return host.sessions.get('${task.id}').record.lockedContext.items.some(i=>i.key==='${papers[1].key}')&&!d.getElementById('confucius-send').disabled;`,
  );
  check(
    "Clicking an @ reference searches and replaces it by identity; undo restores its prior location",
  );

  await wait(
    `return host.sessions.get('${task.id}').record.draft?.mentions?.length===2;`,
  );
  await evaluate(
    `const node=d.querySelector('[data-composer-source="item:1:${papers[1].key}"]');node.focus();node.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));return true;`,
  );
  await wait(
    `return !host.sessions.get('${task.id}').record.lockedContext.items.some(i=>i.key==='${papers[1].key}')&&!d.getElementById('confucius-send').disabled;`,
  );
  assert.ok(
    (await current()).lockedContext.items.some((i) => i.key === papers[2].key),
  );
  assert.equal(
    (await current()).lockedContext.reader.attachmentKey,
    papers[0].pdfKey,
  );
  assert.match(
    await evaluate("return d.getElementById('confucius-prompt').value;"),
    /请保留正文/,
  );
  await key("z", { ctrlKey: true });
  await wait(
    `return host.sessions.get('${task.id}').record.lockedContext.items.some(i=>i.key==='${papers[1].key}')&&!d.getElementById('confucius-send').disabled;`,
  );
  check(
    "Removing and undoing one @ reference changes only that material and preserves surrounding prose",
  );
  await evaluate(
    "const p=d.getElementById('confucius-prompt');p.focus();p.setSelectionRange(0,0);p.dispatchEvent(new win.CompositionEvent('compositionstart',{bubbles:true}));return true;",
  );
  await key("Backspace", { isComposing: true });
  await key("Enter", { isComposing: true });
  assert.ok((await current()).lockedContext.reader);
  assert.equal(requests.length, 0);
  await evaluate(
    "d.getElementById('confucius-prompt').dispatchEvent(new win.CompositionEvent('compositionend',{bubbles:true}));return true;",
  );
  check("IME composition cannot remove references or submit a prompt");
  const separated = await evaluate(
    "const p=d.getElementById('confucius-prompt');p.focus();p.setSelectionRange(p.value.length,p.value.length);d.execCommand('insertText',false,'\\n  ');const event=new win.KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true});p.dispatchEvent(event);return event.defaultPrevented;",
  );
  assert.equal(separated, false);
  check(
    "Backspace on ordinary whitespace leaves reference deletion to its actual boundary",
  );

  const referenced = await instance.rpc("task/new", {
    title: "Reference fixture conversation",
    autoStart: false,
    context: { version: 1, capturedAt: Date.now(), items: [] },
  });
  await evaluate(
    "const p=d.getElementById('confucius-prompt');p.focus();p.setSelectionRange(p.value.length,p.value.length);return true;",
  );
  await text(" @Reference fixture");
  await wait("return !!d.querySelector('.confucius-mention-tabs');");
  await evaluate(
    "d.querySelectorAll('.confucius-mention-tabs button')[1].click();return true;",
  );
  await wait(
    "return [...d.querySelectorAll('[data-mention-index]')].some(n=>n.textContent.includes('Reference fixture conversation'));",
  );
  await evaluate(
    "[...d.querySelectorAll('[data-mention-index]')].find(n=>n.textContent.includes('Reference fixture conversation')).click();return true;",
  );
  await wait(
    `return host.sessions.get('${task.id}').record.draft?.references.some(r=>r.taskId==='${referenced.id}');`,
  );
  await evaluate(
    `const n=d.querySelector('[data-composer-source="task:${referenced.id}"]');n.focus();n.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));return true;`,
  );
  await wait(
    `return host.sessions.get('${task.id}').record.draft?.references.length===0;`,
  );
  await key("z", { metaKey: true });
  await wait(
    `return host.sessions.get('${task.id}').record.draft?.references.some(r=>r.taskId==='${referenced.id}');`,
  );
  await key("z", { metaKey: true, shiftKey: true });
  await wait(
    `return host.sessions.get('${task.id}').record.draft?.references.length===0;`,
  );
  check(
    "Conversation @ references use the same inline insertion, removal, undo and draft persistence",
  );

  await evaluate(
    "const p=d.getElementById('confucius-prompt');p.focus();p.setSelectionRange(p.value.length,p.value.length);const e=new win.ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:new win.DataTransfer()});e.clipboardData.setData('text/plain','\\nplain paste\\n第二行');e.clipboardData.setData('text/html','<img src=x onerror=alert(1)>');p.dispatchEvent(e);return true;",
  );
  assert.equal(
    await evaluate(
      "return d.querySelectorAll('#confucius-prompt img').length;",
    ),
    0,
  );
  assert.match(
    await evaluate("return d.getElementById('confucius-prompt').value;"),
    /plain paste\n第二行/,
  );
  check("Paste retains plain text and line breaks without accepting rich HTML");
  await wait(
    `return host.sessions.get('${task.id}').record.draft?.text.includes('第二行');`,
  );
  await instance.stop({ graceful: true });
  await instance.launch();
  await open();
  await wait(
    `return !!d.querySelector('[data-task-id="${task.id}"] .confucius-task-open');`,
  );
  await evaluate(
    `d.querySelector('[data-task-id="${task.id}"] .confucius-task-open').click();return true;`,
  );
  await wait(
    `return d.querySelector('[data-entry-id="overview:${task.id}"]');`,
  );
  await wait(
    "return d.querySelectorAll('#confucius-prompt .confucius-inline-reference').length===3;",
  );
  assert.match(
    await evaluate("return d.getElementById('confucius-prompt').value;"),
    /plain paste\n第二行/,
  );
  assert.equal((await current()).draft.mentions.length, 2);
  check(
    "Ordinary restart preserves inline reference identity, placement, prose and PDF binding",
  );
  await evaluate(
    "Zotero.__inlineQA={errors:[]};win.addEventListener('error',e=>qa.errors.push(e.message));d.getElementById('confucius-pdf-binding').click();return true;",
  );
  await wait(
    `return !!d.querySelector('[data-pdf-key="${papers[2].pdfKey}"]');`,
  );
  await evaluate(
    `d.querySelector('[data-pdf-key="${papers[2].pdfKey}"]').click();return true;`,
  );
  await wait(
    `return host.sessions.get('${task.id}').record.lockedContext.reader?.attachmentKey==='${papers[2].pdfKey}'&&!d.getElementById('confucius-send').disabled;`,
  );
  check(
    "Clicking the inline PDF opens a searchable picker and switches the exact attachment",
  );
  holdModel = true;
  await evaluate("d.getElementById('confucius-send').click();return true;");
  await until(() => requests.length > 0);
  await evaluate(
    "const b=d.getElementById('confucius-pdf-binding');b.focus();b.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));return true;",
  );
  assert.equal(
    (await current()).lockedContext.reader.attachmentKey,
    papers[2].pdfKey,
  );
  check(
    "References cannot be removed while the model is using their source snapshot",
  );
  holdModel = false;
  releaseModel();

  await wait(
    `return host.sessions.get('${task.id}').record.status!=='running'&&host.sessions.get('${task.id}').record.run;`,
  );
  // Host completion precedes the workspace's next poll. Editing sources stays
  // locked until that poll restores the idle UI; do not race the intentional lock.
  await wait(
    "return d.getElementById('confucius-stop').style.display==='none'&&d.getElementById('confucius-send').style.display!=='none';",
  );
  assert.equal(
    (await current()).run.sources.reader.attachmentKey,
    papers[2].pdfKey,
  );
  assert.ok(
    requests.some((r) => JSON.stringify(r.messages).includes("plain paste")),
  );
  check(
    "Send uses the edited prose, explicit mentions and switched PDF in the actual model request",
  );
  for (const [theme, language, size, width] of [
    ["light", "zh-CN", 14, 1120],
    ["dark", "en-US", 28, 430],
  ]) {
    await instance.rpc("config/set", {
      uiTheme: theme,
      uiLanguage: language,
      uiFontSize: size,
    });
    await evaluate(`win.resizeTo(${width},780);return true;`);
    await wait(`return win.innerWidth<=${width};`);
    await capture(`${theme}-layout`);
    const geometry = await evaluate(
      "const p=d.getElementById('confucius-prompt'),r=p.getBoundingClientRect();return {width:win.innerWidth,scroll:d.documentElement.scrollWidth,editorWidth:r.width,refs:[...p.querySelectorAll('button')].map(b=>({width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}))};",
    );
    assert.ok(geometry.scroll <= geometry.width + 1);
    assert.ok(
      geometry.refs.every(
        (r) => r.width <= geometry.editorWidth && r.height >= 34,
      ),
    );
    report.styles.push({ theme, language, size, ...geometry });
  }
  await evaluate(
    "Services.prefs.setIntPref('ui.useAccessibilityTheme',1);return true;",
  );
  await wait("return win.matchMedia('(prefers-contrast: more)').matches;");
  await capture("high-contrast");
  check(
    "Light/Chinese, dark/English at 28px and 430px width, and native high contrast retain usable inline references",
  );
  await evaluate(
    "const p=d.getElementById('confucius-prompt');p.focus();const r=d.createRange();r.selectNodeContents(p);const s=d.getSelection();s.removeAllRanges();s.addRange(r);const e=new win.ClipboardEvent('cut',{bubbles:true,cancelable:true,clipboardData:new win.DataTransfer()});p.dispatchEvent(e);qa.copied=e.clipboardData.getData('text/plain');return true;",
  );
  await wait(
    `return !host.sessions.get('${task.id}').record.lockedContext.reader&&host.sessions.get('${task.id}').record.lockedContext.items.length===0&&!d.getElementById('confucius-send').disabled;`,
  );
  assert.match(await evaluate("return qa.copied;"), /Mention Paper/);
  await key("z", { metaKey: true });
  await wait(
    `return !!host.sessions.get('${task.id}').record.lockedContext.reader&&!d.getElementById('confucius-send').disabled;`,
  );
  await key("z", { metaKey: true, shiftKey: true });
  await wait(
    `return !host.sessions.get('${task.id}').record.lockedContext.reader&&!d.getElementById('confucius-send').disabled;`,
  );
  check(
    "Cut, undo and redo reconcile all selected references with persisted context",
  );
  await instance.stop({ graceful: true });
  await instance.launch();
  await open();
  await wait(
    `return !!d.querySelector('[data-task-id="${task.id}"] .confucius-task-open');`,
  );
  await evaluate(
    `d.querySelector('[data-task-id="${task.id}"] .confucius-task-open').click();return true;`,
  );
  await wait(
    `return d.querySelector('[data-entry-id="overview:${task.id}"]');`,
  );
  assert.equal((await current()).pdfBinding, "manual");
  assert.equal((await current()).lockedContext.reader, undefined);
  assert.equal((await current()).lockedContext.items.length, 0);
  check(
    "Removed references and explicit PDF unbinding remain removed after restart",
  );
  await evaluate("Zotero.__inlineQA={errors:[]};return true;");
  const legacyText = `Legacy @[${papers[1].title}] tail`;
  const legacy = await instance.rpc("task/new", {
    title: "Legacy draft fixture",
    autoStart: false,
    context: {
      version: 1,
      capturedAt: Date.now(),
      items: [
        {
          id: `item:1:${papers[1].key}`,
          libraryID: 1,
          key: papers[1].key,
          title: papers[1].title,
          source: "library",
        },
      ],
    },
  });
  await instance.rpc("task/draft", {
    taskId: legacy.id,
    text: legacyText,
    references: [],
  });
  await wait(
    `return !!d.querySelector('[data-task-id="${legacy.id}"] .confucius-task-open');`,
  );
  await evaluate(
    `d.querySelector('[data-task-id="${legacy.id}"] .confucius-task-open').click();return true;`,
  );
  await wait(
    `return d.querySelector('[data-entry-id="overview:${legacy.id}"]');`,
  );
  assert.equal(
    await evaluate("return d.getElementById('confucius-prompt').value;"),
    legacyText,
  );
  assert.equal(
    await evaluate(
      `return d.querySelectorAll('[data-composer-source="item:1:${papers[1].key}"]').length;`,
    ),
    1,
  );
  check(
    "Pre-upgrade plain-text @ drafts hydrate inline without duplicating or changing their text",
  );
  report.errors = await evaluate("return qa.errors;");
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.error = String(error);
  report.debug = await evaluate(
    "const p=d?.getElementById('confucius-prompt');return {taskId:d?.querySelector('[data-entry-id^=\"overview:\"]')?.dataset.entryId,html:p?.innerHTML,value:p?.value,send:d?.getElementById('confucius-send')?.disabled,records:[...host.sessions.values()].map(s=>({id:s.record.id,reader:s.record.lockedContext.reader?.attachmentKey,items:s.record.lockedContext.items.map(i=>i.key),active:s.activeTurnId,status:s.record.status})),errors:qa?.errors};",
  ).catch(() => null);
  process.exitCode = 1;
  console.error(error);
  await capture("failure").catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
  releaseModel?.();
  await instance.stop({ graceful: true });
  await new Promise((done) => server.close(done));
}
