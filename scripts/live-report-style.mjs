/** Native composer regression with synthetic tasks and intercepted model requests. */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/report-style-scope");
await mkdir(output, { recursive: true });
const instance = await IsolatedZotero.create({
  root,
  binary: process.env.ZOTERO_BIN ?? "C:/Program Files/Zotero/zotero.exe",
  xpi: join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "report-style-scope-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\nuser_pref("extensions.zotero.confucius.uiLanguage", "zh-CN");\n',
);
const report = { checks: [] };
const evaluate = (code) =>
  instance.rdp.evaluate(
    `
  const host=Zotero.Confucius.hooks.host,qa=Zotero.__reportScopeQA;
  const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml');
  const d=win?.document;
  ${code}
`,
    30000,
  );
const waitFor = (code) => until(() => evaluate(code), 20000, 100);
const capture = async (name) => {
  const png = await evaluate(`
    const node=d.querySelector('.confucius-composer'),r=node.getBoundingClientRect();
    const c=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');
    c.width=r.width;c.height=r.height;
    c.getContext('2d').drawWindow(win,r.x,r.y,r.width,r.height,'white');
    return c.toDataURL('image/png');
  `);
  await writeFile(
    join(output, name + ".png"),
    Buffer.from(png.split(",")[1], "base64"),
  );
};
try {
  report.environment = await instance.launch();
  console.log(`Isolated Zotero ${report.environment.zotero}`);
  await evaluate(`
    const task=await host.rpc('task/new',{title:'Report style scope',backend:'native',context:{version:1,capturedAt:Date.now(),items:[]}});
    Zotero.__reportScopeQA={taskId:task.id,prompts:[],errors:[]};
    const original=host.rpc.bind(host);
    host.rpc=async(method,params={})=>{
      if(method==='task/prompt'){Zotero.__reportScopeQA.prompts.push(params);return {superseded:true};}
      const result=await original(method,params);
      if(method==='config/get')return {...result,configured:true};
      return result;
    };
    const main=Zotero.getMainWindow();
    main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));
    return true;
  `);
  await waitFor(
    `return !!d?.getElementById('confucius-report-style') && !!d.querySelector('[data-entry-id^="overview:"]');`,
  );
  await evaluate(`
    win.addEventListener('error',e=>qa.errors.push(e.message));
    win.addEventListener('unhandledrejection',e=>qa.errors.push(String(e.reason)));
    qa.metrics=()=>{
      const b=d.getElementById('confucius-report-style'),toolbar=d.querySelector('.confucius-composer-toolbar');
      const nodes=[...toolbar.querySelectorAll('button, #confucius-context-ring')].filter(n=>n.getClientRects().length>0);
      const boxes=nodes.map(n=>({id:n.id,box:n.getBoundingClientRect().toJSON()}));
      const overlap=[];
      for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
        const a=boxes[i].box,b=boxes[j].box;
        if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)
          overlap.push([boxes[i].id,boxes[j].id]);
      }
      return {hidden:b.hidden,display:win.getComputedStyle(b).display,width:b.getBoundingClientRect().width,
        disabled:b.disabled,statusActive:toolbar.dataset.statusActive,overlap,boxes,
        overflow:toolbar.scrollWidth>toolbar.clientWidth+1,
        density:d.getElementById('confucius-root').dataset.confuciusDensity};
    };
    return true;
  `);
  let metrics = await evaluate(`return qa.metrics();`);
  assert.equal(metrics.display, "none");
  assert.equal(metrics.width, 0);
  assert.equal(metrics.statusActive, "false");
  report.checks.push({ freshOrdinary: metrics });
  await evaluate(`
    await host.rpc('task/stageTemplate',{taskId:qa.taskId,templateId:'deep-read'});
    await host.rpc('task/setReportStyle',{taskId:qa.taskId,reportStyle:{layout:'parallel',tone:'questions',focus:'method'}});
    return true;
  `);
  await waitFor(`return !d.getElementById('confucius-report-style').hidden;`);
  await evaluate(
    `d.getElementById('confucius-report-style').click();return true;`,
  );
  await waitFor(`return !!d.querySelector('.confucius-report-style-dialog');`);
  assert.deepEqual(
    await evaluate(
      `return [...d.querySelectorAll('[role=radio][aria-checked=true]')].map(n=>n.dataset.value);`,
    ),
    ["parallel", "questions", "method"],
  );
  const reading = await evaluate(`
    const preview=d.querySelector('.confucius-report-style-preview');
    const pair=preview.querySelector('.confucius-reading-parallel');
    const help=[...preview.querySelectorAll('details')];
    if(help[0])help[0].open=true;
    return {paired:!!pair,columns:pair?.children.length,help:help.length,expanded:help[0]?.open,rawSyntax:preview.textContent.includes(':::')};
  `);
  assert.equal(reading.paired, true);
  assert.equal(reading.columns, 2);
  assert.ok(reading.help > 0);
  assert.equal(reading.expanded, true);
  assert.equal(reading.rawSyntax, false);
  report.checks.push({ readingBlocks: reading });
  const readingPng = await evaluate(`
    const panel=d.querySelector('.confucius-dialog-panel'),r=panel.getBoundingClientRect();
    const c=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=r.width;c.height=r.height;
    c.getContext('2d').drawWindow(win,r.x,r.y,r.width,r.height,'white');return c.toDataURL('image/png');
  `);
  await writeFile(
    join(output, "reading-blocks.png"),
    Buffer.from(readingPng.split(",")[1], "base64"),
  );
  await evaluate(
    `d.activeElement.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));d.getElementById('confucius-preset').click();return true;`,
  );
  await waitFor(
    `return d.getElementById('confucius-preset').hidden && qa.metrics().display==='none';`,
  );
  assert.deepEqual(
    await evaluate(
      `return (await host.rpc('task/load',{taskId:qa.taskId})).reportStyle;`,
    ),
    { layout: "parallel", tone: "questions", focus: "method" },
  );
  await evaluate(
    `const b=d.getElementById('confucius-report-style');b.disabled=false;b.click();return true;`,
  );
  assert.equal(
    await evaluate(
      `return !!d.querySelector('.confucius-report-style-dialog');`,
    ),
    false,
  );
  report.checks.push({
    dismissRetainsPreference: true,
    hiddenButtonCannotOpenDialog: true,
  });

  for (const width of [1080, 620, 390, 280]) {
    await evaluate(
      `d.getElementById('confucius-root').style.width='${width}px';return true;`,
    );
    await waitFor(
      `return Math.abs(d.getElementById('confucius-root').getBoundingClientRect().width-${width})<1;`,
    );
    for (const templateId of [
      null,
      "deep-read",
      "evidence-audit",
      "synthesis",
    ]) {
      for (const mode of ["agent", "plan"]) {
        await evaluate(`
          await host.rpc('task/stageTemplate',{taskId:qa.taskId,templateId:${JSON.stringify(templateId)}});
          await host.rpc('task/setMode',{taskId:qa.taskId,mode:'${mode}'});
          return true;
        `);
        await waitFor(`
          const b=d.getElementById('confucius-preset'),p=d.getElementById('confucius-mode');
          return b.hidden===${templateId === null} && (${templateId === null} || b.dataset.templateId===${JSON.stringify(templateId)}) && p.hidden===${mode !== "plan"};
        `);
        metrics = await evaluate(`return qa.metrics();`);
        const expected = templateId === "deep-read";
        assert.equal(metrics.hidden, !expected);
        assert.equal(metrics.display === "none", !expected);
        assert.deepEqual(
          metrics.overlap,
          [],
          JSON.stringify({ width, templateId, mode, metrics }),
        );
        assert.equal(
          metrics.overflow,
          false,
          JSON.stringify({ width, templateId, mode, metrics }),
        );
        if (!expected) assert.equal(metrics.width, 0);
        report.checks.push({ width, templateId, mode, metrics });
        if (mode === "agent" && (templateId === null || expected))
          await capture(`${templateId ?? "ordinary"}-${width}`);
        if (expected) {
          const localized = await evaluate(`
            const b=d.getElementById('confucius-report-style'),p=d.getElementById('confucius-preset');
            const label=p.querySelector('.confucius-composer-status-label');
            const original=[b.textContent,label.textContent];b.textContent='Report style';label.textContent='Paper review';
            qa.restoreLabels=()=>{b.textContent=original[0];label.textContent=original[1];};
            return {...qa.metrics(),whiteSpace:win.getComputedStyle(b).whiteSpace,labelFits:b.scrollWidth<=b.clientWidth+1};
          `);
          assert.equal(localized.whiteSpace, "nowrap");
          assert.equal(localized.labelFits, true);
          assert.deepEqual(localized.overlap, []);
          assert.equal(localized.overflow, false);
          if (width === 280) await capture(`english-${mode}-${width}`);
          await evaluate(`qa.restoreLabels();return true;`);
          report.checks.push({ width, mode, english: localized });
        }
      }
    }
  }
  await evaluate(
    `await host.rpc('task/stageTemplate',{taskId:qa.taskId,templateId:null});await host.rpc('task/setMode',{taskId:qa.taskId,mode:'agent'});return true;`,
  );
  await waitFor(
    `return d.getElementById('confucius-preset').hidden && d.getElementById('confucius-mode').hidden;`,
  );
  await evaluate(
    `const p=d.getElementById('confucius-prompt');p.value='Ordinary question';p.dispatchEvent(new win.Event('input',{bubbles:true}));d.getElementById('confucius-send').click();return true;`,
  );
  await waitFor(`return qa.prompts.length===1;`);
  assert.equal(
    await evaluate(
      `return !!d.querySelector('.confucius-report-style-dialog');`,
    ),
    false,
  );
  assert.deepEqual(await evaluate(`return qa.errors;`), []);
  report.checks.push({ ordinarySendWithoutChooser: true });
  console.log(
    `Passed ${report.checks.length} native composer checks; no live model calls.`,
  );
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  if (instance.rdp) await instance.stop({ graceful: true });
}
