/** Native sidebar regression: a fresh Zotero profile, synthetic conversations, no model calls. */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_SIDEBAR_OUTPUT ??
    join(root, "output/sidebar-navigation"),
);
await mkdir(output, { recursive: true });
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi:
    process.env.CONFUCIUS_SIDEBAR_XPI ??
    join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "sidebar-navigation-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\nuser_pref("extensions.zotero.confucius.workspaceWidth", 1200);\nuser_pref("extensions.zotero.confucius.uiLanguage", "zh-CN");\nuser_pref("extensions.zotero.confucius.uiTheme", "light");\n',
);
const result = { checks: [], clicks: 0 };
const evaluate = (code) =>
  instance.rdp.evaluate(
    `const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml');const d=win?.document;let qa=Zotero.__sidebarQA;\n${code}`,
    30000,
  );
const waitFor = (code) => until(() => evaluate(code), 15000, 50);
const check = (label) => {
  result.checks.push(label);
  console.log(`PASS ${label}`);
};
const screenshot = async (name) => {
  const data = await evaluate(
    `if(!win)return null;const c=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=win.innerWidth;c.height=win.innerHeight;c.getContext('2d').drawWindow(win,0,0,c.width,c.height,win.getComputedStyle(d.body).backgroundColor);return c.toDataURL('image/png');`,
  );
  if (data)
    await writeFile(
      join(output, name + ".png"),
      Buffer.from(data.split(",")[1], "base64"),
    );
};
const selected = (index) =>
  waitFor(
    `return qa.selected()===qa.tasks[${index}].id && d.getElementById('confucius-prompt').value===qa.tasks[${index}].draft.text;`,
  );
const clickTask = async (index) => {
  await evaluate(`qa.clickTask(qa.tasks[${index}].id);return true;`);
  result.clicks++;
  await selected(index);
};
try {
  result.environment = await instance.launch();
  console.log(`Isolated Zotero ${result.environment.zotero}`);
  await evaluate(`const host=Zotero.Confucius.hooks.host;qa=Zotero.__sidebarQA={tasks:[],papers:[],requests:[],delays:{},errors:[]};
    for(const title of ['A · 证据检索与长期记忆','B · 多智能体的上下文管理','C · 评测设计与复现','D · 方法与局限']) {
      const item=new Zotero.Item('journalArticle');item.setField('title',title);await item.saveTx();
      const pdf=await Zotero.Attachments.importFromFile({file:${JSON.stringify(join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"))},parentItemID:item.id});
      qa.papers.push({item,pdf,context:{version:1,capturedAt:Date.now(),items:[{id:'item:'+item.libraryID+':'+item.key,libraryID:item.libraryID,key:item.key,title,source:'library',attachmentKey:pdf.key}]}});
    }
    for(let n=0;n<48;n++) {
      const record=await host.rpc('task/new',{title:n%8===0?'同名对话':String(n).padStart(2,'0')+' · 梳理问题、证据与结论',titleState:'fixed',backend:'codex',context:n<40?qa.papers[n%4].context:{version:1,capturedAt:Date.now(),items:[]}});
      const state=host.sessions.get(record.id);record.draft={text:'draft:'+n,references:[]};
      host.emitSessionEvent(state,'fixture-'+n,'turn_started',{userText:'question:'+n});host.emitSessionEvent(state,'fixture-'+n,'text_delta',{text:'answer:'+n});host.emitSessionEvent(state,'fixture-'+n,'turn_completed',{phase:'done'});
      record.status='completed';record.updatedAt=Date.now()-[0,1,3,12,45][n%5]*86400000-n*1000;qa.tasks.push(record);
    }
    const original=host.rpc.bind(host);qa.original=original;
    host.rpc=async(method,params={})=>{
      const key=method+'/'+(params.taskId??'');const plan=qa.delays[key]?.shift();qa.requests.push({method,id:params.taskId,at:Date.now()});
      const value=await original(method,params);const copy=JSON.parse(JSON.stringify(value??null));
      if(plan)await new Promise(resolve=>Zotero.getMainWindow().setTimeout(resolve,plan.ms));
      if(plan?.fail)throw new Error('fixture delayed failure');return copy;
    };
    Zotero.getMainWindow().document.getElementById('confucius-toolbar-button').dispatchEvent(new (Zotero.getMainWindow().Event)('command'));return true;`);
  await waitFor(
    `return !!d?.querySelector('[data-entry-id^="overview:"]') && d.querySelectorAll('.confucius-task-row').length===48;`,
  );
  await evaluate(`qa.selected=()=>d.querySelector('[data-entry-id^="overview:"]')?.dataset.entryId.slice(9);qa.clickTask=id=>{
    const row=[...d.querySelectorAll('.confucius-task-row')].find(row=>row.dataset.taskId===id);
    if(!row)throw new Error('Missing row '+id);const group=row.closest('.confucius-task-group');const toggle=group?.querySelector('.confucius-article-toggle');if(toggle?.getAttribute('aria-expanded')==='false')toggle.click();
    row.querySelector('.confucius-task-open').click();
  };win.addEventListener('unhandledrejection',event=>qa.errors.push(String(event.reason)));win.addEventListener('error',event=>qa.errors.push(event.message));return true;`);
  const initial = await evaluate(
    `return {mode:d.getElementById('confucius-session-pane').dataset.organization,groups:d.querySelectorAll('.confucius-task-group').length,recent:d.querySelector('[data-task-group="recent"]')!==null};`,
  );
  assert.deepEqual(initial, { mode: "articles", groups: 5, recent: false });
  check(
    "article mode includes all 48 tasks, including 8 without an article, with no Recent section",
  );

  const codecCheck = await evaluate(
    `const host=Zotero.Confucius.hooks.host;const original=Zotero.getMainWindow;const task=qa.tasks[0];const content='中文研究笔记 😀';let ref;try {Zotero.getMainWindow=()=>null;ref=await host.history.append({taskId:task.id,windowId:task.contextWindow.id,itemId:'codec-regression',role:'assistant',content});}finally{Zotero.getMainWindow=original;}return {ref,files:await host.history.exportTask(task.id)};`,
  );
  assert(
    codecCheck.files.items.some((item) => item.content === "中文研究笔记 😀"),
  );
  check(
    "native history writes and restores Chinese/emoji while the main-window API is unavailable",
  );

  for (const mode of ["articles", "time"]) {
    await evaluate(
      `d.getElementById('confucius-tasks-${mode}').click();return true;`,
    );
    for (let n = 0; n < 48; n++) await clickTask(n);
    const ids = await evaluate(
      `return [...d.querySelectorAll('.confucius-task-row')].map(row=>row.dataset.taskId);`,
    );
    assert.equal(new Set(ids).size, 48);
    assert.equal(ids.length, 48);
    check(
      `${mode}: all 48 individual clicks select the intended history and draft, including duplicate titles`,
    );
  }

  await evaluate(`await Zotero.Reader.open(qa.papers[2].pdf.id);return true;`);
  for (let n = 0; n < 16; n++) await clickTask(n);
  const groupsAfterReading = await evaluate(
    `d.getElementById('confucius-tasks-articles').click();return [...d.querySelectorAll('.confucius-task-group')].map(group=>({id:group.dataset.groupId,ids:[...group.querySelectorAll('.confucius-task-row')].map(row=>row.dataset.taskId)}));`,
  );
  for (let n = 0; n < 40; n++) {
    const expected = await evaluate(
      `return qa.papers[${n % 4}].item.libraryID+':'+qa.papers[${n % 4}].item.key;`,
    );
    const id = await evaluate(`return qa.tasks[${n}].id;`);
    assert.deepEqual(
      groupsAfterReading
        .filter((group) => group.ids.includes(id))
        .map((group) => group.id),
      [expected],
    );
  }
  check(
    "opening a different PDF and visiting 16 tasks does not add or move article associations",
  );

  for (const mode of ["articles", "time"]) {
    await evaluate(
      `d.getElementById('confucius-tasks-${mode}').click();return true;`,
    );
    for (let batch = 0; batch < 12; batch++) {
      const sequence = Array.from(
        { length: 16 },
        (_, i) => (batch * 13 + i * 7) % 48,
      );
      await evaluate(
        `for(const [i,n] of ${JSON.stringify(sequence)}.entries()) {const id=qa.tasks[n].id;qa.delays['task/load/'+id]=[{ms:25+(i%5)*35}];qa.delays['task/events/'+id]=[{ms:30+(i%4)*25}];qa.clickTask(id);}return true;`,
      );
      result.clicks += sequence.length;
      await selected(sequence.at(-1));
      await evaluate(
        `await new Promise(resolve=>win.setTimeout(resolve,210));return true;`,
      );
      assert.equal(
        await evaluate(
          `return qa.selected()===qa.tasks[${sequence.at(-1)}].id;`,
        ),
        true,
      );
    }
    check(
      `${mode}: 192 rapid clicks with deliberately reordered load/event replies keep the last selection`,
    );
  }
  await evaluate(
    `qa.delays={};d.getElementById('confucius-tasks-time').click();return true;`,
  );
  await clickTask(0);
  await evaluate(
    `const id=qa.tasks[1].id;qa.delays['task/load/'+id]=[{ms:300}];qa.before=qa.requests.filter(r=>r.method==='task/load'&&r.id===id).length;for(let n=0;n<20;n++)qa.clickTask(id);return true;`,
  );
  result.clicks += 20;
  await selected(1);
  assert.equal(
    await evaluate(
      `return qa.requests.filter(r=>r.method==='task/load'&&r.id===qa.tasks[1].id).length-qa.before;`,
    ),
    1,
  );
  check("20 repeated clicks on a pending task perform one load");
  await evaluate(
    `qa.delays['task/load/'+qa.tasks[2].id]=[{ms:350,fail:true}];qa.clickTask(qa.tasks[2].id);qa.clickTask(qa.tasks[1].id);await new Promise(resolve=>win.setTimeout(resolve,450));return {id:qa.selected(),expected:qa.tasks[1].id};`,
  ).then((value) => assert.equal(value.id, value.expected));
  result.clicks += 2;
  check(
    "A → B → A cancels B, including a late failure without an unhandled rejection",
  );

  // Real mouse down/up with a background metadata change between the two events.
  await evaluate(
    `d.getElementById('confucius-tasks-time').click();const pane=d.getElementById('confucius-session-pane');pane.scrollTop=0;const target=[...d.querySelectorAll('.confucius-task-open')].find(button=>button.getBoundingClientRect().top>pane.getBoundingClientRect().top+120);const r=target.getBoundingClientRect();qa.pointer={x:r.x+24,y:r.y+r.height/2,id:target.parentElement.dataset.taskId,top:r.top};win.windowUtils.sendMouseEvent('mousemove',qa.pointer.x,qa.pointer.y,0,0,0);win.windowUtils.sendMouseEvent('mousedown',qa.pointer.x,qa.pointer.y,0,1,0);const record=Zotero.Confucius.hooks.host.sessions.get(qa.pointer.id).record;record.updatedAt=Date.now()+100000;record.title+=' · metadata';return true;`,
  );
  await waitFor(
    `return [...d.querySelectorAll('.confucius-task-row')].find(row=>row.dataset.taskId===qa.pointer.id)?.textContent.includes('metadata');`,
  );
  const hit = await evaluate(
    `const hit=d.elementFromPoint(qa.pointer.x,qa.pointer.y)?.closest('.confucius-task-row')?.dataset.taskId;win.windowUtils.sendMouseEvent('mouseup',qa.pointer.x,qa.pointer.y,0,1,0);return {hit,expected:qa.pointer.id};`,
  );
  result.clicks++;
  assert.equal(hit.hit, hit.expected);
  await waitFor(`return qa.selected()===qa.pointer.id;`);
  check(
    "a real mouse click retains its target when a poll changes task recency between down and up",
  );

  await evaluate(
    `const pane=d.getElementById('confucius-session-pane');const target=d.querySelector('.confucius-task-group[data-group-id="yesterday"] .confucius-task-open');target.scrollIntoView({block:'center'});const r=target.getBoundingClientRect();qa.pointer={x:r.x+24,y:r.y+r.height/2,id:target.parentElement.dataset.taskId};win.windowUtils.sendMouseEvent('mousemove',qa.pointer.x,qa.pointer.y,0,0,0);win.windowUtils.sendMouseEvent('mousedown',qa.pointer.x,qa.pointer.y,0,1,0);const record=Zotero.Confucius.hooks.host.sessions.get(qa.pointer.id).record;record.updatedAt=Date.now();record.title+=' · cross-day';return true;`,
  );
  await waitFor(
    `return [...d.querySelectorAll('.confucius-task-row')].find(row=>row.dataset.taskId===qa.pointer.id)?.textContent.includes('cross-day');`,
  );
  assert.equal(
    await evaluate(
      `return d.elementFromPoint(qa.pointer.x,qa.pointer.y)?.closest('.confucius-task-row')?.dataset.taskId===qa.pointer.id;`,
    ),
    true,
  );
  await evaluate(
    `win.windowUtils.sendMouseEvent('mouseup',qa.pointer.x,qa.pointer.y,0,1,0);return true;`,
  );
  result.clicks++;
  await waitFor(`return qa.selected()===qa.pointer.id;`);
  check(
    "a task moving from Yesterday to Today also retains its pointer target until navigation ends",
  );

  await evaluate(
    `win.windowUtils.sendMouseEvent('mousemove',800,300,0,0,0);d.getElementById('confucius-prompt').focus();d.getElementById('confucius-tasks-articles').click();const search=d.querySelector('.confucius-task-search');search.value='同名对话';search.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  const searched = await evaluate(
    `return [...d.querySelectorAll('.confucius-task-row')].map(row=>row.dataset.taskId);`,
  );
  assert.equal(searched.length, 6);
  await evaluate(
    `const toggle=d.querySelector('.confucius-article-toggle');qa.searchToggle=toggle;toggle.click();return true;`,
  );
  assert.equal(
    await evaluate(`return qa.searchToggle.getAttribute('aria-expanded');`),
    "false",
  );
  await evaluate(
    `qa.searchToggle.click();const search=d.querySelector('.confucius-task-search');search.value='not-a-real-task';search.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  assert.equal(
    await evaluate(`return d.querySelectorAll('.confucius-task-row').length;`),
    0,
  );
  await evaluate(
    `d.getElementById('confucius-tasks-time').click();const search=d.querySelector('.confucius-task-search');search.value='';search.dispatchEvent(new win.Event('input',{bubbles:true}));search.focus();search.dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.activeElement.classList.contains('confucius-task-open');`,
    ),
    true,
  );
  await evaluate(
    `d.activeElement.dispatchEvent(new win.KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));d.activeElement.click();return true;`,
  );
  result.clicks++;
  await waitFor(
    `return qa.selected()===d.activeElement.closest('.confucius-task-row')?.dataset.taskId;`,
  );
  await evaluate(
    `d.activeElement.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.activeElement.classList.contains('confucius-task-search');`,
    ),
    true,
  );
  check(
    "search, zero matches, article collapse during search, and keyboard navigation remain usable",
  );

  // An older create request cannot steal a subsequent click.
  await clickTask(5);
  await evaluate(
    `qa.delays['task/new/']=[{ms:450}];d.getElementById('confucius-new-session').click();qa.clickTask(qa.tasks[6].id);return true;`,
  );
  result.clicks += 2;
  await selected(6);
  await evaluate(
    `await new Promise(resolve=>win.setTimeout(resolve,600));return true;`,
  );
  assert.equal(await evaluate(`return qa.selected()===qa.tasks[6].id;`), true);
  check(
    "a delayed New conversation response cannot steal a later conversation selection",
  );

  // Menu actions do not also open a conversation; deletion cannot cancel another pending selection.
  await clickTask(7);
  await evaluate(
    `const id=qa.tasks[7].id;qa.delays['task/load/'+qa.tasks[8].id]=[{ms:500}];qa.clickTask(qa.tasks[8].id);const row=[...d.querySelectorAll('.confucius-task-row')].find(row=>row.dataset.taskId===id);row.querySelector('.confucius-task-menu-trigger').click();d.querySelector('#confucius-task-action-menu [data-danger="true"]').click();return true;`,
  );
  result.clicks += 3;
  await selected(8);
  assert.equal(
    await evaluate(
      `return !!d.querySelector('.confucius-task-row[data-task-id="'+qa.tasks[7].id+'"]');`,
    ),
    false,
  );
  check(
    "deleting the previous task from its menu does not cancel the newer pending selection",
  );

  // Exercise the same navigation while the sidebar is a narrow overlay.
  for (const width of [1200, 400, 220]) {
    await evaluate(`win.resizeTo(${width},760);return true;`);
    await waitFor(`return win.innerWidth===${width};`);
    for (let n = 0; n < 12; n++) {
      const geometry = await evaluate(
        `const toggle=d.getElementById('confucius-toggle-sessions');const before=toggle.getBoundingClientRect();toggle.click();const after=toggle.getBoundingClientRect();return {x:before.x,y:before.y,nx:after.x,ny:after.y,width:win.innerWidth,scroll:d.documentElement.scrollWidth};`,
      );
      result.clicks++;
      assert.equal(geometry.x, geometry.nx);
      assert.equal(geometry.y, geometry.ny);
      assert(geometry.scroll <= geometry.width);
    }
    await evaluate(
      `const toggle=d.getElementById('confucius-toggle-sessions');if(toggle.getAttribute('aria-expanded')!=='true')toggle.click();d.getElementById('confucius-tasks-time').click();qa.clickTask(qa.tasks[9].id);return true;`,
    );
    result.clicks += 2;
    await selected(9);
    check(
      `${width}px: repeated folding keeps the toggle fixed and task selection works without horizontal overflow`,
    );
  }
  await evaluate(
    `win.resizeTo(1200,760);const toggle=d.getElementById('confucius-toggle-sessions');if(toggle.getAttribute('aria-expanded')!=='true')toggle.click();d.getElementById('confucius-tasks-articles').click();for(const button of d.querySelectorAll('.confucius-article-toggle'))if(button.getAttribute('aria-expanded')==='false')button.click();d.getElementById('confucius-session-pane').scrollTop=0;return true;`,
  );
  await screenshot("articles-light");
  await evaluate(
    `d.getElementById('confucius-tasks-time').click();await qa.original('config/set',{uiTheme:'dark'});return true;`,
  );
  await waitFor(
    `return d.documentElement.getAttribute('data-confucius-theme')==='dark';`,
  );
  await evaluate(
    `d.getElementById('confucius-session-pane').scrollTop=0;return true;`,
  );
  await evaluate(
    `await new Promise(resolve=>win.setTimeout(resolve,180));return true;`,
  );
  result.colors = await evaluate(
    `return [...d.querySelectorAll('.confucius-task-row[data-active="true"],.confucius-task-row[data-active="true"] button,[role="tab"][aria-selected="true"]')].map(node=>{const css=win.getComputedStyle(node);return {class:node.className,color:css.color,background:css.backgroundColor,selected:css.getPropertyValue('--confucius-selected'),style:node.getAttribute('style')};});`,
  );
  assert.equal(
    result.colors.find((item) => item.class === "confucius-task-row")
      .background,
    "rgb(68, 60, 47)",
  );
  await screenshot("time-dark");
  check(
    "dark selected rows retain readable contrast after the theme transition",
  );
  const createdForArticle = await evaluate(
    `const main=Zotero.getMainWindow();qa.originalMainFocus=main.focus;qa.mainFocusRequests=0;main.focus=function(...args){qa.mainFocusRequests++;return qa.originalMainFocus.apply(this,args);};qa.beforeFocus={active:Services.focus.activeWindow,tab:main.Zotero_Tabs.selectedID,readers:qa.requests.filter(r=>r.method==='reader/open').length,newTasks:qa.requests.filter(r=>r.method==='task/new').length};d.getElementById('confucius-tasks-articles').click();const plus=d.querySelector('.confucius-article-new');qa.createdArticle=plus.closest('.confucius-task-group').dataset.articleId;for(let n=0;n<20;n++)plus.click();return qa.createdArticle;`,
  );
  result.clicks += 20;
  await waitFor(
    `return qa.requests.filter(r=>r.method==='task/new').length===qa.beforeFocus.newTasks+1 && !qa.tasks.some(task=>task.id===qa.selected()) && d.querySelector('.confucius-article-new')?.disabled===false;`,
  );
  const focus = await evaluate(
    `const task=await qa.original('task/load',{taskId:qa.selected()});return {focused:Services.focus.activeWindow===qa.beforeFocus.active,focusRequests:qa.mainFocusRequests,tab:Zotero.getMainWindow().Zotero_Tabs.selectedID,originalTab:qa.beforeFocus.tab,readers:qa.requests.filter(r=>r.method==='reader/open').length-qa.beforeFocus.readers,articles:task.articleSources.map(item=>item.libraryID+':'+item.key)};`,
  );
  result.creationFocus = focus;
  assert.equal(focus.focused, true);
  assert.equal(focus.focusRequests, 0);
  assert.equal(focus.tab, focus.originalTab);
  assert.equal(focus.readers, 0);
  assert(focus.articles.includes(createdForArticle));
  check(
    "20 article-plus clicks create one attached conversation without opening a reader, changing tabs, or requesting main-window focus",
  );
  await evaluate(
    `qa.beforeNew=qa.requests.filter(r=>r.method==='task/new').length;qa.previousNew=qa.selected();for(let n=0;n<20;n++)d.getElementById('confucius-new-session').click();return true;`,
  );
  result.clicks += 20;
  await waitFor(
    `return qa.selected()!==qa.previousNew && !d.getElementById('confucius-new-session').disabled;`,
  );
  assert.equal(
    await evaluate(
      `return qa.requests.filter(r=>r.method==='task/new').length-qa.beforeNew;`,
    ),
    1,
  );
  assert.equal(
    await evaluate(
      `return Services.focus.activeWindow===qa.beforeFocus.active && qa.mainFocusRequests===0;`,
    ),
    true,
  );
  check(
    "20 toolbar New clicks create one task without changing the active window",
  );
  await evaluate(
    `Zotero.getMainWindow().focus=qa.originalMainFocus;d.getElementById('confucius-tasks-time').click();return true;`,
  );
  await evaluate(
    `d.getElementById('confucius-tasks-articles').click();qa.delays['task/new/']=[{ms:350}];qa.beforeArticleRace=qa.requests.filter(r=>r.method==='task/new').length;d.querySelector('.confucius-article-new').click();qa.clickTask(qa.tasks[12].id);return true;`,
  );
  result.clicks += 2;
  await selected(12);
  await evaluate(
    `await new Promise(resolve=>win.setTimeout(resolve,500));return true;`,
  );
  assert.equal(await evaluate(`return qa.selected()===qa.tasks[12].id;`), true);
  check(
    "an article-plus click followed immediately by another conversation keeps that later selection after creation finishes",
  );
  const doubleClick = await evaluate(
    `const before=qa.requests.filter(r=>r.method==='task/new').length;for(const button of [d.getElementById('confucius-new-session'),d.querySelector('.confucius-article-new')])button.dispatchEvent(new win.MouseEvent('click',{bubbles:true,detail:2}));await new Promise(resolve=>win.setTimeout(resolve,100));return qa.requests.filter(r=>r.method==='task/new').length-before;`,
  );
  result.clicks += 2;
  assert.equal(doubleClick, 0);
  check("the second click of a mouse double-click cannot create another task");
  await evaluate(
    `d.getElementById('confucius-tasks-time').click();return true;`,
  );

  // Exercise the installed add-on's real waiting row, without starting a model.
  await evaluate(
    `const h=Zotero.Confucius.hooks.host;const s=h.sessions.get(qa.tasks[12].id);s.record.status='running';h.emitSessionEvent(s,'loading-fixture','turn_started',{userText:'检查流光显示'});h.emitSessionEvent(s,'loading-fixture','reasoning_delta',{text:'核对证据',statusText:'正在核对论文中的证据'});qa.loadingRoot=d.querySelector('.confucius-workspace-root');qa.inspectLoading=()=>{const row=d.querySelector('.tui-waiting');const text=row?.querySelector('.tui-waiting-text');const path=row?.querySelector('svg path');const shine=row?.querySelector('.tui-waiting-shine');const box=row?.getBoundingClientRect();return {text:text?.textContent,color:text&&win.getComputedStyle(text).color,fill:path&&win.getComputedStyle(path).fill,clock:row?.querySelector('.tui-waiting-elapsed')?.textContent,width:box?.width,height:box?.height,animations:row?.getAnimations({subtree:true}).map(a=>a.animationName),duplicateHidden:shine?.getAttribute('aria-hidden'),duplicate:shine?.textContent,palette:d.getElementById('confucius-palette-css')?.getAttribute('href')};};return true;`,
  );
  await waitFor(
    `return !!d.querySelector('.tui-waiting-elapsed')?.textContent;`,
  );
  result.loading = {};
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `await qa.original('config/set',{uiTheme:${JSON.stringify(theme)}});return true;`,
    );
    await waitFor(
      `return d.documentElement.getAttribute('data-confucius-theme')===${JSON.stringify(theme)};`,
    );
    for (const mode of ["normal", "legacy", "no-effects"]) {
      await evaluate(
        `for(const token of ['deep','bright','shine'])qa.loadingRoot.style.removeProperty('--confucius-loading-'+token);d.getElementById('loading-qa-effects')?.remove();if(${JSON.stringify(mode)}==='legacy')for(const token of ['deep','bright','shine'])qa.loadingRoot.style.setProperty('--confucius-loading-'+token,'initial');if(${JSON.stringify(mode)}==='no-effects'){const style=d.createElementNS('http://www.w3.org/1999/xhtml','style');style.id='loading-qa-effects';style.textContent='.tui-waiting *,.tui-waiting *::before,.tui-waiting *::after{background-image:none!important;mask-image:none!important;-webkit-mask-image:none!important;animation:none!important}.tui-waiting-metal{display:none!important}';d.head.append(style);}await new Promise(resolve=>win.setTimeout(resolve,180));return true;`,
      );
      const value = await evaluate(`return qa.inspectLoading();`);
      result.loading[`${theme}-${mode}`] = value;
      assert(value.text && value.color !== "rgba(0, 0, 0, 0)");
      assert(value.fill && !["none", "rgba(0, 0, 0, 0)"].includes(value.fill));
      assert(value.clock && value.width > 0 && value.height > 0);
      assert.equal(value.duplicateHidden, "true");
      assert.equal(value.duplicate, value.text);
      assert(value.palette.endsWith(`?v=${result.environment.version}`));
      assert.equal(value.animations.length, mode === "no-effects" ? 0 : 3);
      await screenshot(`loading-${theme}-${mode}`);
    }
    check(
      `${theme}: installed gold logo, status and clock stay visible with normal, old and disabled effect styles`,
    );
  }
  await evaluate(
    `d.getElementById('loading-qa-effects')?.remove();qa.loadingRow=d.querySelector('.tui-waiting');qa.loadingText=qa.loadingRow.querySelector('.tui-waiting-text');qa.loadingAnimations=qa.loadingRow.getAnimations({subtree:true});qa.loadingTime=Number(qa.loadingAnimations[0].currentTime);return true;`,
  );
  for (let n = 0; n < 8; n++) {
    await evaluate(
      `const h=Zotero.Confucius.hooks.host;h.emitSessionEvent(h.sessions.get(qa.tasks[12].id),'loading-fixture','reasoning_delta',{text:' · ${n}'});await new Promise(resolve=>win.setTimeout(resolve,180));return true;`,
    );
  }
  const continuity = await evaluate(
    `return {row:qa.loadingRow===d.querySelector('.tui-waiting'),text:qa.loadingText===d.querySelector('.tui-waiting-text'),animations:qa.loadingAnimations.every(a=>qa.loadingRow.getAnimations({subtree:true}).includes(a)),advanced:Number(qa.loadingAnimations[0].currentTime)-qa.loadingTime};`,
  );
  result.loading.continuity = continuity;
  assert(continuity.row && continuity.text && continuity.animations);
  assert(continuity.advanced > 1000);
  check(
    "streamed events and timer ticks preserve the mounted logo, text and advancing animations",
  );
  await evaluate(
    `Services.prefs.setIntPref('ui.prefersReducedMotion',1);return true;`,
  );
  await waitFor(
    `return win.matchMedia('(prefers-reduced-motion: reduce)').matches;`,
  );
  result.loading.reducedMotion = await evaluate(`return qa.inspectLoading();`);
  assert.equal(result.loading.reducedMotion.animations.length, 0);
  assert.notEqual(result.loading.reducedMotion.color, "rgba(0, 0, 0, 0)");
  assert.notEqual(result.loading.reducedMotion.fill, "rgba(0, 0, 0, 0)");
  check(
    "reduced motion disables decoration while preserving the visible logo and status",
  );
  await evaluate(
    `Services.prefs.clearUserPref('ui.prefersReducedMotion');const h=Zotero.Confucius.hooks.host;const s=h.sessions.get(qa.tasks[12].id);h.emitSessionEvent(s,'loading-fixture','turn_completed',{phase:'done'});s.record.status='completed';return true;`,
  );
  await waitFor(`return !d.querySelector('.tui-waiting');`);

  const errors = await evaluate(`return qa.errors;`);
  assert.deepEqual(errors, []);
  check("no unhandled UI errors across the interaction suite");
  await evaluate(`win.close();return true;`);
  await waitFor(`return !win;`);
  await evaluate(
    `Zotero.getMainWindow().document.getElementById('confucius-toolbar-button').dispatchEvent(new (Zotero.getMainWindow().Event)('command'));return true;`,
  );
  await waitFor(
    `return d?.getElementById('confucius-session-pane')?.dataset.organization==='time';`,
  );
  check("organization preference survives closing and reopening the workspace");
  await writeFile(
    join(output, "zotero-qa.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({ passed: result.checks.length, clicks: result.clicks }),
  );
} catch (error) {
  await screenshot("error").catch(() => {});
  const debug = await evaluate(
    `return {selected:qa?.selected?.(),mode:d?.getElementById('confucius-session-pane')?.dataset.organization,errors:qa?.errors,body:d?.body?.textContent?.slice(-2400),requests:qa?.requests?.slice(-35)};`,
  ).catch((e) => String(e));
  await writeFile(
    join(output, "zotero-error.json"),
    JSON.stringify(
      { ...result, error: String(error), stack: error.stack, debug },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await instance.stop({ graceful: true });
}
