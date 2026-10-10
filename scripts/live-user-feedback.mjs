import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import http from "node:http";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
import { resolveZoteroExecutable } from "../apps/zotero-addon/src/development/zoteroExecutable.ts";

const root = resolve(import.meta.dirname, "..");
const fixtureServer = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  JSON.parse(Buffer.concat(chunks).toString());
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      id: "feedback-menu-fixture",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Test complete." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 },
    }),
  );
});
await new Promise((ready) => fixtureServer.listen(0, "127.0.0.1", ready));
const fixtureBaseUrl = `http://127.0.0.1:${fixtureServer.address().port}/v1`;
const output = join(root, "output/user-feedback-acceptance");
await mkdir(join(output, "apps/zotero-addon/.scaffold"), { recursive: true });
const instance = await IsolatedZotero.create({
  root: output,
  binary: resolveZoteroExecutable().path,
  xpi: join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  sourcePreferences: process.env.CONFUCIUS_FEEDBACK_PREFS,
  prefix: "isolated-",
});
const report = { checks: [], environment: null, modelSamples: [] };
function check(name, value) {
  assert.ok(value, name);
  report.checks.push(name);
  console.log(name);
}
const evaluate = (s) => instance.rdp.evaluate(s, 60000);
const ui = (code) =>
  evaluate(`
  const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml'),d=win?.document;
  ${code}
`);
const wait = (code) => until(() => ui(code), 30000);
async function input(value) {
  await ui(
    `const p=d.getElementById('confucius-prompt');p.focus();p.value=${JSON.stringify(value)};p.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
}
async function menu(slug, method) {
  await input(` \n/${slug}`);
  await wait(
    `return !![...d.querySelectorAll('#confucius-slash-menu [role=option]')].find(r=>r.textContent.includes('/${slug}'));`,
  );
  return ui(`const p=d.getElementById('confucius-prompt'),row=[...d.querySelectorAll('#confucius-slash-menu [role=option]')].find(r=>r.textContent.includes('/${slug}'));
    row.dispatchEvent(new win.MouseEvent('mouseenter',{bubbles:true}));
    ${method === "mouse" ? "row.click();" : `p.dispatchEvent(new win.KeyboardEvent('keydown',{key:${JSON.stringify(method)},bubbles:true,cancelable:true}));`}
    return {draft:p.value,closed:!d.getElementById('confucius-slash-menu')};`);
}
try {
  await instance.launch();
  report.environment = instance.environment;
  await writeFile(
    join(output, "instance.json"),
    JSON.stringify(instance.publicState(), null, 2),
  );
  const task = await evaluate(`
    const host=Zotero.Confucius.hooks.host;
    if(!${Boolean(process.env.CONFUCIUS_FEEDBACK_PREFS)}) {
      Zotero.Prefs.set('extensions.zotero.confucius.baseUrl','http://127.0.0.1:1',true);
      Zotero.Prefs.set('extensions.zotero.confucius.model','acceptance-no-network',true);
    }
    Zotero.Prefs.set('extensions.zotero.confucius.historyAutoCleanup',false,true);
    const paper=new Zotero.Item('journalArticle');paper.setField('title','User feedback fixture');await paper.saveTx();
    const task=host.sessionNew({title:'User feedback acceptance',backend:'native',lockedContext:{version:1,capturedAt:Date.now(),fingerprint:'qa',items:[{id:'item:'+paper.libraryID+':'+paper.key,libraryID:paper.libraryID,key:paper.key,title:'User feedback fixture',source:'library'}]}});
    task.titleState='fixed';
    const q=globalThis.feedbackQA={host,task,paperId:paper.id,prompts:[],originalAdapter:host.openaiAdapter,originalRequire:host.requireEndpoint};
    host.requireEndpoint=()=>({id:'feedback-menu-fixture',baseUrl:${JSON.stringify(fixtureBaseUrl)},apiKey:'fixture',model:'acceptance-menu-fixture',contextWindowTokens:32768,maxTokens:1024});
    host.openaiAdapter=function(options,endpoint){
      const adapter=q.originalAdapter.call(host,{...options,stream:false},endpoint),complete=adapter.complete.bind(adapter);
      adapter.complete=async function(request,...args){
        q.prompts.push(request.messages.map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\\n'));
        return complete(request,...args);
      };
      return adapter;
    };
    Zotero.Prefs.set('extensions.zotero.confucius.workspaceLayout','window',true);
    const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));
    return {id:task.id};
  `);
  await wait(
    `return !!d?.querySelector('[data-task-id="${task.id}"] .confucius-task-open');`,
  );
  await ui(
    `d.querySelector('[data-task-id="${task.id}"] .confucius-task-open').click();return true;`,
  );
  await wait(`return !!d?.getElementById('confucius-prompt');`);
  for (const [index, slug, method] of [
    [0, "paper-deep-reading", "mouse"],
    [1, "annotation-pass", "Enter"],
    [2, "paper-deep-reading", "Tab"],
  ]) {
    const picked = await menu(slug, method);
    check(
      `Turn ${index + 1}: ${method} selects a skill after leading whitespace`,
      picked.closed && picked.draft === `/${slug} `,
    );
    await input(
      picked.draft +
        (index === 0
          ? "Bitte erkläre die Belege auf Deutsch."
          : index === 1
            ? "请用中文解释证据。"
            : ""),
    );
    await wait(
      `const b=d.getElementById('confucius-send');return !b.disabled&&win.getComputedStyle(b).display!=='none';`,
    );
    await ui(`d.getElementById('confucius-send').click();return true;`);
    await writeFile(
      join(output, `turn-${index + 1}-ui.json`),
      JSON.stringify(
        await ui(
          `const q=globalThis.feedbackQA,s=q.host.sessions.get(q.task.id);return {draft:d.getElementById('confucius-prompt').value,menu:!!d.getElementById('confucius-slash-menu'),send:d.getElementById('confucius-send').outerHTML,events:s.events.map(e=>({type:e.type,turnId:e.turnId})),task:s.record.status,windows:[...Services.wm.getEnumerator(null)].map(w=>w.location.href),dialogs:[...d.querySelectorAll('[role=dialog]')].map(e=>({id:e.id,hidden:e.hidden,display:win.getComputedStyle(e).display}))};`,
        ),
        null,
        2,
      ),
    );
    await until(
      () =>
        evaluate(
          `const q=globalThis.feedbackQA,s=q.host.sessions.get(q.task.id);return q.prompts.length===${index + 1}&&!s.activeTurnId;`,
        ),
      30000,
    );
    check(
      `Turn ${index + 1}: actual submission carries /${slug} body in the same task`,
      await evaluate(
        `const q=globalThis.feedbackQA;return q.prompts[${index}].includes('## ${slug}')&&q.task.id===${JSON.stringify(task.id)};`,
      ),
    );
    if (index > 0) {
      for (const method of ["mouse", "Enter", "Tab"]) {
        const picked = await menu("annotation-pass", method);
        check(
          `After turn ${index + 1}: ${method} can select another skill`,
          picked.closed && picked.draft === "/annotation-pass ",
        );
      }
    }
    await input(" \n/annotation-pass");
    await wait(`return !!d.getElementById('confucius-slash-menu');`);
    if (index > 0)
      check(
        `After turn ${index + 1}: IME keys leave the slash draft unchanged`,
        await ui(`
      const p=d.getElementById('confucius-prompt'),text=p.value;
      p.dispatchEvent(new win.CompositionEvent('compositionstart',{bubbles:true}));
      for(const key of ['Enter','Tab','Escape']) p.dispatchEvent(new win.KeyboardEvent('keydown',{key,isComposing:true,bubbles:true,cancelable:true}));
      const unchanged=p.value===text&&!!d.getElementById('confucius-slash-menu');
      p.dispatchEvent(new win.CompositionEvent('compositionend',{bubbles:true}));return unchanged;
    `),
      );
    check(
      `Turn ${index + 1}: Escape closes the menu and preserves the draft`,
      await ui(
        `const p=d.getElementById('confucius-prompt'),text=p.value;p.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return !d.getElementById('confucius-slash-menu')&&p.value===text;`,
      ),
    );
  }
  check(
    "Third bare skill retains Chinese language evidence and both loaded skills",
    await evaluate(
      `const q=globalThis.feedbackQA,s=q.host.sessions.get(q.task.id);return q.task.responseLanguageContext.request==='请用中文解释证据。'&&s.loadedSkills.size===2&&q.prompts[2].includes('Follow the loaded skill instructions for the current Zotero context');`,
    ),
  );
  await input("/unknown-command");
  check(
    "Unknown command remains ordinary draft text",
    await ui(
      `return !d.getElementById('confucius-slash-menu')&&d.getElementById('confucius-prompt').value==='/unknown-command';`,
    ),
  );
  for (const [width, theme] of [
    [960, "light"],
    [560, "dark"],
  ]) {
    await ui(
      `win.resizeTo(${width},760);d.documentElement.setAttribute('data-confucius-theme',${JSON.stringify(theme)});return true;`,
    );
    await menu("annotation-pass", "mouse");
    await input(" \n/annotation-pass");
    await wait(`return !!d.getElementById('confucius-slash-menu');`);
    check(
      `${theme} ${width}px slash menu stays within the workspace and receives pointer hits`,
      await ui(
        `const m=d.getElementById('confucius-slash-menu'),r=m.getBoundingClientRect(),row=m.querySelector('[role=option]'),b=row.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=win.innerWidth+1&&r.bottom<=win.innerHeight+1&&m.scrollWidth<=m.clientWidth+1&&row.contains(d.elementFromPoint(b.x+b.width/2,b.y+b.height/2));`,
      ),
    );
    const png = await ui(
      `const c=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=win.innerWidth;c.height=win.innerHeight;c.getContext('2d').drawWindow(win,0,0,c.width,c.height,'white');return c.toDataURL('image/png');`,
    );
    await writeFile(
      join(output, `slash-${theme}-${width}.png`),
      Buffer.from(png.split(",")[1], "base64"),
    );
  }
  // A preset stages the existing chat; it must not create another task.
  await input("/");
  await wait(
    `return !!d.querySelector('#confucius-slash-menu [data-template-id]');`,
  );
  const count = await evaluate(
    `return globalThis.feedbackQA.host.sessions.size;`,
  );
  const presetId = await ui(
    `const row=d.querySelector('#confucius-slash-menu [data-template-id]');const id=row.dataset.templateId;row.click();return id;`,
  );
  check(
    "Choosing a later preset reuses the current task",
    await until(
      () =>
        evaluate(
          `const q=globalThis.feedbackQA;return q.host.sessions.get(q.task.id).record.templateId===${JSON.stringify(presetId)}&&q.host.sessions.size===${count};`,
        ),
      30000,
    ),
  );
  await evaluate(
    `const q=globalThis.feedbackQA;q.host.openaiAdapter=q.originalAdapter;q.host.requireEndpoint=q.originalRequire;await q.host.persistNow();return true;`,
  );

  if (process.env.CONFUCIUS_FEEDBACK_PREFS) {
    for (const sample of [
      {
        ui: "en-US",
        request:
          "Erkläre kurz, warum Quellenbelege wichtig sind. Gib JSON mit title, answer, comment und report zurück.",
        language: "German",
        pattern: "Beleg|Quelle|Aussage|Nachweis",
      },
      {
        ui: "zh-CN",
        request:
          "Explain briefly why source evidence matters. Return JSON with title, answer, comment and report.",
        language: "English",
        pattern: "evidence|source|claim|support",
      },
      {
        ui: "zh-CN",
        request: "/annotation-pass",
        contextRequest: "Bitte erläutere die Quellen auf Deutsch.",
        language: "inherited German",
        pattern: "Quelle|Beleg|Kontext|vorhanden|keine",
      },
      {
        ui: "en-US",
        request:
          "Please revise this source report in German, without adding facts. Return JSON with title, answer, comment and report. Source report: Only a partial result is available; complete success has not been established. Preserve this verbatim quote: The result is partial.",
        language: "explicit German",
        pattern:
          "Beleg|Quelle|Aussage|Ergebnis|Bericht|Zitat|Deutsch|Zusammenfassung|über|\\b(das|der|die|ein|eine|ist|sind|und|ohne|wurde|bleibt|keine)\\b",
      },
    ]) {
      const value = await evaluate(`
        const q=globalThis.feedbackQA;Zotero.Prefs.set('extensions.zotero.confucius.uiLanguage',${JSON.stringify(sample.ui)},true);
        const request=${JSON.stringify(sample.request)};
        const instruction=q.host.languageInstruction({responseLanguageContext:{request:${JSON.stringify(sample.contextRequest ?? sample.request)},priorRequests:[]}},request);
        const result=await q.host.openaiAdapter({stream:false,maxTokens:4096}).complete({messages:[{role:'system',content:instruction+'\\nReturn one JSON object with four short text fields: title, answer, comment, report. Include source quotations unchanged in report when requested.'},{role:'user',content:request}],maxAttempts:1});
        return {text:result.text,end:result.end,model:q.host.requireEndpoint().model};
      `);
      assert.equal(
        typeof value.text,
        "string",
        `Model returned no text (${value.end})`,
      );
      const json = JSON.parse(
        value.text
          .replace(/^\s*\x60{3}(?:json)?\s*/, "")
          .replace(/\s*\x60{3}\s*$/, ""),
      );
      report.modelSamples.push({ ...sample, ...value, fields: json });
      check(
        `Real model: ${sample.ui} UI follows ${sample.language} for answer, comment and report`,
        ["title", "answer", "comment", "report"].every((field) =>
          new RegExp(sample.pattern, "i").test(json[field]),
        ) &&
          typeof json.title === "string" &&
          json.title.length > 0,
      );
      if (sample.language === "explicit German")
        check(
          "Real revision sample preserves verbatim English quote",
          json.report.includes("The result is partial."),
        );
    }
    const german = report.modelSamples[0].fields;
    const saved = await evaluate(`
      const q=globalThis.feedbackQA;
      const pdf=await Zotero.Attachments.importFromFile({file:${JSON.stringify(join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"))},parentItemID:q.paperId});
      const reader=await Zotero.Reader.open(pdf.id);await reader._initPromise;
      const provider=q.host.execution.wrap(q.host.reviewTools()),context={taskId:q.task.id,taskTitle:q.task.title,agent:'native'};
      const pages=await provider.call('get_pages',{libraryID:pdf.libraryID,key:pdf.key,start:1,end:1},undefined,context);
      if(!pages.ok)throw new Error(JSON.stringify(pages));
      const anchor=[...JSON.stringify(pages.data).matchAll(/\\[anchor:([^\\]]+)\\]/g)][0]?.[1];
      if(!anchor)throw new Error('No fixture anchor');
      const staged=await provider.call('commit_annotations',{libraryID:pdf.libraryID,key:pdf.key,annotations:[{anchor,comment:${JSON.stringify(german.comment)}}]},undefined,context);
      if(!staged.ok)throw new Error(JSON.stringify(staged));
      const batch=(await q.host.reviews().list(q.task.id)).batches.at(-1),entry=batch.entries[0];
      const pool=await q.host.rpc('annotation/review/decide',{taskId:q.task.id,action:'accept',entries:[{batchId:batch.id,entryId:entry.id}]});
      const accepted=pool.batches.find(b=>b.id===batch.id).entries[0];
      const native=Zotero.Items.getByLibraryAndKey(pdf.libraryID,accepted.annotationKey);
      return {comment:native.annotationComment,quote:native.annotationText,tags:native.getTags(),source:JSON.stringify(pages.data)};
    `);
    check(
      "Actual review saves the model's German comment with no automatic tags",
      saved.comment === german.comment && saved.tags.length === 0,
    );
    check(
      "Native highlight retains verbatim English source text",
      saved.quote.length > 0 &&
        saved.source.includes(JSON.stringify(saved.quote).slice(1, -1)),
    );
  }
  await instance.stop({ graceful: true });
  await instance.launch();
  check(
    "Restart retains the same conversation language and loaded skills",
    await evaluate(
      `const s=Zotero.Confucius.hooks.host.sessions.get(${JSON.stringify(task.id)});return s?.record.responseLanguageContext.request==='请用中文解释证据。'&&s.loadedSkills.has('annotation-pass')&&s.loadedSkills.has('paper-deep-reading');`,
    ),
  );
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await instance.stop().catch(() => undefined);
  fixtureServer.closeAllConnections();
  await new Promise((done) => fixtureServer.close(done));
}
