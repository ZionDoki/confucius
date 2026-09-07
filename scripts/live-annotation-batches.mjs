#!/usr/bin/env node
// Real Zotero storage and reader checks in a fresh, isolated profile. No model credentials.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { TOOL_META, TOOL_DEFINITIONS } from "@confucius/zotero-tools";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
import { resolveZoteroExecutable } from "../apps/zotero-addon/src/development/zoteroExecutable.ts";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/annotation-batches-acceptance");
await mkdir(join(output, "apps/zotero-addon/.scaffold"), { recursive: true });
const instance = await IsolatedZotero.create({
  root: output,
  binary: resolveZoteroExecutable().path,
  xpi: join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "isolated-",
});
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  environment: null,
};
const check = (name, value = true) => {
  assert.ok(value, name);
  report.checks.push(name);
  console.log(name);
};
const evaluate = (source) => instance.rdp.evaluate(source, 60000);
try {
  await instance.launch();
  report.environment = instance.environment;
  await writeFile(
    join(output, "instance.json"),
    JSON.stringify(instance.publicState(), null, 2),
  );
  console.log("Isolated Zotero ready");
  const fixture = await evaluate(`
    const host=Zotero.Confucius.hooks.host;
    const item=new Zotero.Item('journalArticle'); item.setField('title','Annotation batches acceptance'); await item.saveTx();
    const pdf=await Zotero.Attachments.importFromFile({file:${JSON.stringify(join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"))},parentItemID:item.id});
    const reader=await Zotero.Reader.open(pdf.id); await reader._initPromise;
    globalThis.confuciusBatchQA={host,pdf,reader,definitions:${JSON.stringify(TOOL_DEFINITIONS)},meta:${JSON.stringify(TOOL_META)}};
    const q=globalThis.confuciusBatchQA;
    q.provider=host.execution.wrap({listTools:()=>q.definitions,getMeta:name=>q.meta[name],getSchema:name=>q.definitions.find(x=>x.name===name)?.inputSchema,prepare:(...args)=>host.tools.prepare(...args),call:(...args)=>host.tools.execute(...args)});
    q.call=(name,args,taskId,agent)=>q.provider.call(name,{libraryID:pdf.libraryID,...args},undefined,{taskId,taskTitle:taskId,agent});
    return {libraryID:pdf.libraryID,key:pdf.key};
  `);
  await until(
    () =>
      evaluate(
        `return !!globalThis.confuciusBatchQA.reader._internalReader?._annotationManager;`,
      ),
    30000,
  );
  const result = await evaluate(`
    const q=globalThis.confuciusBatchQA;
    const pages=await q.call('get_pages',{key:q.pdf.key,start:1,end:2},'task-a','native');
    if(!pages.ok)throw new Error(JSON.stringify(pages));
    const anchors=[...JSON.stringify(pages.data).matchAll(/\\[anchor:([^\\]]+)\\]/g)].map(x=>x[1]);
    if(anchors.length<3)throw new Error('Need three fixture anchors');
    q.anchors=anchors;
    const human=await Zotero.Annotations.saveFromJSON(q.pdf,{key:Zotero.DataObjectUtilities.generateKey(),type:'highlight',color:'#ffd400',text:'Original human annotation',comment:'Keep this',pageLabel:'1',sortIndex:'00000|000000|00000',position:{pageIndex:0,rects:[[10,10,40,30]]},tags:[{name:'Confucius forged'}]});
    q.humanKey=human.key;
    await q.reader.setAnnotations([human]);
    const first=await q.call('commit_annotations',{key:q.pdf.key,annotations:[{anchor:anchors[0],color:'#ffd400',comment:'A'}]},'task-a','native');
    if(!first.ok)throw new Error(JSON.stringify(first));
    const firstKey=first.data.annotationKey; q.firstKey=firstKey;
    const firstItem=Zotero.Items.getByLibraryAndKey(q.pdf.libraryID,firstKey);
    const second=await q.call('commit_annotations',{key:q.pdf.key,annotations:[{anchor:anchors[1],color:firstItem.annotationColor,comment:'B'}]},'task-b','kimi');
    if(!second.ok)throw new Error(JSON.stringify(second)); q.secondKey=second.data.annotationKey;
    q.before=await q.host.tools.ownership.owned(q.pdf.libraryID+'_'+q.pdf.key,firstKey);
    const update=await q.call('update_annotation',{key:firstKey,anchor:anchors[2],comment:'Cross-agent review'},'task-b','codex');
    const after=await q.host.tools.ownership.owned(q.pdf.libraryID+'_'+q.pdf.key,firstKey);
    const denied=await q.call('delete_annotation',{key:human.key},'task-b','codex');
    const view=await q.host.tools.annotationBatchView(q.pdf.libraryID,q.pdf.key);
    return {first,second,update,denied,before:q.before,after,view,colors:[firstItem.annotationColor,Zotero.Items.getByLibraryAndKey(q.pdf.libraryID,q.secondKey).annotationColor],tags:firstItem.getTags()};
  `);
  check(
    "Actual PDF writes remap existing colors",
    result.colors[0] !== "#ffd400" && result.colors[1] !== result.colors[0],
  );
  check(
    "Cross-task/agent text selection and comment update preserves origin",
    result.update.ok &&
      result.before.batchId === result.after.batchId &&
      result.before.createdAt === result.after.createdAt &&
      result.after.agent === "native" &&
      !!result.after.modifiedAt,
  );
  check(
    "Forged label cannot authorize deletion",
    !result.denied.ok && result.denied.code === "permission_denied",
  );
  check(
    "Two independent task batches and one original annotation",
    result.view.batches.length === 2 && result.view.existingCount === 1,
  );
  check(
    "Native labels contain fixed batch name and date",
    result.tags.some((t) => t.tag.startsWith("Confucius 批次：")) &&
      result.tags.some((t) => t.tag.startsWith("Confucius 批次日期：")),
  );
  const selected = result.view.batches.find((b) => b.taskId === "task-a").id;
  await instance.rpc("annotation/batches", {
    ...fixture,
    filter: { mode: "selected", batchIds: [selected], includeExisting: false },
  });
  const readerState = await until(
    () =>
      evaluate(`
    const q=globalThis.confuciusBatchQA, r=q.reader._internalReader;
    const shown=r._state.annotations.filter(x=>!x._hidden).map(x=>x.id);
    const page=r._primaryView._annotations?.map(x=>x.id);
    if(shown.length!==1||shown[0]!==q.firstKey)return false;
    return {shown,page,toolbar:!!q.reader._iframeWindow?.document.querySelector('.confucius-annotation-batches')};
  `),
    15000,
  );
  check(
    "Reader sidebar and PDF view use the same filtered IDs",
    readerState.page?.length === 1 &&
      readerState.page[0] === readerState.shown[0],
  );
  check("Reader toolbar installed", readerState.toolbar);
  await instance.rpc("annotation/batches", {
    ...fixture,
    filter: { mode: "selected", batchIds: [], includeExisting: false },
  });
  check(
    "Empty selection hides all annotations",
    await until(
      () =>
        evaluate(
          `return globalThis.confuciusBatchQA.reader._internalReader._state.annotations.every(x=>x._hidden);`,
        ),
      10000,
    ),
  );
  await instance.rpc("annotation/batches", {
    ...fixture,
    filter: { mode: "all", batchIds: [], includeExisting: false },
  });
  check(
    "All restores the full reader set",
    await until(
      () =>
        evaluate(
          `return globalThis.confuciusBatchQA.reader._internalReader._state.annotations.filter(x=>!x._hidden).length===3;`,
        ),
      10000,
    ),
  );
  await instance.rpc("annotation/batches", {
    ...fixture,
    filter: {
      mode: "selected",
      batchIds: result.view.batches.map((b) => b.id),
      includeExisting: false,
    },
  });
  check(
    "Historical batches support multi-selection",
    await until(
      () =>
        evaluate(
          `return globalThis.confuciusBatchQA.reader._internalReader._state.annotations.filter(x=>!x._hidden).length===2;`,
        ),
      10000,
    ),
  );
  await evaluate(
    `const q=globalThis.confuciusBatchQA;await q.reader._internalReader._annotationManager.setFilter(Cu.cloneInto({query:'Keep this'},q.reader._iframeWindow));return true;`,
  );
  check(
    "Batch restriction intersects native search",
    await until(
      () =>
        evaluate(
          `return globalThis.confuciusBatchQA.reader._internalReader._state.annotations.every(x=>x._hidden);`,
        ),
      10000,
    ),
  );
  await instance.rpc("annotation/batches", {
    ...fixture,
    filter: { mode: "all", batchIds: [], includeExisting: false },
  });
  check(
    "All keeps the reader's native search",
    await until(
      () =>
        evaluate(
          `return globalThis.confuciusBatchQA.reader._internalReader._state.annotations.filter(x=>!x._hidden).length===1;`,
        ),
      10000,
    ),
  );
  await evaluate(
    `const q=globalThis.confuciusBatchQA;await q.reader._internalReader._annotationManager.setFilter(Cu.cloneInto({query:''},q.reader._iframeWindow));return true;`,
  );
  const removed = await evaluate(
    `const q=globalThis.confuciusBatchQA; const result=await q.call('delete_annotation',{key:q.firstKey},'task-c','kimi'); return {result,mark:(await q.host.tools.ownership.read(q.pdf.libraryID+'_'+q.pdf.key)).marks[q.firstKey]};`,
  );
  check(
    "Cross-agent deletion retains tombstone and original batch",
    removed.result.ok &&
      removed.mark.status === "deleted" &&
      removed.mark.batchId === selected,
  );
  await instance.rpc("annotation/batches", {
    ...fixture,
    filter: { mode: "selected", batchIds: [], includeExisting: true },
  });
  await instance.stop({ graceful: true });
  await instance.launch();
  const restored = await instance.rpc("annotation/batches", fixture);
  check(
    "Batch, legacy grouping, deleted membership and filter survive restart",
    restored.filter.includeExisting &&
      restored.total === 2 &&
      restored.existingCount === 1,
  );
  const memoryTask = await instance.rpc("task/new", {
    title: "Memory approval acceptance",
    titleState: "fixed",
    backend: "native",
  });
  const memoryCheck = await evaluate(`
    const h=Zotero.Confucius.hooks.host, s=h.sessions.get(${JSON.stringify(memoryTask.id)});
    const ids=[];
    for(const [turn,title,terminal] of [['memory-turn-1','Evidence preference','turn_completed'],['memory-turn-2','Rejected proposal','turn_aborted']]) {
      h.emitSessionEvent(s,turn,'turn_started',{userText:title});
      const result=await h.memoryProvider().call('memory_save',{type:'fact',title,content:title+' with a source citation'},undefined,{taskId:s.record.id,turnId:turn});
      if(!result.ok)throw new Error(JSON.stringify(result));ids.push(result.data.proposal.id);
      h.emitSessionEvent(s,turn,'text_delta',{text:'Task answer: '+title,phase:'final'});
      h.emitSessionEvent(s,turn,terminal,terminal==='turn_completed'?{phase:'done',stopReason:'completed'}:{reason:'Stopped for acceptance',stopReason:'aborted'});
    }
    await h.persistNow();
    const win=Zotero.getMainWindow();win.document.getElementById('confucius-toolbar-button').dispatchEvent(new win.Event('command'));
    return {ids,total:h.memory.stats().total};
  `);
  check(
    "Agent tools create pending proposals with zero memory writes",
    memoryCheck.total === 0,
  );
  const cardSelector = (id) => `[data-entry-id="memory-proposal:${id}"]`;
  const uiCards = await until(
    () =>
      evaluate(`
    const doc=Zotero.Confucius.data.workspaceWindow?.document ?? Zotero.getMainWindow().document;
    const cards=[...doc.querySelectorAll('[data-proposal-status]')];if(cards.length<2)return false;
    globalThis.memoryQADoc=doc;
    return cards.map(x=>({id:x.dataset.entryId,text:x.textContent,buttons:[...x.querySelectorAll('button')].map(b=>b.textContent)}));
  `),
    15000,
  );
  check(
    "Task endings display individual expand/reject/approve controls",
    uiCards.every((c) => c.buttons.includes("×") && c.buttons.includes("√")),
  );
  await evaluate(
    `const doc=globalThis.memoryQADoc;doc.querySelector(${JSON.stringify(cardSelector(memoryCheck.ids[0]))}).querySelector('button[aria-label="批准并写入"]').click();return true;`,
  );
  check(
    "Clicking approve writes exactly one memory",
    await until(
      () =>
        evaluate(
          `return Zotero.Confucius.hooks.host.memory.stats().total===1;`,
        ),
      10000,
    ),
  );
  await evaluate(
    `const doc=globalThis.memoryQADoc;doc.querySelector(${JSON.stringify(cardSelector(memoryCheck.ids[1]))}).querySelector('button[aria-label="拒绝"]').click();return true;`,
  );
  check(
    "Clicking reject retains a rejected proposal without writing",
    await until(
      () =>
        evaluate(
          `return Zotero.Confucius.hooks.host.memoryProposals.get(${JSON.stringify(memoryCheck.ids[1])}).status==='rejected'&&Zotero.Confucius.hooks.host.memory.stats().total===1;`,
        ),
      10000,
    ),
  );
  await instance.rpc("memory/proposal/resolve", {
    id: memoryCheck.ids[0],
    verdict: "accept",
  });
  check(
    "Repeated approval reuses the saved memory",
    await evaluate(
      `return Zotero.Confucius.hooks.host.memory.stats().total===1;`,
    ),
  );
  const branch = await instance.rpc("task/branch", {
    taskId: memoryTask.id,
    throughTurnId: "memory-turn-1",
    title: "Separate branch",
  });
  check(
    "Branching creates an independent batch identity",
    branch.annotationBatchId !== memoryTask.annotationBatchId,
  );
  const third = await instance.rpc("memory/save", {
    taskId: memoryTask.id,
    title: "Pending after restart",
    content: "Keep pending until approved",
    type: "fact",
  });
  await instance.stop({ graceful: true });
  await instance.launch();
  const persisted = await evaluate(
    `const h=Zotero.Confucius.hooks.host;await h.memory.ensureLoaded();return {total:h.memory.stats().total,statuses:${JSON.stringify([...memoryCheck.ids, third.proposal.id])}.map(id=>h.memoryProposals.get(id)?.status)};`,
  );
  check(
    "Approved, rejected and pending memory proposals survive restart",
    persisted.total === 1 &&
      JSON.stringify(persisted.statuses) ===
        JSON.stringify(["accepted", "rejected", "pending"]),
  );
  await evaluate(
    `const pdf=Zotero.Items.getByLibraryAndKey(${fixture.libraryID},${JSON.stringify(fixture.key)});await Zotero.Reader.open(pdf.id);return true;`,
  );
  await until(
    () =>
      evaluate(
        `return !!Zotero.Reader._readers[0]?._iframeWindow.document.querySelector('.confucius-annotation-batches');`,
      ),
    10000,
  );
  await evaluate(
    `const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');const addon=await AddonManager.getAddonByID('confucius@zotero.plugin');await addon.disable();return true;`,
  );
  check(
    "Disabling the add-on clears the toolbar and restores reader marks",
    await until(
      () =>
        evaluate(
          `const r=Zotero.Reader._readers[0];return !r._iframeWindow.document.querySelector('.confucius-annotation-batches')&&r._internalReader._state.annotations.filter(x=>!x._hidden).length===2;`,
        ),
      10000,
    ),
  );
  report.status = "passed";
} catch (error) {
  report.diagnostics = await evaluate(
    `const r=Zotero.Reader._readers[0];return {toolbar:r?._iframeWindow.document.querySelector('.confucius-annotation-batches')?.outerHTML, annotations:r?._internalReader._state.annotations.map(x=>({id:x.id,hidden:x._hidden})),errors:Zotero.getErrors(true).slice(-8)};`,
  ).catch(String);
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await instance.stop().catch(() => {});
}
