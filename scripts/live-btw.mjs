/** Isolated Zotero acceptance: real readers and Native loop, simulated model. */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/btw-live");
await mkdir(output, { recursive: true });
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ??
    (process.platform === "darwin"
      ? "/Applications/Zotero.app/Contents/MacOS/zotero"
      : "C:/Program Files/Zotero/zotero.exe"),
  xpi: join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "btw-acceptance-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\n',
);
const checks = [];
const evaluate = (code) =>
  instance.rdp.evaluate(
    `
 const host=Zotero.Confucius.hooks.host, qa=Zotero.__btwQA;
 const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml');
 const d=win?.document;
 const ad=d?.querySelector('.confucius-artifact-host')?.contentDocument, aw=ad?.defaultView;
 ${code}`,
    30_000,
  );
const wait = (code) => until(() => evaluate(code), 20_000, 100);
const capture = async (name, target = "d.querySelector('.confucius-btw')") => {
  const png =
    await evaluate(`const node=${target},dw=node.ownerDocument.defaultView,r=node.getBoundingClientRect();
   const canvas=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');canvas.width=r.width;canvas.height=r.height;
   canvas.getContext('2d').drawWindow(dw,r.x,r.y,r.width,r.height,'white');return canvas.toDataURL('image/png');`);
  await writeFile(
    join(output, name + ".png"),
    Buffer.from(png.split(",")[1], "base64"),
  );
};
try {
  const environment = await instance.launch();
  console.log("Isolated Zotero launched", environment.zotero);
  await evaluate(`
    Zotero.__btwQA={requests:[],pending:[],errors:[]};const q=Zotero.__btwQA;
    await host.rpc('config/set',{baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic',model:'btw-fixture',maxTokens:4096,contextWindowTokens:32768,historyAutoCleanup:false});
    host.openaiAdapter=(options)=>({complete:async(request)=>{
      q.requests.push(request);
      return new Promise(resolve=>q.pending.push({resolve,emit:options.onTextDelta}));
    }});
    const article=new Zotero.Item('journalArticle');article.setField('title','Btw acceptance article');await article.saveTx();q.article=article;
    const attachment=await Zotero.Attachments.importFromFile({file:${JSON.stringify(join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"))},parentItemID:article.id});q.attachment=attachment;
    const context={version:1,fingerprint:'qa',capturedAt:Date.now(),items:[{id:'item:'+article.libraryID+':'+article.key,libraryID:article.libraryID,key:article.key,title:'Btw acceptance article',source:'library'}]};
    const task=await host.rpc('task/new',{title:'划线询问验收',backend:'native',context});q.taskId=task.id;
    const state=host.sessions.get(task.id);
    host.emitSessionEvent(state,'qa_completed','turn_started',{userText:'这篇文章的方法是什么？'});
    host.emitSessionEvent(state,'qa_completed','text_delta',{text:'卷积网络提取局部特征，注意力机制处理全局依赖。这里是可选择的任务对话正文。'});
    host.emitSessionEvent(state,'qa_completed','turn_completed',{});
    const artifact=await host.artifacts.upsert({taskId:task.id,kind:'report',title:'划线询问测试报告',body:{type:'markdown',markdown:'# 方法解读\\n\\n卷积网络提取局部特征，注意力机制处理全局依赖。\\n\\n报告中的问题应使用所属任务的上下文。'}},'native');
    q.artifactId=artifact.id;state.record.artifactIds.push(artifact.id);host.emitSessionEvent(state,undefined,'artifact_upserted',{artifact});
    q.mainSnapshot=JSON.stringify({record:state.record,events:state.events});
    const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;
  `);
  await wait(`return !!d?.querySelector('.tui-answer[data-btw-source]');`);
  await evaluate(`
    win.addEventListener('error',e=>qa.errors.push(e.message));win.addEventListener('unhandledrejection',e=>qa.errors.push(String(e.reason)));
    const state=host.sessions.get(qa.taskId);qa.mainSnapshot=JSON.stringify({record:state.record,events:state.events});
    qa.select=(surface)=>{const dw=surface.ownerDocument.defaultView,r=surface.ownerDocument.createRange();r.selectNodeContents(surface);const s=dw.getSelection();s.removeAllRanges();s.addRange(r);surface.dispatchEvent(new dw.MouseEvent('pointerup',{bubbles:true}));};
    qa.select(d.querySelector('.tui-answer[data-btw-source]'));return true;
  `);
  await wait(
    `return !!d.querySelector('.confucius-btw-input') && host.btwManager.documents.size===1;`,
  );
  const metrics = await evaluate(
    `const p=d.querySelector('.confucius-btw'),i=p.querySelector('input');return {height:i.getBoundingClientRect().height,inputs:p.querySelectorAll('input').length,buttons:p.querySelectorAll('button').length,selected:win.getSelection().toString(),focused:d.activeElement===i};`,
  );
  assert.equal(metrics.height, 34);
  assert.equal(metrics.inputs, 1);
  assert.equal(metrics.buttons, 0);
  assert.equal(metrics.focused, false);
  assert.match(metrics.selected, /卷积/);
  checks.push({ singleLineInput: metrics });
  await capture("conversation-input");
  await evaluate(
    `const i=d.querySelector('.confucius-btw-input');i.focus();i.value='解释局部特征';i.dispatchEvent(new win.Event('input',{bubbles:true}));i.dispatchEvent(new win.CompositionEvent('compositionstart',{bubbles:true}));i.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));return true;`,
  );
  assert.equal(await evaluate(`return qa.requests.length;`), 0);
  await evaluate(
    `const i=d.querySelector('.confucius-btw-input');i.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;`,
  );
  assert.equal(
    await evaluate(`return !!d.querySelector('.confucius-btw');`),
    true,
  );
  await evaluate(
    `const i=d.querySelector('.confucius-btw-input');i.dispatchEvent(new win.CompositionEvent('compositionend',{bubbles:true}));i.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`,
  );
  await wait(`return qa.pending.length===1;`);
  await evaluate(
    `qa.pending[0].emit('局部特征指相邻位置之间的模式。');return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-btw-answer').textContent.includes('相邻');`,
  );
  await capture("conversation-answer");
  await evaluate(
    `qa.select(d.querySelector('.confucius-btw-reply'));qa.pending[0].emit(' 新增的流式内容。');return true;`,
  );
  await wait(
    `return host.btwManager.view('btw_task_'+qa.taskId).record.turns[0].answer.includes('新增');`,
  );
  // Let the poll receive the selected paragraph, then clear selection after completion.
  await evaluate(
    `qa.pending[0].resolve({text:'局部特征指相邻位置之间的模式。卷积核在不同位置复用参数。',end:'stop',streamed:true});return true;`,
  );
  await wait(
    `return host.btwManager.view('btw_task_'+qa.taskId).record.turns[0].status==='completed' && d.querySelector('.confucius-btw').getAttribute('aria-busy')==='false';`,
  );
  assert.doesNotMatch(
    await evaluate(
      `return d.querySelector('.confucius-btw-reply').textContent;`,
    ),
    /复用参数/,
  );
  await evaluate(`win.getSelection().removeAllRanges();return true;`);
  await wait(
    `return d.querySelector('.confucius-btw-reply').textContent.includes('复用参数');`,
  );
  checks.push({
    selectedAnswerCatchesUpAfterCompletion: true,
    imeEscapeIgnored: true,
  });
  await evaluate(
    `d.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;`,
  );
  await wait(
    `return host.btwManager.view('btw_task_'+qa.taskId).record.turns[0].status==='completed';`,
  );
  assert.equal(
    await evaluate(`return !!d.querySelector('.confucius-btw');`),
    false,
  );
  await evaluate(
    `qa.select(d.querySelector('.tui-answer[data-btw-source]'));return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-btw-answer').textContent.includes('复用参数');`,
  );
  checks.push({
    imeEnterIgnored: true,
    reopenedAnswer: true,
  });
  for (const width of [390, 280]) {
    await evaluate(
      `d.getElementById('confucius-root').style.width='${width}px';win.dispatchEvent(new win.Event('resize'));return true;`,
    );
    const box = await evaluate(
      `const p=d.querySelector('.confucius-btw'),r=p.getBoundingClientRect();return {width:r.width,left:r.left,right:r.right,overflow:p.scrollWidth>p.clientWidth+1};`,
    );
    assert.equal(box.overflow, false);
    assert.ok(box.width <= width);
    checks.push({ width, ...box });
  }
  await capture("narrow-answer");
  await evaluate(
    `const root=d.getElementById('confucius-root');root.style.minHeight='0';root.style.height='240px';win.dispatchEvent(new win.Event('resize'));return true;`,
  );
  const shortBounds = await evaluate(
    `const p=d.querySelector('.confucius-btw').getBoundingClientRect(),r=d.getElementById('confucius-root').getBoundingClientRect();return {top:p.top,bottom:p.bottom,min:r.top+8,max:r.bottom-8};`,
  );
  assert.ok(
    shortBounds.top >= shortBounds.min && shortBounds.bottom <= shortBounds.max,
  );
  checks.push({ shortReadingArea: shortBounds });
  await evaluate(
    `d.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));const root=d.getElementById('confucius-root');root.style.width='';root.style.height='';root.style.minHeight='';Zotero.Prefs.set('extensions.zotero.confucius.uiFontSize',18,true);Zotero.Prefs.set('extensions.zotero.confucius.uiLineHeight','relaxed',true);d.querySelector('.confucius-artifact-file-open').click();return true;`,
  );
  await wait(`return !!ad?.querySelector('[data-btw-source*="report"]');`);
  await evaluate(
    `qa.select(ad.querySelector('[data-btw-source*="report"]'));return true;`,
  );
  await wait(
    `return ad.querySelector('.confucius-btw-answer')?.textContent.includes('复用参数');`,
  );
  await evaluate(
    `const i=ad.querySelector('.confucius-btw-input');i.value='报告中所说的全局依赖是什么？';i.dispatchEvent(new aw.Event('input',{bubbles:true}));i.dispatchEvent(new aw.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;`,
  );
  await wait(`return qa.pending.length===2;`);
  const prompt = await evaluate(
    `return qa.requests[1].messages.map(m=>m.content).join('\\n');`,
  );
  assert.match(prompt, /report/);
  assert.match(prompt, /局部特征指/);
  await evaluate(
    `ad.dispatchEvent(new aw.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));qa.pending[1].resolve({text:${JSON.stringify("### 全局依赖\n\n全局依赖是相距较远的位置之间的关系。\n\n- 注意力连接不同位置。\n- 解释需要结合原文的条件。\n\n```text\nattention(query, key, value, positions_with_a_long_name_that_stays_inside_the_code_block)\n```\n\n| 方法 | 关注范围 |\n| --- | --- |\n| 卷积 | 相邻位置 |\n| 注意力 | 全局位置 |\n\n> 这是解释，不替代原文结论。")},end:'stop'});return true;`,
  );
  await wait(
    `return host.btwManager.view('btw_task_'+qa.taskId).record.turns[1].status==='completed';`,
  );
  assert.equal(
    await evaluate(`return !!ad.querySelector('.confucius-btw');`),
    false,
  );
  await evaluate(
    `qa.select(ad.querySelector('[data-btw-source*="report"]'));return true;`,
  );
  await wait(
    `return ad.querySelector('.confucius-btw-answer')?.textContent.includes('相距较远');`,
  );
  await capture("report-answer", "ad.querySelector('.confucius-btw')");
  const largeText = await evaluate(
    `const p=ad.querySelector('.confucius-btw'),s=aw.getComputedStyle(p);return {font:s.fontSize,lineHeight:s.lineHeight,inputHeight:p.querySelector('input').getBoundingClientRect().height,overflow:p.scrollWidth>p.clientWidth+1,codeOverflow:p.querySelector('pre').scrollWidth>p.querySelector('pre').clientWidth};`,
  );
  assert.equal(largeText.font, "18px");
  assert.equal(largeText.lineHeight, "31.5px");
  assert.equal(largeText.inputHeight, 34);
  assert.equal(largeText.overflow, false);
  assert.equal(largeText.codeOverflow, true);
  checks.push({ largeTextAndMarkdown: largeText });
  await evaluate(
    `Zotero.Prefs.set('extensions.zotero.confucius.uiFontSize',13,true);Zotero.Prefs.set('extensions.zotero.confucius.uiLineHeight','standard',true);return true;`,
  );
  checks.push({
    reportSharesTaskBtw: true,
    followupContext: true,
    closedGenerationCompleted: true,
  });
  const mainState = await evaluate(
    `const state=host.sessions.get(qa.taskId);return {before:JSON.parse(qa.mainSnapshot),after:{record:state.record,events:state.events}};`,
  );
  await writeFile(
    join(output, "main-state.json"),
    JSON.stringify(mainState, null, 2),
  );
  assert.deepEqual(mainState.after, mainState.before);
  checks.push({ mainTaskUnchanged: true });
  await evaluate(
    `qa.reader=await Zotero.Reader.open(qa.attachment.id);return true;`,
  );
  await wait(`return !!qa.reader?._internalReader?._primaryView;`);
  await wait(
    `return !!qa.reader._internalReader._primaryView._iframeWindow?.document.querySelector('.textLayer span');`,
  );
  await evaluate(`
    const view=qa.reader._internalReader._primaryView;
    await view._ensureBasicPageData(0);
    const pw=view._iframeWindow,pd=pw.document;
    view._container.ownerDocument.defaultView.addEventListener('error',event=>qa.errors.push(event.message));
    qa.pdfSelect=async()=>{const span=[...pd.querySelectorAll('.textLayer span')].find(n=>n.textContent.trim()),text=span.textContent;
      const rects=view._pdfPages[0].chars.slice(0,text.replace(/\\s/g,'').length).map(c=>c.rect);
      const ranges=[{pageIndex:0,anchor:true,head:true,anchorOffset:0,headOffset:rects.length,collapsed:false,text,sortIndex:'00000|000000|00000',position:{pageIndex:0,rects}}];
      view._setSelectionRanges(Components.utils.cloneInto(ranges,view._iframeWindow));
      view._render();
    };
    await qa.pdfSelect();qa.pdfDoc=Components.utils.unwaiveXrays(view._container.ownerDocument);
    qa.pdfEvent=(target,type,kind,options)=>{const pw=Components.utils.waiveXrays(target.ownerDocument.defaultView);const event=new pw[kind](type,Components.utils.cloneInto(options,pw));Components.utils.waiveXrays(target).dispatchEvent(event);};
    return true;
  `);
  await wait(`return !!qa.pdfDoc.querySelector('.confucius-btw-input');`);
  const pdfMetrics = await evaluate(
    `const p=qa.pdfDoc.querySelector('.confucius-btw'),i=p.querySelector('input'),s=qa.pdfDoc.defaultView.getComputedStyle(p);return {height:i.getBoundingClientRect().height,background:s.backgroundColor,ink:s.color,selection:qa.reader._internalReader._primaryView._selectionRanges.map(s=>s.text).join(' ')};`,
  );
  assert.equal(pdfMetrics.height, 34);
  assert.notEqual(pdfMetrics.background, "rgba(0, 0, 0, 0)");
  assert.ok(pdfMetrics.selection);
  await capture("pdf-input", "qa.pdfDoc.querySelector('.confucius-btw')");
  await evaluate(
    `const i=qa.pdfDoc.querySelector('.confucius-btw-input');i.focus();i.value='解释选中的原文';qa.pdfEvent(i,'input','Event',{bubbles:true});qa.pdfEvent(i,'keydown','KeyboardEvent',{key:'Enter',bubbles:true});return true;`,
  );
  await wait(`return qa.pending.length===3;`);
  const pdfPrompt = await evaluate(
    `return qa.requests[2].messages.map(m=>m.content).join(' ');`,
  );
  assert.match(pdfPrompt, /pdf/);
  assert.match(pdfPrompt, /这篇文章的方法/);
  assert.doesNotMatch(pdfPrompt, /局部特征指相邻/);
  await evaluate(
    `qa.pending[2].resolve({text:'这是原文标题，下面的段落介绍了研究方法。',end:'stop'});return true;`,
  );
  await wait(
    `return qa.pdfDoc.querySelector('.confucius-btw-answer')?.textContent.includes('原文标题');`,
  );
  await capture("pdf-answer", "qa.pdfDoc.querySelector('.confucius-btw')");
  checks.push({
    pdfRealSelection: pdfMetrics,
    pdfUsesArticleHistory: true,
    pdfSeparateFromTaskBtw: true,
  });
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `Zotero.Prefs.set('extensions.zotero.confucius.uiTheme','${theme}',true);return true;`,
    );
    await wait(
      `return qa.pdfDoc.documentElement.getAttribute('data-confucius-theme')==='${theme}';`,
    );
    await capture("pdf-" + theme, "qa.pdfDoc.querySelector('.confucius-btw')");
  }
  await evaluate(
    `const i=qa.pdfDoc.querySelector('.confucius-btw-input');i.value='保留这条草稿';qa.pdfEvent(i,'input','Event',{bubbles:true});await qa.pdfSelect();await Zotero.Promise.delay(500);return true;`,
  );
  await wait(
    `return qa.pdfDoc.querySelector('.confucius-btw-input')?.value==='保留这条草稿';`,
  );
  await evaluate(
    `const pd=Components.utils.unwaiveXrays(qa.reader._internalReader._primaryView._iframeWindow.document);qa.pdfEvent(pd.body,'pointerdown','PointerEvent',{bubbles:true});return true;`,
  );
  assert.equal(
    await evaluate(`return !!qa.pdfDoc.querySelector('.confucius-btw');`),
    false,
  );
  await evaluate(`await qa.pdfSelect();return true;`);
  await wait(
    `return qa.pdfDoc.querySelector('.confucius-btw-input')?.value==='保留这条草稿';`,
  );
  checks.push({
    pdfRedrawPreservesDraft: true,
    pdfOutsideClickCloses: true,
    pdfDraftReopens: true,
  });
  assert.deepEqual(await evaluate(`return qa.errors;`), []);
  const errors = await evaluate(`return qa.errors;`);
  const recoverySource = await evaluate(`
    const record=[...host.btwManager.documents.values()].find(doc=>doc.record.source.kind==='pdf').record;
    const selection=record.turns[0].selection;
    await host.rpc('btw/prompt',{btwId:record.id,requestId:'restart_check',text:'重启前的问题',selection});
    return {id:record.id,selection,taskId:qa.taskId};
  `);
  await wait(`return qa.pending.length===4;`);
  await evaluate(`
    qa.pending[3].emit('重启前已保存的部分回答');
    const run=[...host.btwManager.running.values()][0];await run.save();
    await host.rpc('btw/draft',{btwId:run.document.record.id,text:'重启后保留的草稿'});return true;
  `);
  await instance.stop({ graceful: true });
  const restarted = await instance.launch();
  const recovery = await evaluate(`
    let modelCalls=0;host.openaiAdapter=()=>{modelCalls++;throw new Error('Unexpected automatic retry');};
    const pdf=await host.rpc('btw/open',{selection:${JSON.stringify(recoverySource.selection)}});
    const task=await host.rpc('btw/open',{selection:{source:{kind:'conversation',taskId:${JSON.stringify(recoverySource.taskId)},messageId:'qa_completed'},text:'卷积网络',surroundingText:'',capturedAt:Date.now()}});
    return {pdf:pdf.record,task:task.record,modelCalls,running:host.btwManager.running.size};
  `);
  assert.equal(restarted.temporary, false);
  assert.equal(recovery.pdf.id, recoverySource.id);
  assert.equal(recovery.pdf.turns[0].status, "completed");
  assert.equal(recovery.pdf.turns[1].status, "interrupted");
  assert.match(recovery.pdf.turns[1].answer, /重启前已保存/);
  assert.equal(recovery.pdf.draft, "重启后保留的草稿");
  assert.equal(recovery.task.turns.length, 2);
  assert.equal(recovery.modelCalls, 0);
  assert.equal(recovery.running, 0);
  checks.push({
    restartRetainsAnswersAndDraft: true,
    interruptedTurnNotResent: true,
  });
  await writeFile(
    join(output, "result.json"),
    JSON.stringify({ environment, restarted, checks, errors }, null, 2),
  );
  console.log("Passed", checks.length, "checks");
} catch (error) {
  const diagnostic = await evaluate(
    `return {errors:qa?.errors,console:Services.console.getMessageArray().slice(-25).map(e=>e.message),html:d?.body?.innerHTML.slice(-3000),pdf:qa?.pdfDoc?.body.innerHTML.slice(-10000),ranges:qa?.reader?._internalReader?._primaryView?._selectionRanges,state:qa?.reader?._internalReader?._state};`,
  ).catch(() => null);
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify({ error: String(error), diagnostic }, null, 2),
  );
  throw error;
} finally {
  await instance.stop({ graceful: true });
}
