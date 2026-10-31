/** Caret, selection and scroll regression against an ordinary XPI in real Gecko. */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_SELECTION_OUTPUT ?? "output/composer-selection",
);
await mkdir(output, { recursive: true });
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi:
    process.env.CONFUCIUS_SELECTION_XPI ??
    join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "composer-selection-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\n',
);
const report = { checks: [], snapshots: [] };
const evaluate = (code) =>
  instance.rdp.evaluate(
    `if(PathUtils.profileDir!==${JSON.stringify(instance.profile)})throw new Error('Wrong isolated profile');const host=Zotero.Confucius.hooks.host;const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml'),d=win?.document,p=d?.getElementById('confucius-prompt');${code}`,
    30000,
  );
const wait = (code) => until(() => evaluate(code), 30000, 100);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const snapshot = () =>
  evaluate(
    `const s=d.getSelection();return {text:p.value,start:p.selectionStart,end:p.selectionEnd,anchorOffset:s.anchorOffset,focusOffset:s.focusOffset,anchorText:s.anchorNode?.textContent,focusText:s.focusNode?.textContent,scroll:p.scrollTop,focused:d.activeElement===p};`,
  );
const check = (label) => {
  report.checks.push(label);
  console.log("PASS", label);
};
const remainsStable = async (label) => {
  await evaluate(
    `win.__selectionMutations=[];win.__selectionObserver=new win.MutationObserver(records=>win.__selectionMutations.push(...records.map(r=>r.type)));win.__selectionObserver.observe(p,{childList:true,characterData:true,subtree:true});return true;`,
  );
  const before = await snapshot();
  await pause(2400);
  const after = await snapshot();
  const mutations = await evaluate(
    `win.__selectionObserver.disconnect();return win.__selectionMutations;`,
  );
  report.snapshots.push({ label, before, after, mutations });
  assert.deepEqual(
    after,
    before,
    label + " changed the caret, selection, draft or scroll",
  );
  assert.deepEqual(mutations, [], label + " rewrote unchanged editor contents");
  check(label);
};
try {
  report.environment = await instance.launch();
  await evaluate(
    `const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;`,
  );
  await wait("return !!p;");
  await pause(1500);
  const text = "First line\n第二行 keep the caret here\nThird line";
  await evaluate(
    `p.focus();p.setSelectionRange(0,0);d.execCommand('insertText',false,${JSON.stringify(text)});p.setSelectionRange(22,22);return true;`,
  );
  assert.equal((await snapshot()).text, text);
  assert.equal((await snapshot()).start, 22);
  await remainsStable(
    "Empty workspace polling preserves an interior caret and draft",
  );
  await evaluate("d.execCommand('insertText',false,'插入');return true;");
  assert.equal(
    (await snapshot()).text,
    text.slice(0, 22) + "插入" + text.slice(22),
  );
  check("Typing after idle polling inserts at the retained caret");

  await evaluate(
    `p.setSelectionRange(11,25);const s=d.getSelection(),r=s.getRangeAt(0);s.setBaseAndExtent(r.endContainer,r.endOffset,r.startContainer,r.startOffset);return true;`,
  );
  await remainsStable("Polling preserves a backward text selection");
  const longText = Array.from(
    { length: 35 },
    (_, i) => `Line ${i + 1} — 中文输入与多行草稿`,
  ).join("\n");
  await evaluate(
    `p.value=${JSON.stringify(longText)};p.dispatchEvent(new win.Event('input',{bubbles:true}));p.setSelectionRange(p.value.length-10,p.value.length-10);p.scrollTop=p.scrollHeight;return true;`,
  );
  assert.ok((await snapshot()).scroll > 0, "Fixture must scroll the composer");
  await remainsStable(
    "Polling preserves long-draft scroll and a caret near the end",
  );

  await evaluate(
    `p.dispatchEvent(new win.CompositionEvent('compositionstart',{bubbles:true}));d.execCommand('insertText',false,'正在组合');return true;`,
  );
  await remainsStable("Polling leaves an active IME composition untouched");
  await evaluate(
    `p.dispatchEvent(new win.CompositionEvent('compositionend',{bubbles:true}));return true;`,
  );
  await remainsStable(
    "Composition completion keeps the resulting insertion point",
  );

  const fixture = await evaluate(
    `const item=new Zotero.Item('journalArticle');item.setField('title','Caret fixture paper');await item.saveTx();const task=await host.rpc('task/new',{title:'Caret fixture conversation',backend:'native',autoStart:false,context:{version:1,capturedAt:Date.now(),items:[{id:'item:1:'+item.key,libraryID:1,key:item.key,title:'Caret fixture paper',source:'library'}]}});await host.rpc('task/draft',{taskId:task.id,text:'Before @[Caret fixture paper] after the reference',mentions:[{id:'item:1:'+item.key,label:'Caret fixture paper',start:7,end:29}]});return {id:task.id,key:item.key};`,
  );
  await wait(
    `return d.querySelector('[data-entry-id="overview:${fixture.id}"]')&&p.querySelector('[data-composer-source="item:1:${fixture.key}"]');`,
  );
  await evaluate(
    "p.focus();p.setSelectionRange(p.value.length-5,p.value.length-5);return true;",
  );
  await remainsStable(
    "Saved task reference refresh preserves prose caret and native nodes",
  );
  await evaluate(
    `p.setSelectionRange(3,p.value.length-3);const s=d.getSelection(),r=s.getRangeAt(0);s.setBaseAndExtent(r.endContainer,r.endOffset,r.startContainer,r.startOffset);return true;`,
  );
  await remainsStable(
    "Polling preserves a backward selection across a reference",
  );
  await evaluate(
    `const button=d.getElementById('confucius-new-session');button.focus();return true;`,
  );
  await remainsStable(
    "Background source refresh does not steal focus from another control",
  );

  const previousTask = await instance.rpc("task/load", { taskId: fixture.id });
  await evaluate(
    "d.getElementById('confucius-new-session').click();return true;",
  );
  await wait(
    `return !!d.querySelector('[data-entry-id^="overview:"]')&&!d.querySelector('[data-entry-id="overview:${fixture.id}"]')&&p.value==='';`,
  );
  assert.equal(
    (await instance.rpc("task/load", { taskId: fixture.id })).draft.text,
    previousTask.draft.text,
  );
  check(
    "Explicit task switching still restores the new draft and preserves the old one",
  );
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
  await instance.stop({ graceful: true });
}
