/** Native Zotero acceptance with an isolated library and fictional indicator CSVs. */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
import {
  casCsv,
  jcrCsv,
  xrCsv,
  journalName,
} from "./fixtures/venue-ratings.mjs";

const root = resolve(import.meta.dirname, ".."),
  output = resolve(
    process.env.CONFUCIUS_VENUE_OUTPUT ??
      join(root, "output/venue-ratings-live"),
  );
await mkdir(output, { recursive: true });
const paths = {};
for (const [name, value] of [
  ["JCR2025.csv", jcrCsv()],
  ["FQBJCR2025.csv", casCsv()],
  ["XR2026.csv", xrCsv()],
  ["invalid.csv", jcrCsv(2025, journalName, "Q5")],
]) {
  paths[name] = join(output, name);
  await writeFile(paths[name], value);
}
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi: join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "venue-ratings-acceptance-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\n',
);
const checks = [];
const evaluate = (code) =>
  instance.rdp.evaluate(
    `const host=Zotero.Confucius.hooks.host,qa=Zotero.__venueQA;const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml');const d=win?.document;${code}`,
    30000,
  );
const wait = (code) => until(() => evaluate(code), 30000, 100);
const capture = async (name) => {
  const data = await evaluate(
    `const r=d.documentElement.getBoundingClientRect(),canvas=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');canvas.width=r.width;canvas.height=r.height;canvas.getContext('2d').drawWindow(win,0,0,r.width,r.height,'white');return canvas.toDataURL('image/png');`,
  );
  await writeFile(
    join(output, name + ".png"),
    Buffer.from(data.split(",")[1], "base64"),
  );
};
try {
  const environment = await instance.launch();
  await evaluate(`Zotero.__venueQA={errors:[],opened:[],calls:[]};const q=Zotero.__venueQA;
    const task=await host.rpc('task/new',{title:'Venue rating acceptance'});q.taskId=task.id;
    host.openAlex.transport=async()=>({status:200,data:{results:Array.from({length:9},(_,i)=>({id:'https://openalex.org/W'+(990000+i),title:i===0?'Journal paper':'NeurIPS paper '+i,type:'article',publication_year:2021,authorships:[{author:{display_name:'Test Author'}}],primary_location:{source:i===0?{id:'https://openalex.org/S100',type:'journal',display_name:${JSON.stringify(journalName)},issn:['0734-2071','1557-7333']}:{id:'https://openalex.org/S200',type:'conference',display_name:'Advances in Neural Information Processing Systems'}},abstract_inverted_index:{Evidence:[0],limitations:[1]},cited_by_count:5})),meta:{count:9,next_cursor:null}}});
    Zotero.launchURL=url=>q.opened.push(url);
    const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;`);
  await wait(`return !!d?.getElementById('confucius-prompt');`);
  await evaluate(`win.addEventListener('error',e=>qa.errors.push(e.message));win.addEventListener('unhandledrejection',e=>qa.errors.push(String(e.reason)));
    await host.rpc('config/set',{baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic-fixture',model:'venue-fixture',contextWindowTokens:32768,historyAutoCleanup:false,uiTheme:'light'});
    let n=0;host.openaiAdapter=()=>({complete:async request=>{await request.onAttempt?.();return ++n===1?{end:'tool_calls',toolCalls:[{id:'search',name:'literature_search',args:{query:'Venue rating fixture'}}]}:{end:'stop',text:'Review these metadata-only results.'};}});
    const prompt=d.getElementById('confucius-prompt');prompt.value='比较这些论文的发表场所评级';prompt.dispatchEvent(new win.Event('input',{bubbles:true}));d.getElementById('confucius-send').click();return true;`);
  await wait(
    `return !host.sessions.get(qa.taskId).activeTurnId && !d.getElementById('confucius-literature-popup')?.hidden && !!d.querySelector('.confucius-literature-review .ar-paper .confucius-venue-rating');`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-literature-review').dataset.view==='card' && d.querySelector('.confucius-literature-review .ar-paper .confucius-venue-rating').textContent.includes('CCF A') && d.querySelector('.confucius-literature-review .ar-paper .confucius-venue-rating').textContent.includes('2026');`,
    ),
    true,
  );
  await capture("ratings-card-light");
  await evaluate(
    `d.querySelector('.confucius-literature-review .ar-card-next').click();return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelectorAll('.confucius-literature-review .ar-paper .confucius-venue-rating').length===2 && d.querySelector('.confucius-literature-review .ar-paper [data-system="core"]').textContent.includes('CORE A*');`,
    ),
    true,
  );
  await evaluate(
    `d.querySelector('.confucius-literature-review .ar-paper [data-system="core"] a').click();return true;`,
  );
  assert.equal(
    await evaluate(`return qa.opened.at(-1).includes('portal.core.edu.au');`),
    true,
  );
  checks.push(
    "Native cards show both systems, edition years and actionable official sources",
  );

  await evaluate(
    `d.querySelector('.confucius-literature-review .ar-card-previous').click();d.querySelector('.confucius-literature-review .ar-paper .confucius-venue-rating-details').open=true;d.querySelector('.confucius-literature-review .ar-paper .confucius-literature-abstract').open=true;await host.rpc('literature/updateCandidates',{taskId:qa.taskId,candidateRevision:0,changes:[{id:'W990000',selected:true,reason:'User choice'}]});return true;`,
  );
  const before = await instance.rpc("literature/review/list", {
    taskId: await evaluate("return qa.taskId;"),
  });
  // Deterministic picker selection exercises the same import controls and real
  // native file reads/storage. An interactive operating-system picker is not automated.
  const bundle = await build({
    entryPoints: [
      join(root, "apps/zotero-addon/src/modules/ui/venueRatings.ts"),
    ],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "venueSettingsFixture",
    banner: { js: "var addon=Zotero.Confucius;" },
  });
  await evaluate(`${bundle.outputFiles[0].text}
    qa.importSettings=venueSettingsFixture.createVenueRatingSettings(d,(method,params)=>{qa.calls.push({method,params});return host.rpc(method,params);},{pickFile:async()=>qa.nextCsv});
    qa.importSettings.node.id='venue-import-fixture';qa.importSettings.node.style.cssText='position:fixed;inset:16px;z-index:99999;overflow:auto;padding:20px;background:var(--confucius-paper);color:var(--confucius-ink);';
    d.querySelector('.confucius-workspace-root').append(qa.importSettings.node);await qa.importSettings.refresh();return true;`);
  await evaluate(
    `qa.importSettings.node.querySelector('[data-action="import-ratings"]').click();return true;`,
  );
  await wait(
    `return !qa.importSettings.node.querySelector('[data-action="import-ratings"]').disabled;`,
  );
  assert.equal(
    await evaluate(
      `return !qa.calls.some(c=>c.method==='literature/ratings/import');`,
    ),
    true,
  );
  for (const name of ["JCR2025.csv", "FQBJCR2025.csv", "XR2026.csv"]) {
    await evaluate(
      `qa.nextCsv=${JSON.stringify(paths[name])};qa.importSettings.node.querySelector('[data-action="import-ratings"]').click();return true;`,
    );
    await wait(
      `return !qa.importSettings.node.hasAttribute('aria-busy') && qa.importSettings.node.textContent.includes(${JSON.stringify(name)}) && !qa.importSettings.node.querySelector('[data-action="import-ratings"]').disabled;`,
    );
  }
  await capture("ratings-imported-catalogs");
  await evaluate(`qa.importSettings.node.hidden=true;return true;`);
  await wait(
    `return d.querySelectorAll('.confucius-literature-review .ar-paper .confucius-venue-rating').length===4;`,
  );
  const after = await instance.rpc("literature/review/list", {
    taskId: before.summary.id,
  });
  assert.deepEqual(after.summary, before.summary);
  assert.deepEqual(after.items[0].decision, before.items[0].decision);
  assert.equal(after.items[0].venueRatings.length, 4);
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-literature-review .ar-paper .confucius-venue-rating-details').open && d.querySelector('.confucius-literature-review .ar-paper .confucius-literature-abstract').open && d.querySelector('.confucius-literature-review .ar-range').value==='1';`,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      `return (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID,true,false)).length;`,
    ),
    0,
  );
  await capture("ratings-all-systems-card");
  checks.push(
    "CSV import updates the active card through real host events without changing selection, revisions or library items",
  );
  checks.push(
    "All subject/major/minor partitions remain visible in expandable details",
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-literature-review .ar-paper .confucius-venue-rating-details').textContent.includes('ENGINEERING') && d.querySelector('.confucius-literature-review .ar-paper .confucius-venue-rating-details').textContent.includes('Top') && d.querySelector('.confucius-literature-review .ar-paper .confucius-venue-rating-details').textContent.includes('JCR2025.csv');`,
    ),
    true,
  );
  await evaluate(
    `qa.importSettings.node.hidden=false;qa.nextCsv=${JSON.stringify(paths["invalid.csv"])};qa.importSettings.node.querySelector('[data-action="import-ratings"]').click();return true;`,
  );
  await wait(
    `return qa.importSettings.node.querySelector('[role=status]').textContent.includes('quartile') && !qa.importSettings.node.hasAttribute('aria-busy');`,
  );
  assert.equal(
    (await instance.rpc("literature/ratings/list")).catalogs.length,
    5,
  );
  await evaluate(
    `qa.importSettings.node.querySelector('[data-catalog-id="jcr_2025"] [data-action="remove-ratings"]').click();return true;`,
  );
  await wait(
    `return !qa.importSettings.node.hasAttribute('aria-busy') && !qa.importSettings.node.querySelector('[data-catalog-id="jcr_2025"]');`,
  );
  await evaluate(`qa.importSettings.node.hidden=true;return true;`);
  await wait(
    `return d.querySelectorAll('.confucius-literature-review .ar-paper .confucius-venue-rating').length===3;`,
  );
  checks.push(
    "Cancelled picker and invalid CSV preserve catalogs; Remove refreshes the active results",
  );

  await evaluate(
    `d.querySelector('.confucius-literature-review .ar-view-switch button:last-child').click();return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-literature-review').dataset.view==='list';`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-literature-review .ar-list-row[data-entry-id="W990000"] [data-system="cas"]').textContent.includes('2025') && d.querySelector('.confucius-literature-review .ar-list-row[data-entry-id="W990001"] [data-system="core"]').textContent.includes('2026');`,
    ),
    true,
  );
  await capture("ratings-list-light");
  const geometry = async () =>
    evaluate(
      `const root=d.querySelector('.confucius-literature-review'),b=root.getBoundingClientRect();return {width:b.width,noHorizontalOverflow:root.scrollWidth<=root.clientWidth+1,badges:[...root.querySelectorAll('.confucius-venue-rating')].filter(e=>e.getBoundingClientRect().width).every(e=>e.scrollWidth<=e.clientWidth+1)};`,
    );
  assert.equal((await geometry()).noHorizontalOverflow, true);
  await evaluate(
    `await host.rpc('config/set',{uiTheme:'dark'});win.resizeTo(420,720);return true;`,
  );
  await wait(
    `return d.documentElement.getAttribute('data-confucius-theme')==='dark' && d.documentElement.clientWidth<=440;`,
  );
  assert.equal((await geometry()).noHorizontalOverflow, true);
  await capture("ratings-list-dark-420");
  await evaluate(`win.resizeTo(280,720);return true;`);
  await wait(`return d.documentElement.clientWidth<=300;`);
  assert.equal((await geometry()).noHorizontalOverflow, true);
  assert.equal((await geometry()).badges, true);
  await capture("ratings-list-dark-280");
  await evaluate(
    `win.resizeTo(420,720);const style=d.createElementNS('http://www.w3.org/1999/xhtml','style');style.id='venue-large-fonts';style.textContent='.confucius-venue-rating,.confucius-venue-rating-details {font-size:18px !important}';d.head.append(style);return true;`,
  );
  assert.equal((await geometry()).noHorizontalOverflow, true);
  await capture("ratings-list-large-fonts");
  await evaluate(
    `Services.prefs.setIntPref('ui.useAccessibilityTheme',1);return true;`,
  );
  await wait(`return win.matchMedia('(prefers-contrast: more)').matches;`);
  assert.equal((await geometry()).noHorizontalOverflow, true);
  await capture("ratings-list-high-contrast");
  checks.push(
    "Cards and lists wrap in light, dark, 420/280-pixel widths, larger fonts and native high-contrast media",
  );
  await evaluate(
    `Services.prefs.clearUserPref('ui.useAccessibilityTheme');await host.rpc('config/set',{uiLanguage:'en-US',uiTheme:'light'});win.close();return true;`,
  );
  await evaluate(
    `const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;`,
  );
  await wait(
    `return !!d?.querySelector('#confucius-literature-capsule') && !d.querySelector('.confucius-literature-review').hidden;`,
  );
  await evaluate(
    `d.getElementById('confucius-literature-capsule').click();return true;`,
  );
  await wait(`return !d.getElementById('confucius-literature-popup').hidden;`);
  await evaluate(
    `const range=d.querySelector('.confucius-literature-review .ar-range');range.value='1';range.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  await wait(
    `return !!d.querySelector('.confucius-literature-review .ar-paper [data-system="cas"]');`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-literature-review .ar-paper [data-system="cas"]').textContent.includes('CAS Zone 2');`,
    ),
    true,
  );
  await capture("ratings-english-card");
  checks.push(
    "English and Chinese UI labels render in actual Zotero documents",
  );
  assert.deepEqual(await evaluate(`return qa.errors;`), []);
  const taskId = before.summary.id;
  await instance.stop({ graceful: true });
  await instance.launch();
  const resumed = await instance.rpc("literature/review/list", { taskId });
  assert.equal(resumed.items[0].decision.selected, true);
  assert.deepEqual(
    resumed.items[0].venueRatings.map((r) => r.system),
    ["ccf", "cas", "xr"],
  );
  checks.push(
    "Imported catalogs and candidate choices survive a real isolated Zotero restart",
  );
  const result = {
    passed: true,
    environment,
    checks,
    ordinaryBuiltXpi: true,
    modelAndOpenAlex: "deterministic fixtures",
    nativeFilePicker: "selection injected; interactive dialog not automated",
    personalLibrary: "untouched",
  };
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const diagnostic = await evaluate(
    `return {view:d?.querySelector('.confucius-literature-review')?.dataset.view,range:d?.querySelector('.confucius-literature-review .ar-range')?.value,badges:[...d?.querySelectorAll('.confucius-literature-review .ar-paper .confucius-venue-rating')??[]].map(e=>e.textContent),catalogs:(await host.rpc('literature/ratings/list')).catalogs.map(c=>c.id),cardWorkId:d?.querySelector('.confucius-literature-review .ar-entry-extra')?.dataset.workId,errors:qa?.errors};`,
  ).catch(() => null);
  console.error(JSON.stringify({ error: String(error), diagnostic }, null, 2));
  throw error;
} finally {
  await instance.stop({ graceful: true }).catch(() => {});
}
