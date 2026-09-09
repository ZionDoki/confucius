/** Hot-update regression using isolated Zotero profiles and a local XPI server. */
import assert from "node:assert/strict";
import {
  access,
  readFile,
  writeFile,
  appendFile,
  mkdir,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
const root = resolve(import.meta.dirname, "..");
const oldXpi = resolve(
  process.argv[2] ?? "output/release-0.4.4/old-stable/confucius.xpi",
);
const newXpi = resolve(
  process.argv[3] ?? "apps/zotero-addon/.scaffold/build/confucius.xpi",
);
const output = resolve(
  process.env.CONFUCIUS_UPDATE_OUTPUT ?? "output/update-window",
);
await mkdir(output, { recursive: true });
const bytes = await readFile(newXpi);
await access(oldXpi);
const manifest = JSON.parse(
  execFileSync("unzip", ["-p", newXpi, "manifest.json"], { encoding: "utf8" }),
);
const version = manifest.version;
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.end(bytes);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const release = {
  version,
  downloadURL: `http://127.0.0.1:${server.address().port}/confucius.xpi`,
  size: bytes.length,
  digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
};
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi: oldXpi,
  prefix: "update-window-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout","window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost",false);\n',
);
const result = { checks: [], candidateSha256: release.digest, version };
const evaluate = (code) =>
  instance.rdp.evaluate(
    `const w=Zotero.__updateWindow;const d=w&&!w.closed?w.document:undefined;const h=Zotero.Confucius?.hooks.host;${code}`,
  );
const waitFor = (code) => until(() => evaluate(code), 20000, 100);
const check = (name) => {
  result.checks.push(name);
  console.log("PASS " + name);
};
const findWorkspace = (layout = "window") =>
  waitFor(
    `Zotero.__updateWindow=${layout === "sidebar" ? "Zotero.getMainWindow()" : "[...Services.wm.getEnumerator(null)].find(win=>win.location.href==='chrome://confucius/content/workspace.xhtml')"};const next=Zotero.__updateWindow?.document;return !!next?.getElementById('confucius-settings')&&!!next.querySelector('[data-entry-id^="overview:"]')&&next.getElementById('confucius-root')!==Zotero.__oldRoot;`,
  );
const open = async () => {
  await evaluate(
    `Zotero.getMainWindow().document.getElementById('confucius-toolbar-button').dispatchEvent(new (Zotero.getMainWindow().Event)('command'));return true;`,
  );
  await findWorkspace();
};
const settings = async () => {
  await evaluate(`d.getElementById('confucius-settings').click();return true;`);
  await waitFor(`return !!d.getElementById('confucius-cfg-tab-update');`);
  await evaluate(
    `d.getElementById('confucius-cfg-tab-update').click();return true;`,
  );
};
const install = async (viaUI = true) => {
  await evaluate(
    `h.updates.pendingRelease=${JSON.stringify(release)};h.updates.last={state:'available',canInstall:true,availableVersion:${JSON.stringify(version)}};const original=h.rpc.bind(h);h.rpc=async(method,params)=>{const value=await original(method,params);if(method==='update/install')Zotero.__updateReceipt=value;return value;};return true;`,
  );
  // The UI's check performs release discovery; replace that input with the local candidate.
  await evaluate(
    `h.updates.options.loadReleases=async()=>[];h.updates.check=async()=>h.updates.status();h.updates.pendingRelease=${JSON.stringify(release)};h.updates.last={state:'available',canInstall:true,availableVersion:${JSON.stringify(version)}};${viaUI ? "d.getElementById('confucius-cfg-check-update').click();" : ""}return true;`,
  );
  if (viaUI)
    await waitFor(
      `return !d.getElementById('confucius-cfg-install-update').disabled;`,
    );
  await evaluate(
    `Zotero.__oldHost=h;Zotero.__oldWindow=w;Zotero.__oldRoot=d?.getElementById('confucius-root');Zotero.__updateReceipt=null;${viaUI ? "d.getElementById('confucius-cfg-install-update').click();" : "void h.rpc('update/install').catch(error=>Zotero.__updateReceipt={error:String(error)});"}return true;`,
  );
  await waitFor(
    `return Zotero.Confucius?.data.initialized&&h!==Zotero.__oldHost&&h.health().version===${JSON.stringify(version)};`,
  );
  await waitFor(`return !!Zotero.__updateReceipt;`);
  return evaluate(`return Zotero.__updateReceipt;`);
};
const verifyRestored = async (taskId, draft, layout = "window") => {
  // Deliberately do not click the toolbar or Settings after installation.
  await findWorkspace(layout);
  await waitFor(
    `return d.getElementById('confucius-cfg-tab-update')?.getAttribute('aria-selected')==='true'&&d.getElementById('confucius-settings-overlay').textContent.includes('当前版本 ${version}');`,
  );
  await waitFor(
    `return d.getElementById('confucius-settings-overlay').textContent.includes('更新已生效，无需重启 Zotero');`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('[data-entry-id^="overview:"]').dataset.entryId;`,
    ),
    `overview:${taskId}`,
  );
  assert.equal(
    await evaluate(`return d.getElementById('confucius-prompt').value;`),
    draft,
  );
  assert.equal(
    await evaluate(`return Services.appinfo.processID;`),
    result.environment.pid,
  );
  assert.equal(
    await evaluate(
      `return d.getElementById('confucius-root').getAttribute('data-confucius-layout');`,
    ),
    layout,
  );
  if (layout === "window") {
    assert.equal(
      await evaluate(
        `return Zotero.__oldWindow.closed&&Zotero.Confucius.data.workspaceWindow===w;`,
      ),
      true,
    );
    assert.equal(
      await evaluate(
        `return [...Services.wm.getEnumerator(null)].filter(win=>win.location.href==='chrome://confucius/content/workspace.xhtml').length;`,
      ),
      1,
    );
  } else {
    assert.equal(
      await evaluate(
        `return !Zotero.__oldRoot.isConnected&&d.querySelectorAll('#confucius-sidebar').length===1;`,
      ),
      true,
    );
  }
};
try {
  result.environment = await instance.launch();
  const task = await instance.rpc("task/new", {
    title: "Update window fixture",
    titleState: "fixed",
    backend: "native",
    context: { version: 1, capturedAt: Date.now(), items: [] },
  });
  await instance.rpc("task/draft", {
    taskId: task.id,
    text: "升级前的中文草稿 😀",
  });
  await instance.rpc("task/new", {
    title: "A newer task must not steal selection",
    titleState: "fixed",
    backend: "native",
    context: { version: 1, capturedAt: Date.now(), items: [] },
  });
  await open();
  await evaluate(
    `d.getElementById('confucius-tasks-time')?.click();return true;`,
  );
  await waitFor(
    `return !!d.querySelector('[data-task-id="${task.id}"] button');`,
  );
  await evaluate(
    `d.querySelector('[data-task-id="${task.id}"] button').click();return true;`,
  );
  await waitFor(
    `return d.querySelector('[data-entry-id^="overview:"]')?.dataset.entryId==='overview:${task.id}'&&d.getElementById('confucius-prompt').value==='升级前的中文草稿 😀';`,
  );
  await evaluate(
    `d.getElementById('confucius-prompt').value='最后输入，尚未保存的草稿 😀';d.getElementById('confucius-toggle-sessions').click();return true;`,
  );
  await settings();
  result.first = await install();
  await verifyRestored(task.id, "最后输入，尚未保存的草稿 😀");
  check(
    "an old untracked settings window is automatically replaced with the current task, latest Chinese draft and Update tab in the same Zotero process",
  );
  assert.equal(
    await evaluate(
      `return d.getElementById('confucius-toggle-sessions').getAttribute('aria-expanded');`,
    ),
    "false",
  );
  check(
    "the collapsed conversation list remains collapsed after automatic reopening",
  );
  // Reinstall only in this isolated profile to exercise the fixed updater itself.
  await evaluate(
    `d.getElementById('confucius-prompt').value='第二次热更新的即时草稿 ✨';return true;`,
  );
  result.second = await install();
  assert.equal(result.second.restartRequired, false);
  assert.equal(result.second.currentVersion, version);
  await verifyRestored(task.id, "第二次热更新的即时草稿 ✨");
  check(
    "the fixed updater automatically restores its tracked window and reports the actual new version with restartRequired=false",
  );
  await evaluate(`h.updates.check=async()=>h.updates.status();return true;`);
  for (const required of [false, true]) {
    await evaluate(
      `h.updates.last={state:'ready',canInstall:false,availableVersion:${JSON.stringify(version)},restartRequired:${required}};d.getElementById('confucius-cfg-check-update').click();return true;`,
    );
    const text = required
      ? "更新已暂存，需要重启 Zotero 后生效"
      : "更新已生效，无需重启 Zotero";
    await waitFor(
      `return d.querySelector('#confucius-settings-overlay').textContent.includes(${JSON.stringify(text)});`,
    );
  }
  check(
    "settings render distinct applied and restart-staged messages from the reported installation state",
  );
  await evaluate(
    `d.getElementById('confucius-cfg-close').click();d.getElementById('confucius-layout').click();return true;`,
  );
  await findWorkspace("sidebar");
  await waitFor(
    `return d.querySelector('[data-entry-id^="overview:"]')?.dataset.entryId==='overview:${task.id}';`,
  );
  await evaluate(
    `d.getElementById('confucius-prompt').value='侧栏中的即时草稿 📚';return true;`,
  );
  await settings();
  result.sidebar = await install();
  assert.equal(result.sidebar.restartRequired, false);
  await verifyRestored(task.id, "侧栏中的即时草稿 📚", "sidebar");
  check(
    "sidebar installation automatically remounts exactly one sidebar with the selected task, immediate draft and Update tab",
  );

  await evaluate(
    `d.getElementById('confucius-cfg-close').click();d.getElementById('confucius-toolbar-button').dispatchEvent(new w.Event('command'));return true;`,
  );
  await waitFor(`return !d.getElementById('confucius-root');`);
  result.closed = await install(false);
  assert.equal(result.closed.restartRequired, false);
  assert.equal(
    await evaluate(
      `return !Zotero.getMainWindow().document.getElementById('confucius-root')&&![...Services.wm.getEnumerator(null)].some(win=>win.location.href==='chrome://confucius/content/workspace.xhtml');`,
    ),
    true,
  );
  assert.equal(
    await evaluate(`return Zotero.confuciusWorkspaceReload;`),
    undefined,
  );
  check(
    "a workspace closed before installation stays closed, with no stale reload handoff",
  );

  await evaluate(
    `const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');const plugin=await AddonManager.getAddonByID('confucius@zotero.plugin');await plugin.disable();await plugin.enable();return true;`,
  );
  await waitFor(`return Zotero.Confucius?.data.initialized;`);
  assert.equal(
    await evaluate(
      `return !Zotero.getMainWindow().document.getElementById('confucius-root')&&![...Services.wm.getEnumerator(null)].some(win=>win.location.href==='chrome://confucius/content/workspace.xhtml');`,
    ),
    true,
  );
  check(
    "ordinary disable and enable do not reopen a workspace from an earlier update",
  );
  result.pass = true;
} catch (error) {
  result.pass = false;
  result.error = String(error);
  result.stack = error.stack;
  result.debug = await evaluate(
    `return {version:h?.health().version,update:await h?.updates.status(),closed:w?.closed,oldClosed:Zotero.__oldWindow?.closed,receipt:Zotero.__updateReceipt,tracked:Zotero.Confucius?.data.workspaceWindow===w,windows:[...Services.wm.getEnumerator(null)].map(win=>({url:win.location.href,root:!!win.document.getElementById('confucius-root')})),body:w&&!w.closed?d.body.textContent.slice(-1800):null};`,
  ).catch(String);
  throw error;
} finally {
  await writeFile(join(output, "qa.json"), JSON.stringify(result, null, 2));
  await instance.stop({ graceful: true });
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
