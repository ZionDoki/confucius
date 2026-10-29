/** Native reader + real Flex Annotations acceptance in an isolated library. */
import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
import { resolveZoteroExecutable } from "../apps/zotero-addon/src/development/zoteroExecutable.ts";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_NATIVE_ANNOTATIONS_OUTPUT ??
    join(root, "output/native-annotations/live"),
);
await mkdir(output, { recursive: true });
const instance = await IsolatedZotero.create({
  root,
  binary: resolveZoteroExecutable().path,
  xpi: join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "native-annotations-",
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
const check = (name, value) => {
  assert.ok(value, name);
  report.checks.push(name);
  console.log(name);
};
const evaluate = (code) => instance.rdp.evaluate(code, 30000);
const ui = (code) =>
  evaluate(
    `const q=globalThis.nativeAnnotationQA,r=q.reader,win=r._iframeWindow,d=win.document;${code}`,
  );
const wait = (code) => until(() => ui(code), 20000, 100);
const openPopup = async (index = 0, rect = [260, 170, 380, 190]) => {
  await ui(
    `const internal=r._internalReader;internal.toggleSidebar(false);internal.setSelectedAnnotations(Components.utils.cloneInto([q.marks[${index}].key],win),true,Components.utils.cloneInto({button:2,shiftKey:false,ctrlKey:false,metaKey:false},win));await new Promise(resolve=>win.requestAnimationFrame(resolve));return true;`,
  );
  return ui(
    `const internal=r._internalReader;internal.toggleSidebar(false);const annotation=internal._annotationManager._getAnnotationByID(q.marks[${index}].key);if(!annotation)throw new Error('Missing annotation');internal._primaryView._onSetAnnotationPopup(Components.utils.cloneInto({annotation:JSON.parse(JSON.stringify(annotation)),rect:${JSON.stringify(rect)}},win));return true;`,
  );
};
const capture = async (name) => {
  const png = await ui(
    `const c=d.createElement('canvas');c.width=win.innerWidth;c.height=win.innerHeight;c.getContext('2d').drawWindow(win,0,0,c.width,c.height,'white');return c.toDataURL('image/png');`,
  );
  await writeFile(
    join(output, `${name}.png`),
    Buffer.from(png.split(",")[1], "base64"),
  );
};
const dragCorner = async (corner, dx, dy, end = "pointerup") => {
  await ui(
    `const p=d.querySelector('.annotation-popup'),h=p.querySelector('[data-corner=${corner}]'),b=h.getBoundingClientRect();q.resizeHandle=h;q.resizePointer={x:b.x+b.width/2,y:b.y+b.height/2};h.dispatchEvent(new win.PointerEvent('pointerdown',Components.utils.cloneInto({bubbles:true,cancelable:true,pointerId:7,button:0,clientX:q.resizePointer.x,clientY:q.resizePointer.y},win)));return true;`,
  );
  await ui(
    `q.resizeHandle.dispatchEvent(new win.PointerEvent('pointermove',Components.utils.cloneInto({bubbles:true,cancelable:true,pointerId:7,buttons:1,clientX:q.resizePointer.x+${dx},clientY:q.resizePointer.y+${dy}},win)));await new Promise(done=>win.requestAnimationFrame(done));return true;`,
  );
  await ui(
    end === "Escape"
      ? `q.resizeHandle.dispatchEvent(new win.KeyboardEvent('keydown',Components.utils.cloneInto({key:'Escape',bubbles:true,cancelable:true},win)));return true;`
      : `q.resizeHandle.dispatchEvent(new win.PointerEvent('${end}',Components.utils.cloneInto({bubbles:true,cancelable:true,pointerId:7},win)));return true;`,
  );
  await ui(
    `await new Promise(done=>win.requestAnimationFrame(done));return true;`,
  );
};
const popupRect = () =>
  ui(
    `const b=d.querySelector('.annotation-popup').getBoundingClientRect();return {left:b.left,top:b.top,right:b.right,bottom:b.bottom,width:b.width,height:b.height};`,
  );
const comment = [
  "## 理解这个结果",
  "",
  "这是 **关键证据**，保留原生批注和 Flex Annotations 的归类。",
  "",
  "- 样本量：128",
  "- 能量关系 $E=mc^2$",
  "",
  "$$",
  "\\mathcal{L}(\\theta)=\\sum_{i=1}^{n}(y_i-f_\\theta(x_i))^2",
  "$$",
  "",
  "| 方法 | 结果 |",
  "| --- | --- |",
  "| Baseline | 0.82 |",
  "| Proposed | 0.91 |",
  "",
  "[来源链接](https://www.zotero.org/)",
  "",
  "```python",
  "loss = sum((y - predict(x)) ** 2 for x, y in samples)",
  "```",
  "",
  "<b>原生加粗</b> 和 H<sub>2</sub>O",
].join("\n");
try {
  report.environment = await instance.launch();
  await writeFile(
    join(output, "instance.json"),
    JSON.stringify(instance.publicState(), null, 2),
  );
  await instance.rpc("config/set", {
    uiFont: "serif",
    uiFontSize: 16,
    uiLineHeight: 1.7,
    uiTheme: "light",
  });
  await evaluate(`
    const article=new Zotero.Item('journalArticle');article.setField('title','Native annotations acceptance');await article.saveTx();
    const pdf=await Zotero.Attachments.importFromFile({file:${JSON.stringify(join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"))},parentItemID:article.id});
    const marks=[];
    for(let i=0;i<2;i++)marks.push(await Zotero.Annotations.saveFromJSON(pdf,{key:Zotero.DataObjectUtilities.generateKey(),type:'highlight',text:'Original source passage '+(i+1),comment:i?'Second annotation — no stale preview':${JSON.stringify(comment)},color:'#ffd400',pageLabel:'1',sortIndex:'00000|000000|0000'+i,position:{pageIndex:0,rects:[[50,640-i*35,330,660-i*35]]},tags:[{name:'§Methods'},{name:'Review'},{name:'#flexannotate-locator-section'}]}));
    const reader=await Zotero.Reader.open(pdf.id);await reader._initPromise;await reader._internalReader._primaryView.initializedPromise;
    reader._internalReader.toggleSidebar(true);
    reader._internalReader.setSidebarView('annotations');
    globalThis.nativeAnnotationQA={article,pdf,marks,reader,errors:[]};
    reader._iframeWindow.addEventListener('error',e=>globalThis.nativeAnnotationQA.errors.push(e.message));
    return true;
  `);
  await wait(
    `return r._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.getPageView(0)?.renderingState===3;`,
  );
  await wait(
    `return d.querySelectorAll('[data-confucius-annotation=card] .confucius-annotation-markdown').length===2;`,
  );
  if (process.env.CONFUCIUS_FLEX_XPI)
    check(
      "Real Flex Annotations API is loaded",
      await evaluate("return !!Zotero.FlexAnnotate?.api;"),
    );
  check(
    "Native cards render Markdown, MathML and native inline formatting",
    await ui(
      `const p=d.querySelector('[data-confucius-annotation=card] .confucius-annotation-markdown');return !!p.querySelector('h2')&&!!p.querySelector('strong')&&!!p.querySelector('math')&&p.querySelectorAll('tr').length===3&&!!p.querySelector('pre code')&&!!p.querySelector('sub');`,
    ),
  );
  await capture("pdf-cards-light");
  await openPopup();
  await wait(
    `return d.querySelectorAll('.annotation-popup .confucius-annotation-markdown math').length===2;`,
  );
  await capture("pdf-popup-light");
  const metrics = await ui(
    `const p=d.querySelector('.annotation-popup'),b=p.getBoundingClientRect(),s=win.getComputedStyle(p),body=p.querySelector('.confucius-annotation-markdown'),preview=p.querySelector('.preview');return {width:b.width,left:b.left,right:b.right,top:b.top,bottom:b.bottom,viewport:[win.innerWidth,win.innerHeight],font:s.fontSize,family:s.fontFamily,background:s.backgroundColor,overflow:preview.scrollWidth>preview.clientWidth,math:body.querySelectorAll('math').length};`,
  );
  report.metrics = metrics;
  check(
    "PDF popup uses the saved Confucius font, palette and bounded layout",
    metrics.width === 420 &&
      metrics.font === "16px" &&
      metrics.background === "rgb(255, 254, 250)" &&
      !metrics.overflow &&
      metrics.right <= metrics.viewport[0] &&
      metrics.bottom <= metrics.viewport[1],
  );
  check(
    "Rendering preserves native comments, colors, tags and editor nodes",
    await ui(
      `return q.marks[0].annotationComment===${JSON.stringify(comment)}&&q.marks[0].annotationColor==='#ffd400'&&q.marks[0].getTags().some(t=>t.tag==='§Methods')&&!!d.querySelector('.annotation-popup .editor .content');`,
    ),
  );
  check(
    "The edit action sits immediately left of the native menu and stays visible with long comments",
    await ui(
      `const p=d.querySelector('.annotation-popup'),b=p.getBoundingClientRect(),button=p.querySelector('.confucius-annotation-edit'),edit=button.getBoundingClientRect(),more=p.querySelector('header button.more'),menu=more.getBoundingClientRect();return button.closest('header')&&button.parentElement.nextElementSibling===more&&edit.right<=menu.left&&Math.abs(edit.top+edit.height/2-menu.top-menu.height/2)<1&&edit.top>=b.top&&edit.bottom<=b.bottom&&edit.height>=34&&!p.querySelector('.comment .confucius-annotation-actions');`,
    ),
  );
  await ui(
    `const button=d.querySelector('.annotation-popup .confucius-annotation-edit');button.focus();button.dispatchEvent(new win.KeyboardEvent('keydown',Components.utils.cloneInto({key:'Backspace',bubbles:true,cancelable:true},win)));return true;`,
  );
  check(
    "Backspace on the header edit action never deletes the selected annotation",
    await ui(`return q.pdf.getAnnotations().length===2;`),
  );
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const before = await popupRect();
    const dx = corner.includes("w") ? 40 : -40,
      dy = corner.includes("n") ? 40 : -40;
    await dragCorner(corner, dx, dy);
    const after = await popupRect();
    (report.resizes ??= []).push({ corner, before, after });
    const anchorX = corner.includes("w") ? "right" : "left",
      anchorY = corner.includes("n") ? "bottom" : "top";
    check(
      `The ${corner} corner resizes both dimensions and preserves its opposite corner`,
      Math.abs(after.width - before.width + 40) < 1 &&
        Math.abs(after.height - before.height + 40) < 1 &&
        Math.abs(after[anchorX] - before[anchorX]) < 1 &&
        Math.abs(after[anchorY] - before[anchorY]) < 1,
    );
    await dragCorner(corner, -dx, -dy);
    const restored = await popupRect();
    assert.ok(
      Math.abs(restored.width - before.width) < 1 &&
        Math.abs(restored.height - before.height) < 1,
    );
  }
  await dragCorner("se", -55, -45, "Escape");
  await wait(`return !d.querySelector('.annotation-popup');`);
  check(
    "Escape retains native dismissal during a resize and clears drag state",
    await ui(
      `return !q.resizeHandle.isConnected&&!d.querySelector('[data-confucius-resizing]');`,
    ),
  );
  await openPopup();
  await wait(
    `return !!d.querySelector('.annotation-popup .confucius-annotation-resize');`,
  );
  const beforeCancel = await popupRect();
  await dragCorner("se", -55, -45, "pointercancel");
  check(
    "Cancelled pointers restore the previous dimensions and release resize state",
    JSON.stringify(await popupRect()) === JSON.stringify(beforeCancel) &&
      (await ui(`return !d.querySelector('[data-confucius-resizing]');`)),
  );
  await dragCorner("se", 10000, 10000);
  check(
    "Dragging beyond the pane keeps the popup and its controls within bounds",
    await ui(
      `const p=d.querySelector('.annotation-popup'),b=p.getBoundingClientRect(),parent=p.parentElement.getBoundingClientRect(),edit=p.querySelector('.confucius-annotation-edit').getBoundingClientRect();return b.right<=parent.right-7&&b.bottom<=parent.bottom-7&&edit.bottom<=b.bottom;`,
    ),
  );
  await capture("pdf-popup-resized");
  await dragCorner("se", -10000, -10000);
  check(
    "Minimum resize preserves readable content and reachable actions",
    await ui(
      `const p=d.querySelector('.annotation-popup'),b=p.getBoundingClientRect(),edit=p.querySelector('.confucius-annotation-edit').getBoundingClientRect(),tags=p.querySelector('.tags').getBoundingClientRect();return b.width>=260&&b.height>=180&&edit.top>=b.top&&edit.bottom<=b.bottom&&tags.bottom<=b.bottom;`,
    ),
  );
  await ui(
    `d.querySelector('.confucius-annotation-resize[data-corner=se]').dispatchEvent(new win.KeyboardEvent('keydown',Components.utils.cloneInto({key:'Enter',bubbles:true,cancelable:true},win)));return true;`,
  );
  await wait(
    `const p=d.querySelector('.annotation-popup');return !p.hasAttribute('data-confucius-resized')&&p.getBoundingClientRect().width===420;`,
  );
  const keyboardBefore = await popupRect();
  await ui(
    `const h=d.querySelector('.confucius-annotation-resize[data-corner=se]');h.focus();h.dispatchEvent(new win.KeyboardEvent('keydown',Components.utils.cloneInto({key:'ArrowLeft',bubbles:true,cancelable:true},win)));return true;`,
  );
  check(
    "Keyboard resizing adjusts dimensions without editing the comment",
    Math.abs((await popupRect()).width - keyboardBefore.width + 8) < 1 &&
      (await ui(
        `return !d.querySelector('.comment[data-confucius-editing]');`,
      )),
  );
  await ui(
    `const h=d.querySelector('.confucius-annotation-resize[data-corner=se]');h.dispatchEvent(new win.KeyboardEvent('keydown',Components.utils.cloneInto({key:'Backspace',bubbles:true,cancelable:true},win)));return true;`,
  );
  check(
    "Backspace on a resize control never deletes an annotation",
    await ui(`return q.pdf.getAnnotations().length===2;`),
  );
  await openPopup(1);
  await wait(
    `return d.querySelector('.annotation-popup .editor .content')?.id===q.marks[1].key&&d.querySelectorAll('.annotation-popup .confucius-annotation-resize').length===4&&!!d.querySelector('.annotation-popup .confucius-annotation-rendered');`,
  );
  check(
    "Switching annotations retains the reader's preferred popup size",
    Math.abs((await popupRect()).width - keyboardBefore.width + 8) < 1,
  );
  await openPopup();
  await wait(
    `return !!d.querySelector('.annotation-popup .confucius-annotation-markdown math');`,
  );
  await ui(
    `d.querySelector('.confucius-annotation-resize').dispatchEvent(new win.MouseEvent('dblclick',Components.utils.cloneInto({bubbles:true,cancelable:true},win)));return true;`,
  );
  await wait(
    `return !d.querySelector('.annotation-popup[data-confucius-resized]');`,
  );
  await instance.rpc("config/set", {
    annotationFontSize: 19.5,
    annotationLineHeight: 1.85,
    annotationParagraphSpacing: 20,
  });
  await wait(
    `const p=d.querySelector('.annotation-popup'),s=win.getComputedStyle(p);return s.fontSize==='19.5px'&&Math.abs(parseFloat(s.lineHeight)-36.075)<0.05;`,
  );
  const independent = await instance.rpc("config/get");
  check(
    "Annotation settings persist independently and apply to open comments",
    independent.uiFontSize === 16 &&
      independent.uiLineHeight === 1.7 &&
      independent.annotationFontSize === 19.5 &&
      independent.annotationParagraphSpacing === 20 &&
      (await ui(
        `return win.getComputedStyle(d.querySelector('.confucius-annotation-markdown p')).marginBottom==='20px';`,
      )),
  );
  await instance.rpc("config/set", { uiFontSize: 22, uiLineHeight: 2.1 });
  await wait(
    `return d.getElementById('confucius-appearance-css').textContent.includes('--confucius-font-size: 22px');`,
  );
  check(
    "Independent annotation typography survives changes to global typography",
    await ui(
      `return win.getComputedStyle(d.querySelector('.annotation-popup')).fontSize==='19.5px';`,
    ),
  );
  await capture("pdf-popup-custom-typography");
  await instance.rpc("config/set", {
    annotationFontSize: null,
    annotationLineHeight: null,
    annotationParagraphSpacing: null,
  });
  await wait(
    `return win.getComputedStyle(d.querySelector('.annotation-popup')).fontSize==='22px';`,
  );
  check(
    "Following global settings clears overrides and restores default paragraph spacing",
    await ui(
      `return win.getComputedStyle(d.querySelector('.confucius-annotation-markdown p')).marginBottom==='12px';`,
    ),
  );
  await instance.rpc("config/set", { uiFontSize: 16, uiLineHeight: 1.7 });
  await evaluate(
    `Services.prefs.setIntPref('ui.useAccessibilityTheme',1);return true;`,
  );
  await wait(`return win.matchMedia('(prefers-contrast: more)').matches;`);
  check(
    "Native system contrast retains readable text and a visible popup boundary",
    await ui(
      `const p=d.querySelector('.annotation-popup'),s=win.getComputedStyle(p);return s.color!==s.backgroundColor&&s.outlineStyle==='solid'&&s.outlineWidth==='1px'&&s.getPropertyValue('--confucius-ink').trim()==='CanvasText';`,
    ),
  );
  await capture("pdf-popup-high-contrast");
  await evaluate(
    `Services.prefs.setIntPref('ui.useAccessibilityTheme',0);return true;`,
  );
  if (process.env.CONFUCIUS_FLEX_XPI) {
    report.locator = await ui(
      `const p=d.querySelector('.annotation-popup .page');q.page=p;return {label:p?.textContent,html:p?.outerHTML,keys:Object.keys(Zotero.FlexAnnotate),stateKeys:Object.keys(r._state??{})};`,
    );
    check(
      "Flex locator tags and native header elements are preserved",
      await ui(
        `return !!q.page&&q.marks[0].getTags().some(t=>t.tag==='#flexannotate-locator-section');`,
      ),
    );
  }
  await instance.rpc("config/set", {
    uiTheme: "dark",
    uiFont: "custom",
    uiFontFamily: "Arial",
    uiFontSize: 28,
    uiLineHeight: 1.9,
  });
  await wait(
    `const p=d.querySelector('.annotation-popup'),s=win.getComputedStyle(p);return s.fontSize==='28px'&&s.fontFamily.includes('Arial')&&s.backgroundColor==='rgb(41, 39, 34)';`,
  );
  check(
    "Open popups immediately follow font, size, line-height and dark-theme settings",
    await ui(
      `const p=d.querySelector('.annotation-popup'),b=p.getBoundingClientRect(),s=win.getComputedStyle(p),preview=p.querySelector('.preview');return parseFloat(s.lineHeight)>50&&b.left>=0&&b.top>=0&&b.bottom<=win.innerHeight&&preview.scrollWidth<=preview.clientWidth;`,
    ),
  );
  await capture("pdf-popup-dark-large");
  await ui(
    `const p=d.querySelector('.annotation-popup').parentElement;p.style.width='300px';p.style.flexGrow='0';return true;`,
  );
  await wait(
    `const p=d.querySelector('.annotation-popup'),b=p.getBoundingClientRect(),parent=p.parentElement.getBoundingClientRect();return b.width<=284&&b.left>=parent.left&&b.right<=parent.right;`,
  );
  check(
    "Large type stays inside a narrow PDF pane",
    await ui(
      `const p=d.querySelector('.annotation-popup .preview');return p.scrollWidth<=p.clientWidth;`,
    ),
  );
  await capture("pdf-popup-dark-narrow");
  await ui(
    `const button=d.querySelector('.annotation-popup .confucius-annotation-edit');q.editLabel=button.value;button.value='Edit comment';return true;`,
  );
  await wait(
    `const p=d.querySelector('.annotation-popup'),edit=p.querySelector('.confucius-annotation-edit').getBoundingClientRect(),menu=p.querySelector('header button.more').getBoundingClientRect(),b=p.getBoundingClientRect();return edit.right<=menu.left&&edit.left>=b.left&&Math.abs(edit.top+edit.height/2-menu.top-menu.height/2)<1&&menu.right<=b.right;`,
  );
  check(
    "Large English edit labels stay beside the menu in a narrow pane",
    true,
  );
  await capture("pdf-popup-header-narrow-english");
  await ui(
    `d.querySelector('.annotation-popup .confucius-annotation-edit').value=q.editLabel;return true;`,
  );
  await ui(
    `const p=d.querySelector('.annotation-popup').parentElement;p.style.removeProperty('width');p.style.removeProperty('flex-grow');return true;`,
  );
  await instance.rpc("config/set", {
    uiTheme: "light",
    uiFont: "sans",
    uiFontSize: 16,
    uiLineHeight: 1.7,
  });
  await ui(
    `const p=d.querySelector('.annotation-popup .confucius-annotation-markdown');const range=d.createRange();range.selectNodeContents(p);win.getSelection().removeAllRanges();win.getSelection().addRange(range);q.preview=p;return true;`,
  );
  check(
    "Preview text can be selected without entering editing",
    await ui(
      `return win.getSelection().toString().includes('关键证据')&&!d.querySelector('.annotation-popup .comment[data-confucius-editing]')&&d.querySelector('.annotation-popup .confucius-annotation-markdown')===q.preview;`,
    ),
  );
  await ui(
    `win.getSelection().removeAllRanges();d.querySelector('.annotation-popup .confucius-annotation-markdown').focus();return true;`,
  );
  check(
    "Focused previews keep browser text copy",
    await ui(
      `const p=d.querySelector('.annotation-popup .confucius-annotation-markdown'),e=new win.Event('copy',Components.utils.cloneInto({bubbles:true,cancelable:true},win));p.dispatchEvent(e);return !e.defaultPrevented;`,
    ),
  );
  await ui(
    `d.querySelector('.annotation-popup .confucius-annotation-markdown').dispatchEvent(new win.KeyboardEvent('keydown',Components.utils.cloneInto({key:'Backspace',bubbles:true,cancelable:true},win)));return true;`,
  );
  check(
    "Backspace in a preview does not delete any selected annotations",
    await ui(
      `return r._internalReader._state.annotations.length===2&&q.pdf.getAnnotations().length===2;`,
    ),
  );
  await ui(
    `win.getSelection().removeAllRanges();d.querySelector('.annotation-popup .confucius-annotation-edit').click();return true;`,
  );
  await wait(
    `return d.activeElement?.matches('.annotation-popup .editor .content[contenteditable=true]');`,
  );
  check(
    "Edit comment focuses the original native editor",
    await ui(
      `q.originalEditor=d.activeElement;return q.originalEditor.id===q.marks[0].key&&win.getComputedStyle(q.originalEditor).display!=='none';`,
    ),
  );
  await dragCorner("se", -40, -40);
  check(
    "Resizing while editing preserves the focused native editor and its contents",
    await ui(
      `return d.activeElement===q.originalEditor&&q.originalEditor.isConnected&&q.marks[0].annotationComment===${JSON.stringify(comment)};`,
    ),
  );
  await ui(
    `q.originalEditor.dispatchEvent(new win.CompositionEvent('compositionstart',Components.utils.cloneInto({bubbles:true},win)));return true;`,
  );
  check(
    "IME composition keeps the original editor active and the preview hidden",
    await ui(
      `return d.activeElement===q.originalEditor&&win.getComputedStyle(d.querySelector('.annotation-popup .confucius-annotation-rendered')).display==='none';`,
    ),
  );
  const edited = "## 已更新\n\n保存 **中文评论** 与 $a^2+b^2=c^2$。";
  await ui(
    `const e=q.originalEditor;e.dispatchEvent(new win.CompositionEvent('compositionend',Components.utils.cloneInto({bubbles:true},win)));e.innerText=${JSON.stringify(edited)};e.dispatchEvent(new win.InputEvent('input',Components.utils.cloneInto({bubbles:true,inputType:'insertText'},win)));e.dispatchEvent(new win.KeyboardEvent('keydown',Components.utils.cloneInto({key:'Escape',bubbles:true,cancelable:true},win)));return true;`,
  );
  await wait(
    `return q.marks[0].annotationComment===${JSON.stringify(edited)};`,
  );
  await openPopup();
  await wait(
    `return !!d.querySelector('.annotation-popup .confucius-annotation-markdown strong')&&!!d.querySelector('.annotation-popup .confucius-annotation-markdown math')&&!d.querySelector('.annotation-popup .comment[data-confucius-editing]');`,
  );
  check(
    "Native save survives Escape dismissal and reopening with updated Markdown/math",
    await ui(
      `return d.querySelector('.annotation-popup .editor .content').id===q.marks[0].key&&q.marks[0].getTags().some(t=>t.tag==='§Methods')&&q.marks[0].annotationColor==='#ffd400';`,
    ),
  );
  await capture("pdf-popup-edited");
  await openPopup(1);
  await wait(
    `return d.querySelector('.annotation-popup .confucius-annotation-markdown')?.textContent==='Second annotation — no stale preview';`,
  );
  check("Switching annotations never reuses the previous comment", true);
  const untrusted =
    '<img src=x onerror="alert(1)">\n\n`<b>literal</b>` and **safe** [bad](javascript:alert)';
  await ui(
    `q.marks[1].annotationComment=${JSON.stringify(untrusted)};await q.marks[1].saveTx();return true;`,
  );
  await wait(
    `return !!d.querySelector('.annotation-popup .confucius-annotation-markdown code');`,
  );
  check(
    "Authored HTML stays text, code stays literal and unsafe links stay inert",
    await ui(
      `const p=d.querySelector('.annotation-popup .confucius-annotation-markdown');return !p.querySelector('img,script,[onerror],a')&&p.querySelector('code').textContent==='<b>literal</b>'&&p.querySelector('strong').textContent==='safe';`,
    ),
  );
  await openPopup(0);
  await wait(
    `return !!d.querySelector('.annotation-popup .confucius-annotation-markdown math');`,
  );
  if (process.env.CONFUCIUS_FLEX_XPI) {
    await ui(
      `d.querySelector('.annotation-popup header button.more').click();return true;`,
    );
    await wait(`return !!d.querySelector('.context-menu');`);
    report.menu = await ui(
      `return d.querySelector('.context-menu').textContent;`,
    );
    check(
      "Native annotation menu still contains the Flex edit action",
      /编辑|Edit/i.test(report.menu),
    );
    await ui(
      `r._internalReader._updateState(Components.utils.cloneInto({contextMenu:null},win));return true;`,
    );
  }
  await ui(`r._internalReader.setReadOnly(true);return true;`);
  await wait(
    `return !!d.querySelector('.annotation-popup .preview.read-only')&&!d.querySelector('.annotation-popup .confucius-annotation-edit');`,
  );
  check(
    "Read-only annotations render without exposing an editing action",
    await ui(
      `return !!d.querySelector('.annotation-popup .confucius-annotation-markdown math')&&!d.querySelector('.annotation-popup .content[contenteditable=true]');`,
    ),
  );
  await ui(`r._internalReader.setReadOnly(false);return true;`);
  await wait(
    `return !!d.querySelector('.annotation-popup .confucius-annotation-edit');`,
  );
  await ui(
    `q.marks[1].annotationComment='';await q.marks[1].saveTx();return true;`,
  );
  await openPopup(1);
  await wait(
    `return !!d.querySelector('.annotation-popup .content[contenteditable=true]')&&!d.querySelector('.annotation-popup .confucius-annotation-rendered')&&d.querySelectorAll('.annotation-popup .confucius-annotation-resize').length===4;`,
  );
  check("Empty comments retain a directly editable native input", true);
  await ui(
    `const h=d.querySelector('.confucius-annotation-resize');h.focus();h.dispatchEvent(new win.KeyboardEvent('keydown',Components.utils.cloneInto({key:'Delete',bubbles:true,cancelable:true},win)));return true;`,
  );
  check(
    "Resize controls also protect empty annotations from Delete",
    await ui(`return q.pdf.getAnnotations().length===2;`),
  );
  await openPopup();
  await wait(
    `return !!d.querySelector('.annotation-popup .confucius-annotation-rendered');`,
  );
  await ui(
    `q.beforeDisable={editor:d.querySelector('.annotation-popup .editor .content'),page:d.querySelector('.annotation-popup .page'),comment:q.marks[0].annotationComment,tags:JSON.stringify(q.marks[0].getTags())};return true;`,
  );
  await evaluate(
    `const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');await(await AddonManager.getAddonByID('confucius@zotero.plugin')).disable();return true;`,
  );
  await wait(
    `return !d.querySelector('.confucius-annotation-rendered')&&!d.getElementById('confucius-native-annotation-css');`,
  );
  check(
    "Disabling restores the original editor/header and leaves annotation data unchanged",
    await ui(
      `return d.querySelector('.annotation-popup .editor .content')===q.beforeDisable.editor&&d.querySelector('.annotation-popup .page')===q.beforeDisable.page&&!d.querySelector('[data-confucius-annotation]')&&!d.querySelector('.confucius-annotation-resize,.confucius-annotation-edit')&&!d.querySelector('.annotation-popup').style.getPropertyValue('--confucius-annotation-height')&&q.marks[0].annotationComment===q.beforeDisable.comment&&JSON.stringify(q.marks[0].getTags())===q.beforeDisable.tags;`,
    ),
  );
  report.nativeLocator = await ui(
    `return d.querySelector('.annotation-popup .page')?.textContent;`,
  );
  await evaluate(
    `const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');await(await AddonManager.getAddonByID('confucius@zotero.plugin')).enable();return true;`,
  );
  await wait(
    `return d.querySelectorAll('.annotation-popup .confucius-annotation-rendered').length===1;`,
  );
  check(
    "Re-enabling restores exactly one preview in an already-open reader",
    await ui(
      `return !!d.querySelector('.annotation-popup .confucius-annotation-markdown math')&&d.querySelector('.annotation-popup .page')===q.beforeDisable.page;`,
    ),
  );
  await ui(
    `r._internalReader.toggleSidebar(true);r._internalReader.setSidebarView('annotations');return true;`,
  );
  await wait(
    `return !!d.querySelector('[data-confucius-annotation=card] .confucius-annotation-edit');`,
  );
  await ui(
    `r._internalReader._updateState(Components.utils.cloneInto({selectedAnnotationIDs:q.marks.map(a=>a.key)},win));return true;`,
  );
  await wait(
    `return d.querySelectorAll('#annotationsView .annotation.selected').length===2;`,
  );
  await ui(
    `const p=d.querySelector('[data-confucius-annotation=card] .confucius-annotation-markdown');p.dispatchEvent(new win.PointerEvent('pointerdown',Components.utils.cloneInto({bubbles:true,cancelable:true,button:0},win)));p.dispatchEvent(new win.PointerEvent('pointerup',Components.utils.cloneInto({bubbles:true,button:0},win)));return true;`,
  );
  await wait(
    `return r._internalReader._state.selectedAnnotationIDs.length===1;`,
  );
  await ui(
    `d.querySelector('[data-confucius-annotation=card] .confucius-annotation-markdown').dispatchEvent(new win.KeyboardEvent('keydown',Components.utils.cloneInto({key:'Backspace',bubbles:true,cancelable:true},win)));return true;`,
  );
  check(
    "Reading a card selects that annotation and Backspace never deletes the prior multi-selection",
    await ui(
      `return r._internalReader._state.selectedAnnotationIDs[0]===q.marks[0].key&&r._internalReader._state.annotations.length===2&&q.pdf.getAnnotations().length===2;`,
    ),
  );
  await ui(
    `d.querySelector('[data-confucius-annotation=card] .confucius-annotation-edit').click();return true;`,
  );
  await wait(
    `return d.activeElement?.matches('#annotationsView .editor .content[contenteditable=true]');`,
  );
  check(
    "Sidebar Edit comment also opens the original editor",
    await ui(`return d.activeElement.id===q.marks[0].key;`),
  );
  await ui(`d.activeElement.blur();return true;`);
  await wait(
    `return !d.querySelector('#annotationsView .comment[data-confucius-editing]');`,
  );
  await capture("pdf-cards-final");
  check(
    "Reader reports no script errors during rendering or editing",
    await ui(`return q.errors.length===0;`),
  );
} catch (error) {
  report.error = String(error);
  report.debug = await ui(
    `return {type:r.type,active:d.activeElement?.outerHTML.slice(0,500),sidebar:r._internalReader._state.sidebarOpen,cards:d.querySelectorAll('[data-sidebar-annotation-id]').length,preview:d.querySelectorAll('.confucius-annotation-rendered').length,style:!!d.getElementById('confucius-native-annotation-css'),comments:[...d.querySelectorAll('.comment')].map(c=>c.outerHTML.slice(0,1000)),errors:q.errors};`,
  ).catch(String);
  console.log(report.debug);
  throw error;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  if (!process.env.CONFUCIUS_KEEP_TEST_INSTANCE)
    await instance.stop().catch(() => {});
}
