/** Settings regression in real Zotero, with an isolated empty library. */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_SETTINGS_OUTPUT ??
    join(root, "output/appearance-settings"),
);
await mkdir(output, { recursive: true });
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi:
    process.env.CONFUCIUS_SETTINGS_XPI ??
    join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "appearance-settings-",
});
await appendFile(
  join(instance.profile, "user.js"),
  '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");\nuser_pref("extensions.zotero.confucius.pluginRuntimeHost", false);\nuser_pref("extensions.zotero.confucius.uiFontSize", 14);\nuser_pref("extensions.zotero.confucius.uiLineHeight", "relaxed");\n',
);
const report = { checks: [] };
const check = (label) => {
  report.checks.push(label);
  console.log("PASS", label);
};
const evaluate = (code) =>
  instance.rdp.evaluate(
    `const host=Zotero.Confucius.hooks.host;const shell=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml');const win=shell?.document.getElementById('confucius-window-frame')?.contentWindow??shell;const d=win?.document;const root=d?.querySelector('.confucius-workspace-root');${code}`,
    30000,
  );
const wait = (code) => until(() => evaluate(code), 20000, 100);
// Hold only fixture RPCs; real host persistence still executes on release.
const holdRpc = (methods) =>
  evaluate(
    `const race={original:host.rpc.bind(host),calls:[],pending:[]};Zotero.__settingsRace=race;host.rpc=async(method,params)=>{if(${JSON.stringify(methods)}.includes(method)){race.calls.push({method,provider:params?.provider});await new Promise(resolve=>race.pending.push(resolve));}return race.original(method,params);};return true;`,
  );
const releaseRpc = () =>
  evaluate(
    `for(const release of Zotero.__settingsRace.pending.splice(0))release();return true;`,
  );
const restoreRpc = () =>
  evaluate(
    `host.rpc=Zotero.__settingsRace.original;delete Zotero.__settingsRace;return true;`,
  );
const open = async () => {
  await evaluate(
    `Zotero.getMainWindow().document.getElementById('confucius-toolbar-button').dispatchEvent(new (Zotero.getMainWindow().Event)('command'));return true;`,
  );
  await wait(`return !!d?.getElementById('confucius-settings');`);
  await appearance();
};
const appearance = async () => {
  await evaluate(
    `if(!d.getElementById('confucius-settings-overlay'))d.getElementById('confucius-settings').click();return true;`,
  );
  await wait(`return !!d?.getElementById('confucius-cfg-tab-appearance');`);
  await evaluate(
    `d.getElementById('confucius-cfg-tab-appearance').click();return true;`,
  );
  await wait(`return !!d?.getElementById('confucius-cfg-font-size');`);
};
const save = async () => {
  await evaluate(`d.getElementById('confucius-cfg-save').click();return true;`);
  await wait(`return !d.getElementById('confucius-cfg-save').disabled;`);
  const feedback = await evaluate(
    `const f=d.querySelector('.confucius-settings-feedback');return {state:f.dataset.state,text:f.textContent};`,
  );
  assert.equal(feedback.state, "saved", JSON.stringify(feedback));
};
const snapshot = () =>
  evaluate(
    `const s=win.getComputedStyle(root);return {theme:d.documentElement.getAttribute('data-confucius-theme'),font:s.fontFamily,size:s.fontSize,line:s.getPropertyValue('--confucius-reading-line-height').trim(),paper:s.getPropertyValue('--confucius-paper').trim(),accent:s.getPropertyValue('--confucius-accent').trim()};`,
  );
const capture = async (name, run = evaluate) => {
  const data = await run(
    `const c=d.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=win.innerWidth;c.height=win.innerHeight;c.getContext('2d').drawWindow(win,0,0,c.width,c.height,win.getComputedStyle(d.body??d.documentElement).backgroundColor);return c.toDataURL('image/png');`,
  );
  await writeFile(
    join(output, `${name}.png`),
    Buffer.from(data.split(",")[1], "base64"),
  );
};
const geometry = () =>
  evaluate(
    `const content=d.querySelector('.confucius-settings-content'),tabs=d.querySelector('.confucius-settings-tabs'),items=[...tabs.children].map(n=>n.getBoundingClientRect()),grid=d.querySelector('.confucius-appearance-grid');return {width:win.innerWidth,noOverflow:content.scrollWidth<=content.clientWidth+1&&d.documentElement.scrollWidth<=win.innerWidth+1,topTabs:items.every(r=>Math.abs(r.top-items[0].top)<1),columns:win.getComputedStyle(grid).gridTemplateColumns.split(' ').length,controls:[...content.querySelectorAll('input')].filter(n=>n.getClientRects().length).every(n=>n.getBoundingClientRect().right<=content.getBoundingClientRect().right+1)};`,
  );
const settingsStyles = (run, selectors) =>
  run(
    `const properties=['font-family','font-size','font-weight','line-height','min-height','margin','padding','border-radius','background-color','color'];return Object.fromEntries(${JSON.stringify(selectors)}.map(selector=>{const n=d.querySelector(selector);if(!n)throw new Error('Missing style sample '+selector);const style=win.getComputedStyle(n);return [selector,Object.fromEntries(properties.filter(key=>key!=='padding'||!selector.startsWith('.confucius-settings-tabs')).map(key=>[key,style.getPropertyValue(key)]))];}));`,
  );
// Top-tab padding follows workspace density; content controls share one geometry.
const compareSettingsStyles = async (prefRun, selectors) => {
  const workspace = await settingsStyles(evaluate, selectors);
  const preferences = await settingsStyles(prefRun, selectors);
  assert.deepEqual(preferences, workspace, "Shared settings styles");
};
const assertButtonInteraction = async (run, selector) => {
  // Gecko drops :focus on inactive chrome windows. A temporary pseudo class
  // lock exercises focus styling while this isolated test runs in the background.
  const states = await run(
    `const button=d.querySelector(${JSON.stringify(selector)});win.focus();await new Promise(done=>win.setTimeout(done,80));button.scrollIntoView({block:'nearest'});win.windowUtils.sendMouseEvent('mousemove',0,0,0,0,0);const read=()=>{const s=win.getComputedStyle(button);return {background:s.backgroundColor,color:s.color,opacity:s.opacity,cursor:s.cursor,outline:s.outlineStyle,outlineWidth:s.outlineWidth,modality:d.documentElement.getAttribute('data-confucius-input'),active:d.activeElement?.id,focused:button.matches(':focus'),documentFocused:d.hasFocus()};};const normal=read(),r=button.getBoundingClientRect();win.windowUtils.sendMouseEvent('mousemove',r.x+r.width/2,r.y+r.height/2,0,0,0);await new Promise(done=>win.setTimeout(done,80));const hover=read(),hovered=button.matches(':hover');button.disabled=true;const disabled=read();button.disabled=false;d.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));button.focus({preventScroll:true});const inspector=win.InspectorUtils;const locked=!button.matches(':focus');if(locked)inspector.addPseudoClassLock(button,':focus');const keyboard=read();d.dispatchEvent(new win.MouseEvent('pointerdown',{bubbles:true}));const pointer=read();if(locked)inspector.removePseudoClassLock(button,':focus');win.windowUtils.sendMouseEvent('mousemove',0,0,0,0,0);return {normal,hover,hovered,disabled,keyboard,pointer};`,
  );
  assert.equal(states.hovered, true, selector + JSON.stringify(states));
  assert.notEqual(states.hover.background, states.normal.background, selector);
  assert.equal(states.disabled.background, states.normal.background, selector);
  assert.equal(states.disabled.opacity, "0.48", selector);
  assert.equal(states.disabled.cursor, "default", selector);
  assert.equal(
    states.keyboard.outline,
    "solid",
    selector + JSON.stringify(states),
  );
  assert.equal(states.keyboard.outlineWidth, "2px", selector);
  assert.equal(states.pointer.outline, "none", selector);
};
const assertFocusedColorError = async (run) => {
  const state = await run(
    `const input=d.querySelector('.confucius-color-field [aria-invalid=true]'),inspector=win.InspectorUtils,locked=!input.matches(':focus');if(locked)inspector.addPseudoClassLock(input,':focus');try{return {focused:input.matches(':focus'),outline:win.getComputedStyle(input).outlineColor,error:win.getComputedStyle(d.querySelector('.confucius-settings-feedback')).color};}finally{if(locked)inspector.removePseudoClassLock(input,':focus');}`,
  );
  assert.equal(state.focused, true);
  assert.equal(state.outline, state.error);
};
const appearanceStyleSelectors = [
  "#confucius-cfg-font",
  "#confucius-cfg-font-size",
  "#confucius-cfg-font-size-range",
  "#confucius-cfg-line-height",
  ".confucius-color-field input[type=color]",
  "#confucius-cfg-color-paper",
  ".confucius-settings-field > label",
  ".confucius-appearance-settings > .confucius-settings-help",
  "#confucius-cfg-theme [data-value=auto]",
  "#confucius-cfg-theme [data-value=light]",
  "#confucius-cfg-colors-light",
  "#confucius-cfg-appearance-reset",
  ".confucius-settings-tabs [aria-selected=true]",
  ".confucius-settings-tabs [aria-selected=false]",
];
const editorGeometry = (run) =>
  run(
    `const scope=d.querySelector('.confucius-settings-shell')??d.getElementById('confucius-preferences'),content=scope.querySelector('.confucius-settings-content')??scope;const visible=n=>n.getClientRects().length&&!n.closest('[hidden]')&&![...scope.querySelectorAll('details:not([open])')].some(details=>details.contains(n)&&!details.querySelector(':scope > summary')?.contains(n));const bounds=content.getBoundingClientRect();const outside=[...content.querySelectorAll('input,button,summary,label')].filter(visible).filter(n=>{const r=n.getBoundingClientRect();return !n.closest('.confucius-settings-tabs')&&(r.left<bounds.left-1||r.right>bounds.right+1);}).map(n=>({id:n.id,type:n.localName,text:n.textContent?.slice(0,60),width:n.getBoundingClientRect().width}));return {width:win.innerWidth,contentWidth:content.clientWidth,contentHeight:content.clientHeight,overflow:content.scrollWidth>content.clientWidth+1,windowOverflow:d.documentElement.scrollWidth>win.innerWidth+1,outside};`,
  );
const assertEditorGeometry = async (run, label) => {
  const geometry = await editorGeometry(run);
  assert.equal(geometry.overflow, false, label + JSON.stringify(geometry));
  assert.equal(
    geometry.windowOverflow,
    false,
    label + JSON.stringify(geometry),
  );
  assert.deepEqual(geometry.outside, [], label + JSON.stringify(geometry));
  assert(geometry.contentHeight >= 48, label + JSON.stringify(geometry));
  return geometry;
};
const assertStickyPreferences = async (run) => {
  const result = await run(
    `const scroller=d.querySelector('[data-confucius-preferences-scroll]'),tabs=d.getElementById('confucius-pref-tabs'),footer=d.querySelector('#confucius-pref-appearance > footer'),before=scroller.scrollTop;scroller.scrollTop=scroller.scrollHeight;await new Promise(done=>win.setTimeout(done,80));const view=scroller.getBoundingClientRect(),t=tabs.getBoundingClientRect(),f=footer.getBoundingClientRect(),last=d.querySelector('.confucius-color-field:last-child input[type=text]').getBoundingClientRect();const result={scroll:scroller.scrollTop,visible:t.top>=view.top-1&&t.bottom<=view.bottom&&f.top>=t.bottom&&f.bottom<=view.bottom+1,lastInputAboveFooter:last.bottom<=f.top+1,view:[view.top,view.bottom],tabs:[t.top,t.bottom],footer:[f.top,f.bottom],lastInput:[last.top,last.bottom]};scroller.scrollTop=before;return result;`,
  );
  assert(result.scroll > 0, JSON.stringify(result));
  assert.equal(result.visible, true, JSON.stringify(result));
  assert.equal(result.lastInputAboveFooter, true, JSON.stringify(result));
};
const colorContrast = (background, foreground) => {
  const backdrop = background.match(/[\d.]+/g).map(Number);
  const front = foreground.match(/[\d.]+/g).map(Number);
  const alpha = front[3] ?? 1;
  const luminance = (color) =>
    color
      .slice(0, 3)
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      })
      .reduce(
        (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
        0,
      );
  const values = [
    luminance(backdrop),
    luminance(
      front
        .slice(0, 3)
        .map((value, index) => value * alpha + backdrop[index] * (1 - alpha)),
    ),
  ];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
};
const assertContrastPrimary = async (run, selector) => {
  const state = await run(
    `const button=d.querySelector(${JSON.stringify(selector)}),style=win.getComputedStyle(button),inspector=win.InspectorUtils,locked=!button.matches(':focus');d.documentElement.setAttribute('data-confucius-input','keyboard');if(locked)inspector.addPseudoClassLock(button,':focus');const focused=win.getComputedStyle(button);const result={background:style.backgroundColor,color:style.color,focus:focused.outlineColor,focusStyle:focused.outlineStyle,disabled:button.disabled};if(locked)inspector.removePseudoClassLock(button,':focus');return result;`,
  );
  assert.equal(state.disabled, false);
  state.textContrast = colorContrast(state.background, state.color);
  state.focusContrast = colorContrast(state.background, state.focus);
  assert(state.textContrast >= 4.5, JSON.stringify(state));
  assert.equal(state.focusStyle, "solid", JSON.stringify(state));
  assert(state.focusContrast >= 3, JSON.stringify(state));
  return state;
};
try {
  report.zotero = (await instance.launch()).zotero;
  await writeFile(
    join(output, "state.json"),
    JSON.stringify(instance.publicState(), null, 2),
  );
  const legacy = await instance.rpc("config/get");
  assert.equal(legacy.uiFontSize, 14);
  assert.equal(legacy.uiLineHeight, 1.75);
  check("Legacy integer font sizes and named line heights retain their values");
  await instance.rpc("config/set", {
    endpoint: {
      name: "Synthetic settings fixture",
      baseUrl: "https://example.invalid/v1",
      apiKey: "",
      model: "fixture",
    },
  });
  await open();
  assert.equal((await geometry()).topTabs, true);
  const annotationGlobal = await snapshot();
  assert.equal((await instance.rpc("config/get")).annotationFontSize, null);
  await evaluate(
    `d.querySelector('#confucius-cfg-annotation-mode [data-value=custom]').click();for(const [id,value] of [['font-size','20.5'],['line-height','2.05'],['paragraph-spacing','18']]){const n=d.getElementById('confucius-cfg-annotation-'+id);n.value=value;n.dispatchEvent(new win.Event('input',{bubbles:true}));}d.querySelector('#confucius-cfg-annotation-mode [data-value=global]').click();d.querySelector('#confucius-cfg-annotation-mode [data-value=custom]').click();return true;`,
  );
  assert.equal(
    await evaluate(
      `return d.getElementById('confucius-cfg-annotation-font-size').value;`,
    ),
    "20.5",
  );
  assert.equal((await instance.rpc("config/get")).annotationFontSize, null);
  await evaluate(
    `d.getElementById('confucius-cfg-cancel').click();return true;`,
  );
  await appearance();
  assert.equal(
    await evaluate(
      `return d.querySelector('#confucius-cfg-annotation-mode [data-value=global]').getAttribute('aria-checked');`,
    ),
    "true",
  );
  await evaluate(
    `d.querySelector('#confucius-cfg-annotation-mode [data-value=custom]').click();for(const [id,value] of [['font-size','20.5'],['line-height','2.05'],['paragraph-spacing','18']]){const n=d.getElementById('confucius-cfg-annotation-'+id);n.value=value;n.dispatchEvent(new win.Event('input',{bubbles:true}));}return true;`,
  );
  await save();
  const annotationSaved = await instance.rpc("config/get");
  assert.equal(annotationSaved.annotationFontSize, 20.5);
  assert.equal(annotationSaved.annotationLineHeight, 2.05);
  assert.equal(annotationSaved.annotationParagraphSpacing, 18);
  assert.deepEqual(await snapshot(), annotationGlobal);
  await evaluate(
    `d.getElementById('confucius-cfg-annotation-font-size').scrollIntoView({block:'center'});return true;`,
  );
  await capture("annotation-typography-settings");
  check(
    "Annotation typography has separate saved controls; mode toggles retain drafts and Cancel discards them without affecting workspace typography",
  );
  await evaluate(
    `d.getElementById('confucius-cfg-annotation-font-size').value='20.2';d.getElementById('confucius-cfg-save').click();return true;`,
  );
  await wait(`return !d.getElementById('confucius-cfg-save').disabled;`);
  assert.equal((await instance.rpc("config/get")).annotationFontSize, 20.5);
  await evaluate(
    `d.querySelector('#confucius-cfg-annotation-mode [data-value=global]').click();return true;`,
  );
  await save();
  assert.equal((await instance.rpc("config/get")).annotationFontSize, null);
  assert.equal((await instance.rpc("config/get")).annotationLineHeight, null);
  assert.equal(
    (await instance.rpc("config/get")).annotationParagraphSpacing,
    null,
  );
  check(
    "Invalid annotation values cannot persist; following global settings explicitly clears all annotation overrides",
  );
  await evaluate(
    `d.getElementById('confucius-cfg-cancel').click();return true;`,
  );
  await appearance();
  const before = await snapshot();
  await evaluate(
    `const set=(id,value)=>{const n=d.getElementById(id);n.value=value;n.dispatchEvent(new win.Event('input',{bubbles:true}));};set('confucius-cfg-font-size','19.5');set('confucius-cfg-line-height','1.95');d.querySelector('#confucius-cfg-theme [data-value=dark]').click();set('confucius-cfg-color-accent','#123456');d.getElementById('confucius-cfg-colors-dark').click();set('confucius-cfg-color-paper','#23272f');return true;`,
  );
  assert.deepEqual(await snapshot(), before);
  await evaluate(
    `d.getElementById('confucius-cfg-cancel').click();return true;`,
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal((await instance.rpc("config/get")).uiFontSize, 14);
  check(
    "Typography and both palettes stay unchanged until Save; Cancel discards drafts",
  );
  await appearance();
  await evaluate(
    `const n=d.getElementById('confucius-cfg-font-size');n.value='17.5';n.dispatchEvent(new win.Event('input',{bubbles:true}));const l=d.getElementById('confucius-cfg-line-height');l.value='1.85';l.dispatchEvent(new win.Event('input',{bubbles:true}));d.getElementById('confucius-cfg-font').click();d.querySelector('#confucius-cfg-font-source [data-value=local]').click();return true;`,
  );
  await wait(
    `return d.getElementById('confucius-cfg-font-query').getAttribute('aria-busy')==='false'&&d.getElementById('confucius-cfg-font-results').children.length>0;`,
  );
  assert.deepEqual(
    await evaluate(
      `const q=d.getElementById('confucius-cfg-font-query'),rows=d.getElementById('confucius-cfg-font-results');q.dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));const up=q.getAttribute('aria-activedescendant')===rows.lastElementChild.id;q.dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));return {up,wrap:q.getAttribute('aria-activedescendant')===rows.firstElementChild.id};`,
    ),
    { up: true, wrap: true },
  );
  const family = await evaluate(
    `const first=d.getElementById('confucius-cfg-font-results').firstElementChild.textContent;const q=d.getElementById('confucius-cfg-font-query');q.value=first;q.dispatchEvent(new win.Event('input',{bubbles:true}));q.dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));q.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return first;`,
  );
  assert.equal(typeof family, "string");
  await evaluate(
    `d.querySelector('#confucius-cfg-theme [data-value=dark]').click();const a=d.getElementById('confucius-cfg-color-accent');a.value='#456789';a.dispatchEvent(new win.Event('input',{bubbles:true}));d.getElementById('confucius-cfg-colors-dark').click();for(const [id,value] of [['paper','#23272f'],['accent','#9bbfff']]){const n=d.getElementById('confucius-cfg-color-'+id);n.value=value;n.dispatchEvent(new win.Event('input',{bubbles:true}));}return true;`,
  );
  await save();
  await wait(
    `return win.getComputedStyle(root).fontSize==='17.5px'&&win.getComputedStyle(root).getPropertyValue('--confucius-paper').trim()==='#23272f';`,
  );
  const saved = await instance.rpc("config/get");
  assert.equal(saved.uiFont, "custom");
  assert.equal(saved.uiFontFamily, family);
  assert.equal(saved.uiFontSize, 17.5);
  assert.equal(saved.uiLineHeight, 1.85);
  assert.equal(saved.uiThemeColors.light.accent, "#456789");
  assert.equal(saved.uiThemeColors.dark.accent, "#9bbfff");
  assert((await snapshot()).font.includes(family));
  assert.equal((await snapshot()).line, "1.85");
  await capture("appearance-dark-saved");
  check(
    "Real installed fonts support search and keyboard selection; decimal typography and both palettes save and apply",
  );
  await evaluate(
    `d.querySelector('#confucius-cfg-theme [data-value=light]').click();return true;`,
  );
  assert.equal((await snapshot()).theme, "dark");
  await save();
  await wait(
    `return win.getComputedStyle(root).getPropertyValue('--confucius-accent').trim()==='#456789';`,
  );
  await capture("appearance-light-saved");
  check(
    "Theme selection applies on Save and uses the independently saved light palette",
  );
  const stable = await instance.rpc("config/get");
  await evaluate(
    `const n=d.getElementById('confucius-cfg-font-size');n.value='29';n.dispatchEvent(new win.Event('input',{bubbles:true}));d.getElementById('confucius-cfg-save').click();return true;`,
  );
  await wait(`return !d.getElementById('confucius-cfg-save').disabled;`);
  assert.equal(
    (await instance.rpc("config/get")).uiFontSize,
    stable.uiFontSize,
  );
  await evaluate(
    `d.getElementById('confucius-cfg-font-size').value='17.5';const a=d.getElementById('confucius-cfg-color-accent');a.value='#xyz';a.dispatchEvent(new win.Event('input',{bubbles:true}));d.getElementById('confucius-cfg-save').click();return true;`,
  );
  await wait(`return !d.getElementById('confucius-cfg-save').disabled;`);
  assert.deepEqual(
    (await instance.rpc("config/get")).uiThemeColors,
    stable.uiThemeColors,
  );
  await assertFocusedColorError(evaluate);
  await evaluate(
    `d.getElementById('confucius-cfg-cancel').click();return true;`,
  );
  check(
    "Invalid numeric or color edits cannot partially persist appearance settings",
  );
  await appearance();
  await evaluate(
    `d.getElementById('confucius-cfg-appearance-reset').click();return true;`,
  );
  assert.equal((await instance.rpc("config/get")).uiFont, "custom");
  await evaluate(
    `d.getElementById('confucius-cfg-cancel').click();return true;`,
  );
  assert.equal((await instance.rpc("config/get")).uiFontSize, 17.5);
  check("Restore defaults is a draft and can be cancelled");
  await appearance();
  await holdRpc(["config/set"]);
  const pendingSave = await evaluate(
    `const input=d.getElementById('confucius-cfg-font-size');input.value='18.5';const button=d.getElementById('confucius-cfg-save');button.click();button.dispatchEvent(new win.MouseEvent('click',{bubbles:true}));d.getElementById('confucius-cfg-cancel').click();d.getElementById('confucius-cfg-close').click();const overlay=d.getElementById('confucius-settings-overlay');overlay.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));overlay.click();return {calls:Zotero.__settingsRace.calls.length,busy:overlay.getAttribute('aria-busy'),inert:d.querySelector('.confucius-settings-content').inert,cancel:d.getElementById('confucius-cfg-cancel').disabled,close:d.getElementById('confucius-cfg-close').disabled,connected:overlay.isConnected};`,
  );
  assert.deepEqual(pendingSave, {
    calls: 1,
    busy: "true",
    inert: true,
    cancel: true,
    close: true,
    connected: true,
  });
  await releaseRpc();
  await wait(
    `return d.querySelector('.confucius-settings-feedback').dataset.state==='saved'&&!d.querySelector('.confucius-settings-content').inert;`,
  );
  assert.equal((await instance.rpc("config/get")).uiFontSize, 18.5);
  await restoreRpc();
  await instance.rpc("config/set", { uiFontSize: 17.5 });
  await evaluate(
    `d.getElementById('confucius-cfg-cancel').click();return true;`,
  );
  check(
    "Delayed workspace saves freeze the submitted draft, reject duplicate saves and retain the dialog through Cancel/Escape/outside clicks",
  );
  await appearance();
  await instance.rpc("config/set", { uiFontSize: 28, uiLanguage: "en-US" });
  await evaluate(
    `d.querySelector('#confucius-cfg-annotation-mode [data-value=custom]').click();return true;`,
  );
  await wait(`return win.getComputedStyle(root).fontSize==='28px';`);
  await evaluate(`shell.resizeTo(420,760);return true;`);
  await wait(`return win.innerWidth<=420;`);
  assert.equal(
    (await geometry()).noOverflow,
    true,
    JSON.stringify(await geometry()),
  );
  assert.equal((await geometry()).columns, 1);
  await capture("appearance-large-narrow");
  await instance.rpc("config/set", { uiFontSize: 17.5, uiLanguage: "zh-CN" });
  await evaluate(`shell.resizeTo(1000,820);return true;`);
  await evaluate(
    `Services.prefs.setIntPref('ui.useAccessibilityTheme',1);return true;`,
  );
  await wait(`return win.matchMedia('(prefers-contrast: more)').matches;`);
  assert.notEqual((await snapshot()).accent, "#456789");
  await capture("appearance-high-contrast");
  await evaluate(
    `Services.prefs.setIntPref('ui.useAccessibilityTheme',0);return true;`,
  );
  check(
    "Large fonts stack the editor in narrow windows; native system contrast overrides custom colors",
  );
  await evaluate(
    `d.getElementById('confucius-cfg-tab-runtime').click();return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-runtime-settings').getAttribute('aria-busy')==='false';`,
  );
  assert.equal(
    await evaluate(
      `const card=d.querySelector('.confucius-runtime-card');return card.querySelector('[data-state=ready]')!==null;`,
    ),
    true,
  );
  await evaluate(
    `const p=d.getElementById('confucius-runtime-codex-path');p.closest('details').open=true;d.getElementById('confucius-runtime-codex-manual').click();p.value='/synthetic/path with spaces/codex';p.dispatchEvent(new win.Event('input',{bubbles:true}));d.getElementById('confucius-runtime-codex-save').click();return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-runtime-settings').getAttribute('aria-busy')==='false';`,
  );
  assert.equal(
    await evaluate(
      `return Zotero.Prefs.get('extensions.zotero.confucius.codexExecutable',true);`,
    ),
    "/synthetic/path with spaces/codex",
  );
  await evaluate(
    `d.getElementById('confucius-runtime-codex-auto').click();d.getElementById('confucius-runtime-codex-save').click();return true;`,
  );
  await wait(
    `return d.querySelector('.confucius-runtime-settings').getAttribute('aria-busy')==='false';`,
  );
  assert.equal(
    await evaluate(
      `return Zotero.Prefs.get('extensions.zotero.confucius.codexExecutable',true);`,
    ),
    "",
  );
  await capture("runtime-grouped");
  check(
    "Runtime groups native/Codex/Kimi status; manual and automatic path configuration persist independently",
  );
  const emptyPath = await evaluate(
    `const path=d.getElementById('confucius-runtime-codex-path');d.getElementById('confucius-runtime-codex-manual').click();d.getElementById('confucius-runtime-codex-save').click();return {focused:d.activeElement===path,enabled:!path.disabled,error:!!d.querySelector('.confucius-runtime-error').textContent};`,
  );
  assert.deepEqual(emptyPath, { focused: true, enabled: true, error: true });
  await holdRpc(["literature/config", "literature/configure"]);
  await evaluate(
    `d.querySelector('.confucius-runtime-settings > details').open=true;return true;`,
  );
  await wait(`return Zotero.__settingsRace.calls.length===2;`);
  assert.deepEqual(
    await evaluate(
      `const section=d.querySelector('.confucius-literature-settings'),input=section.querySelector('input');input.value='SYNTHETIC_SETTINGS_KEY';return {editable:!input.disabled,blocked:[...section.querySelectorAll('button')].every(button=>button.disabled)};`,
    ),
    { editable: true, blocked: true },
  );
  await releaseRpc();
  await wait(
    `return !d.querySelector('.confucius-literature-settings button').disabled;`,
  );
  assert.equal(
    await evaluate(
      `return d.querySelector('.confucius-literature-settings input').value;`,
    ),
    "SYNTHETIC_SETTINGS_KEY",
  );
  assert.deepEqual(
    await evaluate(
      `const section=d.querySelector('.confucius-literature-settings'),buttons=section.querySelectorAll('button');buttons[0].click();buttons[1].dispatchEvent(new win.MouseEvent('click',{bubbles:true}));return {calls:Zotero.__settingsRace.calls.filter(call=>call.method==='literature/configure').length,blocked:[...buttons].every(button=>button.disabled),inputDisabled:section.querySelector('input').disabled};`,
    ),
    { calls: 1, blocked: true, inputDisabled: true },
  );
  await releaseRpc();
  await wait(
    `return !d.querySelector('.confucius-literature-settings button').disabled;`,
  );
  assert.equal(
    await evaluate(
      `return (await Zotero.__settingsRace.original('literature/config',{provider:'openalex'})).hasKey;`,
    ),
    true,
  );
  await evaluate(
    `d.querySelector('.confucius-literature-settings button:nth-child(2)').click();return true;`,
  );
  await releaseRpc();
  await wait(
    `return !d.querySelector('.confucius-literature-settings button').disabled;`,
  );
  assert.equal(
    await evaluate(
      `return (await Zotero.__settingsRace.original('literature/config',{provider:'openalex'})).hasKey;`,
    ),
    false,
  );
  await restoreRpc();
  check(
    "Runtime empty-path validation focuses an enabled input; delayed retrieval reads preserve typed keys and save/clear operations cannot race",
  );
  await appearance();
  await assertButtonInteraction(evaluate, "#confucius-cfg-save");
  await evaluate(
    `Zotero.Utilities.Internal.openPreferences('confucius-prefpane');return true;`,
  );
  const prefEvaluate = (code) =>
    instance.rdp.evaluate(
      `const pw=[...Services.wm.getEnumerator('zotero:pref')][0],pd=pw?.document;${code}`,
      30000,
    );
  await until(
    () =>
      prefEvaluate(
        `return !!pd?.getElementById('confucius-pref-tab-appearance');`,
      ),
    20000,
    100,
  );
  await prefEvaluate(
    `pd.getElementById('confucius-pref-tab-appearance').click();return true;`,
  );
  assert.equal(
    await prefEvaluate(
      `return !pd.getElementById('confucius-pref-panel-appearance-0').hidden&&pd.getElementById('confucius-pref-panel-model-0').hidden;`,
    ),
    true,
  );
  const prefStyleEvaluate = (code) => prefEvaluate(`const win=pw,d=pd;${code}`);
  await appearance();
  await compareSettingsStyles(prefStyleEvaluate, appearanceStyleSelectors);
  await assertStickyPreferences(prefStyleEvaluate);
  const workspaceSave = await settingsStyles(evaluate, ["#confucius-cfg-save"]);
  const preferenceSave = await settingsStyles(prefStyleEvaluate, [
    "#confucius-pref-appearance-save",
  ]);
  assert.deepEqual(
    preferenceSave["#confucius-pref-appearance-save"],
    workspaceSave["#confucius-cfg-save"],
  );
  assert.equal(
    await prefStyleEvaluate(
      `const pane=d.getElementById('confucius-preferences'),scroller=d.querySelector('[data-confucius-preferences-scroll]');const probe=d.createElementNS('http://www.w3.org/1999/xhtml','span');probe.style.color='var(--confucius-paper)';pane.append(probe);const color=win.getComputedStyle(probe).color;probe.remove();return !!scroller&&win.getComputedStyle(scroller).backgroundColor===color&&win.getComputedStyle(pane).backgroundColor===color;`,
    ),
    true,
  );
  check(
    "Appearance controls, primary buttons and top-tab states match between both settings entry points; the preferences background follows the saved palette",
  );
  await assertButtonInteraction(
    prefStyleEvaluate,
    "#confucius-pref-appearance-save",
  );
  check(
    "Both settings entry points preserve shared hover/disabled feedback and keyboard focus without pointer focus outlines",
  );
  await prefEvaluate(
    `await pw.Zotero_Preferences.navigateToPane('zotero-prefpane-general');return true;`,
  );
  await until(
    () =>
      prefEvaluate(
        `return !pd.querySelector('[data-confucius-preferences-scroll]');`,
      ),
    20000,
    100,
  );
  const general = await prefEvaluate(
    `const container=pw.Zotero_Preferences.panes.get('zotero-prefpane-general').container,s=pw.getComputedStyle(container);return {confuciusHidden:pd.getElementById('confucius-preferences').closest('.pane-container').hidden,font:s.fontFamily,size:s.fontSize};`,
  );
  assert.equal(general.confuciusHidden, true);
  assert.equal(general.font.includes(family), false);
  assert.notEqual(general.size, "17.5px");
  await prefEvaluate(
    `await pw.Zotero_Preferences.navigateToPane('confucius-prefpane');return true;`,
  );
  await until(
    () =>
      prefEvaluate(
        `return !!pd.querySelector('[data-confucius-preferences-scroll]');`,
      ),
    20000,
    100,
  );
  check(
    "Confucius background and typography stay scoped: other Zotero preference panes retain their native styles",
  );
  await prefEvaluate(
    `const n=pd.getElementById('confucius-cfg-color-accent');n.value='#xyz';n.dispatchEvent(new pw.Event('input',{bubbles:true}));pd.getElementById('confucius-pref-appearance-save').click();return true;`,
  );
  await until(
    () =>
      prefEvaluate(
        `return !pd.getElementById('confucius-pref-appearance-save').disabled;`,
      ),
    20000,
    100,
  );
  await assertFocusedColorError(prefStyleEvaluate);
  await prefEvaluate(
    `pd.getElementById('confucius-pref-appearance-cancel').click();return true;`,
  );
  check(
    "Invalid color fields keep their error outline while focused in both entry points",
  );
  await holdRpc(["config/set"]);
  await prefEvaluate(
    `const n=pd.getElementById('confucius-cfg-font-size');n.value='15.5';n.dispatchEvent(new pw.Event('input',{bubbles:true}));pd.querySelector('#confucius-cfg-language [data-value=en-US]').click();pd.getElementById('confucius-pref-appearance-save').click();return true;`,
  );
  assert.deepEqual(
    await prefEvaluate(
      `const save=pd.getElementById('confucius-pref-appearance-save'),editor=pd.querySelector('.confucius-appearance-settings');save.dispatchEvent(new pw.MouseEvent('click',{bubbles:true}));pd.getElementById('confucius-pref-appearance-cancel').dispatchEvent(new pw.MouseEvent('click',{bubbles:true}));return {same:editor===pd.querySelector('.confucius-appearance-settings'),inert:editor.inert,cancel:pd.getElementById('confucius-pref-appearance-cancel').disabled,busy:pd.getElementById('confucius-pref-appearance').getAttribute('aria-busy'),calls:Zotero.__settingsRace.calls.length};`,
    ),
    { same: true, inert: true, cancel: true, busy: "true", calls: 1 },
  );
  await releaseRpc();
  await until(
    () =>
      prefEvaluate(
        `return pd.querySelector('#confucius-pref-appearance .confucius-settings-feedback')?.dataset.state==='saved';`,
      ),
    20000,
    100,
  );
  await wait(`return win.getComputedStyle(root).fontSize==='15.5px';`);
  await restoreRpc();
  assert.deepEqual(
    await prefEvaluate(
      `return {runtime:pd.getElementById('confucius-runtime-refresh').textContent,updates:pd.getElementById('confucius-pref-updates-open').textContent};`,
    ),
    {
      runtime: "Check again",
      updates: "Open update settings in the workspace",
    },
  );
  check(
    "Delayed preference saves reject duplicate submission and draft replacement; saved language refreshes Runtime and Update labels",
  );
  assert.equal(
    await prefEvaluate(
      `return pd.getElementById('confucius-pref-tab-appearance').textContent;`,
    ),
    "Appearance",
  );
  await prefEvaluate(
    `pd.getElementById('confucius-cfg-font-size').value='24';pd.getElementById('confucius-pref-appearance-cancel').click();return true;`,
  );
  assert.equal((await instance.rpc("config/get")).uiFontSize, 15.5);
  await prefEvaluate(
    `pd.getElementById('confucius-pref-tab-runtime').click();return true;`,
  );
  assert.equal(
    await prefEvaluate(
      `return pd.querySelectorAll('.confucius-runtime-card').length;`,
    ),
    3,
  );
  await evaluate(
    `d.getElementById('confucius-cfg-tab-runtime').click();return true;`,
  );
  await compareSettingsStyles(prefStyleEvaluate, [
    "#confucius-runtime-refresh",
    "#confucius-runtime-host-enabled",
    "#confucius-runtime-codex-auto",
    "#confucius-runtime-codex-save",
    ".confucius-runtime-header h3",
    ".confucius-runtime-card .confucius-settings-help",
  ]);
  check(
    "Runtime text buttons, native check controls, headings and help use the same geometry and colors in both settings entry points",
  );
  await evaluate(
    `d.getElementById('confucius-cfg-cancel').click();return true;`,
  );
  await holdRpc(["config/get"]);
  await prefEvaluate(
    `pd.getElementById('confucius-pref-tab-update').click();const open=pd.getElementById('confucius-pref-updates-open');open.click();open.dispatchEvent(new pw.MouseEvent('click',{bubbles:true}));return true;`,
  );
  await wait(`return Zotero.__settingsRace.calls.length>0;`);
  assert.equal(await evaluate(`return Zotero.__settingsRace.calls.length;`), 1);
  await releaseRpc();
  await wait(
    `return d.getElementById('confucius-cfg-tab-update')?.getAttribute('aria-selected')==='true';`,
  );
  await releaseRpc();
  await restoreRpc();
  check(
    "Repeated Update-page opening shares one pending request and cannot toggle the settings dialog closed",
  );
  await prefEvaluate(`pw.close();return true;`);
  await instance.rpc("config/set", { uiFontSize: 17.5, uiLanguage: "zh-CN" });
  check(
    "Zotero preferences share top tabs and editors; saving updates open workspaces, Cancel preserves values, language labels refresh, and Updates opens the correct tab",
  );
  await evaluate(
    `d.getElementById('confucius-cfg-cancel').click();return true;`,
  );
  const task = await instance.rpc("task/new", {
    title: "Appearance reader fixture",
    backend: "native",
  });
  await instance.rpc("artifact/upsert", {
    taskId: task.id,
    kind: "report",
    title: "Appearance reader fixture",
    body: {
      type: "markdown",
      markdown:
        "# Appearance reader fixture\n\nEnglish reading text and 中文阅读正文。",
    },
    status: "ready",
  });
  await wait(
    `return !!d.querySelector('[data-entry-id="overview:${task.id}"]');`,
  );
  await evaluate(
    `d.querySelector('[data-entry-id="overview:${task.id}"]').click();return true;`,
  );
  await wait(`return !!d.querySelector('.confucius-artifact-file');`);
  await evaluate(
    `d.querySelector('.confucius-artifact-file').click();return true;`,
  );
  await wait(
    `return !!d.querySelector('.confucius-artifact-host')?.contentDocument?.querySelector('.tui-answer');`,
  );
  const embeddedEvaluate = (code) =>
    evaluate(
      `const rw=d.querySelector('.confucius-artifact-host').contentWindow,rd=rw.document;${code}`,
    );
  const selectReading = `const text=rd.querySelector('.tui-answer'),range=rd.createRange();range.selectNodeContents(text);const selection=rw.getSelection();selection.removeAllRanges();selection.addRange(range);text.dispatchEvent(new rw.MouseEvent('pointerup',{bubbles:true}));return true;`;
  await embeddedEvaluate(selectReading);
  await until(
    () => embeddedEvaluate(`return !!rd.querySelector('.confucius-btw');`),
    20000,
    100,
  );
  await instance.rpc("config/set", { uiFontSize: 20.5, uiLineHeight: 2.05 });
  const readingUpdated = `const reader=rd.getElementById('confucius-artifact-window'),popup=rd.querySelector('.confucius-btw');return rw.getComputedStyle(reader).fontSize==='20.5px'&&rw.getComputedStyle(popup).fontSize==='20.5px'&&Math.abs(parseFloat(rw.getComputedStyle(popup).lineHeight)-42.025)<0.03;`;
  await until(() => embeddedEvaluate(readingUpdated), 20000, 100);
  await embeddedEvaluate(
    `rd.getElementById('confucius-artifact-detach').click();return true;`,
  );
  await wait(
    `return [...Services.wm.getEnumerator(null)].some(w=>w.location.href==='chrome://confucius/content/artifact.xhtml'&&w.document.querySelector('.tui-answer'));`,
  );
  const readerEvaluate = (code) =>
    instance.rdp.evaluate(
      `const rw=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/artifact.xhtml'),rd=rw?.document;${code}`,
      30000,
    );
  await readerEvaluate(selectReading);
  await until(
    () => readerEvaluate(`return !!rd.querySelector('.confucius-btw');`),
    20000,
    100,
  );
  await until(() => readerEvaluate(readingUpdated), 20000, 100);
  await instance.rpc("config/set", { uiFontSize: 17.5, uiLineHeight: 1.85 });
  await until(
    () =>
      readerEvaluate(
        `return rw.getComputedStyle(rd.getElementById('confucius-artifact-window')).fontSize==='17.5px'&&rw.getComputedStyle(rd.querySelector('.confucius-btw')).fontSize==='17.5px';`,
      ),
    20000,
    100,
  );
  await instance.rpc("config/set", {
    uiFont: "sans",
    uiFontSize: 28,
    uiLineHeight: 2.4,
    uiTheme: "dark",
  });
  await until(
    async () => {
      const sample = await readerEvaluate(
        `const reader=rd.getElementById('confucius-artifact-window'),popup=rd.querySelector('.confucius-btw'),input=popup.querySelector('input');input.value='English 问题 gpy';const style=rw.getComputedStyle(input),box=popup.getBoundingClientRect(),bounds=reader.getBoundingClientRect(),expectedHeight=parseFloat(style.lineHeight)+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth);return {size:style.fontSize,line:style.lineHeight,minHeight:style.minHeight,maxHeight:style.maxHeight,inputHeight:input.getBoundingClientRect().height,expectedHeight,box:[box.left,box.top,box.right,box.bottom],bounds:[bounds.left,bounds.top,bounds.right,bounds.bottom],contained:box.left>=bounds.left+7&&box.right<=bounds.right-7&&box.top>=bounds.top+7&&box.bottom<=bounds.bottom-7,readerAccent:rw.getComputedStyle(reader).getPropertyValue('--confucius-accent').trim(),popupAccent:rw.getComputedStyle(popup).getPropertyValue('--confucius-accent').trim()};`,
      );
      report.readingTypography = sample;
      return (
        sample.size === "28px" &&
        sample.inputHeight >= sample.expectedHeight - 0.1 &&
        sample.contained &&
        sample.readerAccent === "#9bbfff" &&
        sample.popupAccent === "#9bbfff"
      );
    },
    20000,
    100,
  );
  await capture("style-reading-large", (code) =>
    readerEvaluate(`const win=rw,d=rd;${code}`),
  );
  await instance.rpc("config/set", {
    uiFont: "custom",
    uiFontFamily: family,
    uiFontSize: 17.5,
    uiLineHeight: 1.85,
    uiTheme: stable.uiTheme,
  });
  check(
    "Maximum reading typography leaves the selection-question input unclipped and within reading bounds; reader and popup colors update together",
  );
  await readerEvaluate(`rw.close();return true;`);
  check(
    "Already open embedded/detached reading windows and selection-question popups follow saved decimal typography",
  );
  const neutral = {
    light: {
      paper: "#ffffff",
      canvas: "#f4f4f5",
      surface: "#eaeaed",
      ink: "#252529",
      secondary: "#606069",
      accent: "#465fb0",
    },
    dark: {
      paper: "#202024",
      canvas: "#18181b",
      surface: "#303036",
      ink: "#f0f0f3",
      secondary: "#bdbdc7",
      accent: "#aabaff",
    },
  };
  const matrix = [
    {
      name: "warm-light",
      theme: "light",
      colors: {},
      size: 13,
      language: "zh-CN",
      width: 1000,
      prefWidth: 800,
    },
    {
      name: "warm-dark",
      theme: "dark",
      colors: {},
      size: 12,
      language: "en-US",
      width: 1000,
      prefWidth: 800,
    },
    {
      name: "neutral-light",
      theme: "light",
      colors: neutral,
      size: 13,
      language: "zh-CN",
      width: 620,
      prefWidth: 800,
    },
    {
      name: "neutral-dark",
      theme: "dark",
      colors: neutral,
      size: 17.5,
      language: "en-US",
      width: 620,
      prefWidth: 620,
    },
    {
      name: "custom-light",
      theme: "light",
      colors: stable.uiThemeColors,
      size: 28,
      language: "en-US",
      width: 280,
      prefWidth: 620,
    },
    {
      name: "custom-dark",
      theme: "dark",
      colors: stable.uiThemeColors,
      size: 28,
      language: "zh-CN",
      width: 420,
      prefWidth: 620,
    },
  ];
  report.styleMatrix = [];
  for (const scenario of matrix) {
    await evaluate(
      `d.getElementById('confucius-cfg-cancel')?.click();return true;`,
    );
    await instance.rpc("config/set", {
      uiFont: "sans",
      uiFontFamily: "",
      uiFontSize: scenario.size,
      uiLineHeight: 2.4,
      uiTheme: scenario.theme,
      uiThemeColors: scenario.colors,
      uiLanguage: scenario.language,
    });
    await wait(
      `return win.getComputedStyle(root).fontSize===${JSON.stringify(scenario.size + "px")};`,
    );
    await evaluate(`shell.resizeTo(${scenario.width},820);return true;`);
    await appearance();
    await evaluate(
      `d.getElementById('confucius-cfg-font').closest('details').open=true;return true;`,
    );
    await evaluate(
      `Zotero.Utilities.Internal.openPreferences('confucius-prefpane');return true;`,
    );
    await until(
      () =>
        prefEvaluate(
          `return !!pd?.getElementById('confucius-pref-tab-appearance');`,
        ),
      20000,
      100,
    );
    await prefEvaluate(
      `pw.resizeTo(${scenario.prefWidth},900);pd.getElementById('confucius-pref-tab-appearance').click();pd.getElementById('confucius-cfg-font').closest('details').open=true;return true;`,
    );
    await compareSettingsStyles(prefStyleEvaluate, appearanceStyleSelectors);
    const workspaceGeometry = await assertEditorGeometry(
      evaluate,
      scenario.name + " workspace appearance ",
    );
    const preferencesGeometry = await assertEditorGeometry(
      prefStyleEvaluate,
      scenario.name + " preferences appearance ",
    );
    await assertStickyPreferences(prefStyleEvaluate);
    await capture("style-" + scenario.name);
    await capture("style-preferences-" + scenario.name, prefStyleEvaluate);
    const expandRuntime = `d.querySelector('.confucius-settings-tabs [id$="runtime"]').click();for(const details of d.querySelectorAll('.confucius-runtime-settings > details,.confucius-runtime-card details'))details.open=true;for(const radio of d.querySelectorAll('.confucius-runtime-card input[id$="manual"]'))radio.click();return true;`;
    await evaluate(expandRuntime);
    await prefStyleEvaluate(expandRuntime);
    await until(
      () =>
        evaluate(
          `return d.querySelectorAll('.confucius-runtime-settings .confucius-literature-settings').length===2;`,
        ),
      20000,
      100,
    );
    await until(
      () =>
        prefStyleEvaluate(
          `return d.querySelectorAll('.confucius-runtime-settings .confucius-literature-settings').length===2;`,
        ),
      20000,
      100,
    );
    await assertEditorGeometry(evaluate, scenario.name + " workspace runtime ");
    await assertEditorGeometry(
      prefStyleEvaluate,
      scenario.name + " preferences runtime ",
    );
    if (scenario.name === "custom-dark") {
      await evaluate(
        `Services.prefs.setIntPref('ui.useAccessibilityTheme',1);d.getElementById('confucius-cfg-tab-appearance').click();return true;`,
      );
      await until(
        () =>
          prefStyleEvaluate(
            `d.getElementById('confucius-pref-tab-appearance').click();return win.matchMedia('(prefers-contrast: more)').matches;`,
          ),
        20000,
        100,
      );
      await wait(
        `return win.matchMedia('(prefers-contrast: more)').matches&&win.getComputedStyle(root).getPropertyValue('--confucius-primary').trim()==='Highlight';`,
      );
      await until(
        () =>
          prefStyleEvaluate(
            `return win.getComputedStyle(d.getElementById('confucius-preferences')).getPropertyValue('--confucius-primary').trim()==='Highlight';`,
          ),
        20000,
        100,
      );
      await compareSettingsStyles(prefStyleEvaluate, appearanceStyleSelectors);
      report.contrastPrimary = {
        workspace: await assertContrastPrimary(evaluate, "#confucius-cfg-save"),
        preferences: await assertContrastPrimary(
          prefStyleEvaluate,
          "#confucius-pref-appearance-save",
        ),
      };
      check(
        "High-contrast primary buttons retain readable labels and contrasting keyboard focus in both settings entry points",
      );
      const selectedVisible = `return [...d.querySelectorAll('.confucius-appearance-settings :is([role=tab][aria-selected=true],[role=option][aria-selected=true],[role=radio][aria-checked=true])')].every(n=>win.getComputedStyle(n).textDecorationLine.includes('underline'));`;
      assert.equal(await evaluate(selectedVisible), true);
      assert.equal(await prefStyleEvaluate(selectedVisible), true);
      await assertEditorGeometry(evaluate, "High contrast workspace ");
      await assertEditorGeometry(
        prefStyleEvaluate,
        "High contrast preferences ",
      );
      await capture("style-high-contrast");
      await capture("style-preferences-high-contrast", prefStyleEvaluate);
      await evaluate(
        `Services.prefs.setIntPref('ui.useAccessibilityTheme',0);return true;`,
      );
      check(
        "System contrast overrides custom palettes in both entry points, with clear selected tabs, radio choices and font options",
      );
    }
    await prefEvaluate(`pw.close();return true;`);
    report.styleMatrix.push({
      name: scenario.name,
      fontSize: scenario.size,
      language: scenario.language,
      workspaceWidth: workspaceGeometry.width,
      preferencesWidth: preferencesGeometry.width,
    });
  }
  check(
    "Light/dark warm, neutral and custom palettes render consistent Appearance and expanded Runtime editors at 12–28px, in English/Chinese and regular/compact/very narrow windows",
  );
  await evaluate(
    `d.getElementById('confucius-cfg-cancel')?.click();shell.resizeTo(1000,820);return true;`,
  );
  await instance.rpc("config/set", {
    uiFont: "custom",
    uiFontFamily: family,
    uiFontSize: 17.5,
    uiLineHeight: 1.85,
    uiTheme: stable.uiTheme,
    uiThemeColors: stable.uiThemeColors,
    uiLanguage: "zh-CN",
  });
  // user.js is launch-only setup, not a source of values after the restart.
  await writeFile(
    join(instance.profile, "user.js"),
    'user_pref("extensions.zotero.firstRun2",false);\n',
  );
  await instance.stop({ graceful: true });
  await instance.launch();
  await writeFile(
    join(output, "state.json"),
    JSON.stringify(instance.publicState(), null, 2),
  );
  const restarted = await instance.rpc("config/get");
  assert.equal(restarted.uiFontSize, 17.5);
  assert.equal(restarted.uiLineHeight, 1.85);
  assert.equal(restarted.uiFontFamily, family);
  assert.deepEqual(restarted.uiThemeColors, stable.uiThemeColors);
  check(
    "Decimal values, local font family and independent palettes survive Zotero restart",
  );
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
  if (process.env.CONFUCIUS_SETTINGS_KEEP !== "1")
    await instance.stop({ graceful: true });
}
