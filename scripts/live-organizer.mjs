import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
import { resolveZoteroExecutable } from "../apps/zotero-addon/src/development/zoteroExecutable.ts";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_ORGANIZER_OUTPUT ??
    join(root, "output/pr12-validation/live"),
);
await mkdir(join(output, "apps/zotero-addon/.scaffold"), { recursive: true });
const instance = await IsolatedZotero.create({
  root: output,
  binary: resolveZoteroExecutable().path,
  xpi: join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "isolated-",
});
if (process.env.CONFUCIUS_FLEX_XPI) {
  await copyFile(
    resolve(process.env.CONFUCIUS_FLEX_XPI),
    join(
      instance.profile,
      "extensions/flexannotate@justanotherjurastudent.github.io.xpi",
    ),
  );
}
const report = { checks: [], environment: null };
const check = (name, value = true) => {
  assert.ok(value, name);
  report.checks.push(name);
  console.log(name);
};
const evaluate = (source) => instance.rdp.evaluate(source, 60000);
const ui = (source) =>
  evaluate(
    `const shell=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml');const win=shell?.document.getElementById('confucius-window-frame')?.contentWindow??shell,d=win?.document;${source}`,
  );
const capture = async (name) => {
  const png = await ui(
    `const c=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=win.innerWidth;c.height=win.innerHeight;c.getContext('2d').drawWindow(win,0,0,c.width,c.height,'white');return c.toDataURL('image/png');`,
  );
  await writeFile(
    join(output, `${name}.png`),
    Buffer.from(png.split(",")[1], "base64"),
  );
};
try {
  await instance.launch();
  await instance.rpc("config/set", {
    uiLanguage: "zh-CN",
    uiTheme: "light",
    uiFontSize: 16,
  });
  report.environment = instance.environment;
  await writeFile(
    join(output, "instance.json"),
    JSON.stringify(instance.publicState(), null, 2),
  );
  const fixture = await evaluate(`
    const host=Zotero.Confucius.hooks.host, libraryID=Zotero.Libraries.userLibraryID;
    const collection=new Zotero.Collection(); collection.name='Organizer verification'; await collection.saveTx();
    const other=new Zotero.Collection(); other.name='Unrelated collection'; await other.saveTx();
    const work=new Zotero.Item('journalArticle'); work.setField('title','Flex review integration'); work.setCollections([collection.id]); await work.saveTx();
    const pdf=await Zotero.Attachments.importFromFile({file:${JSON.stringify(join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"))},parentItemID:work.id});
    const annotations=[];
    for(let i=0;i<2;i++){const a=new Zotero.Item('annotation');a.libraryID=libraryID;a.parentID=pdf.id;a.annotationType='highlight';a.annotationText='Review quote '+(i+1);a.annotationColor='#ffd400';a.annotationPageLabel='1';a.annotationSortIndex='00000|000000|0000'+i;a.annotationPosition=JSON.stringify({pageIndex:0,rects:[[50,50+i*20,160,65+i*20]]});await a.saveTx();annotations.push(a);}
    const note=new Zotero.Item('note');note.addTag('★outline');note.addTag('#flexannotate-outline-'+collection.key);note.setNote('<pre>LATTICE-OUTLINE-V1\\n'+JSON.stringify({v:1,roots:[{id:'intro',title:'Introduction',children:[{id:'background',title:'Background',children:[]}]},{id:'methods',title:'Methods',children:[]}]})+'</pre>');await note.saveTx();
    const libraryNote=new Zotero.Item('note');libraryNote.addTag('★outline');libraryNote.setNote('<pre>LATTICE-OUTLINE-V1\\n'+JSON.stringify({v:1,roots:[{id:'general',title:'General',children:[]}]})+'</pre>');await libraryNote.saveTx();
    const task=host.sessionNew({title:'Flex Annotations verification'}),state=host.requireSession(task.id);state.record.permissionMode='ask';
    const q=globalThis.organizerQA={host,libraryID,collection,other,work,pdf,annotations,note,task,state};q.provider=host.execution.wrap(host.reviewTools());
    q.stage=(name,args)=>{q.done=null;q.pending=(async()=>{const context={taskId:task.id,operationId:'organizer-'+Date.now()};const invalid=await q.provider.prepare(name,args,context);if(invalid)return invalid;const decision=await host.requestToolApproval(state,'review-turn','review-call',name,args);if(decision.verdict!=='allow')return {denied:true};return q.provider.call(name,decision.editedArgs??args,undefined,context);})().then(result=>{q.done=result;state.record.status='ready';return result;}).catch(error=>{q.done={error:String(error)};});};
    return {taskId:task.id,keys:annotations.map(a=>a.key),flexAPI:!!Zotero.FlexAnnotate?.api};
  `);
  if (process.env.CONFUCIUS_FLEX_XPI)
    check("Real Flex Annotations plugin API loaded", fixture.flexAPI);
  const outlines = await evaluate(
    `const q=globalThis.organizerQA;const api=await q.host.tools.execute('organizer_get_outline',{collection:q.collection.key});const installed=Zotero.FlexAnnotate;delete Zotero.FlexAnnotate;q.host.tools.organizer.outlineCache.clear();const fallback=await q.host.tools.execute('organizer_get_outline',{collection:q.collection.key});const missing=await q.host.tools.execute('organizer_get_outline',{collection:q.other.key});Zotero.FlexAnnotate=installed;q.host.tools.organizer.outlineCache.clear();return {api,fallback,missing};`,
  );
  check(
    "Plugin API and stored-note fallback return the same numbered outline",
    outlines.api.ok &&
      outlines.fallback.ok &&
      outlines.api.data.headings.length === 3 &&
      JSON.stringify(
        outlines.api.data.headings.map((h) => [h.title, h.num, h.tag]),
      ) ===
        JSON.stringify(
          outlines.fallback.data.headings.map((h) => [h.title, h.num, h.tag]),
        ),
  );
  check(
    "Missing collection outline never falls back to the library tree",
    !outlines.missing.ok,
  );
  const listing = await evaluate(
    `const q=globalThis.organizerQA;return q.host.tools.execute('organizer_list_annotations',{collection:q.collection.key});`,
  );
  check(
    "Real collection annotations are listed as unassigned",
    listing.ok && listing.data.annotations.length === 2,
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
  await evaluate(
    `const q=globalThis.organizerQA;q.stage('organizer_assign_annotations',{collection:q.collection.key,assignments:q.annotations.map(a=>({key:a.key,headings:['Background']}))});return true;`,
  );
  await until(
    () => ui("return !!d?.querySelector('.confucius-organizer-review-card');"),
    30000,
  );
  check(
    "Approval blocks tag writes",
    await evaluate(
      `return globalThis.organizerQA.annotations.every(a=>a.getTags().length===0);`,
    ),
  );
  await ui(
    `shell.resizeTo(1100,900);const card=d.querySelector('.confucius-organizer-review-card');card.scrollIntoView();const row=card.querySelector('[data-key="${fixture.keys[0]}"]');[...row.querySelectorAll('button')].find(b=>b.textContent==='✗ 拒绝').click();globalThis.organizerCardQA=card;return true;`,
  );
  // Polling, unrelated activity and layout changes must not recreate decisions.
  await evaluate(
    `const q=globalThis.organizerQA;q.host.emitSessionEvent(q.state,'review-turn','tool_progress',{callId:'unrelated',toolName:'search_items',message:'Refresh review'});return true;`,
  );
  await until(() =>
    ui(
      `return d.querySelector('.confucius-organizer-review-card')?.querySelector('[data-key="${fixture.keys[0]}"]')?.dataset.status==='rejected';`,
    ),
  );
  check(
    "Timeline refresh preserves the exact review card and rejected choice",
    await ui(
      `return d.querySelector('.confucius-organizer-review-card')===globalThis.organizerCardQA;`,
    ),
  );
  await ui(
    `const c=d.querySelector('.confucius-organizer-review-card');c.querySelector('[data-variant="link"]').click();return true;`,
  );
  await until(
    () =>
      evaluate(
        "return Zotero.Reader._readers.some(reader=>reader.itemID===globalThis.organizerQA.pdf.id);",
      ),
    15000,
  );
  check(
    "Source link opens the annotation's real PDF without an explicit library argument",
  );
  await ui("win.focus();return true;");
  await capture("review-light");
  const measures = [];
  report.layout = measures;
  for (const [width, theme, font] of [
    [1100, "dark", 16],
    [420, "light", 20],
    [300, "dark", 24],
  ]) {
    await instance.rpc("config/set", { uiTheme: theme, uiFontSize: font });
    await ui(`shell.resizeTo(${width},900);return true;`);
    const value = await until(() =>
      ui(
        `const c=d.querySelector('.confucius-organizer-review-card');if(!c||win.innerWidth!==${width}||d.documentElement.getAttribute('data-confucius-theme')!==${JSON.stringify(theme)})return false;const buttons=[...c.querySelectorAll('button')].filter(b=>b.getClientRects().length);return {width:win.innerWidth,theme:d.documentElement.getAttribute('data-confucius-theme'),overflow:Math.max(c.scrollWidth-c.clientWidth,...[...c.querySelectorAll('[data-heading-scroll]')].map(n=>n.scrollWidth-n.clientWidth)),short:buttons.filter(b=>b.getBoundingClientRect().height<33).map(b=>b.textContent)};`,
      ),
    );
    measures.push(value);
    console.log(JSON.stringify(value));
    await capture(`review-${width}-${theme}`);
    check(
      `Review fits ${width}px ${theme} with shared 34px controls`,
      value.overflow <= 2 && value.short.length === 0,
    );
  }
  await instance.rpc("config/set", { uiFontSize: 16 });
  await ui(
    "shell.resizeTo(1100,900);Services.prefs.setIntPref('ui.useAccessibilityTheme',1);return true;",
  );
  await until(() =>
    ui("return win.matchMedia('(prefers-contrast: more)').matches;"),
  );
  report.contrast = await ui(
    `const c=d.querySelector('.confucius-organizer-review-card'),b=c.querySelector('[data-variant="primary"]');b.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));b.focus();win.InspectorUtils.addPseudoClassLock(b,':focus-visible');const s=win.getComputedStyle(b);const result={systemPrimary:win.getComputedStyle(c).getPropertyValue('--confucius-primary').trim(),background:s.backgroundColor,color:s.color,outline:s.outlineStyle,width:s.outlineWidth};win.InspectorUtils.removePseudoClassLock(b,':focus-visible');return result;`,
  );
  check(
    "System contrast and keyboard focus keep the approval action readable",
    report.contrast.systemPrimary === "Highlight" &&
      report.contrast.background !== report.contrast.color &&
      report.contrast.outline === "solid" &&
      report.contrast.width === "2px",
  );
  await capture("review-high-contrast");
  await ui(
    "Services.prefs.setIntPref('ui.useAccessibilityTheme',0);return true;",
  );
  await ui(
    `shell.resizeTo(1100,900);const c=d.querySelector('.confucius-organizer-review-card');[...c.querySelectorAll('button')].find(b=>b.textContent.includes('应用')).click();return true;`,
  );
  const applied = await until(() =>
    evaluate("return globalThis.organizerQA.done;"),
  );
  report.applied = applied;
  check(
    "Accepted subset is saved by the real write provider",
    applied.ok &&
      applied.data.assigned.length === 1 &&
      applied.data.assigned[0].key === fixture.keys[1],
  );
  check(
    "Rejected annotation stays unchanged",
    await evaluate(
      `const q=globalThis.organizerQA;return !q.annotations[0].getTags().length&&q.annotations[1].getTags().some(t=>t.tag==='§Background');`,
    ),
  );
  const remaining = await evaluate(
    `const q=globalThis.organizerQA;return q.host.tools.execute('organizer_list_annotations',{collection:q.collection.key});`,
  );
  check(
    "Assigned annotation leaves the unassigned query",
    remaining.ok && remaining.data.annotations.length === 1,
  );
  await until(() =>
    ui("return !d.querySelector('.confucius-organizer-review-card');"),
  );
  await evaluate(
    `const q=globalThis.organizerQA;q.stage('organizer_assign_annotations',{collection:q.collection.key,dryRun:true,assignments:[{key:q.annotations[0].key,headings:['Methods']}]});return true;`,
  );
  await until(() =>
    ui("return !!d.querySelector('.confucius-organizer-review-card');"),
  );
  await ui(
    `const c=d.querySelector('.confucius-organizer-review-card');[...c.querySelectorAll('button')].find(b=>b.textContent.includes('应用')).click();return true;`,
  );
  const preview = await until(() =>
    evaluate("return globalThis.organizerQA.done;"),
  );
  check(
    "Approving an explicit preview performs no tag writes",
    preview.ok &&
      (await evaluate(
        "return !globalThis.organizerQA.annotations[0].getTags().length;",
      )),
  );
  await until(() =>
    ui("return !d.querySelector('.confucius-organizer-review-card');"),
  );
  await evaluate(
    `const q=globalThis.organizerQA;q.stage('organizer_unassign_annotations',{collection:q.collection.key,assignments:[{key:q.annotations[1].key,headings:['Background']}]});return true;`,
  );
  await until(() =>
    ui("return !!d.querySelector('.confucius-organizer-review-card');"),
  );
  check(
    "Unassign review names the removal action",
    await ui(
      "return d.querySelector('.confucius-organizer-review-card').textContent.includes('取消归类');",
    ),
  );
  await ui(
    `const c=d.querySelector('.confucius-organizer-review-card');[...c.querySelectorAll('button')].find(b=>b.textContent.includes('应用')).click();return true;`,
  );
  const removed = await until(() =>
    evaluate("return globalThis.organizerQA.done;"),
  );
  check(
    "Approved removal deletes only the selected outline tag",
    removed.ok &&
      (await evaluate(
        "return !globalThis.organizerQA.annotations[1].getTags().length;",
      )),
  );
  report.passed = true;
} catch (error) {
  report.error = String(error);
  try {
    await capture("failure");
  } catch {}
  throw error;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await instance.stop({ graceful: true });
}
