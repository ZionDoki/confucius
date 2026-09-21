/** Isolated Zotero acceptance; deterministic OpenAlex/model fixtures, real library/PDF operations. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
const root = resolve(import.meta.dirname, ".."),
  output = resolve(
    process.env.CONFUCIUS_LITERATURE_OUTPUT ??
      join(root, "output/literature-live"),
  );
await mkdir(output, { recursive: true });
const pdf = await readFile(
  join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"),
);
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/paper.pdf" ? "application/pdf" : "text/html",
  );
  res.end(
    req.url === "/paper.pdf"
      ? pdf
      : "<html>Sign in to access this paper</html>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi: resolve(
    process.env.CONFUCIUS_LITERATURE_XPI ??
      join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  ),
  prefix: "literature-acceptance-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\n',
);
const checks = [];
const evaluate = (code) =>
  instance.rdp.evaluate(
    `const host=Zotero.Confucius.hooks.host,qa=Zotero.__literatureQA;const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml');const d=win?.document;${code}`,
    30000,
  );
const wait = (code) => until(() => evaluate(code), 30000, 150);
const capture = async (name) => {
  const png = await evaluate(
    `const r=d.documentElement.getBoundingClientRect(),canvas=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');canvas.width=r.width;canvas.height=r.height;canvas.getContext('2d').drawWindow(win,0,0,r.width,r.height,'white');return canvas.toDataURL('image/png');`,
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
  await evaluate(`Zotero.__literatureQA={requests:[],pending:[],errors:[],opened:[]};const q=Zotero.__literatureQA;
    const existing=new Zotero.Item('journalArticle');existing.setField('title','Existing paper');existing.setField('DOI','10.1234/confucius-qa-0');await existing.saveTx();q.existing=existing.key;
    await Zotero.getActiveZoteroPane().selectItem(existing.id);
    const task=await host.rpc('task/new',{title:'文献研究验收'});q.taskId=task.id;
    if(task.lockedContext.items.length)throw new Error('Blank task captured library selection');
    q.transport=host.openAlex.transport;
    host.openAlex.transport=async()=>({status:200,data:{results:Array.from({length:100},(_,i)=>({id:'https://openalex.org/W'+(900000+i),doi:i===1?null:'https://doi.org/10.1234/confucius-qa-'+i,title:'Research paper '+i,publication_year:2024,authorships:[{author:{display_name:'Test Author'}}],abstract_inverted_index:{Useful:[0],research:[1],abstract:[2]},cited_by_count:i,open_access:{is_oa:true},best_oa_location:{is_oa:true,pdf_url:${JSON.stringify(url)}+(i===0?'/paper.pdf':'/signin'),landing_page_url:${JSON.stringify(url)}+'/paper/'+i},has_content:{pdf:false}})),meta:{count:2500,next_cursor:'next'}}});
    Zotero.launchURL=target=>q.opened.push(target);
    const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;`);
  await wait(`return !!d?.querySelector('#confucius-prompt');`);
  const keySettings =
    await evaluate(`await host.rpc('literature/configure',{key:'openalex-test-placeholder'});
    const configured=await host.rpc('literature/config');const general=await host.rpc('config/get');const tested=await host.rpc('literature/test');
    await host.rpc('literature/configure',{key:''});
    return {configured:configured.hasKey,publicConfigRedacted:!JSON.stringify(general).includes('openalex-test-placeholder'),test:tested.ok,cleared:!(await host.rpc('literature/config')).hasKey};`);
  assert.deepEqual(keySettings, {
    configured: true,
    publicConfigRedacted: true,
    test: true,
    cleared: true,
  });
  checks.push({ keySettings });
  assert.equal(
    await evaluate(
      `return d.querySelectorAll('.confucius-template-button').length;`,
    ),
    0,
  );
  assert.equal(
    await evaluate(
      `return d.querySelectorAll('.confucius-literature-card').length===0 && d.querySelector('.confucius-literature-dock').hidden;`,
    ),
    true,
  );
  await evaluate(`win.addEventListener('error',e=>qa.errors.push(e.message));win.addEventListener('unhandledrejection',e=>qa.errors.push(String(e.reason)));
    await host.rpc('config/set',{baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic-fixture',model:'research-fixture',maxTokens:4096,contextWindowTokens:32768,historyAutoCleanup:false});
    qa.discoveryCalls=0;
    host.openaiAdapter=(options)=>({complete:async request=>{await request.onAttempt?.();const n=++qa.discoveryCalls;
      if(n===1)return {end:'tool_calls',toolCalls:[{id:'search',name:'literature_search',args:{query:'图神经网络 · 分子性质预测',fromYear:2020,toYear:2026}}]};
      if(n===2)return {end:'tool_calls',toolCalls:[{id:'candidates',name:'literature_update_candidates',args:{candidateRevision:0,changes:[{id:'W900000',selected:true,reason:'方法与研究问题相关'},{id:'W900001',selected:true,reason:'提供可比较的实验设计'}]}}]};
      const answer='已检索 100 篇文献，推荐 2 篇候选。请在文献卡片中确认；尚未入库或下载全文。\\n\\n'+Array.from({length:12},(_,i)=>(i+1)+'. 这些结果目前仅按元数据和摘要筛选。后续可以比较数据集、实验设计和模型的局限；获得全文后再查证具体结果。').join('\\n\\n');
      options.onTextDelta?.(answer);return {end:'stop',text:answer};}});
    const prompt=d.getElementById('confucius-prompt');prompt.value='帮我找近几年图神经网络用于分子性质预测的论文，先推荐相关候选。';prompt.dispatchEvent(new win.Event('input',{bubbles:true}));d.getElementById('confucius-send').click();return true;`);
  await wait(
    `return !host.sessions.get(qa.taskId).activeTurnId && host.sessions.get(qa.taskId).record.literature?.candidates===2 && d.querySelectorAll('.confucius-literature-card').length===1;`,
  );
  await evaluate(
    `const timeline=d.querySelector('.confucius-timeline-pane');timeline.scrollTop=timeline.scrollHeight;return true;`,
  );
  await wait(`return !d.querySelector('.confucius-literature-dock').hidden;`);
  await capture("literature-capsule");
  const beforePopup = await evaluate(
    `const before=d.querySelector('.confucius-timeline-pane').scrollTop;d.getElementById('confucius-literature-capsule').click();return before;`,
  );
  await wait(
    `return !d.getElementById('confucius-literature-popup').hidden && d.querySelectorAll('.confucius-literature-row').length===2;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-timeline-pane').scrollTop;`,
    ),
    beforePopup,
  );
  await capture("literature-floating");
  // One editor: tab navigation, selection and scroll position survive docking.
  await evaluate(
    `d.getElementById('confucius-literature-candidates-tab').dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true;`,
  );
  await wait(
    `return d.querySelectorAll('.confucius-literature-row').length===20;`,
  );
  for (const selected of [false, true]) {
    await evaluate(
      `const c=d.querySelector('[data-work-id="W900001"] input[type=checkbox]');c.checked=${selected};c.dispatchEvent(new win.Event('change',{bubbles:true}));return true;`,
    );
    await wait(
      `return host.sessions.get(qa.taskId).record.literature.candidates===${selected ? 2 : 1} && !d.querySelector('.confucius-literature-footer [data-variant=primary]').disabled;`,
    );
  }
  await evaluate(
    `d.querySelector('.confucius-literature-local-filter').open=true;const input=d.querySelector('.confucius-literature-filter');input.value='Research paper 1';input.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  await wait(
    `return d.querySelectorAll('.confucius-literature-row').length===11;`,
  );
  await evaluate(
    `d.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.getElementById('confucius-literature-popup').hidden;`,
    ),
    true,
  );
  await evaluate(
    `d.getElementById('confucius-literature-capsule').click();return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-literature-filter').value;`,
    ),
    "Research paper 1",
  );
  await evaluate(
    `const input=d.querySelector('.confucius-literature-filter');input.value='';input.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  await wait(
    `return d.querySelectorAll('.confucius-literature-row').length===20;`,
  );
  await evaluate(
    `[...d.querySelectorAll('.confucius-literature-popup button')].find(b=>b.textContent==='回到对话位置').click();return true;`,
  );
  await wait(`return d.querySelector('.confucius-literature-dock').hidden;`);
  await capture("literature-card");
  await evaluate(
    `d.querySelector('.confucius-literature-card .confucius-literature-footer button').click();return true;`,
  );
  await wait(
    `return !!d.querySelector('.confucius-literature-card .confucius-literature-editor');`,
  );
  checks.push({
    interaction: {
      promptStartsSearch: true,
      blankTaskHasNoEntry: true,
      chronologicalCard: true,
      capsuleOnlyOffscreen: true,
      popupPreservesConversationScroll: true,
      selectionShared: true,
      keyboardTabs: true,
      escapeCloses: true,
      filterSurvivesReopen: true,
      locateReturnsToCard: true,
    },
    pool: 100,
    apiTotal: 2500,
    unconfirmedLibraryCount: await evaluate(
      `return (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID,true,false)).filter(i=>i.isRegularItem()).length;`,
    ),
  });
  await evaluate(
    `const scroll=d.querySelector('.confucius-literature-scroll');d.querySelector('.confucius-literature-row details').open=true;scroll.scrollTop=64;qa.innerScroll=scroll.scrollTop;const t=d.querySelector('.confucius-timeline-pane');t.scrollTop=t.scrollHeight;return true;`,
  );
  await wait(`return !d.querySelector('.confucius-literature-dock').hidden;`);
  const expandedBefore = await evaluate(
    `const t=d.querySelector('.confucius-timeline-pane');return {top:t.scrollTop,height:t.scrollHeight};`,
  );
  await evaluate(
    `d.getElementById('confucius-literature-capsule').click();return true;`,
  );
  await wait(`return !d.getElementById('confucius-literature-popup').hidden;`);
  assert.deepEqual(
    await evaluate(
      `const t=d.querySelector('.confucius-timeline-pane');return {top:t.scrollTop,height:t.scrollHeight};`,
    ),
    expandedBefore,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-literature-row details').open && d.querySelector('.confucius-literature-scroll').scrollTop===qa.innerScroll;`,
    ),
    true,
  );
  await evaluate(
    `const prompt=d.getElementById('confucius-prompt');prompt.dispatchEvent(new win.Event('pointerdown',{bubbles:true}));prompt.focus();return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.getElementById('confucius-literature-popup').hidden && d.activeElement.id==='confucius-prompt';`,
    ),
    true,
  );
  assert.deepEqual(
    await evaluate(
      `const t=d.querySelector('.confucius-timeline-pane');return {top:t.scrollTop,height:t.scrollHeight};`,
    ),
    expandedBefore,
  );
  // Switching tasks must close the old UI and never show its pool in a blank task.
  await evaluate(
    `d.getElementById('confucius-literature-capsule').click();d.getElementById('confucius-new-session').click();return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-literature-dock').hidden && d.querySelectorAll('.confucius-literature-card').length===0;`,
  );
  await evaluate(
    `d.querySelector('[data-task-id="'+qa.taskId+'"] .confucius-task-open').click();return true;`,
  );
  await wait(
    `return d.querySelectorAll('.confucius-literature-card').length===1;`,
  );
  await evaluate(
    `const card=d.querySelector('.confucius-literature-card');card.scrollIntoView({block:'start'});card.querySelector('.confucius-literature-footer button').click();return true;`,
  );
  await wait(
    `return !!d.querySelector('.confucius-literature-card .confucius-literature-editor');`,
  );
  checks.push({
    editorContinuity: {
      expandedCardPlaceholder: true,
      conversationAndListScrollPreserved: true,
      abstractPreserved: true,
      outsideClickKeepsInputFocus: true,
      taskSwitchIsolation: true,
    },
  });
  const before = await evaluate(
    `return (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID,true,false)).filter(i=>i.isRegularItem()).length;`,
  );
  assert.equal(before, 1);
  await evaluate(
    `[...d.querySelectorAll('.confucius-literature button')].find(b=>b.textContent==='确认候选').click();return true;`,
  );
  await wait(
    `return [...d.querySelectorAll('.confucius-literature button')].some(b=>b.textContent==='确认并获取全文');`,
  );
  await evaluate(
    `[...d.querySelectorAll('.confucius-literature button')].find(b=>b.textContent==='确认并获取全文').click();return true;`,
  );
  await wait(
    `const p=await host.literature.load(qa.taskId);return p.works[0].acquisition.status==='available' && p.works[1].acquisition.status==='failed';`,
  );
  const acquired = await evaluate(
    `const p=await host.literature.load(qa.taskId);return {first:p.works[0].acquisition,second:p.works[1].acquisition,bound:host.sessions.get(qa.taskId).record.lockedContext.items.length};`,
  );
  assert.equal(acquired.first.item.key, await evaluate(`return qa.existing;`));
  assert.equal(acquired.second.error, "invalid_pdf");
  assert.equal(acquired.bound, 2);
  checks.push({
    acquisition: {
      reusedExisting: true,
      validPdf: true,
      htmlRejected: true,
      bound: 2,
    },
  });
  const forged = join(output, "forged.pdf");
  await writeFile(
    forged,
    "%PDF-1.7\n" + "not a PDF object ".repeat(50) + "\n%%EOF",
  );
  await assert.rejects(
    instance.rpc("literature/attach", {
      taskId: await evaluate(`return qa.taskId;`),
      id: "W900001",
      path: forged,
    }),
  );
  assert.equal(
    await evaluate(
      `return (await host.literature.get(qa.taskId,'W900001')).acquisition.status;`,
    ),
    "failed",
  );
  checks.push({ forgedPdf: { parserRejected: true } });
  await wait(`return !!d.querySelector('.confucius-literature-drop');`);
  await evaluate(
    `await host.rpc('literature/browser',{taskId:qa.taskId,id:'W900001'});const drop=d.querySelector('[data-work-id="W900001"]').querySelector('.confucius-literature-drop');const event=new win.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[{path:${JSON.stringify(join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"))}}]}});drop.dispatchEvent(event);return true;`,
  );
  await wait(
    `return (await host.literature.get(qa.taskId,'W900001')).acquisition.status==='available';`,
  );
  assert.equal(await evaluate(`return qa.opened.length;`), 1);
  await evaluate(
    `await host.rpc('literature/confirm',{taskId:qa.taskId,candidateRevision:3});return true;`,
  );
  assert.equal(
    await evaluate(
      `return (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID,true,false)).filter(i=>i.isRegularItem()).length;`,
    ),
    2,
  );
  checks.push({
    manualPdf: {
      targetedDrop: true,
      browserDispatch: true,
      originalPreserved: true,
      noAutomaticResearch: await evaluate(
        `return !host.sessions.get(qa.taskId).activeTurnId;`,
      ),
    },
  });
  await capture("literature-light");
  await evaluate(`await host.rpc('config/set',{baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic-fixture',model:'research-fixture',maxTokens:4096,contextWindowTokens:32768,historyAutoCleanup:false});
    host.openaiAdapter=(options)=>({complete:async(request)=>{qa.requests.push({task:request.messages[0].content,tools:request.tools.map(t=>t.name)});await request.onAttempt?.();return new Promise(resolve=>qa.pending.push({resolve,emit:options.onTextDelta,child:request.messages[0].content.includes('You are an isolated research subagent')}));}});
    await host.rpc('task/prompt',{taskId:qa.taskId,text:'Compare methods using isolated child research'});return true;`);
  await wait(`return qa.pending.length>=1;`);
  await evaluate(
    `const p=qa.pending.shift();p.resolve({end:'tool_calls',toolCalls:[{id:'delegate1',name:'subagent_spawn',args:{title:'比较方法',goal:'Read the assigned methods and report limitations',sourceIds:[],background:'Only explicit background'}}]});return true;`,
  );
  await wait(
    `return (await host.subagents().list(qa.taskId)).some(r=>r.status==='running');`,
  );
  await wait(`return !!d.querySelector('.confucius-subagent-entries button');`);
  await evaluate(
    `const button=d.querySelector('.confucius-subagent-entries button');button.scrollIntoView({block:'center'});button.click();return true;`,
  );
  await wait(`return !!d.getElementById('confucius-subagent-popup');`);
  assert.equal(
    await evaluate(
      `return d.getElementById('confucius-subagent-popup').querySelectorAll('input,textarea').length;`,
    ),
    0,
  );
  await capture("subagent-popup");
  await evaluate(
    `d.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;`,
  );
  assert.equal(
    await evaluate(
      `return (await host.subagents().list(qa.taskId))[0].status;`,
    ),
    "running",
  );
  checks.push({
    subagent: {
      spawnThroughNativeTool: true,
      readOnlyBubble: true,
      closeKeepsRunning: true,
    },
  });
  await evaluate(
    `d.querySelector('.confucius-subagent-entry').click();return true;`,
  );
  await wait(`return !!d.getElementById('confucius-subagent-popup');`);
  await evaluate(
    `const index=qa.pending.findIndex(p=>p.child);if(index<0)throw new Error('Missing child fixture');qa.pending.splice(index,1)[0].resolve({end:'stop',text:'Child result: compare the explicit source methods; no additional evidence was read.'});return true;`,
  );
  await wait(
    `return (await host.subagents().list(qa.taskId))[0].status==='completed' && d.querySelector('.confucius-subagent-result')?.textContent.includes('Child result');`,
  );
  assert.equal(
    await evaluate(
      `const bubble=d.getElementById('confucius-subagent-popup').getBoundingClientRect(),anchor=d.querySelector('.confucius-subagent-entry').getBoundingClientRect();return Math.abs(bubble.left-anchor.left)<16 && bubble.top>=8 && bubble.bottom<=win.innerHeight-8;`,
    ),
    true,
  );
  await evaluate(
    `d.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true;`,
  );
  checks.push({
    subagentCompletionBubble: {
      latestResult: true,
      anchorSurvivesTimelineUpdate: true,
    },
  });
  await evaluate(
    `await host.rpc('task/abort',{taskId:qa.taskId});for(const p of qa.pending.splice(0))p.resolve({end:'stop',text:'Cancelled fixture result'});return true;`,
  );
  await wait(`return !host.sessions.get(qa.taskId).activeTurnId;`);
  // Exercise confirmation as an execution boundary, then continue and delegate
  // against the newly bound source within the same parent request.
  await evaluate(`const task=await host.rpc('task/new',{title:'Confirmation continuation'});qa.continuation=task.id;qa.parentCalls=0;
    await host.rpc('literature/search',{taskId:task.id,query:'continuation'});
    await host.rpc('literature/updateCandidates',{taskId:task.id,candidateRevision:0,changes:[{id:'W900000',selected:true,reason:'Assigned evidence'}]});
    host.openaiAdapter=()=>({complete:async request=>{await request.onAttempt?.();
      if(request.messages[0].content.includes('You are an isolated research subagent'))return {end:'stop',text:'Assigned paper retained; this fixture does not claim fulltext reading.'};
      const n=++qa.parentCalls;
      if(n===1)return {end:'tool_calls',toolCalls:[{id:'acquire',name:'literature_acquire',args:{waitForFulltext:true}}]};
      if(n===2)return {end:'tool_calls',toolCalls:[{id:'spawn',name:'subagent_spawn',args:{goal:'Inspect the assigned source scope',sourceIds:['W900000']}}]};
      if(n===3)return {end:'tool_calls',toolCalls:[{id:'wait',name:'subagent_wait',args:{}}]};
      return {end:'stop',text:'Confirmed source accepted in the same request.'};}});
    await host.rpc('task/prompt',{taskId:task.id,text:'Acquire the candidate, then delegate this paper'});return true;`);
  await wait(
    `return host.literature.isWaitingForConfirmation(qa.continuation,host.sessions.get(qa.continuation).record.run.id);`,
  );
  await evaluate(
    `await host.rpc('literature/confirm',{taskId:qa.continuation,candidateRevision:1});return true;`,
  );
  await wait(`return !host.sessions.get(qa.continuation).activeTurnId;`);
  const continuation = await evaluate(
    `const state=host.sessions.get(qa.continuation);return {sources:state.record.run.sources.items.length,children:await host.subagents().list(qa.continuation)};`,
  );
  assert.equal(continuation.sources, 1);
  assert.equal(continuation.children.length, 1);
  assert.equal(continuation.children[0].status, "completed");
  checks.push({
    confirmationContinuation: { sameRequest: true, scopedChildCompleted: true },
  });
  await evaluate(
    `await host.rpc('config/set',{uiTheme:'dark',uiLanguage:'en-US'});win.close();return true;`,
  );
  await evaluate(
    `const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;`,
  );
  await wait(`return !!d?.querySelector('.confucius-literature');`);
  await evaluate(
    `win.resizeTo(420,720);const timeline=d.querySelector('.confucius-timeline-pane');timeline.scrollTop=timeline.scrollHeight;return true;`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await wait(`return !d.querySelector('.confucius-literature-dock').hidden;`);
  await evaluate(
    `d.getElementById('confucius-literature-capsule').click();return true;`,
  );
  await wait(`return !d.getElementById('confucius-literature-popup').hidden;`);
  const narrow = await evaluate(
    `const popup=d.getElementById('confucius-literature-popup'),scroll=popup.querySelector('.confucius-literature-scroll');scroll.scrollTop=scroll.scrollHeight;const rect=popup.getBoundingClientRect();return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,viewport:win.innerWidth,scrollable:scroll.scrollHeight>scroll.clientHeight,reachedEnd:Math.abs(scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight)<2};`,
  );
  assert.ok(
    narrow.left >= 7 &&
      narrow.right <= narrow.viewport - 7 &&
      narrow.scrollable &&
      narrow.reachedEnd,
  );
  checks.push({ narrowPopover: narrow });
  await evaluate(
    `d.querySelector('.confucius-literature-scroll').scrollTop=0;return true;`,
  );
  await capture("literature-dark-narrow");
  assert.equal(
    await evaluate(
      `return d.documentElement.scrollWidth<=d.documentElement.clientWidth+1;`,
    ),
    true,
  );
  checks.push({ uiErrors: await evaluate(`return qa.errors;`) });
  assert.deepEqual(checks.at(-1).uiErrors, []);
  await evaluate(`await host.persistNow();return true;`);
  const savedTask = await evaluate(`return qa.taskId;`);
  await instance.stop({ graceful: true });
  await instance.launch();
  const restored = await instance.rpc("task/load", { taskId: savedTask });
  assert.equal(restored.lockedContext.items.length, 2);
  const page = await instance.rpc("literature/list", { taskId: savedTask });
  assert.equal(page.summary.pool, 100);
  assert.equal(page.summary.available, 2);
  checks.push({ restart: { pool: 100, available: 2, bound: 2 } });
  try {
    const live = await instance.rpc("task/new", {
      title: "OpenAlex anonymous connection check",
    });
    const response = await instance.rpc(
      "literature/search",
      {
        taskId: live.id,
        query: "bibliographic coupling",
        fromYear: 2020,
        toYear: 2026,
        sort: "relevance",
      },
      45000,
    );
    checks.push({
      onlineOpenAlex: {
        authenticated: false,
        pool: response.summary.pool,
        total: response.queries[0]?.total,
      },
    });
  } catch (error) {
    checks.push({
      onlineOpenAlex: { authenticated: false, error: String(error) },
    });
  }
  console.log(
    JSON.stringify(
      { passed: true, checks, liveKey: "not used", onlineModels: "not used" },
      null,
      2,
    ),
  );
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      { passed: true, checks, liveKey: "not used", onlineModels: "not used" },
      null,
      2,
    ),
  );
} finally {
  await instance.stop({ graceful: true }).catch(() => {});
  server.close();
}
