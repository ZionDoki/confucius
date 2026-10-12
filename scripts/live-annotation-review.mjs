import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
import { annotationReviewPanelRegressions } from "./lib/annotation-review-panel.mjs";
import { literatureReviewPanelRegressions } from "./lib/literature-review-panel.mjs";
import { resolveZoteroExecutable } from "../apps/zotero-addon/src/development/zoteroExecutable.ts";
const root = resolve(import.meta.dirname, ".."),
  output = resolve(
    process.env.CONFUCIUS_ANNOTATION_OUTPUT ??
      join(root, "output/annotation-review-minimize-acceptance"),
  );
await mkdir(join(output, "apps/zotero-addon/.scaffold"), { recursive: true });
const instance = await IsolatedZotero.create({
  root: output,
  binary: resolveZoteroExecutable().path,
  xpi: join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "isolated-",
});
const report = { checks: [], environment: null };
const check = (name, value = true) => {
  assert.ok(value, name);
  report.checks.push(name);
  console.log(name);
};
const evaluate = (s) => instance.rdp.evaluate(s, 60000);
try {
  await instance.launch();
  report.environment = instance.environment;
  console.log("Isolated Zotero ready");
  await writeFile(
    join(output, "instance.json"),
    JSON.stringify(instance.publicState(), null, 2),
  );
  const fixture = await evaluate(
    `const host=Zotero.Confucius.hooks.host;const item=new Zotero.Item('journalArticle');item.setField('title','Annotation review integration');await item.saveTx();const pdf=await Zotero.Attachments.importFromFile({file:${JSON.stringify(join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"))},parentItemID:item.id});const reader=await Zotero.Reader.open(pdf.id);await reader._initPromise;const task=host.sessionNew({title:'Annotation review integration'});globalThis.reviewQA={host,pdf,reader,task};return {taskId:task.id,libraryID:pdf.libraryID,key:pdf.key};`,
  );
  await until(
    () =>
      evaluate(
        "return !!globalThis.reviewQA.reader._internalReader?._annotationManager;",
      ),
    30000,
  );
  const staged = await evaluate(
    `const q=globalThis.reviewQA;const context={taskId:q.task.id,taskTitle:q.task.title,agent:'native'};q.provider=q.host.execution.wrap(q.host.reviewTools());q.call=(annotations)=>q.provider.call('commit_annotations',{libraryID:q.pdf.libraryID,key:Zotero.Items.get(q.pdf.parentItemID).key,annotations},undefined,context);const pages=await q.provider.call('get_pages',{libraryID:q.pdf.libraryID,key:q.pdf.key,start:1,end:2},undefined,context);if(!pages.ok)throw new Error(JSON.stringify(pages));q.anchors=[...JSON.stringify(pages.data).matchAll(/\\[anchor:([^\\]]+)\\]/g)].map(x=>x[1]);const first=await q.call([{anchor:q.anchors[0],comment:'Review first'},{anchor:q.anchors[1],comment:'Review second'}]);const next=await q.call([{anchor:q.anchors[2],comment:'Review third'}]);await q.pdf.reload(['childItems'],true);return {first,next,actual:q.pdf.getAnnotations().length,pool:await q.host.reviews().list(q.task.id)};`,
  );
  await writeFile(join(output, "staged.json"), JSON.stringify(staged, null, 2));
  check(
    "Two Agent publications queued without PDF writes",
    staged.first.ok &&
      staged.next.ok &&
      staged.actual === 0 &&
      staged.pool.batches.length === 2,
  );
  check(
    "Parent article requests resolve to the exact PDF in the review card",
    staged.pool.batches.every(
      (batch) =>
        batch.attachmentKey === fixture.key &&
        batch.libraryID === fixture.libraryID,
    ),
  );
  const ui = (code) =>
    evaluate(
      `const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml'),d=win?.document;${code}`,
    );
  await evaluate(
    `Zotero.Prefs.set('extensions.zotero.confucius.workspaceLayout','window',true);const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;`,
  );
  await until(
    () =>
      ui(
        `return !!d?.querySelector('[data-task-id="${fixture.taskId}"] .confucius-task-open');`,
      ),
    30000,
  );
  await ui(
    `d.querySelector('[data-task-id="${fixture.taskId}"] .confucius-task-open').click();return true;`,
  );
  await until(
    () =>
      ui(
        `return !!d?.querySelector('.confucius-annotation-review:not([hidden]) .ar-capsule');`,
      ),
    30000,
  );
  const capture = async (name) => {
    const png = await ui(
      `const c=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=win.innerWidth;c.height=win.innerHeight;c.getContext('2d').drawWindow(win,0,0,c.width,c.height,'white');return c.toDataURL('image/png');`,
    );
    await writeFile(
      join(output, name + ".png"),
      Buffer.from(png.split(",")[1], "base64"),
    );
  };
  check(
    "Review starts minimized with a single capsule",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review');return r.querySelector('.ar-popup').hidden&&r.querySelector('.ar-capsule').getBoundingClientRect().height>=34;`,
    ),
  );
  await capture("zotero-capsule");
  const uiState = await ui(
    `const root=d.querySelector('.confucius-annotation-review'),draft=d.querySelector('#confucius-prompt');draft.value='Continue checking evidence';globalThis.reviewDraftBox=draft.getBoundingClientRect().toJSON();root.querySelector('.ar-capsule').click();return {background:win.getComputedStyle(root.querySelector('.ar-popup')).backgroundColor,blur:win.getComputedStyle(root.querySelector('.ar-popup')).backdropFilter};`,
  );
  await capture("zotero-deck");
  const assertReviewChoiceFocus = async (label) => {
    const samples = await ui(`
      const root=d.querySelector('.confucius-annotation-review'),previous=d.activeElement,inspector=win.InspectorUtils;
      const controls=[...root.querySelectorAll('input[type=range],input[type=checkbox],input[type=radio]')].filter(n=>n.getClientRects().length&&!n.disabled);
      const samples=[];
      for(const control of controls){
        control.focus({preventScroll:true});const focused=!control.matches(':focus'),visible=!control.matches(':focus-visible');
        if(focused)inspector.addPseudoClassLock(control,':focus');if(visible)inspector.addPseudoClassLock(control,':focus-visible');
        const read=()=>{const s=win.getComputedStyle(control);return {outline:s.outlineStyle,width:s.outlineWidth,shadow:s.boxShadow};};
        control.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));const keyboard=read();
        control.dispatchEvent(new win.MouseEvent('pointerdown',{bubbles:true}));const pointer=read();
        samples.push({type:control.type,keyboard,pointer});
        if(visible)inspector.removePseudoClassLock(control,':focus-visible');if(focused)inspector.removePseudoClassLock(control,':focus');
      }
      if(previous?.isConnected)previous.focus({preventScroll:true});return samples;
    `);
    assert(samples.length > 0, label);
    const expected = label.includes("slider")
      ? "range"
      : label.includes("checkboxes")
        ? "checkbox"
        : "radio";
    assert(
      samples.some((sample) => sample.type === expected),
      label,
    );

    for (const sample of samples) {
      assert.equal(sample.keyboard.outline, "solid", JSON.stringify(sample));
      assert.equal(sample.keyboard.width, "2px");
      assert.equal(sample.pointer.outline, "none", JSON.stringify(sample));
      assert.equal(sample.pointer.shadow, "none");
    }
    report.choiceFocus ??= [];
    report.choiceFocus.push({ label, samples });
    check(label);
  };
  await assertReviewChoiceFocus(
    "Review card slider retains keyboard focus without a pointer outline",
  );

  check(
    "Native hover shows gradient arrows and a real edge click turns the card",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review'),range=r.querySelector('.ar-range');range.value='2';range.dispatchEvent(new win.Event('input',{bubbles:true}));const p=r.querySelector('.ar-paper').getBoundingClientRect();win.windowUtils.sendMouseEvent('mousemove',p.x+p.width/2,p.y+16,0,0,0);await new Promise(resolve=>win.setTimeout(resolve,200));const next=r.querySelector('.ar-card-next'),style=win.getComputedStyle(next),box=next.getBoundingClientRect(),visible=style.opacity==='1'&&style.backgroundImage.startsWith('linear-gradient');win.windowUtils.sendMouseEvent('mousedown',box.x+box.width/2,box.y+box.height/2,0,1,0);win.windowUtils.sendMouseEvent('mouseup',box.x+box.width/2,box.y+box.height/2,0,1,0);const moved=range.value==='3';range.value='2';range.dispatchEvent(new win.Event('input',{bubbles:true}));return visible&&moved;`,
    ),
  );
  await capture("zotero-deck-hover");
  await ui(
    `const range=d.querySelector('.ar-range');range.value='1';range.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  check(
    "The active card or list view has a visible selected state",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review');return win.getComputedStyle(r.querySelector('.ar-view-switch [aria-pressed=true]')).backgroundColor!==win.getComputedStyle(r.querySelector('.ar-view-switch [aria-pressed=false]')).backgroundColor;`,
    ),
  );
  check(
    "Card wheel navigation and position slider work inside the floating view",
    await ui(
      `const root=d.querySelector('.confucius-annotation-review'),range=root.querySelector('.ar-range');root.querySelector('.ar-paper').dispatchEvent(new win.WheelEvent('wheel',{deltaY:80,bubbles:true,cancelable:true}));const moved=range.value==='2';range.value='1';range.dispatchEvent(new win.Event('input',{bubbles:true}));return moved&&root.querySelector('.ar-position').textContent.startsWith('01');`,
    ),
  );
  check(
    "Card review opens without moving the composer",
    await ui(
      `const root=d.querySelector('.confucius-annotation-review'),draft=d.querySelector('#confucius-prompt');return !root.querySelector('.ar-card-area').hidden&&Math.abs(draft.getBoundingClientRect().y-globalThis.reviewDraftBox.y)<1;`,
    ),
  );
  await ui(
    `d.querySelector('.ar-view-switch button:last-child').click();return true;`,
  );
  check(
    "Real workspace uses an opaque popup without glass blur",
    !["transparent", "rgba(0, 0, 0, 0)"].includes(uiState.background) &&
      (!uiState.blur || uiState.blur === "none"),
  );
  await capture("zotero-list-before-selection");
  await assertReviewChoiceFocus(
    "Review selection checkboxes retain keyboard focus without pointer outlines",
  );
  await ui(
    `d.querySelector('.confucius-annotation-review .ar-search-row > button').click();return true;`,
  );
  await assertReviewChoiceFocus(
    "Review filter radio buttons retain keyboard focus without pointer outlines",
  );
  await ui(
    `d.querySelector('.confucius-annotation-review .ar-search-row > button').click();return true;`,
  );

  check(
    "Popup collapse control is aligned with the right content edge",
    await ui(
      `const h=d.querySelector('.ar-popup-header'),b=h.querySelector('.ar-header > button');return Math.abs(h.getBoundingClientRect().right-20-b.getBoundingClientRect().right)<1;`,
    ),
  );
  const visible = await ui(
    `const root=d.querySelector('.confucius-annotation-review');return [...root.querySelectorAll('button')].filter(b=>b.getClientRects().length&&win.getComputedStyle(b).visibility!=='hidden'&&(!b.closest('.ar-list')||(()=>{const r=b.getBoundingClientRect(),v=b.closest('.ar-list').getBoundingClientRect();return r.y+r.height/2>=v.y&&r.y+r.height/2<v.bottom;})())).map(b=>{const r=b.getBoundingClientRect();return {label:b.textContent,height:r.height,hit:b.contains(d.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});`,
  );
  await writeFile(
    join(output, "buttons.json"),
    JSON.stringify(visible, null, 2),
  );
  check(
    "Visible review buttons align and receive pointer hits",
    visible.every((b) => b.height >= 34 && b.hit),
  );
  await ui(
    `const box=d.querySelector('.ar-list-row input');box.checked=true;box.dispatchEvent(new win.Event('change',{bubbles:true}));return true;`,
  );
  check(
    "Minimize and reopen retain the selected entry and list view",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review');r.querySelector('.ar-header > button').click();const minimized=r.querySelector('.ar-popup').hidden;r.querySelector('.ar-capsule').click();return minimized&&r.dataset.view==='list'&&r.querySelector('.ar-list-row input').checked;`,
    ),
  );
  const third = await evaluate(
    `const q=globalThis.reviewQA;await q.call([{anchor:q.anchors[0],comment:'Later batch, keep selection'}]);return (await q.host.reviews().list(q.task.id)).batches.at(-1);`,
  );
  await until(
    () => ui(`return d.querySelector('.ar-capsule-new').textContent==='+1';`),
    30000,
  );
  check(
    "New publication does not join the current selected snapshot",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review');return [...r.querySelectorAll('.ar-list-row input')].filter(i=>i.checked).length===1&&!r.querySelector('.ar-popup').hidden;`,
    ),
  );
  await capture("zotero-list");
  await evaluate(
    `const q=globalThis.reviewQA,reviews=q.host.reviews();q.originalDecide=reviews.decide;reviews.decide=async input=>{await new Promise(resolve=>Zotero.getMainWindow().setTimeout(resolve,800));return q.originalDecide.call(reviews,input);};return true;`,
  );
  await ui(
    `const r=d.querySelector('.confucius-annotation-review');r.querySelector('.ar-popup-footer .ar-actions button[data-variant="primary"]').click();r.querySelector('.ar-header > button').click();return true;`,
  );
  await until(async () => {
    const p = await instance.rpc("annotation/review/list", {
      taskId: fixture.taskId,
    });
    return p.batches[0].entries[0].status === "accepted";
  }, 30000);
  await evaluate(
    `const q=globalThis.reviewQA;q.host.reviews().decide=q.originalDecide;return true;`,
  );
  check(
    "A write receipt never reopens a minimized review",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review');return r.querySelector('.ar-popup').hidden&&r.querySelector('.ar-capsule').getAttribute('aria-expanded')==='false';`,
    ),
  );
  const draft = await ui(
    `const draft=d.querySelector('#confucius-prompt'),r=draft.getBoundingClientRect();return {text:draft.value,samePosition:Math.abs(r.y-globalThis.reviewDraftBox.y)<1};`,
  );
  check(
    "List acceptance leaves the real conversation composer and draft intact",
    draft.text === "Continue checking evidence" && draft.samePosition,
  );
  const batch = staged.pool.batches[0],
    second = staged.pool.batches[1];
  const entry = (b, i = 0) => ({ batchId: b.id, entryId: b.entries[i].id });
  await instance.rpc("annotation/review/decide", {
    taskId: fixture.taskId,
    action: "reject",
    entries: [entry(third)],
  });
  let pool = await instance.rpc("annotation/review/decide", {
    taskId: fixture.taskId,
    action: "accept",
    entries: [entry(batch)],
  });
  check(
    "Accept one writes exactly its native annotation and returns a real key",
    pool.batches[0].entries[0].status === "accepted" &&
      !!pool.batches[0].entries[0].annotationKey,
  );
  check(
    "Other publications remain pending",
    pool.batches[0].entries[1].status === "pending" &&
      pool.batches[1].entries[0].status === "pending",
  );
  let native = await evaluate(
    `const q=globalThis.reviewQA;await q.pdf.reload(['childItems'],true);return q.pdf.getAnnotations().map(a=>({key:a.key,comment:a.annotationComment,text:a.annotationText}));`,
  );
  check(
    "Only the selected comment exists in Zotero",
    native.length === 1 && native[0].comment === "Review first",
  );
  await instance.rpc("annotation/review/decide", {
    taskId: fixture.taskId,
    action: "accept",
    entries: [entry(batch)],
  });
  await instance.rpc("annotation/review/decide", {
    taskId: fixture.taskId,
    action: "reject",
    entries: [entry(batch, 1)],
  });
  pool = await instance.rpc("annotation/review/decide", {
    taskId: fixture.taskId,
    action: "restore",
    entries: [entry(batch, 1)],
  });
  check(
    "Reject and restore preserve pending candidate",
    pool.batches[0].entries[1].status === "pending",
  );
  pool = await instance.rpc("annotation/review/decide", {
    taskId: fixture.taskId,
    action: "accept",
    entries: [entry(batch, 1), entry(second)],
  });
  native = await evaluate(
    `const q=globalThis.reviewQA;await q.pdf.reload(['childItems'],true);return q.pdf.getAnnotations().map(a=>({key:a.key,comment:a.annotationComment}));`,
  );
  check(
    "Cross-publication acceptance writes each remaining annotation once",
    native.length === 3 &&
      pool.batches.every((b) =>
        b.entries.every((e) => ["accepted", "rejected"].includes(e.status)),
      ),
  );
  await until(
    () =>
      ui(
        `return d.querySelector('.ar-capsule-count').textContent.includes('4');`,
      ),
    30000,
  );
  check(
    "Completed review minimizes and reopens its saved history",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review');r.querySelector('.ar-capsule').click();const history=r.dataset.view==='list'&&[...r.querySelectorAll('.ar-list-row')].filter(e=>!e.hidden).length===4;r.querySelector('.ar-view-switch button:first-child').click();const receipt=!r.querySelector('.ar-completion').hidden&&!r.querySelector('.ar-finish').hidden;r.querySelector('.ar-finish').click();return history&&receipt&&r.querySelector('.ar-popup').hidden;`,
    ),
  );
  await capture("zotero-completed-capsule");
  await ui(
    `d.querySelector('.ar-capsule').click();d.querySelector('.ar-view-switch button:first-child').click();return true;`,
  );
  await capture("zotero-completion");
  check(
    "Escape returns focus to the capsule",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review');r.querySelector('.ar-header > button').dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return r.querySelector('.ar-popup').hidden&&d.activeElement===r.querySelector('.ar-capsule');`,
    ),
  );
  const later = await evaluate(
    `const q=globalThis.reviewQA;const result=await q.call([{anchor:q.anchors[3],comment:'Arrived after minimizing the completed review'}]);const pool=await q.host.reviews().list(q.task.id);if(pool.batches.length!==4)throw new Error('New publication missing: '+JSON.stringify({result,anchorCount:q.anchors.length,pool}));return pool.batches.at(-1);`,
  );
  await until(
    () =>
      ui(
        `return d.querySelector('.ar-summary-row').textContent.includes('Pending')||d.querySelector('.ar-summary-row').textContent.includes('待审阅');`,
      ),
    30000,
  );
  await until(
    () =>
      ui(
        `return !d.querySelector('.ar-finish').hidden ? false : d.querySelector('.ar-capsule').textContent.includes('+1');`,
      ),
    30000,
  );
  check(
    "A batch arriving after completion updates the minimized capsule only",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review');return r.querySelector('.ar-popup').hidden&&r.querySelector('.ar-capsule').getAttribute('aria-expanded')==='false'&&r.querySelector('.ar-finish').hidden;`,
    ),
  );
  await capture("zotero-new-batch-minimized");
  check(
    "Search and selection survive minimizing the floating list",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review');r.querySelector('.ar-capsule').click();r.querySelector('.ar-view-switch button:last-child').click();const search=r.querySelector('.ar-search');search.value='after minimizing';search.dispatchEvent(new win.Event('input',{bubbles:true}));const checkbox=[...r.querySelectorAll('.ar-list-row')].find(e=>!e.hidden).querySelector('input');checkbox.checked=true;checkbox.dispatchEvent(new win.Event('change',{bubbles:true}));r.querySelector('.ar-header > button').click();r.querySelector('.ar-capsule').click();return search.value==='after minimizing'&&checkbox.checked&&r.dataset.view==='list';`,
    ),
  );
  await ui(
    `win.resizeTo(560,700);d.documentElement.setAttribute('data-confucius-theme','dark');await new Promise(resolve=>win.setTimeout(resolve,200));return true;`,
  );
  const compact = await ui(
    `const r=d.querySelector('.confucius-annotation-review'),p=r.querySelector('.ar-popup'),box=p.getBoundingClientRect(),draft=d.querySelector('#confucius-prompt').getBoundingClientRect();return {width:box.width,inside:box.top>=0&&box.left>=0&&box.right<=win.innerWidth&&box.bottom<=draft.top,overflow:p.scrollWidth>p.clientWidth,background:win.getComputedStyle(p).backgroundColor};`,
  );
  await writeFile(
    join(output, "compact.json"),
    JSON.stringify(compact, null, 2),
  );
  await capture("zotero-dark-compact");
  check(
    "Compact dark review stays within the workspace above the composer",
    compact.width < 620 &&
      compact.inside &&
      !compact.overflow &&
      compact.background === "rgb(41, 39, 34)",
  );
  check(
    "Outside click minimizes without clearing the draft",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review'),draft=d.querySelector('#confucius-prompt');draft.dispatchEvent(new win.PointerEvent('pointerdown',{bubbles:true}));draft.focus();return r.querySelector('.ar-popup').hidden&&d.activeElement===draft&&draft.value==='Continue checking evidence';`,
    ),
  );
  await instance.rpc("annotation/review/decide", {
    taskId: fixture.taskId,
    action: "reject",
    entries: [entry(later)],
  });
  const retry = await evaluate(
    `const q=globalThis.reviewQA;const r=await q.call([{anchor:q.anchors[0],comment:'Review first'},{anchor:q.anchors[1],comment:'Review second'}]);return {r,pool:await q.host.reviews().list(q.task.id)};`,
  );
  check(
    "Repeated Agent suggestions do not create new review cards",
    retry.r.ok && retry.pool.batches.length === 4,
  );
  for (const name of await annotationReviewPanelRegressions(root, ui))
    check(name);
  for (const name of (await literatureReviewPanelRegressions(root, ui)).checks)
    check(name);
  const liveTask = await evaluate(
    `const q=globalThis.reviewQA;q.livePDF=await Zotero.Attachments.importFromFile({file:${JSON.stringify(join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"))},parentItemID:q.pdf.parentItemID});const reader=await Zotero.Reader.open(q.livePDF.id);await reader._initPromise;q.liveTask=q.host.sessionNew({title:'First live annotation arrival'});const context={taskId:q.liveTask.id,taskTitle:q.liveTask.title,agent:'native'};const pages=await q.provider.call('get_pages',{libraryID:q.livePDF.libraryID,key:q.livePDF.key,start:1,end:2},undefined,context);if(!pages.ok)throw new Error(JSON.stringify(pages));q.liveAnchors=[...JSON.stringify(pages.data).matchAll(/\\[anchor:([^\\]]+)\\]/g)].map(x=>x[1]);q.liveCall=annotations=>q.provider.call('commit_annotations',{libraryID:q.livePDF.libraryID,key:q.livePDF.key,annotations},undefined,context);return {id:q.liveTask.id};`,
  );
  await until(
    () =>
      ui(
        `return !!d.querySelector('[data-task-id="${liveTask.id}"] .confucius-task-open');`,
      ),
    30000,
  );
  await ui(
    `d.querySelector('[data-task-id="${liveTask.id}"] .confucius-task-open').click();return true;`,
  );
  await until(
    () => ui(`return d.querySelector('.confucius-annotation-review').hidden;`),
    30000,
  );
  await ui(
    `const r=d.querySelector('.confucius-annotation-review'),capsule=r.querySelector('.ar-capsule'),draft=d.querySelector('#confucius-prompt');draft.value='Keep this draft while the Agent works';draft.focus();globalThis.arrivalMonitor={reminders:0};globalThis.arrivalObserver=new win.MutationObserver(records=>{if(records.some(record=>record.attributeName==='data-reminder')&&capsule.dataset.reminder==='true')globalThis.arrivalMonitor.reminders++;});globalThis.arrivalObserver.observe(capsule,{attributes:true,attributeFilter:['data-reminder']});return true;`,
  );
  const firstLive = await evaluate(
    `const q=globalThis.reviewQA;const result=await q.liveCall([{anchor:q.liveAnchors[0],comment:'Live arrival one'}]);return {result,pool:await q.host.reviews().list(q.liveTask.id)};`,
  );
  check(
    "A fresh live Agent submission creates the first review batch",
    firstLive.result.ok &&
      firstLive.pool.batches.length === 1 &&
      firstLive.pool.batches[0].entries[0].status === "pending",
  );
  await until(
    () =>
      ui(
        `const r=d.querySelector('.confucius-annotation-review');return !r.hidden&&!r.querySelector('.ar-popup').hidden;`,
      ),
    30000,
  );
  check(
    "The real workspace automatically opens the first live batch while preserving composer focus and draft",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review'),draft=d.querySelector('#confucius-prompt');return r.dataset.view==='card'&&d.activeElement===draft&&draft.value==='Keep this draft while the Agent works'&&globalThis.arrivalMonitor.reminders===0;`,
    ),
  );
  await capture("zotero-first-live-batch");
  check(
    "Auto-opening uses the same overlay height without moving the composer on minimize",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review'),draft=d.querySelector('#confucius-prompt'),y=draft.getBoundingClientRect().y;r.querySelector('.ar-header > button').click();draft.focus();return Math.abs(y-draft.getBoundingClientRect().y)<1;`,
    ),
  );
  const secondLive = await evaluate(
    `const q=globalThis.reviewQA;const result=await q.liveCall([{anchor:q.liveAnchors[1],comment:'Live arrival two'}]);return {result,pool:await q.host.reviews().list(q.liveTask.id)};`,
  );
  await until(() => ui(`return globalThis.arrivalMonitor.reminders>0;`), 30000);
  check(
    "A later real Agent submission animates the capsule while retaining minimized state and focus",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review'),draft=d.querySelector('#confucius-prompt');return r.querySelector('.ar-popup').hidden&&r.querySelector('.ar-capsule-new').textContent==='+1'&&d.activeElement===draft&&draft.value==='Keep this draft while the Agent works';`,
    ),
  );
  check(
    "The real reminder floats the whole capsule up 6px at exactly 1.12 scale without moving the composer",
    await ui(
      `const c=d.querySelector('.ar-capsule'),draft=d.querySelector('#confucius-prompt'),y=draft.getBoundingClientRect().y,a=c.getAnimations().find(a=>a.animationName==='confucius-ar-reminder');if(!a)throw new Error('Reminder animation missing');a.pause();a.currentTime=Number(a.effect.getTiming().duration)*.4;const m=new win.DOMMatrix(win.getComputedStyle(c).transform),box=c.getBoundingClientRect();return Math.abs(m.a-1.12)<.001&&Math.abs(m.d-1.12)<.001&&Math.abs(m.m42+6)<.01&&Math.abs(draft.getBoundingClientRect().y-y)<1&&c.contains(d.elementFromPoint(box.x+box.width/2,box.y+box.height/2));`,
    ),
  );
  await capture("zotero-arrival-reminder");
  await ui(
    `d.querySelector('.ar-capsule').getAnimations().find(a=>a.animationName==='confucius-ar-reminder').play();return true;`,
  );
  await until(
    () => ui(`return !d.querySelector('.ar-capsule').dataset.reminder;`),
    30000,
  );
  check(
    "The real capsule reminder finishes and returns to its resting size and elevation",
    await ui(
      `const c=d.querySelector('.ar-capsule');return c.getAnimations({subtree:true}).every(a=>!a.animationName?.startsWith('confucius-ar-reminder'))&&win.getComputedStyle(c).transform==='none';`,
    ),
  );
  const reminderCount = await ui(`return globalThis.arrivalMonitor.reminders;`);
  await evaluate(
    `const q=globalThis.reviewQA;await q.liveCall([{anchor:q.liveAnchors[1],comment:'Live arrival two'}]);return true;`,
  );
  await ui(
    `await new Promise(resolve=>win.setTimeout(resolve,1200));return true;`,
  );
  const repeatedArrival = await ui(
    `const r=d.querySelector('.confucius-annotation-review');return {reminders:globalThis.arrivalMonitor.reminders,hidden:r.querySelector('.ar-popup').hidden,copy:r.querySelector('.ar-capsule').textContent};`,
  );
  report.repeatedArrival = {
    expectedReminders: reminderCount,
    ...repeatedArrival,
  };
  check(
    "Repeated real Agent suggestions do not replay the reminder",
    repeatedArrival.reminders === reminderCount && repeatedArrival.hidden,
  );
  await instance.rpc("annotation/review/decide", {
    taskId: liveTask.id,
    action: "reject",
    entries: [entry(secondLive.pool.batches[1])],
  });
  await until(
    () => ui(`return d.querySelector('.ar-capsule-new').hidden;`),
    30000,
  );
  check(
    "Real review decisions update results without reopening or animating the capsule",
    await ui(
      `return globalThis.arrivalMonitor.reminders===${reminderCount}&&d.querySelector('.ar-popup').hidden;`,
    ),
  );
  await ui(`globalThis.arrivalObserver.disconnect();return true;`);
  await evaluate("await globalThis.reviewQA.host.persistNow();return true;");
  await instance.stop({ graceful: true });
  await instance.launch();
  pool = await instance.rpc("annotation/review/list", {
    taskId: fixture.taskId,
  });
  check(
    "Full Zotero restart retains all publication batches and outcomes",
    pool.batches.length === 4 &&
      pool.batches.every((b) =>
        b.entries.every((e) => ["accepted", "rejected"].includes(e.status)),
      ),
  );
  const count = await evaluate(
    `const pdf=Zotero.Items.getByLibraryAndKey(${fixture.libraryID},${JSON.stringify(fixture.key)});await pdf.reload(['childItems'],true);return pdf.getAnnotations().length;`,
  );
  check("Restart never replays native writes", count === 3);
  await evaluate(
    `const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;`,
  );
  await until(
    () =>
      ui(
        `return !!d?.querySelector('[data-task-id="${liveTask.id}"] .confucius-task-open');`,
      ),
    30000,
  );
  await ui(
    `d.querySelector('[data-task-id="${liveTask.id}"] .confucius-task-open').click();return true;`,
  );
  await until(
    () =>
      ui(
        `return !!d.querySelector('.confucius-annotation-review:not([hidden])');`,
      ),
    30000,
  );
  await ui(
    `await new Promise(resolve=>win.setTimeout(resolve,1200));return true;`,
  );
  check(
    "Restarting and loading historical submission events neither opens review nor replays the reminder",
    await ui(
      `const r=d.querySelector('.confucius-annotation-review'),c=r.querySelector('.ar-capsule');return r.querySelector('.ar-popup').hidden&&!c.dataset.reminder&&c.getAnimations({subtree:true}).every(a=>!a.animationName?.startsWith('confucius-ar-reminder'));`,
    ),
  );
} catch (e) {
  report.error = String(e);
  throw e;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await instance.stop().catch(() => {});
}
