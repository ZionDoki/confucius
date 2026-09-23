/** Real Zotero UI, isolated profile, deterministic local model/activity fixtures. */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, ".."),
  output = resolve(
    process.env.CONFUCIUS_SUBAGENT_OUTPUT ?? "output/subagent-live",
  );
await mkdir(output, { recursive: true });
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi: resolve(
    process.env.CONFUCIUS_SUBAGENT_XPI ??
      "apps/zotero-addon/.scaffold/build/confucius.xpi",
  ),
  prefix: "subagent-acceptance-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\n',
);
const checks = [];
const evaluate = (code) =>
  instance.rdp.evaluate(
    `const host=Zotero.Confucius.hooks.host,qa=Zotero.__subagentQA;const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml');const d=win?.document;${code}`,
    30000,
  );
const wait = (code) => until(() => evaluate(code), 20000, 150);
const capture = async (name) => {
  const png = await evaluate(
    `const r=d.documentElement.getBoundingClientRect(),c=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=r.width;c.height=r.height;c.getContext('2d').drawWindow(win,0,0,r.width,r.height,'white');return c.toDataURL('image/png');`,
  );
  await writeFile(
    join(output, name + ".png"),
    Buffer.from(png.split(",")[1], "base64"),
  );
};
try {
  const environment = await instance.launch();
  checks.push({
    environment: {
      zotero: environment.zotero,
      version: environment.version,
      isolated: true,
    },
  });
  await evaluate(`Zotero.__subagentQA={pending:[],errors:[],parentCalls:0};const q=Zotero.__subagentQA;
    const task=await host.rpc('task/new',{title:'子任务 trace 验收'});q.taskId=task.id;
    await host.rpc('config/set',{baseUrl:'http://127.0.0.1:1/v1',apiKey:'local-test-placeholder',model:'subagent-fixture',maxTokens:4096,contextWindowTokens:32768,historyAutoCleanup:false,uiTheme:'light'});
    host.openaiAdapter=()=>({complete:async(request,signal)=>{await request.onAttempt?.();
      if(request.messages[0].content.includes('You are an isolated research subagent'))return new Promise(resolve=>{const goal=request.messages.find(m=>m.role==='user')?.content;q.pending.push({resolve,goal});signal?.addEventListener('abort',()=>resolve({end:'stop',text:'Cancelled fixture'}),{once:true});});
      if(++q.parentCalls===1)return {end:'tool_calls',toolCalls:Array.from({length:4},(_,i)=>({id:'spawn'+i,name:'subagent_spawn',args:{title:['方法与数据集','实验结果核对','局限与适用范围','补充检索'][i],goal:'Research fixture '+i,sourceIds:[],background:'Synthetic sources for UI verification'}}))};
      if(q.parentCalls===2)return {end:'tool_calls',toolCalls:[{id:'wait',name:'subagent_wait',args:{}}]};
      return {end:'stop',text:'All delegated research has finished.'};}});
    const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;`);
  await wait(`return !!d?.getElementById('confucius-prompt');`);
  await evaluate(
    `win.resizeTo(1120,850);win.addEventListener('error',e=>qa.errors.push(e.message));win.addEventListener('unhandledrejection',e=>qa.errors.push(String(e.reason)));const p=d.getElementById('confucius-prompt');p.value='分配四个研究子任务，等待它们完成并汇总。';p.dispatchEvent(new win.Event('input',{bubbles:true}));d.getElementById('confucius-send').click();return true;`,
  );
  await wait(
    `return qa.pending.length===3 && d.querySelectorAll('.confucius-subagent-entry').length===4 && host.sessions.get(qa.taskId).events.some(e=>e.type==='tool_requested'&&e.payload.toolName==='subagent_wait');`,
  );
  const start = await evaluate(
    `qa.children=await host.subagents().list(qa.taskId);return {statuses:qa.children.map(c=>c.status),waiting:d.querySelector('.tui-waiting')?.textContent};`,
  );
  assert.deepEqual(start.statuses, ["running", "running", "running", "queued"]);
  await wait(
    `return d.querySelector('.tui-waiting')?.textContent.includes('等待子任务完成');`,
  );
  checks.push({ concurrency: start });
  await evaluate(`qa.run=host.subagents().run(qa.children[0].id);qa.serial=0;qa.emit=(type,payload)=>qa.run.event({id:'fixture-'+(++qa.serial),sessionId:qa.run.task.id,turnId:qa.run.task.run.id,ts:Date.now(),type,payload});
    for(let i=0;i<40;i++){qa.emit('tool_requested',{callId:'pages'+i,toolName:'get_pages',args:{page:i+1,libraryID:1,key:'SYNTHETIC'}});qa.emit('tool_progress',{callId:'pages'+i,message:'读取第 '+(i+1)+' 页'});qa.emit('tool_result',{callId:'pages'+i,result:{ok:true,toolName:'get_pages',data:{page:i+1,text:'Evidence '+i+'：本条仅为隔离测试材料，用于核对完整输入与工具结果。'+(i===0?'long receipt '.repeat(500)+' END-OF-FULL-RECEIPT':'')}}});}
    qa.emit('text_delta',{phase:'commentary',text:'已核对 40 页材料，正在汇总方法与结果。'});
    for(let i=0;i<15;i++)qa.run.document.archive['tool:evidence-'+i]='Archived evidence '+i+' '+('source passage '.repeat(600))+' END-OF-RECEIPT';
    qa.run.document.archive['h:private']='private model context must not be exported';await qa.run.save();return true;`);
  await wait(
    `return d.querySelector('.confucius-subagent-entry').textContent.includes('40');`,
  );
  await capture("subagent-entries");
  const entryShape = () =>
    evaluate(
      `const b=d.querySelector('.confucius-subagent-entry'),r=b.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};`,
    );
  const initialEntry = await entryShape();
  const cardAlignment = await evaluate(
    `const column=d.querySelector('.confucius-activity-shell').getBoundingClientRect();return [...d.querySelectorAll('.confucius-subagent-entry')].map(b=>{const r=b.getBoundingClientRect();return {left:r.left-column.left,right:r.right-column.right};});`,
  );
  assert.ok(
    cardAlignment.every((r) => Math.abs(r.left) < 1 && Math.abs(r.right) < 1),
    JSON.stringify(cardAlignment),
  );
  checks.push({ fullChatWidth: cardAlignment });
  await evaluate(
    `const r=d.querySelector('.confucius-subagent-entry').getBoundingClientRect();qa.point={x:r.left+r.width/2,y:r.top+r.height/2};win.windowUtils.sendMouseEvent('mousemove',qa.point.x,qa.point.y,0,0,0);win.windowUtils.sendMouseEvent('mousedown',qa.point.x,qa.point.y,0,1,0);return true;`,
  );
  assert.deepEqual(await entryShape(), initialEntry);
  await evaluate(
    `win.windowUtils.sendMouseEvent('mouseup',qa.point.x,qa.point.y,0,1,0);return true;`,
  );
  await wait(
    `return d.querySelectorAll('.confucius-subagent-trace-item[data-kind=tools]').length===1;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelectorAll('#confucius-subagent-popup').length;`,
    ),
    1,
  );
  await evaluate(
    `d.querySelector('.confucius-subagent-trace .confucius-tools').open=true;return true;`,
  );
  await wait(
    `return d.querySelectorAll('.confucius-subagent-trace .confucius-tool-call').length===40;`,
  );
  await evaluate(
    `d.querySelector('.confucius-subagent-trace .confucius-tool-call').open=true;d.querySelector('.confucius-subagent-raw').open=true;d.querySelector('.confucius-subagent-scroll').scrollTop=0;return true;`,
  );
  await wait(
    `return !!d.querySelector('.confucius-subagent-trace .confucius-tool-call pre') && d.querySelector('.confucius-subagent-raw pre').textContent.includes('tool_requested');`,
  );
  const trace = await evaluate(
    `const row=d.querySelector('.confucius-subagent-trace .confucius-tool-call');return {text:row.textContent,raw:d.querySelector('.confucius-subagent-raw pre').textContent,records:d.querySelector('.confucius-subagent-filter span').textContent,archives:d.querySelectorAll('.confucius-subagent-details > div > details').length};`,
  );
  assert.match(trace.text, /Evidence 0/);
  assert.match(trace.text, /END-OF-FULL-RECEIPT/);
  assert.match(trace.text, /"page": 1/);
  assert.match(trace.raw, /tool_requested/);
  assert.equal(trace.archives, 15);
  checks.push({
    fullTrace: {
      tools: 40,
      allPagesLoaded: true,
      inputAndResult: true,
      rawEvents: true,
      archiveRefs: 15,
    },
  });
  await capture("subagent-light-trace");
  await evaluate(
    `const s=d.querySelector('.confucius-subagent-scroll');s.scrollTop=120;qa.scroll=s.scrollTop;qa.mainScroll=d.querySelector('.confucius-timeline-pane').scrollTop;qa.emit('tool_requested',{callId:'live',toolName:'get_outline',args:{key:'LATEST'}});await qa.run.save();return true;`,
  );
  await wait(
    `return [...d.querySelectorAll('.confucius-subagent-trace .confucius-tools > summary')].some(s=>s.textContent.includes('get_outline'));`,
  );
  const continuity = await evaluate(
    `return {scroll:d.querySelector('.confucius-subagent-scroll').scrollTop,before:qa.scroll,main:d.querySelector('.confucius-timeline-pane').scrollTop,mainBefore:qa.mainScroll,open:!!d.querySelector('.confucius-subagent-trace .confucius-tool-call[open]') && !!d.querySelector('.confucius-subagent-raw[open]')};`,
  );
  assert.ok(
    Math.abs(continuity.scroll - continuity.before) < 2,
    JSON.stringify(continuity),
  );
  assert.ok(
    Math.abs(continuity.main - continuity.mainBefore) < 2,
    JSON.stringify(continuity),
  );
  assert.equal(continuity.open, true);
  checks.push({ continuity });
  await evaluate(
    `const row=d.querySelector('.confucius-tool-call[data-call-id="live"]');row.open=true;row.querySelector('summary').focus({preventScroll:true});qa.emit('tool_progress',{callId:'live',message:'Focused tool progress refreshed'});await qa.run.save();return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-tool-call[data-call-id="live"] > summary').textContent.includes('Focused tool progress refreshed');`,
  );
  assert.equal(
    await evaluate(
      `return d.activeElement.parentElement.dataset.callId==='live';`,
    ),
    true,
  );
  await evaluate(
    `const pre=d.querySelector('.confucius-subagent-trace .confucius-tool-call pre');qa.selectedNode=pre;const range=d.createRange();range.selectNodeContents(pre);const selection=d.getSelection();selection.removeAllRanges();selection.addRange(range);qa.selectionText=selection.toString();qa.emit('tool_progress',{callId:'live',message:'Progress after selection'});await qa.run.save();return true;`,
  );
  await evaluate(
    `await new Promise(resolve=>win.setTimeout(resolve,1200));return true;`,
  );
  assert.equal(
    await evaluate(
      `return qa.selectedNode.isConnected && d.getSelection().toString()===qa.selectionText;`,
    ),
    true,
  );
  await evaluate(`d.getSelection().removeAllRanges();return true;`);
  await wait(
    `return d.querySelector('.confucius-tool-call[data-call-id="live"] > summary').textContent.includes('Progress after selection');`,
  );
  await evaluate(
    `const b=d.querySelector('.confucius-subagent-trace .confucius-reasoning-toggle');b.click();return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-subagent-trace .confucius-reasoning-toggle').getAttribute('aria-expanded');`,
    ),
    "true",
  );
  await evaluate(
    `d.querySelector('.confucius-subagent-trace .confucius-reasoning-toggle').click();return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-subagent-trace .confucius-reasoning').dataset.fold;`,
    ),
    "compact",
  );
  checks.push({
    focusedToolRefresh: true,
    selectedTextPreserved: true,
    progressFolding: true,
    fullReceiptNotTruncated: true,
  });

  // Receipt changes must invalidate a closed group's lazy body. Detached
  // controls may still dispatch queued native toggle events after replacement.
  await evaluate(`qa.obsoleteGroup=d.querySelector('.confucius-subagent-trace .confucius-tools');qa.obsoleteGroup.querySelector('summary').click();
    qa.emit('tool_progress',{callId:'live',message:'Closed group refresh'});await qa.run.save();return true;`);
  await wait(
    `return d.querySelector('.confucius-subagent-raw pre').textContent.includes('Closed group refresh');`,
  );
  assert.equal(await evaluate(`return !qa.obsoleteGroup.isConnected;`), true);
  await evaluate(`qa.obsoleteGroup.open=true;qa.obsoleteGroup.dispatchEvent(new win.Event('toggle'));
    qa.emit('tool_result',{callId:'live',result:{ok:true,toolName:'get_outline',data:{text:'RECEIPT-AFTER-COLLAPSE'}}});await qa.run.save();return true;`);
  await wait(
    `return d.querySelector('.confucius-subagent-raw pre').textContent.includes('RECEIPT-AFTER-COLLAPSE');`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-subagent-trace .confucius-tools').open;`,
    ),
    false,
  );
  const keyboard = await evaluate(
    `const group=d.querySelector('.confucius-subagent-trace .confucius-tools'),head=group.querySelector('summary');qa.keys=[];for(const type of ['keydown','keypress','keyup','click'])head.addEventListener(type,e=>qa.keys.push({type,key:e.key,button:e.button,trusted:e.isTrusted}));win.focus();head.focus();const tip=Components.classes['@mozilla.org/text-input-processor;1'].createInstance(Components.interfaces.nsITextInputProcessor);if(!tip.beginInputTransactionForTests(win))throw new Error('Keyboard transaction failed');tip.keydown(new win.KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13}),2);tip.keyup(new win.KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13}),2);return {open:group.open,focused:d.activeElement===head,events:qa.keys};`,
  );
  assert.equal(keyboard.open, true, JSON.stringify(keyboard));
  await wait(
    `return d.querySelector('.confucius-subagent-trace .confucius-tools').open && d.querySelector('.confucius-subagent-trace [data-call-id=live]').textContent.includes('RECEIPT-AFTER-COLLAPSE');`,
  );
  const space = await evaluate(
    `const group=d.querySelector('.confucius-subagent-trace .confucius-tools');group.querySelector('summary').focus();const tip=Components.classes['@mozilla.org/text-input-processor;1'].createInstance(Components.interfaces.nsITextInputProcessor);if(!tip.beginInputTransactionForTests(win))throw new Error('Keyboard transaction failed');const states=[];for(let i=0;i<2;i++){tip.keydown(new win.KeyboardEvent('keydown',{key:' ',code:'Space',keyCode:32}));tip.keyup(new win.KeyboardEvent('keyup',{key:' ',code:'Space',keyCode:32}));states.push(group.open);}return states;`,
  );
  assert.deepEqual(space, [false, true]);
  checks.push({
    closedGroupGetsLatestReceipt: true,
    detachedToggleIgnored: true,
    keyboardDisclosure: true,
  });

  // Polling an unchanged trace should perform no subtree writes; filtering is
  // local work and must not invoke list/read RPCs on every input event.
  await evaluate(
    `qa.mutations=0;qa.observer=new win.MutationObserver(changes=>qa.mutations+=changes.length);qa.observer.observe(d.querySelector('.confucius-subagent-trace'),{subtree:true,childList:true,attributes:true,characterData:true});return true;`,
  );
  await evaluate(
    `await new Promise(resolve=>win.setTimeout(resolve,1600));qa.observer.disconnect();return true;`,
  );
  assert.equal(await evaluate(`return qa.mutations;`), 0);
  const localFiltering =
    await evaluate(`const old=host.rpc;let calls=0;host.rpc=function(...args){if(args[0].startsWith('subagent/'))calls++;return old.apply(this,args);};
    try {const f=d.querySelector('.confucius-subagent-filter input'),start=win.performance.now();for(const query of ['E','Ev','Evi','Evid','Evidence 3','Evidence 38','']){f.value=query;f.dispatchEvent(new win.Event('input',{bubbles:true}));}return {calls,elapsedMs:win.performance.now()-start};}finally{host.rpc=old;}`);
  assert.equal(localFiltering.calls, 0);
  checks.push({ idleTraceMutations: 0, localFiltering });

  await evaluate(
    `const f=d.querySelector('.confucius-subagent-filter input');qa.beforeComposition=d.querySelector('.confucius-subagent-trace').textContent;f.dispatchEvent(new win.CompositionEvent('compositionstart'));f.value='Evidence 38';f.dispatchEvent(new win.InputEvent('input',{bubbles:true,isComposing:true}));await new Promise(resolve=>win.setTimeout(resolve,1200));return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-subagent-trace').textContent===qa.beforeComposition;`,
    ),
    true,
  );
  await evaluate(
    `d.querySelector('.confucius-subagent-filter input').dispatchEvent(new win.CompositionEvent('compositionend'));return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelectorAll('.confucius-subagent-trace .confucius-tool-call').length;`,
    ),
    1,
  );
  await evaluate(
    `const f=d.querySelector('.confucius-subagent-filter input');f.value='';f.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  checks.push({ pollRespectsInputComposition: true });

  await evaluate(
    `for(let i=0;i<40;i++)qa.run.document.archive['tool:race-'+i]='Archive race fixture';await qa.run.save();return true;`,
  );
  await wait(
    `return !d.querySelector('.confucius-subagent-details > button').hidden;`,
  );
  await evaluate(
    `const manager=host.subagents();qa.archiveRead=manager.read;qa.deferArchive=true;manager.read=async function(...args){const value=await qa.archiveRead.apply(this,args);if(qa.deferArchive && args[4]?.indexOffset>=25 && !args[4]?.ref){qa.deferArchive=false;return new Promise(resolve=>qa.releaseArchive=()=>resolve(value));}return value;};d.querySelector('.confucius-subagent-details > button').click();return true;`,
  );
  await wait(
    `return !!qa.releaseArchive && d.querySelectorAll('.confucius-subagent-details > div > details').length===55 && d.querySelector('.confucius-subagent-details > button').hidden;`,
  );
  await evaluate(
    `qa.releaseArchive();host.subagents().read=qa.archiveRead;return true;`,
  );
  await wait(
    `return !d.querySelector('.confucius-subagent-details > button').disabled;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-subagent-details > button').hidden;`,
    ),
    true,
  );
  await evaluate(
    `for(let i=0;i<40;i++)delete qa.run.document.archive['tool:race-'+i];await qa.run.save();return true;`,
  );
  checks.push({ outOfOrderArchivePageCannotRegressCursor: true });

  await evaluate(
    `const f=d.querySelector('.confucius-subagent-filter input');f.value='Evidence 38';f.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelectorAll('.confucius-subagent-trace-item:not([hidden])').length;`,
    ),
    1,
  );
  await evaluate(
    `const f=d.querySelector('.confucius-subagent-filter input');f.value='';f.dispatchEvent(new win.Event('input',{bubbles:true}));const a=d.querySelector('.confucius-subagent-details > div > details');a.parentElement.parentElement.open=true;a.open=true;return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-subagent-details > div > details pre').textContent.length>0;`,
  );
  for (let n = 0; n < 6; n++) {
    const more = await evaluate(
      `const b=d.querySelector('.confucius-subagent-details > div > details button');if(b.hidden)return false;if(b.disabled)throw new Error('Archive still loading');b.click();return true;`,
    );
    if (!more) break;
    await wait(
      `return !d.querySelector('.confucius-subagent-details > div > details button').disabled;`,
    );
  }
  assert.match(
    await evaluate(
      `return d.querySelector('.confucius-subagent-details > div > details pre').textContent;`,
    ),
    /END-OF-RECEIPT$/,
  );
  checks.push({ traceFilterAndCompleteReceipt: true });
  const popupBox = () =>
    evaluate(
      `const r=d.getElementById('confucius-subagent-popup').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};`,
    );
  const fixedBox = await popupBox();
  await evaluate(
    `qa.popup=d.getElementById('confucius-subagent-popup');qa.firstPane=d.querySelector('.confucius-subagent-pane');const f=d.querySelector('.confucius-subagent-filter input');f.value='Evidence';f.dispatchEvent(new win.Event('input',{bubbles:true}));const s=d.querySelector('.confucius-subagent-scroll');s.scrollTop=120;qa.switchScroll=s.scrollTop;
    const manager=host.subagents(),read=manager.read.bind(manager);qa.deferRead=true;manager.read=async(...args)=>{const value=await read(...args);if(args[1]===qa.children[1].id && qa.deferRead){qa.deferRead=false;return new Promise(resolve=>{qa.releaseStale=()=>resolve({...value,record:{...value.record,title:'STALE RESPONSE SHOULD NOT SHOW'}});});}return value;};return true;`,
  );
  await evaluate(
    `const b=d.querySelectorAll('.confucius-subagent-entry')[1];b.dispatchEvent(new win.Event('pointerdown',{bubbles:true}));b.click();return true;`,
  );
  await wait(`return !!qa.releaseStale;`);
  assert.deepEqual(await popupBox(), fixedBox);
  assert.equal(
    await evaluate(
      `return d.getElementById('confucius-subagent-popup')===qa.popup && d.querySelectorAll('.confucius-subagent-pane').length===1 && d.activeElement===qa.popup.querySelector('header button');`,
    ),
    true,
  );
  for (let n = 0; n < 2; n++) {
    await evaluate(
      `d.querySelector('.confucius-subagent-navigation [data-direction=next]').click();return true;`,
    );
  }
  await wait(
    `return d.getElementById('confucius-subagent-popup')?.dataset.status==='queued';`,
  );
  await evaluate(
    `qa.releaseStale();d.querySelector('.confucius-timeline-pane').scrollTop=0;return true;`,
  );
  assert.deepEqual(await popupBox(), fixedBox);
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-subagent-header h3').textContent===qa.children[3].title && d.querySelector('.confucius-subagent-navigation [data-direction=next]').disabled && d.querySelector('.confucius-subagent-navigation span').textContent==='4 / 4';`,
    ),
    true,
  );
  for (let n = 0; n < 3; n++) {
    await evaluate(
      `d.querySelector('.confucius-subagent-navigation [data-direction=previous]').click();return true;`,
    );
  }
  const restored = await evaluate(
    `return {shell:d.getElementById('confucius-subagent-popup')===qa.popup,pane:d.querySelector('.confucius-subagent-pane')===qa.firstPane,query:d.querySelector('.confucius-subagent-filter input').value,scroll:d.querySelector('.confucius-subagent-scroll').scrollTop,before:qa.switchScroll,open:!!d.querySelector('.confucius-subagent-trace .confucius-tool-call[open]') && !!d.querySelector('.confucius-subagent-raw[open]'),receipt:d.querySelector('.confucius-subagent-details > div > details pre').textContent.endsWith('END-OF-RECEIPT'),previousDisabled:d.querySelector('.confucius-subagent-navigation [data-direction=previous]').disabled};`,
  );
  assert.equal(
    restored.shell &&
      restored.pane &&
      restored.open &&
      restored.receipt &&
      restored.previousDisabled,
    true,
    JSON.stringify(restored),
  );
  assert.equal(restored.query, "Evidence");
  assert.ok(
    Math.abs(restored.scroll - restored.before) < 2,
    JSON.stringify(restored),
  );
  assert.deepEqual(await popupBox(), fixedBox);
  checks.push({
    sharedCenteredBubble: {
      fixedBox,
      restored,
      ignoresLateResponse: true,
      backgroundScrollKeepsPosition: true,
    },
  });
  await evaluate(
    `d.querySelectorAll('.confucius-subagent-entry')[1].click();return true;`,
  );
  await wait(
    `return d.getElementById('confucius-subagent-popup')?.dataset.subagentId===qa.children[1].id;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelectorAll('#confucius-subagent-popup').length;`,
    ),
    1,
  );
  await evaluate(
    `d.querySelectorAll('.confucius-subagent-entry')[1].click();return true;`,
  );
  assert.equal(
    await evaluate(`return !!d.getElementById('confucius-subagent-popup');`),
    false,
  );
  await evaluate(
    `d.querySelectorAll('.confucius-subagent-entry')[1].click();return true;`,
  );
  await wait(`return !!d.getElementById('confucius-subagent-popup');`);
  await evaluate(
    `d.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.activeElement.dataset.subagentId===qa.children[1].id && !d.getElementById('confucius-subagent-popup');`,
    ),
    true,
  );
  checks.push({
    singleton: { switching: true, sameEntryCloses: true, escapeFocus: true },
  });
  await evaluate(
    `qa.pending.splice(0,1)[0].resolve({end:'stop',text:'## 方法比较\\n\\n**已完成**。此测试未访问个人文库或在线模型。'});return true;`,
  );
  await wait(
    `return (host.subagents().run(qa.children[3].id)) && (await host.subagents().list(qa.taskId))[0].status==='completed';`,
  );
  await evaluate(
    `d.querySelectorAll('.confucius-subagent-entry')[2].click();return true;`,
  );
  await wait(
    `return d.getElementById('confucius-subagent-popup')?.dataset.status==='running';`,
  );
  await evaluate(
    `[...d.querySelectorAll('.confucius-subagent-footer button')].find(b=>b.textContent==='停止').click();return true;`,
  );
  await wait(
    `return d.getElementById('confucius-subagent-popup')?.dataset.status==='cancelled';`,
  );
  await evaluate(
    `[...d.querySelectorAll('.confucius-subagent-footer button')].find(b=>b.textContent==='重试').click();return true;`,
  );
  await wait(
    `return d.getElementById('confucius-subagent-popup')?.dataset.status==='running' && (await host.subagents().list(qa.taskId))[2].attempt===2;`,
  );
  checks.push({
    schedulingAndControls: {
      fourthStarted: true,
      stopAndRetry: true,
      parentStillWaiting: await evaluate(
        `return !!host.sessions.get(qa.taskId).activeTurnId;`,
      ),
    },
  });
  await evaluate(
    `for(const p of qa.pending.splice(0))p.resolve({end:'stop',text:'Subagent finished with documented limitations.'});return true;`,
  );
  await wait(`return !host.sessions.get(qa.taskId).activeTurnId;`);
  await wait(`return !d.querySelector('.tui-waiting');`);
  const completed = await evaluate(
    `const report=await host.rpc('task/trace',{taskId:qa.taskId});return {statuses:(await host.subagents().list(qa.taskId)).map(c=>c.status),exported:report.sections.subagents.data.length,events:report.sections.subagents.data[0].events.length,archive:Object.keys(report.sections.subagents.data[0].archive),privatePresent:JSON.stringify(report.sections.subagents).includes('private model context'),errors:qa.errors};`,
  );
  assert.ok(
    completed.statuses.every((s) => s === "completed"),
    JSON.stringify(completed),
  );
  assert.equal(completed.exported, 4);
  assert.ok(completed.events > 120);
  assert.equal(completed.archive.length, 15);
  assert.equal(completed.privatePresent, false);
  assert.deepEqual(completed.errors, []);
  checks.push({ completed });
  // Open the long trace in the same real window at multiple sizes and themes.
  await evaluate(
    `d.querySelector('.confucius-subagent-entry').click();return true;`,
  );
  await wait(
    `return d.getElementById('confucius-subagent-popup')?.dataset.subagentId===qa.children[0].id;`,
  );
  await wait(
    `return !!d.querySelector('.confucius-subagent-result .tui-answer h2');`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelectorAll('.confucius-subagent-result .tui-answer h2').length===1 && !!d.querySelector('.confucius-subagent-result .tui-answer strong') && !d.querySelector('.confucius-subagent-trace .tui-waiting');`,
    ),
    true,
  );
  checks.push({
    sharedMarkdownAnswer: true,
    noDuplicateResult: true,
    completedActivityCleared: true,
  });
  const geometry = () =>
    evaluate(
      `const p=d.getElementById('confucius-subagent-popup'),r=p.getBoundingClientRect(),s=p.querySelector('.confucius-subagent-scroll'),f=p.querySelector('footer').getBoundingClientRect();return {width:win.innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:win.innerHeight,overflow:s.scrollWidth>s.clientWidth+1,footerVisible:f.bottom<=r.bottom+1,buttonHeight:p.querySelector('header button').getBoundingClientRect().height};`,
    );
  for (const [width, theme, height] of [
    [1120, "light", 850],
    [420, "dark", 850],
    [280, "dark", 850],
    [420, "dark", 460],
  ]) {
    await evaluate(
      `await host.rpc('config/set',{uiTheme:${JSON.stringify(theme)}});win.resizeTo(${width},${height});return true;`,
    );
    await wait(
      `return d.documentElement.clientWidth<=${width} && win.outerHeight===${height};`,
    );
    const layout = await geometry();
    assert.ok(
      layout.left >= 7 &&
        layout.right <= layout.width - 7 &&
        layout.top >= 7 &&
        layout.bottom <= layout.height - 7,
      JSON.stringify(layout),
    );
    assert.equal(layout.overflow, false, JSON.stringify(layout));
    assert.ok(
      Math.abs((layout.left + layout.right) / 2 - layout.width / 2) < 1,
      JSON.stringify(layout),
    );
    assert.ok(
      Math.abs((layout.top + layout.bottom) / 2 - layout.height / 2) < 1,
      JSON.stringify(layout),
    );
    assert.equal(layout.footerVisible, true);
    assert.equal(layout.buttonHeight, 34);
    await evaluate(
      `const s=d.querySelector('.confucius-subagent-scroll');s.scrollTop=0;d.querySelector('.confucius-subagent-trace-item[data-kind=tools]').open=true;return true;`,
    );
    await wait(
      `return !d.querySelector('.confucius-subagent-footer button').hidden;`,
    );
    await capture(
      `subagent-${theme}-${width}${height === 850 ? "" : "-short"}`,
    );
    checks.push({ layout });
  }
  await evaluate(
    `const input=d.getElementById('confucius-prompt');input.focus();input.dispatchEvent(new win.Event('pointerdown',{bubbles:true}));return true;`,
  );
  assert.equal(
    await evaluate(
      `return !d.getElementById('confucius-subagent-popup') && d.activeElement.id==='confucius-prompt';`,
    ),
    true,
  );
  checks.push({ outsideClickKeepsFocus: true });
  await evaluate(
    `await host.rpc('config/set',{uiLanguage:'en-US'});win.close();return true;`,
  );
  await evaluate(
    `const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;`,
  );
  await wait(`return !!d?.querySelector('.confucius-subagent-entry');`);
  await evaluate(
    `win.resizeTo(420,850);d.querySelector('.confucius-subagent-entry').click();return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-subagent-filter input')?.placeholder==='Filter activity, tools or content';`,
  );
  const english = await geometry();
  assert.equal(english.overflow, false);
  assert.equal(english.footerVisible, true);
  await capture("subagent-english-420");
  checks.push({ english });

  await evaluate(
    `Services.prefs.setIntPref('ui.useAccessibilityTheme',1);Services.prefs.setCharPref('ui.windowForeground','#FFFFFF');Services.prefs.setCharPref('ui.windowBackground','#000000');return true;`,
  );
  await wait(`return win.matchMedia('(prefers-contrast: more)').matches;`);
  const contrast = await evaluate(
    `const popup=d.getElementById('confucius-subagent-popup'),button=popup.querySelector('header button'),style=win.getComputedStyle(popup);return {border:style.borderTopWidth,ink:style.color,paper:style.backgroundColor,buttonInk:win.getComputedStyle(button).color,buttonHeight:button.getBoundingClientRect().height};`,
  );
  assert.equal(contrast.border, "1px");
  assert.notEqual(contrast.ink, contrast.paper);
  assert.equal(contrast.buttonHeight, 34);
  await capture("subagent-high-contrast");
  checks.push({ highContrast: contrast });
  await evaluate(
    `for(const key of ['ui.useAccessibilityTheme','ui.windowForeground','ui.windowBackground'])Services.prefs.clearUserPref(key);return true;`,
  );

  // Stress the real paged read path, retaining complete receipts while the
  // filter and close controls remain responsive during the initial load.
  await evaluate(`d.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    const run=qa.run;for(let i=0;i<2000;i++){for(const [type,payload] of [['tool_requested',{callId:'stress'+i,toolName:'get_pages',args:{page:i}}],['tool_result',{callId:'stress'+i,result:{ok:true,toolName:'get_pages',data:{text:'STRESS-EVIDENCE-'+i}}}]])run.document.events.push({id:'stress-'+(++qa.serial),sessionId:run.task.id,turnId:run.task.run.id,type,payload,ts:Date.now()});}await run.save();
    qa.stressStarted=win.performance.now();qa.stressHeartbeats=0;qa.heartbeat=win.setInterval(()=>qa.stressHeartbeats++,10);d.querySelector('.confucius-subagent-entry').click();return true;`);
  await wait(
    `return !!d.querySelector('.confucius-subagent-filter span')?.textContent.includes('events');`,
  );
  const initialStress = await evaluate(
    `return {firstContentMs:win.performance.now()-qa.stressStarted,counts:d.querySelector('.confucius-subagent-filter span').textContent};`,
  );
  await evaluate(
    `const f=d.querySelector('.confucius-subagent-filter input');f.value='STRESS-EVIDENCE-1999';f.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-subagent-trace .confucius-tools')?.textContent.includes('get_pages');`,
  );
  await evaluate(
    `win.clearInterval(qa.heartbeat);const group=d.querySelector('.confucius-subagent-trace .confucius-tools');group.querySelector('summary').click();return true;`,
  );
  await wait(
    `return !!d.querySelector('.confucius-subagent-trace [data-call-id=stress1999]');`,
  );
  await evaluate(
    `d.querySelector('.confucius-subagent-trace [data-call-id=stress1999] > summary').click();return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-subagent-trace [data-call-id=stress1999]').textContent.includes('STRESS-EVIDENCE-1999');`,
  );
  const stress = await evaluate(
    `return {totalMs:win.performance.now()-qa.stressStarted,heartbeats:qa.stressHeartbeats,counts:d.querySelector('.confucius-subagent-filter span').textContent,errors:qa.errors};`,
  );
  assert.ok(stress.heartbeats > 0, JSON.stringify(stress));
  assert.deepEqual(stress.errors, []);
  checks.push({
    longTrace: { tools: 2000, initial: initialStress, ...stress },
  });
  await evaluate(
    `const task=await host.rpc('task/new',{title:'Separate task'});qa.other=task.id;return true;`,
  );
  await wait(
    `return !!d.querySelector('[data-task-id="'+qa.other+'"] .confucius-task-open');`,
  );
  await evaluate(
    `d.querySelector('[data-task-id="'+qa.other+'"] .confucius-task-open').click();return true;`,
  );
  await wait(
    `return !d.getElementById('confucius-subagent-popup') && !d.querySelector('.confucius-subagent-entry');`,
  );
  checks.push({
    taskSwitchClosesBubble: true,
    hoverAndPressKeepEntryAligned: true,
  });
  await writeFile(
    join(output, "report.json"),
    JSON.stringify({ ok: true, checks }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, checks: checks.length, output }));
} catch (error) {
  await capture("failure").catch(() => {});
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        ok: false,
        error: String(error),
        stack: error.stack,
        checks,
        state: instance.publicState(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await instance.stop().catch(() => {});
}
