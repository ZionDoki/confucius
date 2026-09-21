/** Real Zotero DOM regression for catalog filtering; uses an isolated, empty profile. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_MODEL_SETTINGS_OUTPUT ??
    join(root, "output/model-settings-picker"),
);
await mkdir(output, { recursive: true });
const requests = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/models")
    return res.end(JSON.stringify({ data: [{ id: "private-alias" }] }));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  res.end(
    JSON.stringify({
      choices: [
        {
          message: { content: "Synthetic verification response." },
          finish_reason: "stop",
        },
      ],
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi:
    process.env.CONFUCIUS_MODEL_SETTINGS_XPI ??
    join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "model-settings-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\nuser_pref("extensions.zotero.confucius.workspaceWidth", 1100);\n',
);
const result = { checks: [] };
const check = (label) => {
  result.checks.push(label);
  console.log("PASS", label);
};
const evaluate = (code) =>
  instance.rdp.evaluate(
    `const host=Zotero.Confucius.hooks.host;const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml');const d=win?.document;const q=d?.getElementById('confucius-cfg-catalog-query');const list=d?.getElementById('confucius-cfg-catalog-result');${code}`,
    30000,
  );
const wait = (code) => until(() => evaluate(code), 20000, 100);
const open = async () => {
  await evaluate(
    `Zotero.getMainWindow().document.getElementById('confucius-toolbar-button').dispatchEvent(new (Zotero.getMainWindow().Event)('command'));return true;`,
  );
  await wait(`return !!d?.getElementById('confucius-settings');`);
  await evaluate(`d.getElementById('confucius-settings').click();return true;`);
  await wait(`return !!q;`);
};
const filter = async (value) => {
  await evaluate(
    `q.closest('details').open=true;q.value=${JSON.stringify(value)};q.dispatchEvent(new win.Event('input',{bubbles:true}));q.focus();q.closest('.confucius-settings-field').scrollIntoView({block:'start'});return true;`,
  );
  await wait(`return q.getAttribute('aria-busy')==='false';`);
};
const screen = async (name) => {
  const data = await evaluate(
    `const canvas=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');canvas.width=win.innerWidth;canvas.height=win.innerHeight;canvas.getContext('2d').drawWindow(win,0,0,canvas.width,canvas.height,win.getComputedStyle(d.body).backgroundColor);return canvas.toDataURL('image/png');`,
  );
  await writeFile(
    join(output, name + ".png"),
    Buffer.from(data.split(",")[1], "base64"),
  );
};
const geometry = () =>
  evaluate(
    `const box=list.getBoundingClientRect(),panel=d.querySelector('.confucius-settings-content'),p=panel.getBoundingClientRect(),row=list.firstElementChild,s=win.getComputedStyle(row);return {count:list.children.length,height:box.height,scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,panelWidth:panel.clientWidth,panelScrollWidth:panel.scrollWidth,inside:box.left>=p.left&&box.right<=p.right&&box.top>=p.top&&box.bottom<=p.bottom+1,background:win.getComputedStyle(list).backgroundColor,display:s.display,styled:s.borderRadius!=='0px',nativeSelect:!!d.querySelector('#confucius-cfg-model-tab select')};`,
  );
try {
  result.zotero = (await instance.launch()).zotero;
  console.log("Zotero", result.zotero);
  await instance.rpc("config/set", {
    endpoint: {
      name: "Synthetic gateway",
      model: "private-alias",
      baseUrl,
      apiKey: "synthetic-test-key",
      contextWindowTokens: 32768,
      maxTokens: 128,
    },
    streamResponses: false,
  });
  await open();
  await filter("deepseek");
  const wide = await geometry();
  assert(wide.count >= 20, JSON.stringify(wide));
  assert(
    wide.height <= 281 && wide.scrollHeight > wide.clientHeight,
    JSON.stringify(wide),
  );
  assert(
    wide.inside && wide.styled && wide.display === "grid",
    JSON.stringify(wide),
  );
  assert.notEqual(wide.background, "rgba(0, 0, 0, 0)");
  assert.equal(wide.nativeSelect, false);
  await screen("zh-light-expanded");
  check(
    "Many catalog entries render as styled rows inside a bounded scrolling list, without native select menus",
  );
  const keyboard = await evaluate(
    `const panel=d.querySelector('.confucius-settings-content'),top=panel.scrollTop;for(let i=0;i<24;i++)q.dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));const active=d.getElementById(q.getAttribute('aria-activedescendant')),a=active.getBoundingClientRect(),b=list.getBoundingClientRect();return {focus:d.activeElement===q,listScroll:list.scrollTop,panelScroll:panel.scrollTop-top,visible:a.top>=b.top-1&&a.bottom<=b.bottom+1};`,
  );
  assert(
    keyboard.focus && keyboard.listScroll > 0 && keyboard.visible,
    JSON.stringify(keyboard),
  );
  assert.equal(keyboard.panelScroll, 0);
  check("Arrow keys keep focus in the filter and scroll only the results list");
  await evaluate(
    `q.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true;`,
  );
  assert.equal(
    await evaluate(
      `return !!d.getElementById('confucius-settings-overlay')&&list.hidden&&q.getAttribute('aria-expanded')==='false';`,
    ),
    true,
  );
  await evaluate(`q.click();return true;`);
  assert.equal(await evaluate(`return !list.hidden;`), true);
  check(
    "Escape closes the list before the dialog, and clicking the filter reopens it",
  );

  await filter("gpt-6-astra openai");
  assert.equal(
    await evaluate(
      `const rows=[...list.children],index=rows.findIndex(row=>row.dataset.provider==='openai'&&row.dataset.model==='gpt-6-astra');if(index<0)throw new Error(d.getElementById('confucius-cfg-catalog-status').textContent);for(let i=0;i<=index;i++)q.dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));q.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return list.hidden&&!d.getElementById('confucius-cfg-catalog-apply').disabled;`,
    ),
    true,
  );
  await evaluate(
    `d.getElementById('confucius-cfg-catalog-apply').click();return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.getElementById('confucius-cfg-model').value==='private-alias'&&d.getElementById('confucius-cfg-baseUrl').value===${JSON.stringify(baseUrl)}&&d.getElementById('confucius-cfg-apiKey').value==='synthetic-test-key'&&Number(d.getElementById('confucius-cfg-contextWindowTokens').value)>32768;`,
    ),
    true,
  );
  check(
    "Typing searches the entire cached catalog; keyboard selection and applying metadata preserve gateway credentials and alias",
  );

  // Deterministic failures, slow responses and IME checks after the live catalog smoke test.
  await evaluate(
    `const original=host.modelCatalog.search.bind(host.modelCatalog);host.__pickerQA={queries:[],offline:0};host.modelCatalog.search=async(query,signal)=>{host.__pickerQA.queries.push(query);if(query==='slow-fixture'){await new Promise(resolve=>win.setTimeout(resolve,450));return {source:'fixture',total:1,models:[{providerId:'fixture',providerName:'Fixture',id:'stale',name:'Stale result'}]};}if(query==='offline-fixture'&&host.__pickerQA.offline++===0)throw new Error('Synthetic offline failure');return original(query==='offline-fixture'?'gpt-6-astra openai':query,signal);};return true;`,
  );
  await evaluate(
    `q.value='slow-fixture';q.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.getElementById('confucius-cfg-catalog-apply').disabled;`,
    ),
    true,
  );
  await wait(`return host.__pickerQA.queries.includes('slow-fixture');`);
  await filter("deepseek");
  assert.equal(
    await evaluate(
      `return [...list.children].every(row=>row.dataset.model!=='stale')&&list.children.length>=20;`,
    ),
    true,
  );
  check(
    "Editing the filter clears the prior selection, and late results cannot replace the latest query",
  );
  const ime = await evaluate(
    `const before=host.__pickerQA.queries.length;q.dispatchEvent(new win.CompositionEvent('compositionstart',{bubbles:true}));q.value='gpt-6-astra openai';q.dispatchEvent(new win.InputEvent('input',{bubbles:true,isComposing:true}));q.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));await new Promise(resolve=>win.setTimeout(resolve,250));return {before,after:host.__pickerQA.queries.length,disabled:d.getElementById('confucius-cfg-catalog-apply').disabled};`,
  );
  assert.equal(ime.before, ime.after);
  assert.equal(ime.disabled, true);
  await evaluate(
    `q.dispatchEvent(new win.CompositionEvent('compositionend',{bubbles:true}));return true;`,
  );
  await wait(
    `return q.getAttribute('aria-busy')==='false'&&list.children.length>0;`,
  );
  check("IME composition neither searches nor selects until composition ends");
  await filter("offline-fixture");
  assert.equal(
    await evaluate(
      `return !d.getElementById('confucius-cfg-catalog-retry').hidden&&d.getElementById('confucius-cfg-catalog-apply').disabled;`,
    ),
    true,
  );
  await evaluate(
    `d.getElementById('confucius-cfg-catalog-retry').click();return true;`,
  );
  await wait(
    `return q.getAttribute('aria-busy')==='false'&&list.children.length>0;`,
  );
  await evaluate(`list.firstElementChild.click();return true;`);
  assert.equal(
    await evaluate(
      `return !d.getElementById('confucius-cfg-catalog-apply').disabled;`,
    ),
    true,
  );
  await filter("no-such-model-fixture");
  assert.equal(
    await evaluate(
      `return list.hidden&&d.getElementById('confucius-cfg-catalog-apply').disabled;`,
    ),
    true,
  );
  await filter("");
  assert.equal(await evaluate(`return list.children.length>0;`), true);
  check(
    "Retry, pointer selection, empty results and clearing the filter behave correctly",
  );

  await evaluate(
    `q.closest('details').open=false;const levels=d.getElementById('confucius-cfg-reasoning-options');levels.value='low, ultra';levels.dispatchEvent(new win.Event('input',{bubbles:true}));d.querySelector('#confucius-cfg-effort [data-effort="ultra"]').click();const group=d.getElementById('confucius-cfg-reasoning-transport');group.querySelector('[data-transport="openai"]').focus();for(let i=0;i<3;i++)d.activeElement.dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('#confucius-cfg-reasoning-transport [aria-checked="true"]').dataset.transport==='openai';`,
    ),
    true,
  );
  await evaluate(`d.getElementById('confucius-cfg-save').click();return true;`);
  await wait(
    `return d.querySelector('.confucius-settings-feedback')?.dataset.state==='saved';`,
  );
  await evaluate(
    `await host.openaiAdapter().complete({messages:[{role:'user',content:'Synthetic verification'}]});return true;`,
  );
  assert.equal(requests.at(-1).reasoning_effort, "ultra");
  check(
    "Styled reasoning-format radios support keyboard selection and preserve custom request parameters",
  );

  await instance.rpc("config/set", { uiTheme: "dark", uiLanguage: "en-US" });
  await appendFile(
    join(instance.profile, "user.js"),
    '\nuser_pref("extensions.zotero.confucius.uiLanguage", "en-US");\n',
  );
  await instance.stop({ graceful: true });
  await instance.launch();
  assert.equal((await instance.rpc("config/get")).reasoningEffort, "ultra");
  await open();
  await evaluate(`win.resizeTo(540,800);return true;`);
  await wait(`return win.innerWidth<620;`);
  await filter("deepseek");
  const narrow = await geometry();
  assert(
    narrow.inside && narrow.panelScrollWidth <= narrow.panelWidth + 1,
    JSON.stringify(narrow),
  );
  assert.equal(
    await evaluate(`return q.placeholder.startsWith('Type a model');`),
    true,
  );
  await screen("en-dark-expanded-narrow");
  check(
    "English dark narrow windows contain the expanded list without horizontal overflow; saved custom settings survive restart",
  );
  result.ok = true;
} catch (error) {
  result.error = String(error);
  await screen("failure").catch(() => {});
  throw error;
} finally {
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  await instance.stop({ graceful: true });
  await new Promise((resolve) => server.close(resolve));
}
