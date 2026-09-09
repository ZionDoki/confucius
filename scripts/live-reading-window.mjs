#!/usr/bin/env node
// Native UI acceptance in a fresh profile, using a public paper specified by --pdf.
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
  flag("output", "output/reading-guide-implementation/window"),
);
if (!flag("pdf"))
  throw new Error("--pdf must point to Attention Is All You Need (1706.03762)");
await mkdir(output, { recursive: true });
const instance = await IsolatedZotero.create({
  root,
  binary: "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi: resolve(
    flag("xpi", join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi")),
  ),
  prefix: "reading-window-",
});
const checks = [];
const check = (text) => {
  checks.push(text);
  console.log("PASS " + text);
};
const e = (code) =>
  instance.rdp.evaluate(
    `const h=Zotero.Confucius.hooks.host;const ui=Zotero.__readingUI;const windows=[...Services.wm.getEnumerator(null)];const main=windows.find(w=>w.document.getElementById('confucius-root'));const workspace=main?.document.getElementById('confucius-root');const separate=windows.find(w=>w.document.getElementById('confucius-artifact-window'));const w=separate??workspace?.querySelector('.confucius-artifact-host')?.contentWindow;const d=w?.document;${code}`,
    15000,
  );
const screenshot = async (name) => {
  await e(`w.top.focus();w.focus();return true;`);
  await delay(200);
  const data = await e(
    `const c=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=w.innerWidth;c.height=w.innerHeight;const frame=w.frameElement;const area=frame?.getBoundingClientRect();c.getContext('2d').drawWindow(frame?w.parent:w,area?.left??0,area?.top??0,c.width,c.height,w.getComputedStyle(d.body).backgroundColor);return c.toDataURL('image/png');`,
  );
  await writeFile(
    join(output, name + ".png"),
    Buffer.from(data.split(",")[1], "base64"),
  );
};
let outcome;
try {
  await instance.launch();
  await writeFile(
    join(output, "run.json"),
    JSON.stringify(instance.publicState(), null, 2),
  );
  const layout = flag("layout", "sidebar");
  assert.ok(["sidebar", "window"].includes(layout));
  await e(
    `Zotero.Prefs.set('extensions.zotero.confucius.workspaceLayout',${JSON.stringify(layout)},true);Zotero.Prefs.set('extensions.zotero.confucius.workspaceWidth',940,true);Zotero.Prefs.set('extensions.zotero.confucius.workspaceHeight',900,true);return true;`,
  );
  await e(
    `const item=new Zotero.Item('journalArticle');item.setField('title','Attention Is All You Need');await item.saveTx();const pdf=await Zotero.Attachments.importFromFile({file:${JSON.stringify(resolve(flag("pdf")))},parentItemID:item.id});Zotero.__readingUI={item,pdf};return true;`,
  );
  const guide = {
    version: 1,
    overview:
      "不用循环或卷积，能不能做好机器翻译？这篇论文用注意力重新组织了编码器和解码器。",
    checkpoints: [
      {
        id: "opening",
        kind: "signpost",
        section: "1  Introduction",
        title: "为什么要换一种结构？",
        before:
          "开头先指出旧方法的瓶颈：词要按顺序处理，很难并行。作者由此引出一个问题——能不能让词直接看见彼此？",
        after: "接着看这个想法如何变成计算。",
        citationIds: ["intro"],
      },
      {
        id: "method",
        kind: "checkpoint",
        section: "3.2  Attention",
        title: "模型怎样决定该看哪些词？",
        before:
          "这部分把“关注相关的词”变成一次加权求和。先弄清权重从哪里来，再看公式会容易得多。",
        after: "接下来，作者把这样的注意力组合成多头结构。",
        citationIds: ["method"],
        reading:
          "把当前词的 query 与其他词的 key 比较，得到一组相关性分数。缩放后用 softmax 把分数变成权重，再对各个 value 加权求和。\n\n所以，注意力的输出不是“选中一个词”，而是把不同位置的信息按不同分量混合起来。这里解释的是计算过程；它不等于对模型语言理解能力的证明。",
        writing:
          "作者先用文字说清输入、输出和操作，再把整批计算写成一个矩阵公式。下一段解释缩放的原因，回答读者看到公式后自然会产生的疑问。",
        further:
          "举个解释性的例子：如果两个位置的权重是 0.8 和 0.2，输出就是 0.8 倍的第一个 value 加上 0.2 倍的第二个 value。这个例子用来理解加权，不是论文中的实验。",
      },
      {
        id: "evidence",
        kind: "checkpoint",
        section: "6  Results",
        title: "实验究竟支持了什么？",
        before:
          "接下来用翻译实验检验这套结构。读表格时，把模型大小、训练成本和翻译质量放在一起看。",
        after: "最后回到结论，区分已验证的结果与后续研究方向。",
        citationIds: ["results"],
        reading:
          "这些结果支持 Transformer 在论文所测试翻译任务上的表现。它们没有单独证明某一个结构选择是全部提升的原因；分析具体组件，还需要结合后面的消融实验。",
        writing:
          "作者先给出整体比较，再拆开讨论组件，让“方法有效”和“哪些选择有用”成为两个不同层次的问题。",
      },
    ],
    annotationsMarkdown:
      "这个界面验收样例没有新增 PDF 批注。来源带有一个不存在的批注标识，用于检查页码定位回退。[cite:method]",
  };
  await e(
    `const task=await h.rpc('task/new',{title:'陪读窗口验收',backend:'native',context:{version:1,capturedAt:Date.now(),items:[]}});const source={itemLibraryID:ui.item.libraryID,itemKey:ui.item.key,attachmentKey:ui.pdf.key,title:ui.item.getDisplayTitle()};const artifact=(await h.rpc('artifact/upsert',{taskId:task.id,kind:'deep_read',title:'Attention Is All You Need',body:{type:'markdown',markdown:'',readingGuide:${JSON.stringify(guide)}},citations:[{...source,id:'intro',page:1,quote:'Attention Is All You Need'},{...source,id:'method',page:4,annotationKey:'MISSINGA',quote:'Attention(Q, K, V) = softmax(QKᵀ / √dₖ)V'},{...source,id:'results',page:8,quote:'On the WMT 2014 English-to-German translation task'}],status:'ready'})).artifact;Object.assign(ui,{taskId:task.id,artifactId:artifact.id});Zotero.getMainWindow().document.getElementById('confucius-toolbar-button').click();return true;`,
  );
  await until(() =>
    e(
      `return [...Services.wm.getEnumerator(null)].some(w=>w.document.querySelector('.confucius-task-row'));`,
    ),
  );
  await e(
    `[...main.document.querySelectorAll('.confucius-task-row')].find(row=>row.dataset.taskId===ui.taskId).querySelector('.confucius-task-open').click();return true;`,
  );
  await until(() =>
    e(
      `return [...Services.wm.getEnumerator(null)].some(w=>w.document.querySelector('.confucius-artifact-file'));`,
    ),
  );
  await e(
    `main.document.querySelector('.confucius-artifact-file').click();return true;`,
  );
  await until(() =>
    e(`return d?.querySelectorAll('.confucius-guide-passage').length===3;`),
  );
  const embedded = await e(
    `const frame=workspace.querySelector('.confucius-artifact-host').getBoundingClientRect();const root=workspace.getBoundingClientRect();return {separate:!!separate,width:frame.width,height:frame.height,rootWidth:root.width,rootHeight:root.height,back:!!d.getElementById('confucius-artifact-back'),inert:workspace.querySelector('.confucius-columns').inert};`,
  );
  assert.equal(embedded.separate, false);
  assert.equal(embedded.back, true);
  assert.equal(embedded.inert, true);
  assert.equal(embedded.width, embedded.rootWidth);
  assert.equal(embedded.height, embedded.rootHeight);
  await screenshot("embedded-companion");
  check(
    "Artifacts fill the plugin workspace by default, with a return control",
  );
  await e(
    `const input=d.querySelector('textarea');input.value='保持这个问题';input.dispatchEvent(new w.Event('input'));d.querySelectorAll('.confucius-artifact-view-tabs button')[1].click();d.getElementById('confucius-artifact-detach').click();return true;`,
  );
  await until(() =>
    e(
      `return !!separate && !workspace.querySelector('.confucius-artifact-host') && d.querySelectorAll('.confucius-artifact-view-tabs button')[1]?.getAttribute('aria-selected')==='true';`,
    ),
  );
  await e(
    `d.querySelectorAll('.confucius-artifact-view-tabs button')[0].click();return true;`,
  );
  await until(() =>
    e(`return d.querySelector('textarea')?.value==='保持这个问题';`),
  );
  check("Detaching preserves the chosen view and private question draft");
  await e(
    `main.document.querySelector('.confucius-artifact-file').click();return true;`,
  );
  await until(() =>
    e(
      `return !separate && d?.querySelector('textarea')?.value==='保持这个问题';`,
    ),
  );
  await e(`d.getElementById('confucius-artifact-back').click();return true;`);
  await until(() =>
    e(
      `return !workspace.querySelector('.confucius-artifact-host') && !workspace.querySelector('.confucius-columns').inert;`,
    ),
  );
  assert.equal(
    await e(
      `return !!main.document.querySelector('.confucius-artifact-file');`,
    ),
    true,
  );
  check(
    "Reopening returns the same artifact to the workspace; Back restores the task",
  );
  await e(
    `main.document.querySelector('.confucius-artifact-file').click();return true;`,
  );
  await until(() =>
    e(`return !!d?.getElementById('confucius-artifact-detach');`),
  );
  await e(`d.getElementById('confucius-artifact-detach').click();return true;`);
  await until(() =>
    e(
      `return !!separate && d?.querySelectorAll('.confucius-guide-passage').length===3;`,
    ),
  );
  await e(`w.resizeTo(940,900);w.focus();return true;`);
  assert.equal(await e(`return d.querySelectorAll('textarea').length;`), 1);
  assert.equal(
    await e(`return !!d.querySelector('.confucius-guide-route');`),
    false,
  );
  check("Continuous article, concise signposts and a single bottom composer");
  await screenshot("companion-wide");
  await e(
    `const s=d.getElementById('confucius-artifact-dialog-body');const cue=d.querySelector('.confucius-reading-guide [data-checkpoint-id="method"] .confucius-guide-signpost');s.scrollTop+=cue.getBoundingClientRect().bottom-s.getBoundingClientRect().top+10;return true;`,
  );
  await until(() =>
    e(`return !d.querySelector('.confucius-guide-floating').hidden;`),
  );
  const geometry = await e(
    `const f=d.querySelector('.confucius-guide-floating').getBoundingClientRect();const s=d.getElementById('confucius-artifact-dialog-body').getBoundingClientRect();const link=d.querySelector('.confucius-reading-guide [data-checkpoint-id="method"] .confucius-guide-source-page').getBoundingClientRect();return {floatingBottom:f.bottom,scrollTop:s.top,linkTop:link.top};`,
  );
  assert.ok(geometry.scrollTop >= geometry.floatingBottom);
  assert.ok(geometry.linkTop > geometry.floatingBottom);
  await screenshot("floating-summary");
  check(
    "Floating summary reserves space above the scroller and never overlaps the source link",
  );
  const selectedSource = await e(
    `const source=d.querySelector('.confucius-reading-guide [data-checkpoint-id="method"] .confucius-guide-source-quote');const range=d.createRange();range.selectNodeContents(source);w.getSelection().removeAllRanges();w.getSelection().addRange(range);const original=h.rpc;let opens=0;h.rpc=function(method,params){if(method==='reader/open')opens++;return original.call(this,method,params);};try{source.parentElement.click();d.dispatchEvent(new w.Event('mouseup',{bubbles:true}));return {opens,quoteVisible:!d.querySelector('.confucius-guide-quote-action').hidden};}finally{h.rpc=original;w.getSelection().removeAllRanges();}`,
  );
  assert.equal(selectedSource.opens, 0);
  assert.equal(selectedSource.quoteVisible, true);
  check(
    "Selecting an original excerpt offers quotation without accidentally opening the PDF",
  );
  const neutralColor = await e(
    `return w.getComputedStyle(d.querySelector('.confucius-guide-floating .confucius-guide-signpost')).backgroundColor;`,
  );
  await e(
    `await h.rpc('reader/open',{libraryID:ui.pdf.libraryID,key:ui.pdf.key,pageIndex:3});return true;`,
  );
  await until(() =>
    e(
      `return d.querySelector('.confucius-guide-floating .is-pdf-current')?.dataset.checkpointId==='method';`,
    ),
  );
  await delay(900);
  const lit = await e(
    `const cue=d.querySelector('.confucius-guide-floating .is-pdf-current');ui.lit=cue;ui.guideTop=d.getElementById('confucius-artifact-dialog-body').scrollTop;const c=w.getComputedStyle(cue);const source=d.querySelector('.confucius-reading-guide [data-checkpoint-id="method"] .confucius-guide-source-page').getBoundingClientRect();return {color:c.backgroundColor,glow:c.boxShadow,label:!cue.querySelector('.confucius-guide-current').hidden,sourceTop:source.top,floatingBottom:d.querySelector('.confucius-guide-floating').getBoundingClientRect().bottom};`,
  );
  assert.notEqual(lit.color, neutralColor);
  assert.notEqual(lit.glow, "none");
  assert.equal(lit.label, true);
  assert.ok(lit.sourceTop > lit.floatingBottom);
  await screenshot("current-reading");
  await e(
    `Zotero.Reader._readers.find(r=>r.itemID===ui.pdf.id)._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber=5;return true;`,
  );
  await delay(700);
  assert.equal(
    await e(
      `return d.querySelector('.confucius-guide-floating .is-pdf-current')===ui.lit && d.getElementById('confucius-artifact-dialog-body').scrollTop===ui.guideTop;`,
    ),
    true,
  );
  check(
    "Current PDF section stays lit without pointer hover or repeated scrolling within the section",
  );
  const summaryClick = await e(
    `const original=h.rpc;let call;h.rpc=function(method,params){if(method==='reader/open')call=params;return original.call(this,method,params);};try{const cue=d.querySelector('.confucius-guide-floating .is-pdf-current');cue.click();return {call,pressed:cue.classList.contains('is-pressed')};}finally{h.rpc=original;}`,
  );
  assert.equal(summaryClick.pressed, true);
  assert.equal(summaryClick.call.pageIndex, 3);
  assert.equal(summaryClick.call.annotationKey, undefined);
  await until(() =>
    e(
      `return Zotero.Reader._readers.find(r=>r.itemID===ui.pdf.id)._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber===4;`,
    ),
  );
  check(
    "Click feedback accompanies navigation to the summary's starting physical page",
  );
  await e(
    `Zotero.Reader._readers.find(r=>r.itemID===ui.pdf.id)._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber=8;return true;`,
  );
  await until(() =>
    e(
      `return d.querySelector('.confucius-guide-floating .is-pdf-current')?.dataset.checkpointId==='evidence';`,
    ),
  );
  assert.equal(
    await e(
      `return d.querySelector('.confucius-reading-guide [data-checkpoint-id="method"] .confucius-guide-signpost').classList.contains('is-pdf-current');`,
    ),
    false,
  );
  assert.equal(
    await e(`return d.querySelector('textarea').value;`),
    "保持这个问题",
  );
  await e(
    `Zotero.getMainWindow().Zotero_Tabs.select('zotero-pane');return true;`,
  );
  await until(() => e(`return !d.querySelector('.is-pdf-current');`));
  await e(
    `await h.rpc('reader/open',{libraryID:ui.pdf.libraryID,key:ui.pdf.key,pageIndex:3});return true;`,
  );
  await until(() =>
    e(
      `return d.querySelector('.confucius-guide-floating .is-pdf-current')?.dataset.checkpointId==='method';`,
    ),
  );
  await delay(900);
  check(
    "The glow moves to the next section, clears outside this PDF, and preserves the question",
  );
  const rest = await e(
    `const cue=d.querySelector('.confucius-guide-floating .is-pdf-current');ui.hoverCue=cue;return w.getComputedStyle(cue).backgroundColor;`,
  );
  await e(
    `w.InspectorUtils.addPseudoClassLock(ui.hoverCue,':hover');return true;`,
  );
  await delay(250);
  const hover = await e(
    `return w.getComputedStyle(ui.hoverCue).backgroundColor;`,
  );
  assert.notEqual(hover, rest);
  await e(
    `w.InspectorUtils.addPseudoClassLock(ui.hoverCue,':active');return true;`,
  );
  await delay(250);
  assert.notEqual(
    await e(`return w.getComputedStyle(ui.hoverCue).backgroundColor;`),
    hover,
  );
  await e(
    `w.InspectorUtils.removePseudoClassLock(ui.hoverCue,':active');w.InspectorUtils.removePseudoClassLock(ui.hoverCue,':hover');w.InspectorUtils.addPseudoClassLock(ui.hoverCue,':focus-visible');return true;`,
  );
  assert.notEqual(
    await e(`return w.getComputedStyle(ui.hoverCue).outlineStyle;`),
    "none",
  );
  await e(
    `w.InspectorUtils.removePseudoClassLock(ui.hoverCue,':focus-visible');return true;`,
  );
  check(
    "Hover, pressed and keyboard focus states remain distinct from the persistent glow",
  );
  await e(
    `await h.rpc('config/set',{uiTheme:'dark'});w.resizeTo(560,780);return true;`,
  );
  await until(() =>
    e(
      `return d.documentElement.getAttribute('data-confucius-theme')==='dark' && w.innerWidth<600;`,
    ),
  );
  await delay(400);
  assert.equal(
    await e(
      `return d.documentElement.scrollWidth<=w.innerWidth && d.querySelector('.confucius-artifact-toolbar').scrollWidth<=w.innerWidth;`,
    ),
    true,
  );
  await screenshot("current-reading-dark-narrow");
  await e(
    `await h.rpc('config/set',{uiTheme:'light'});w.resizeTo(940,900);return true;`,
  );
  await until(() =>
    e(
      `return d.documentElement.getAttribute('data-confucius-theme')==='light' && w.innerWidth===940;`,
    ),
  );
  await delay(400);
  await screenshot("current-reading");
  check(
    "The lit section and padded tabs remain readable in dark and narrow layouts",
  );
  await e(
    `main.document.querySelector('.confucius-artifact-file').click();return true;`,
  );
  await until(() =>
    e(
      `return !separate && d?.querySelector('.confucius-guide-floating .is-pdf-current')?.dataset.checkpointId==='method';`,
    ),
  );
  await delay(400);
  await screenshot("embedded-current-reading");
  check(
    "Persistent PDF lighting also restores in the embedded workspace reader",
  );
  await e(
    `d.querySelectorAll('.confucius-artifact-view-tabs button')[1].click();const frame=Zotero.Reader._readers.find(r=>r.itemID===ui.pdf.id)._internalReader._primaryView._iframeWindow;Zotero.getMainWindow().focus();frame.focus();const page=frame.document.querySelector('.page[data-page-number="4"]').getBoundingClientRect();const x=Math.max(4,Math.min(frame.innerWidth-4,page.left+60));const y=Math.max(4,Math.min(frame.innerHeight-4,page.top+80));const mouse=Cu.unwaiveXrays(frame).windowUtils;for(const count of [1,2]){mouse.sendMouseEvent('mousedown',x,y,0,count,0);mouse.sendMouseEvent('mouseup',x,y,0,count,0);};return true;`,
  );
  await until(() =>
    e(
      `return d.querySelectorAll('.confucius-artifact-view-tabs button')[0]?.getAttribute('aria-selected')==='true' && d.querySelector('.confucius-guide-floating .is-pdf-current')?.dataset.checkpointId==='method';`,
    ),
  );
  assert.equal(
    await e(`return d.querySelector('textarea').value;`),
    "保持这个问题",
  );
  check(
    "Double-clicking the PDF returns from the embedded report to the matching companion section",
  );
  // Deterministic UI answers: exercise focus and pending input without model calls.
  await e(
    `const oldBackend=h.sessions.get(ui.taskId).record.backend;h.sessions.get(ui.taskId).record.backend='codex';try{const a=await h.artifacts.get(ui.artifactId);const cp=d.querySelector('.confucius-discussion-scope').textContent;const checkpoint=a.body.readingGuide.checkpoints.find(c=>c.title===cp);const result=await h.rpc('readingDiscussion/open',{artifactId:a.id,revision:a.revision,checkpointId:checkpoint.id,create:true});const stored=await h.readingStore.get(a.id,result.discussion.id);stored.record.messages=[{id:'fixture-question',role:'user',text:'解释这一段',createdAt:Date.now()},{id:'fixture-answer',role:'assistant',text:'这是一条合成的界面验收回答。',createdAt:Date.now()}];stored.record.status='completed';stored.record.sequence++;await h.readingStore.save(a.id);ui.discussionId=result.discussion.id;}finally{h.sessions.get(ui.taskId).record.backend=oldBackend;}d.querySelectorAll('.confucius-artifact-view-tabs button')[1].click();d.querySelectorAll('.confucius-artifact-view-tabs button')[0].click();return true;`,
  );
  await until(() =>
    e(`return d.querySelectorAll('.confucius-discussion-message').length===2;`),
  );
  // macOS can leave an isolated test window backgrounded. Deliver the same focus
  // event explicitly in that case; exercise the actual installed handler/order.
  await e(
    `const input=d.querySelector('.confucius-reading-discussion textarea');ui.originalFocus=input.focus;input.focus=function(){ui.originalFocus.call(this);if(!d.hasFocus())this.dispatchEvent(new w.FocusEvent('focus'));};input.focus();return true;`,
  );
  assert.equal(
    await e(
      `return d.querySelector('.confucius-reading-discussion').classList.contains('is-open');`,
    ),
    true,
    "Focusing the question composer opens existing messages",
  );
  await e(
    `const close=d.querySelector('.confucius-discussion-heading button');close.focus();close.click();return true;`,
  );
  assert.equal(
    await e(
      `return d.activeElement===d.querySelector('.confucius-reading-discussion textarea') && !d.querySelector('.confucius-reading-discussion').classList.contains('is-open');`,
    ),
    true,
    "Collapsing focuses the composer and hides messages",
  );
  await e(
    `d.querySelector('.confucius-reading-discussion textarea').focus=ui.originalFocus;return true;`,
  );
  check(
    "Collapsing a conversation keeps the composer focused without reopening its bubbles",
  );
  await e(
    `ui.originalRpc=h.rpc;h.rpc=function(method,params){if(method==='readingDiscussion/prompt'){ui.submitted=params;return new Promise(resolve=>ui.reply=resolve);}return ui.originalRpc.call(this,method,params);};const input=d.querySelector('.confucius-reading-discussion textarea');input.value='先发送的问题';input.dispatchEvent(new w.Event('input'));d.querySelector('.confucius-discussion-send').click();input.value='随后输入的草稿';input.dispatchEvent(new w.Event('input'));return true;`,
  );
  await until(() => e(`return !!ui.reply;`));
  assert.equal(await e(`return ui.submitted.text;`), "先发送的问题");
  await e(
    `const record=(await h.readingStore.get(ui.artifactId,ui.discussionId)).record;ui.reply({discussion:{...record,status:'completed',sequence:record.sequence+1}});h.rpc=ui.originalRpc;return true;`,
  );
  await until(() =>
    e(`return !d.querySelector('.confucius-discussion-send').disabled;`),
  );
  assert.equal(
    await e(
      `return d.querySelector('.confucius-reading-discussion textarea').value;`,
    ),
    "随后输入的草稿",
  );
  await e(
    `const input=d.querySelector('.confucius-reading-discussion textarea');input.value='保持这个问题';input.dispatchEvent(new w.Event('input'));d.querySelector('.confucius-discussion-heading button').click();return true;`,
  );
  check(
    "A pending question sends its captured text and preserves subsequently typed drafts",
  );
  if (args.includes("--save-note")) {
    await e(
      `d.getElementById('confucius-artifact-writeback').click();return true;`,
    );
    await until(() =>
      e(
        `return d.querySelector('.confucius-note-save-paper h2') && !d.getElementById('confucius-writeback-request').disabled;`,
      ),
    );
    const saveLayout = await e(
      `const overlay=d.getElementById('confucius-writeback-overlay');const buttons=[...d.querySelectorAll('.confucius-note-save-views button')].map(b=>b.getBoundingClientRect());const paper=d.querySelector('.confucius-note-save-paper');return {heading:d.getElementById('confucius-writeback-heading').textContent,selects:overlay.querySelectorAll('select').length,viewsOverlap:buttons[0].right>buttons[1].left,reportDisabled:d.getElementById('confucius-writeback-report').disabled,quote:!!paper.querySelector('blockquote'),links:paper.querySelectorAll('a').length,previous:!!d.querySelector('.confucius-note-save-previous'),privateDraft:paper.textContent.includes('保持这个问题')};`,
    );
    assert.equal(saveLayout.heading, "保存 Zotero 笔记");
    assert.equal(saveLayout.selects, 0);
    assert.equal(saveLayout.viewsOverlap, false);
    assert.equal(saveLayout.reportDisabled, true);
    assert.equal(saveLayout.quote, true);
    assert.ok(saveLayout.links >= 3);
    assert.equal(saveLayout.previous, false);
    assert.equal(saveLayout.privateDraft, false);
    await screenshot("save-note-guide");
    check(
      "Save Zotero note uses spaced view buttons and a full formatted preview without private drafts",
    );
    await e(
      `d.getElementById('confucius-writeback-request').click();return true;`,
    );
    await until(() =>
      e(
        `return d.getElementById('confucius-writeback-request')?.textContent==='确认保存' && !d.getElementById('confucius-writeback-request').disabled;`,
      ),
    );
    assert.equal(
      await e(
        `return d.getElementById('confucius-writeback-guide').disabled && d.getElementById('confucius-writeback-target').disabled;`,
      ),
      true,
    );
    await e(
      `d.getElementById('confucius-writeback-cancel').click();return true;`,
    );
    await until(() =>
      e(
        `return (await h.artifacts.get(ui.artifactId)).writeback?.state!=='pending';`,
      ),
    );
    assert.equal(await e(`return ui.item.getNotes().length;`), 0);
    check(
      "Cancelling the prepared save denies its approval and creates no note",
    );
    await e(
      `d.getElementById('confucius-artifact-writeback').click();return true;`,
    );
    await until(() =>
      e(
        `return d.getElementById('confucius-writeback-request') && !d.getElementById('confucius-writeback-request').disabled;`,
      ),
    );
    await e(
      `const a=await h.artifacts.get(ui.artifactId);ui.expectedGuide=(await h.rpc('artifact/writebackPreview',{id:a.id,revision:a.revision,target:'zotero_note',view:'guide'})).note.html;d.getElementById('confucius-writeback-request').click();return true;`,
    );
    await until(() =>
      e(
        `return d.getElementById('confucius-writeback-request')?.textContent==='确认保存' && !d.getElementById('confucius-writeback-request').disabled;`,
      ),
    );
    await e(
      `d.getElementById('confucius-writeback-request').click();return true;`,
    );
    await until(() =>
      e(
        `const a=await h.artifacts.get(ui.artifactId);return a.writeback?.state==='committed' || (a.writeback?.state==='failed' && (()=>{throw new Error(JSON.stringify(a.writeback))})());`,
      ),
    );
    const noteResult = await e(
      `const a=await h.artifacts.get(ui.artifactId);const [libraryID,key]=a.writeback.targetRef.split(':');ui.savedNote=Zotero.Items.getByLibraryAndKey(Number(libraryID),key);return {html:ui.savedNote.getNote(),expected:ui.expectedGuide,parentID:ui.savedNote.parentID,itemID:ui.item.id,notes:ui.item.getNotes().length};`,
    );
    assert.equal(noteResult.html, noteResult.expected);
    assert.equal(noteResult.parentID, noteResult.itemID);
    assert.equal(noteResult.notes, 1);
    assert.match(noteResult.html, /<h2>/);
    assert.match(noteResult.html, /<blockquote>/);
    assert.match(noteResult.html, /href="zotero:\/\/open-pdf/);
    assert.doesNotMatch(noteResult.html, /保持这个问题/);
    await writeFile(join(output, "saved-guide-note.html"), noteResult.html);
    check(
      "Confirmed companion save creates one child note with the exact preview HTML and working source URLs",
    );
    const report =
      "# 一分钟概览\n\n这篇论文用注意力重新组织编码器与解码器。\n\n## 关键证据\n\n| 证据 | 边界 |\n| --- | --- |\n| **翻译实验** [cite:results] | 本文测试的任务 |\n\n## 方法\n\n注意力把不同位置的信息加权组合。\n\n$$A=\\mathrm{softmax}(QK^T)V$$\n\n> 这是排版验收用的简短报告样例。";
    await e(
      `const a=await h.artifacts.get(ui.artifactId);await h.rpc('artifact/upsert',{id:a.id,taskId:a.taskId,kind:a.kind,title:a.title,body:{...a.body,markdown:${JSON.stringify(report)}},citations:a.citations,status:'ready'});return true;`,
    );
    await until(() =>
      e(
        `return d.querySelector('.confucius-artifact-revision-trigger')?.textContent.includes('2');`,
      ),
    );
    await e(
      `d.querySelectorAll('.confucius-artifact-view-tabs button')[1].click();d.getElementById('confucius-artifact-writeback').click();return true;`,
    );
    await until(() =>
      e(
        `return !!d.querySelector('.confucius-note-save-paper table') && !d.getElementById('confucius-writeback-request').disabled;`,
      ),
    );
    assert.equal(
      await e(
        `return d.getElementById('confucius-writeback-report').getAttribute('aria-pressed')==='true' && !!d.querySelector('.confucius-note-save-paper math') && !d.querySelector('.confucius-note-save-previous').open;`,
      ),
      true,
    );
    await screenshot("save-note-report");
    await e(
      `await h.rpc('config/set',{uiTheme:'dark'});w.top.resizeTo(560,780);return true;`,
    );
    await until(() =>
      e(
        `return d.documentElement.getAttribute('data-confucius-theme')==='dark' && w.innerWidth<600;`,
      ),
    );
    await delay(400);
    const compact = await e(
      `const panel=d.querySelector('.confucius-note-save-panel');const rect=panel.getBoundingClientRect();const actions=d.querySelector('.confucius-note-save-actions').getBoundingClientRect();return {width:w.innerWidth,scroll:d.documentElement.scrollWidth,left:rect.left,right:rect.right,bottom:actions.bottom,height:w.innerHeight};`,
    );
    assert.ok(compact.scroll <= compact.width);
    assert.ok(compact.left >= 0 && compact.right <= compact.width);
    assert.ok(compact.bottom <= compact.height);
    await screenshot("save-note-dark-narrow");
    check(
      "Existing note stays folded above the report; table, math and save controls fit dark narrow windows",
    );
    await e(
      `d.getElementById('confucius-writeback-request').click();return true;`,
    );
    await until(() =>
      e(
        `return d.getElementById('confucius-writeback-request')?.textContent==='确认保存' && !d.getElementById('confucius-writeback-request').disabled;`,
      ),
    );
    await e(
      `d.getElementById('confucius-writeback-request').click();return true;`,
    );
    await until(() =>
      e(
        `return (await h.artifacts.get(ui.artifactId)).writeback?.state==='committed';`,
      ),
    );
    const updated = await e(
      `const a=await h.artifacts.get(ui.artifactId);return {html:ui.savedNote.getNote(),notes:ui.item.getNotes().length,view:a.writeback.view,revision:a.writeback.revision,guide:!!a.body.readingGuide,expected:(await h.rpc('artifact/writebackPreview',{id:a.id,revision:a.revision,target:'zotero_note',view:'report'})).note.html};`,
    );
    assert.equal(updated.notes, 1);
    assert.equal(updated.html, updated.expected);
    assert.equal(updated.view, "report");
    assert.equal(updated.revision, 2);
    assert.equal(updated.guide, true);
    assert.match(updated.html, /<table>/);
    assert.match(updated.html, /<pre class="math">/);
    assert.doesNotMatch(updated.html, /保持这个问题/);
    await writeFile(join(output, "saved-report-note.html"), updated.html);
    check(
      "Saving the report updates the same note at the selected revision and leaves the companion intact",
    );
  }
  console.log("READY " + output);
  // Keep the actual window available for additional native interaction probes.
  outcome = "ready";
  for (let i = 0; i < 1800 && !args.includes("--close"); i++) await delay(1000);
} catch (error) {
  outcome = String(error);
  console.error(outcome);
  process.exitCode = 1;
} finally {
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify({ checks, outcome }, null, 2),
  );
  await instance.stop({ graceful: true }).catch(() => {});
}
