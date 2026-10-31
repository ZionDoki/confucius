/** Isolated native input-listener lifecycle and idle polling regression. */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_INPUT_OUTPUT ?? join(root, "output/input-lifecycle"),
);
await mkdir(output, { recursive: true });
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi:
    process.env.CONFUCIUS_INPUT_XPI ??
    join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "input-lifecycle-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "sidebar");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\n',
);
const report = { stages: [] };
const evaluate = (code) =>
  instance.rdp.evaluate(
    `const main=Zotero.getMainWindow(),win=main.document.getElementById('confucius-sidebar-frame')?.contentWindow??main,d=win.document;${code}`,
    30000,
  );
const open = async () => {
  await evaluate(
    "await new Promise(done=>main.setTimeout(done,300));main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;",
  );
  await until(
    () => evaluate("return !!d.getElementById('confucius-prompt');"),
    30000,
  );
};
const menuListeners = () =>
  evaluate(
    "return Services.els.getListenerInfoFor(d).filter(info=>info.type==='mousedown'&&String(info.listenerObject).includes('confucius-context-details')).length;",
  );
const sample = async (label, enabled) => {
  const value = await evaluate(`
    d.dispatchEvent(new win.MouseEvent('pointerdown',{bubbles:true}));
    const records=[],observer=new win.MutationObserver(batch=>records.push(...batch));
    observer.observe(d.documentElement,{attributes:true,attributeFilter:['data-confucius-input']});
    const measure=async(type,key)=>{records.length=0;for(let i=0;i<50;i++)d.dispatchEvent(type==='keydown'?new win.KeyboardEvent(type,{key,bubbles:true}):new win.MouseEvent(type,{bubbles:true}));await new Promise(done=>win.setTimeout(done,20));return records.length;};
    const keyboard=await measure('keydown','Tab'),repeatedKeyboard=await measure('keydown','ArrowRight'),ignoredModifier=await measure('keydown','Control'),pointer=await measure('pointerdown'),repeatedPointer=await measure('pointerdown');observer.disconnect();
    return {keyboard,repeatedKeyboard,ignoredModifier,pointer,repeatedPointer,modality:d.documentElement.getAttribute('data-confucius-input')};
  `);
  assert.deepEqual(
    value,
    enabled
      ? {
          keyboard: 1,
          repeatedKeyboard: 0,
          ignoredModifier: 0,
          pointer: 1,
          repeatedPointer: 0,
          modality: "pointer",
        }
      : {
          keyboard: 0,
          repeatedKeyboard: 0,
          ignoredModifier: 0,
          pointer: 0,
          repeatedPointer: 0,
          modality: null,
        },
    label,
  );
  report.stages.push({ label, ...value });
  console.log("PASS", label, JSON.stringify(value));
};
try {
  report.environment = await instance.launch();
  await open();
  if (process.env.CONFUCIUS_INPUT_UPGRADE_XPI) {
    const task = await instance.rpc("task/new", {
      title: "Sidebar upgrade draft",
      backend: "native",
      context: { version: 1, capturedAt: Date.now(), items: [] },
    });
    await until(() =>
      evaluate(
        `return !!d.querySelector('[data-entry-id="overview:${task.id}"]');`,
      ),
    );
    await evaluate(
      "d.getElementById('confucius-settings').click();return true;",
    );
    await until(() =>
      evaluate("return !!d.getElementById('confucius-cfg-tab-update');"),
    );
    await evaluate(
      "d.getElementById('confucius-cfg-tab-update').click();return true;",
    );
    const draft = "Unsaved sidebar upgrade draft · 中文 😀";
    await evaluate(`
      const p=d.getElementById('confucius-prompt');p.value=${JSON.stringify(draft)};
      p.dispatchEvent(new win.Event('input',{bubbles:true}));
      const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      const install=await AddonManager.getInstallForFile(Zotero.File.pathToFile(${JSON.stringify(resolve(process.env.CONFUCIUS_INPUT_UPGRADE_XPI))}));
      await install.install();return true;
    `);
    report.upgrade = await until(() =>
      evaluate(`
        const frame=main.document.getElementById('confucius-sidebar-frame');
        if(!frame||!d.querySelector('[data-entry-id="overview:${task.id}"]')||d.getElementById('confucius-prompt')?.value!==${JSON.stringify(draft)}||d.getElementById('confucius-cfg-tab-update')?.getAttribute('aria-selected')!=='true')return false;
        const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        const addon=await AddonManager.getAddonByID('confucius@zotero.plugin');
        return {version:addon.version,draft:d.getElementById('confucius-prompt').value,layout:'sidebar',settings:'update',type:frame.getAttribute('type')};
      `),
    );
    assert.equal(report.upgrade.type, "content");
    assert.notEqual(report.upgrade.version, report.environment.version);
    assert.equal(
      (await instance.rpc("task/load", { taskId: task.id })).draft.text,
      draft,
    );
    console.log(
      "PASS Public-package hot upgrade preserves unsaved draft, task, sidebar and Update settings",
    );
  }
  await sample(
    "Initial binding: one write per actual input-modality transition",
    true,
  );
  report.idle = await evaluate(`
    const host=Zotero.Confucius.hooks.host,original=host.rpc.bind(host),calls={};
    host.rpc=(method,params)=>{calls[method]=(calls[method]??0)+1;return original(method,params);};
    const button=d.getElementById('confucius-endpoint'),mutations=[],observer=new win.MutationObserver(batch=>mutations.push(...batch));observer.observe(button,{subtree:true,childList:true,attributes:true});
    await new Promise(done=>win.setTimeout(done,3300));host.rpc=original;observer.disconnect();return {calls,endpointMutations:mutations.length};
  `);
  if (process.env.CONFUCIUS_EXPECT_IDLE_MEMORY === "1") {
    assert.ok(report.idle.calls["memory/list"] >= 3);
    assert.ok(report.idle.calls["logs/list"] >= 3);
  } else {
    assert.equal(report.idle.calls["memory/list"] ?? 0, 0);
    assert.equal(report.idle.calls["logs/list"] ?? 0, 0);
  }
  console.log("IDLE", JSON.stringify(report.idle));
  if (process.env.CONFUCIUS_EXPECT_IDLE_MEMORY !== "1")
    assert.ok(
      report.idle.endpointMutations <= 2,
      "Stable endpoint presentation must not rewrite the DOM on each poll",
    );
  report.workspaceMenus = [];
  for (let cycle = 1; cycle <= 3; cycle++) {
    assert.equal(await menuListeners(), 1);
    await evaluate(
      "await new Promise(done=>main.setTimeout(done,300));main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;",
    );
    await until(
      () =>
        evaluate(
          "const pane=main.document.getElementById('confucius-sidebar');return !pane||pane.hidden;",
        ),
      30000,
    );
    assert.equal(
      await menuListeners(),
      0,
      "Closed workspaces release document menu handlers",
    );
    await open();
    assert.equal(
      await menuListeners(),
      1,
      "Remounts retain one current document menu handler",
    );
    report.workspaceMenus.push({ cycle, closed: 0, reopened: 1 });
  }
  console.log(
    "PASS Workspace menu listeners are removed on close and do not accumulate on remount",
  );
  for (let cycle = 1; cycle <= 3; cycle++) {
    await evaluate(
      "const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');await (await AddonManager.getAddonByID('confucius@zotero.plugin')).disable();return true;",
    );
    await until(() => evaluate("return !Zotero.Confucius;"), 30000);
    await sample(
      "Disabled " + cycle + ": all document input listeners removed",
      false,
    );
    await evaluate(
      "const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');await (await AddonManager.getAddonByID('confucius@zotero.plugin')).enable();return true;",
    );
    await until(
      () => evaluate("return !!Zotero.Confucius?.data.initialized;"),
      30000,
    );
    await open();
    await sample(
      "Enabled " + cycle + ": one binding without accumulated callbacks",
      true,
    );
  }
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
  await instance.stop({ graceful: true });
}
