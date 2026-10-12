/** Native sidebar typography/layout acceptance with an isolated synthetic library. */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_SIDEBAR_TYPE_OUTPUT ??
    join(root, "output/sidebar-typography"),
);
await mkdir(output, { recursive: true });
const survey = process.argv.includes("--survey-only");
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi:
    process.env.CONFUCIUS_SIDEBAR_TYPE_XPI ??
    join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "sidebar-typography-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\nuser_pref("extensions.zotero.confucius.workspaceWidth", 1200);\n',
);
const report = { samples: [], checks: [], survey };
const check = (name) => {
  report.checks.push(name);
  console.log("PASS", name);
};
const evaluate = (code) =>
  instance.rdp.evaluate(
    `
  const host=Zotero.Confucius.hooks.host;let qa=Zotero.__sidebarTypography;
  const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml')??Zotero.getMainWindow(),d=win?.document,root=d?.querySelector('.confucius-workspace-root');
  ${code}`,
    30000,
  );
const wait = (code) => until(() => evaluate(code), 30000, 100);
const open = async () => {
  await evaluate(
    "const main=Zotero.getMainWindow();main.document.getElementById('confucius-toolbar-button').dispatchEvent(new main.Event('command'));return true;",
  );
  await wait("return !!d?.querySelector('.confucius-task-row');");
};
const showSidebar = async () => {
  if (!survey)
    await wait(
      `const width=Math.round(root.getBoundingClientRect().width),size=parseFloat(win.getComputedStyle(root).fontSize),preferred=Math.min(384,Math.max(248,Math.round(248+(size-14)*10))),overlay=width<preferred+512,pane=d.getElementById('confucius-session-pane');return width>0&&root.getAttribute('data-confucius-density')===(width<300?'narrow':width<620?'compact':'wide')&&pane.style.position===(overlay?'absolute':'static')&&parseFloat(pane.style.width)===(overlay?Math.min(Math.max(320,preferred),width):preferred);`,
    );
  await evaluate(
    "const button=d.getElementById('confucius-toggle-sessions');if(button.getAttribute('aria-expanded')!=='true')button.click();return true;",
  );
  await wait(
    "return !!d.getElementById('confucius-session-pane').getClientRects().length;",
  );
};
const capture = async (name) => {
  const png = await evaluate(
    "const c=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=win.innerWidth;c.height=win.innerHeight;c.getContext('2d').drawWindow(win,0,0,c.width,c.height,win.getComputedStyle(d.body??d.documentElement).backgroundColor);return c.toDataURL('image/png');",
  );
  await writeFile(
    join(output, name + ".png"),
    Buffer.from(png.split(",")[1], "base64"),
  );
};
const geometry = () =>
  evaluate(`
  const pane=d.getElementById('confucius-session-pane'),p=pane.getBoundingClientRect(),search=d.querySelector('.confucius-task-search'),s=win.getComputedStyle(search),navigation=d.querySelector('.confucius-task-navigation'),n=navigation.getBoundingClientRect();
  const sample=node=>{const r=node.getBoundingClientRect(),style=win.getComputedStyle(node),title=node.querySelector('span');return {height:r.height,line:parseFloat(style.lineHeight),padding:parseFloat(style.paddingTop)+parseFloat(style.paddingBottom),titleHeight:title?.getBoundingClientRect().height,clamp:title?win.getComputedStyle(title).getPropertyValue('-webkit-line-clamp'):null};};
  return {width:win.innerWidth,font:parseFloat(win.getComputedStyle(root).fontSize),paneWidth:p.width,position:win.getComputedStyle(pane).position,paneOverflow:pane.scrollWidth>pane.clientWidth+1,windowOverflow:d.documentElement.scrollWidth>win.innerWidth+1,search:{height:search.getBoundingClientRect().height,line:parseFloat(s.lineHeight),padding:parseFloat(s.paddingTop)+parseFloat(s.paddingBottom)},tabs:[...d.querySelectorAll('.confucius-task-organization [role=tab]')].map(node=>({height:node.getBoundingClientRect().height,clipped:node.scrollHeight>node.clientHeight+1,label:node.textContent})),rows:[...pane.querySelectorAll('.confucius-task-open')].filter(node=>node.getClientRects().length).slice(0,4).map(sample),articles:[...pane.querySelectorAll('.confucius-article-toggle')].map(sample),icons:[...pane.querySelectorAll('.confucius-task-menu-trigger,.confucius-article-new')].filter(node=>node.getClientRects().length).slice(0,8).map(node=>{const r=node.getBoundingClientRect(),svg=node.querySelector('svg'),i=svg?.getBoundingClientRect();return {button:[r.width,r.height],icon:i?[i.width,i.height]:null,centered:i?Math.abs(r.x+r.width/2-i.x-i.width/2)<1&&Math.abs(r.y+r.height/2-i.y-i.height/2)<1:false};}),navigationHeight:n.height,scrollPadding:parseFloat(win.getComputedStyle(pane).scrollPaddingTop)};
`);
const assertGeometry = (sample, context) => {
  const detail = context + " " + JSON.stringify(sample);
  assert.equal(sample.paneOverflow, false, detail);
  assert.equal(sample.windowOverflow, false, detail);
  assert.ok(sample.paneWidth <= sample.width + 1, detail);
  assert.ok(
    sample.search.height >= sample.search.line + sample.search.padding - 1,
    detail,
  );
  assert.ok(
    sample.tabs.every((tab) => !tab.clipped && tab.height >= 34),
    detail,
  );
  assert.ok(sample.rows.length > 0, detail);
  assert.ok(
    sample.rows.every(
      (row) =>
        row.height >= row.line + row.padding - 1 &&
        row.height >= row.titleHeight + row.padding - 1,
    ),
    detail,
  );
  assert.ok(
    sample.articles.every((row) => row.height >= row.line + row.padding - 1),
    detail,
  );
  assert.ok(
    sample.icons.every(
      (icon) =>
        icon.button.every((value) => value === 34) &&
        icon.icon?.every((value) => value === 20) &&
        icon.centered,
    ),
    detail,
  );
  assert.ok(sample.scrollPadding >= sample.navigationHeight + 7, detail);
  if (sample.font >= 20)
    assert.ok(
      sample.rows.every(
        (row) => row.clamp === "2" && row.titleHeight <= row.line * 2 + 1,
      ),
      detail,
    );
};
try {
  report.environment = await instance.launch();
  await evaluate(
    `Zotero.__sidebarTypography={errors:[]};const article=new Zotero.Item('journalArticle');article.setField('title','长篇论文标题：大字体下的阅读、证据与持续对话 · A long research article title');await article.saveTx();const context={version:1,capturedAt:Date.now(),items:[{id:'item:1:'+article.key,libraryID:article.libraryID,key:article.key,title:article.getDisplayTitle(),source:'library'}]};qa=Zotero.__sidebarTypography;qa.tasks=[];for(let i=0;i<24;i++)qa.tasks.push((await host.rpc('task/new',{title:String(i).padStart(2,'0')+' · 对话标题的文字应清楚显示，同时保留操作空间 · A long conversation title without crowding controls',titleState:'fixed',backend:'native',context})).id);qa.first=qa.tasks.at(-1);return true;`,
  );
  for (const language of ["zh-CN", "en-US"]) {
    await instance.rpc("config/set", { uiLanguage: language, uiFontSize: 14 });
    await open();
    await evaluate(
      "win.addEventListener('error',event=>qa.errors.push(event.message));win.addEventListener('unhandledrejection',event=>qa.errors.push(String(event.reason)));return true;",
    );
    for (const theme of ["light", "dark"]) {
      for (const size of survey ? [14, 28] : [12, 17.5, 24, 28]) {
        await evaluate("win.resizeTo(1200,900);return true;");
        await wait("return win.innerWidth>=1190;");
        await showSidebar();
        await instance.rpc("config/set", {
          uiTheme: theme,
          uiFont: theme === "light" ? "sans" : "serif",
          uiFontSize: size,
        });
        await wait(
          `return parseFloat(win.getComputedStyle(root).fontSize)===${size};`,
        );
        if (!survey)
          await wait(
            `return Math.abs(d.getElementById('confucius-session-pane').getBoundingClientRect().width-${Math.min(384, Math.max(248, Math.round(248 + (size - 14) * 10)))})<1;`,
          );
        for (const width of survey ? [1200, 280] : [1200, 800, 280]) {
          await evaluate(`win.resizeTo(${width},900);return true;`);
          await wait(`return Math.abs(win.innerWidth-${width})<6;`);
          await showSidebar();
          for (const mode of ["time", "articles"]) {
            await evaluate(
              `d.getElementById('confucius-tasks-${mode}').click();if(${JSON.stringify(mode)}==='articles')for(const button of d.querySelectorAll('.confucius-article-toggle'))if(button.getAttribute('aria-expanded')==='false')button.click();d.getElementById('confucius-session-pane').scrollTop=0;return true;`,
            );
            const sample = await geometry();
            report.samples.push({ language, theme, size, mode, ...sample });
            if (!survey)
              assertGeometry(
                sample,
                [language, theme, size, width, mode].join("/"),
              );
            if (
              size === 28 &&
              [1200, 280].includes(width) &&
              mode === "articles"
            )
              await capture(`${language}-${theme}-${width}-${size}px`);
          }
        }
      }
    }
    await evaluate("win.close();return true;");
    await wait("return !root;");
  }
  if (!survey) {
    check(
      "96 layout cases: both languages/themes, fractional and size-limit typography, both organizations and three window widths",
    );
    await open();
    await evaluate("win.resizeTo(800,900);return true;");
    await instance.rpc("config/set", { uiFontSize: 14 });
    await wait(
      "return parseFloat(win.getComputedStyle(root).fontSize)===14&&win.getComputedStyle(d.getElementById('confucius-session-pane')).position==='static';",
    );
    await showSidebar();
    await instance.rpc("config/set", { uiFontSize: 28 });
    await wait(
      "return win.getComputedStyle(d.getElementById('confucius-session-pane')).position==='absolute';",
    );
    assert.equal(
      await evaluate(
        "return d.getElementById('confucius-toggle-sessions').getAttribute('aria-expanded');",
      ),
      "true",
    );
    await instance.rpc("config/set", { uiFontSize: 14 });
    await wait(
      "return win.getComputedStyle(d.getElementById('confucius-session-pane')).position==='static';",
    );
    check(
      "Font changes update dock/drawer layout without resizing and retain the open sidebar",
    );
    await instance.rpc("config/set", { uiFontSize: 28 });
    await wait("return parseFloat(win.getComputedStyle(root).fontSize)===28;");
    await showSidebar();
    await evaluate(
      "d.getElementById('confucius-tasks-time').click();const search=d.querySelector('.confucius-task-search');search.focus();search.dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));d.activeElement.dispatchEvent(new win.KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));return true;",
    );
    const focus = await evaluate(
      "const row=d.activeElement,n=d.querySelector('.confucius-task-navigation'),p=d.getElementById('confucius-session-pane');return {task:row.classList.contains('confucius-task-open'),visible:row.getBoundingClientRect().top>=n.getBoundingClientRect().bottom-1&&row.getBoundingClientRect().bottom<=p.getBoundingClientRect().bottom+1};",
    );
    assert.deepEqual(focus, { task: true, visible: true });
    await evaluate(
      "d.activeElement.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true;",
    );
    assert.equal(
      await evaluate(
        "return d.activeElement.classList.contains('confucius-task-search');",
      ),
      true,
    );
    check(
      "Large-font keyboard navigation keeps the focused conversation below the sticky navigation",
    );
    await evaluate(
      "Services.prefs.setIntPref('ui.useAccessibilityTheme',1);d.getElementById('confucius-session-pane').scrollTop=0;return true;",
    );
    await wait("return win.matchMedia('(prefers-contrast: more)').matches;");
    assertGeometry(await geometry(), "System high contrast");
    await capture("high-contrast-28px");
    check("High-contrast layout remains readable without clipping");
    await evaluate(
      "win.close();Zotero.Prefs.set('extensions.zotero.confucius.workspaceLayout','sidebar',true);return true;",
    );
    await wait("return !root;");
    await open();
    await wait(
      "return root?.dataset.confuciusLayout==='sidebar'&&parseFloat(win.getComputedStyle(root).fontSize)===28;",
    );
    await showSidebar();
    report.docked = await geometry();
    assertGeometry(report.docked, "Zotero library sidebar");
    await capture("docked-sidebar-28px");
    check(
      "The docked Zotero sidebar shares the same large-font layout and controls",
    );
    assert.deepEqual(await evaluate("return qa.errors;"), []);
  }
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.error = String(error);
  report.stack = error.stack;
  await capture("failure").catch(() => {});
  process.exitCode = 1;
  console.error(error);
} finally {
  await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
  await instance.stop({ graceful: true });
}
