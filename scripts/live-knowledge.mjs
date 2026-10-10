/** Isolated Zotero regression. Only the model response and file picker are controlled. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  root,
  process.env.KNOWLEDGE_OUTPUT ?? "output/knowledge-index",
);
await mkdir(output, { recursive: true });
let researchRequests = 0;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const messages = body.messages ?? [];
  let text = "已整理研究问题，可以继续设计对照实验。";
  if (JSON.stringify(messages).includes("Maintain concise research memory")) {
    researchRequests++;
    const input = JSON.parse(
      messages.findLast((m) => m.role === "user").content,
    );
    const completed = input.user.includes("已完成对照实验");
    text = JSON.stringify([
      {
        ...(input.existing[0] ? { id: input.existing[0].id } : {}),
        type: "project",
        title: "Agent 长期记忆",
        content: completed
          ? "目标：研究 Agent 长期记忆。\n- 检索可靠性：已完成对照实验，问题已解决。\n- 下一步：整理结果。"
          : "目标：研究 Agent 长期记忆。\n- 未解决问题：检索可靠性。\n- 下一步：设计对照实验。",
        evidence: input.user,
        status: completed ? "completed" : "active",
      },
    ]);
  }
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 600, completion_tokens: 120, total_tokens: 720 },
    }),
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const instance = await IsolatedZotero.create({
  root,
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi: join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "knowledge-index-",
});
await appendFile(
  join(instance.profile, "user.js"),
  [
    '\nuser_pref("extensions.zotero.confucius.workspaceLayout", "window");',
    'user_pref("extensions.zotero.confucius.pluginRuntimeHost", false);',
    'user_pref("extensions.zotero.confucius.workspaceWidth", 1100);',
  ].join("\n"),
);
const result = {
  checks: [],
  model: "controlled responses; no model-quality claim",
};
const check = (label) => {
  result.checks.push(label);
  console.log("PASS", label);
};
const evaluate = (code) =>
  instance.rdp.evaluate(
    `
  const host=Zotero.Confucius.hooks.host;
  const win=[...Services.wm.getEnumerator(null)].find(w=>w.location.href==='chrome://confucius/content/workspace.xhtml');
  const d=win?.document;
  const ad=d?.querySelector('iframe.confucius-artifact-host')?.contentDocument;
  const aw=ad?.defaultView;
  ${code}
`,
    30000,
  );
const wait = (code) => until(() => evaluate(code), 20000, 100);
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
    `const shell=d.querySelector('.confucius-knowledge-shell'),list=d.querySelector('.confucius-knowledge-results'),detail=d.querySelector('.confucius-knowledge-index-detail'),box=shell.getBoundingClientRect();return {width:win.innerWidth,inside:box.left>=0&&box.right<=win.innerWidth+1&&box.bottom<=win.innerHeight+1,overflow:shell.scrollWidth-shell.clientWidth,listHeight:list.clientHeight,detailHeight:detail.clientHeight,columns:win.getComputedStyle(d.querySelector('.confucius-knowledge-index-body')).gridTemplateColumns};`,
  );
const task = (title) =>
  instance.rpc("task/new", { title, titleState: "fixed", backend: "native" });
async function turn(taskId, text) {
  const started = await instance.rpc("task/prompt", { taskId, text });
  await until(
    async () => {
      const row = await instance.rpc("task/load", { taskId });
      if (row.status === "failed")
        throw new Error(JSON.stringify(row.lastError));
      return (
        row.status === "completed" &&
        !row.postProcessing?.some(
          (j) => j.turnId === started.turnId && j.pending.length,
        )
      );
    },
    30000,
    100,
  );
}
const openKnowledge = async () => {
  await evaluate(
    `d.getElementById('confucius-knowledge').click();return true;`,
  );
  await wait(`return !!d.querySelector('.confucius-knowledge-result');`);
};
const select = async (sourceId) => {
  await evaluate(
    `const row=[...d.querySelectorAll('.confucius-knowledge-result')].find(row=>row.dataset.source===${JSON.stringify(sourceId)});if(!row)throw new Error('Missing index item');row.click();return true;`,
  );
  await wait(
    `const error=d.querySelector('.confucius-knowledge-error')?.textContent;if(error)throw new Error(error);return !!d.querySelector('.confucius-knowledge-index-detail article');`,
  );
};
try {
  result.environment = {
    ...(await instance.launch()),
    platform: process.platform,
  };
  await instance.rpc("config/set", {
    endpoint: {
      name: "Synthetic research",
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "synthetic-test-key",
      model: "private-alias",
      contextWindowTokens: 32768,
      maxTokens: 2048,
    },
    streamResponses: false,
    memoryConsent: "review",
    uiTheme: "light",
  });
  const first = await task("长期记忆课题");
  await turn(
    first.id,
    "我正在研究 Agent 长期记忆，需要持续追踪检索可靠性这个问题。",
  );
  const projects = (await instance.rpc("knowledge/index", {})).items.filter(
    (r) => r.kind === "project",
  );
  assert.equal(projects.length, 1);
  const projectId = projects[0].id;
  assert.match(
    (await instance.rpc("knowledge/read", { id: projectId })).content,
    /未解决问题/,
  );
  const second = await task("长期记忆进展");
  await turn(
    second.id,
    "我研究的 Agent 长期记忆课题，检索可靠性已完成对照实验，这个问题已经解决。",
  );
  const evolved = await instance.rpc("knowledge/read", { id: projectId });
  assert.match(evolved.content, /已解决/);
  assert.deepEqual(evolved.sourceRefs, [
    `task:${first.id}`,
    `task:${second.id}`,
  ]);
  assert.equal(
    (await instance.rpc("knowledge/index", {})).items.filter(
      (r) => r.kind === "project",
    ).length,
    1,
  );
  assert.equal(researchRequests, 2);
  check(
    "Real completed turns maintain one research topic across tasks, with updated question state and provenance",
  );

  const created = await instance.rpc("artifact/upsert", {
    taskId: first.id,
    kind: "report",
    title: "知识索引回归报告",
    body: {
      type: "markdown",
      markdown:
        "# 知识索引回归报告\n\n检索与记忆。公式 $x^2$。\n\n[来源](https://example.com/paper)\n\n| 项目 | 状态 |\n| --- | --- |\n| 检索 | 完成 |",
    },
    status: "ready",
  });
  const artifactId = created.artifact.id;
  const preview = await instance.rpc("artifact/writebackPreview", {
    id: artifactId,
  });
  assert.equal(preview.target, "zotero_note");
  const commit = await instance.rpc("artifact/writebackCommit", {
    id: artifactId,
  });
  await instance.rpc("approval/resolve", {
    id: commit.approvalId,
    verdict: "allow",
    scope: "once",
  });
  const saved = await until(
    async () => {
      const row = (await instance.rpc("artifact/get", { id: artifactId }))
        .artifact;
      if (row.writeback?.state === "failed")
        throw new Error(JSON.stringify(row.writeback));
      return row.writeback?.state === "committed" && row;
    },
    20000,
    100,
  );
  const sourceId = `note:${saved.writeback.targetRef}`;
  const note = await instance.rpc("knowledge/read", { id: sourceId });
  assert.match(note.content, /知识索引回归报告/);
  assert.equal(
    (await instance.rpc("knowledge/index", { query: "回归报告" })).items[0].id,
    sourceId,
  );
  const again = await instance.rpc("artifact/writebackCommit", {
    id: artifactId,
  });
  await instance.rpc("approval/resolve", {
    id: again.approvalId,
    verdict: "allow",
    scope: "once",
  });
  await until(
    async () =>
      (await instance.rpc("artifact/get", { id: artifactId })).artifact
        .writeback?.state === "committed",
    20000,
    100,
  );
  assert.equal(
    (await instance.rpc("knowledge/index", {})).items.filter(
      (r) => r.kind === "note",
    ).length,
    1,
  );
  check(
    "A report saves to a native Zotero note without any knowledge base; repeat save reuses it",
  );
  const unloadNote = async () => {
    const unloaded = await evaluate(
      `const libraryID=${note.source.libraryID},key=${JSON.stringify(note.source.key)};const item=await Zotero.Items.getByLibraryAndKeyAsync(libraryID,key);Zotero.Items.unload(item.id);const cold=await Zotero.Items.getAsync(item.id);try{cold.getNote();return false;}catch(error){return error instanceof Zotero.Exception.UnloadedDataException;}`,
    );
    assert.equal(
      unloaded,
      true,
      "The regression must start from an unloaded native note",
    );
  };
  await unloadNote();
  assert.equal(
    (await instance.rpc("knowledge/index", { query: "回归报告" })).items[0].id,
    sourceId,
  );
  await unloadNote();
  assert.match(
    (await instance.rpc("knowledge/read", { id: sourceId })).content,
    /知识索引回归报告/,
  );
  check(
    "Searching and reading explicitly load cold native note data without requiring the user to open the source first",
  );
  await evaluate(
    `const item=await Zotero.Items.getByLibraryAndKeyAsync(${note.source.libraryID},${JSON.stringify(note.source.key)});item.setNote('<h1>原生修改后的笔记</h1><p>原生正文更新，公式 <span class="math">$x^2$</span>。</p><table><tr><th>项目</th><td>完成</td></tr></table><a href="https://example.com/paper">来源</a><img src="https://example.com/image.png"><script>window.unwanted=true</script>');await item.saveTx();return true;`,
  );
  assert.match(
    (await instance.rpc("artifact/export", { id: artifactId })).content,
    /原生正文更新/,
  );
  assert.match(
    (await instance.rpc("knowledge/read", { id: sourceId })).content,
    /原生正文更新/,
  );
  check(
    "Reading and exporting a saved report resolve the current native note after a Zotero edit",
  );

  await evaluate(
    `Zotero.getMainWindow().document.getElementById('confucius-toolbar-button').dispatchEvent(new (Zotero.getMainWindow().Event)('command'));return true;`,
  );
  await wait(`return !!d?.getElementById('confucius-knowledge');`);
  await openKnowledge();
  await select(sourceId);
  const wide = await geometry();
  assert(
    wide.inside &&
      wide.overflow <= 1 &&
      wide.listHeight > 100 &&
      wide.detailHeight > 150,
    JSON.stringify(wide),
  );
  await screen("zh-light-notes");
  const exportPath = join(output, "native-note.html");
  await evaluate(
    `const toolkit=Zotero.Confucius.data.ztoolkit;win.__knowledgePicker=Object.getOwnPropertyDescriptor(toolkit,'FilePicker');Object.defineProperty(toolkit,'FilePicker',{configurable:true,value:class{async open(){return ${JSON.stringify(exportPath)};}}});[...d.querySelectorAll('.confucius-knowledge-actions button')].find(b=>b.textContent==='导出文件').click();return true;`,
  );
  const exported = await until(
    async () => readFile(exportPath, "utf8"),
    10000,
    100,
  );
  assert.match(exported, /原生正文更新/);
  assert.match(exported, /<math\b/);
  assert.match(exported, /<table/);
  assert.match(exported, /href="https:\/\/example.com\/paper"/);
  assert.doesNotMatch(exported, /<script|<img|onerror|window.unwanted/);
  await evaluate(
    `const toolkit=Zotero.Confucius.data.ztoolkit;if(win.__knowledgePicker)Object.defineProperty(toolkit,'FilePicker',win.__knowledgePicker);else delete toolkit.FilePicker;return true;`,
  );
  check(
    "The production export button writes readable HTML with math, tables and checked links; active content and external resources are omitted (controlled file picker)",
  );

  await select(projectId);
  await evaluate(
    `const sources=d.querySelector('.confucius-knowledge-index-detail details');sources.open=true;const link=[...sources.querySelectorAll('button')].find(b=>b.textContent==='长期记忆课题');if(!link)throw new Error('Missing source task link');link.click();return true;`,
  );
  await wait(`return !!d.querySelector('[data-artifact-id="${artifactId}"]');`);
  await evaluate(
    `d.querySelector('[data-artifact-id="${artifactId}"]').click();return true;`,
  );
  await wait(`return !!ad.getElementById('confucius-artifact-writeback');`);
  assert.equal(
    await evaluate(
      `return ad.getElementById('confucius-artifact-writeback').textContent;`,
    ),
    "Zotero 笔记",
  );
  assert.equal(
    await evaluate(`return !!ad.getElementById('confucius-artifact-export');`),
    true,
  );
  await evaluate(
    `ad.getElementById('confucius-artifact-writeback').click();return true;`,
  );
  await wait(
    `return !!ad.getElementById('confucius-writeback-overlay')&&ad.querySelector('.confucius-note-save-preview').textContent.includes('知识索引回归报告');`,
  );
  assert.equal(
    await evaluate(
      `return aw.getComputedStyle(ad.querySelector('.confucius-note-save-controls')).display;`,
    ),
    "none",
  );
  assert.equal(
    await evaluate(
      `return !!ad.querySelector('#confucius-writeback-overlay input');`,
    ),
    false,
  );
  await screen("zh-report-save-preview");
  await evaluate(
    `ad.getElementById('confucius-writeback-cancel').click();ad.getElementById('confucius-artifact-back').click();return true;`,
  );
  await openKnowledge();
  check(
    "Memory sources open their conversations; the report view offers note save and file export, with no destination or internal ID field",
  );

  await select(projectId);
  await evaluate(
    `[...d.querySelectorAll('.confucius-knowledge-actions button')].find(b=>b.textContent==='纠正记忆').click();const input=d.querySelector('.confucius-knowledge-memory-input');input.value='人工纠正：只追踪检索可靠性，不推断额外偏好。';input.focus();input.dispatchEvent(new win.Event('input',{bubbles:true}));return true;`,
  );
  await evaluate(
    `host.emitSessionEvent(host.sessions.get(${JSON.stringify(first.id)}),undefined,'memory_updated',{op:'update',id:${JSON.stringify(projectId.slice(7))},total:host.memory.stats().total});await new Promise(resolve=>win.setTimeout(resolve,1500));return true;`,
  );
  await evaluate(
    `const input=d.querySelector('.confucius-knowledge-memory-input');if(!input||d.activeElement!==input||!input.value.startsWith('人工纠正'))throw new Error('Draft lost');[...input.parentNode.querySelectorAll('button')].find(b=>b.textContent==='保存').click();return true;`,
  );
  await until(
    async () =>
      (await instance.rpc("knowledge/read", { id: projectId })).protected,
    10000,
    100,
  );
  await turn(second.id, "我正在研究 Agent 长期记忆，需要追踪新的假设。");
  assert.match(
    (await instance.rpc("knowledge/read", { id: projectId })).content,
    /^人工纠正/,
  );
  check(
    "Manual correction is protected against subsequent automatic topic updates",
  );

  await instance.rpc("config/set", { uiTheme: "dark", uiLanguage: "en-US" });
  await evaluate(
    `d.getElementById('confucius-knowledge-overlay')?.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));win.resizeTo(520,760);return true;`,
  );
  await wait(`return win.innerWidth<620;`);
  if (
    !(await evaluate(
      `return !!d.getElementById('confucius-knowledge-overlay');`,
    ))
  )
    await openKnowledge();
  await select(projectId);
  const narrow = await geometry();
  assert(
    narrow.inside &&
      narrow.overflow <= 1 &&
      narrow.listHeight > 50 &&
      narrow.detailHeight > 100,
    JSON.stringify(narrow),
  );
  await screen("en-dark-memory-compact");
  check(
    "Chinese light and compact English dark knowledge views have readable panes and no horizontal overflow",
  );
  await evaluate(
    `win.__knowledgeConfirm=win.confirm;win.confirm=()=>true;[...d.querySelectorAll('.confucius-knowledge-actions button')].find(b=>b.textContent==='Forget').click();return true;`,
  );
  await until(
    async () =>
      !(await instance.rpc("knowledge/index", {})).items.some(
        (r) => r.id === projectId,
      ),
    10000,
    100,
  );
  await turn(second.id, "我正在研究 Agent 长期记忆，需要追踪新的假设。");
  assert.equal(
    (await instance.rpc("knowledge/index", {})).items.filter(
      (r) => r.kind === "project",
    ).length,
    0,
  );
  await evaluate(
    `win.confirm=win.__knowledgeConfirm;const item=await Zotero.Items.getByLibraryAndKeyAsync(${note.source.libraryID},${JSON.stringify(note.source.key)});item.deleted=true;await item.saveTx();return true;`,
  );
  await assert.rejects(
    instance.rpc("knowledge/read", { id: sourceId }),
    /deleted or is unavailable/,
  );
  assert.equal(
    (await instance.rpc("knowledge/index", {})).items.filter(
      (r) => r.kind === "note",
    ).length,
    0,
  );
  check(
    "Forget suppresses later same-topic maintenance; trashing a source note removes it from the index",
  );

  const child = await evaluate(`
    const parent = new Zotero.Item('book');
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField('title', 'Knowledge parent trash regression');
    await parent.saveTx();
    const note = new Zotero.Item('note');
    note.libraryID = parent.libraryID;
    note.parentItemID = parent.id;
    note.setNote('<p>parenttrashmarker</p>');
    await note.saveTx();
    return {id:'note:'+note.libraryID+':'+note.key, parentId:parent.id, noteId:note.id};
  `);
  assert.equal(
    (await instance.rpc("knowledge/index", { query: "parenttrashmarker" }))
      .total,
    1,
  );
  const trashState = await evaluate(`
    await Zotero.Items.trashTx([${child.parentId}]);
    const note = await Zotero.Items.getAsync(${child.noteId});
    return {deleted:note.deleted, inTrash:note.isInTrash()};
  `);
  assert.deepEqual(trashState, { deleted: false, inTrash: true });
  assert.equal(
    (await instance.rpc("knowledge/index", { query: "parenttrashmarker" }))
      .total,
    0,
  );
  await assert.rejects(
    instance.rpc("knowledge/read", { id: child.id }),
    /deleted or is unavailable/,
  );
  await evaluate(`
    const parent = await Zotero.Items.getAsync(${child.parentId});
    parent.deleted=false;
    await parent.saveTx();
    return true;
  `);
  assert.equal(
    (await instance.rpc("knowledge/index", { query: "parenttrashmarker" }))
      .items[0].id,
    child.id,
  );
  assert.match(
    (await instance.rpc("knowledge/read", { id: child.id })).content,
    /parenttrashmarker/,
  );
  check(
    "Trashing a parent hides its child note from search and direct reads; restoring the parent restores the source",
  );

  const fileRefresh = await evaluate(`
    const record = await host.memory.save({title:'File refresh regression',content:'oldfilemarker',protection:'none'});
    const path = host.memory.store.memoriesDir + '/' + record.id + '.md';
    const original = await IOUtils.readUTF8(path);
    const modified = original.replace('oldfilemarker','newfilemarker');
    await IOUtils.writeUTF8(path, modified);
    const edited = await host.rpc('knowledge/index',{query:'newfilemarker'});
    const old = await host.rpc('knowledge/index',{query:'oldfilemarker'});
    const untouched = (await IOUtils.readUTF8(path)) === modified;
    const afterSearch = host.memory.get(record.id);
    const access = {count:afterSearch.accessCount,usedAt:afterSearch.lastUsedAt ?? null};
    await IOUtils.remove(path);
    const removed = await host.rpc('knowledge/index',{query:'newfilemarker'});
    const addedPath = host.memory.store.memoriesDir + '/mem_external_regression.md';
    const added = original.replace('id: '+record.id,'id: mem_external_regression').replace('oldfilemarker','externalfilemarker');
    await IOUtils.writeUTF8(addedPath, added);
    const found = await host.rpc('knowledge/index',{query:'externalfilemarker'});
    const read = await host.rpc('knowledge/read',{id:'memory:mem_external_regression'});
    return {edited:edited.total,old:old.total,removed:removed.total,added:found.total,
      untouched,access,content:read.content,addedUntouched:(await IOUtils.readUTF8(addedPath))===added};
  `);
  assert.deepEqual(fileRefresh, {
    edited: 1,
    old: 0,
    removed: 0,
    added: 1,
    untouched: true,
    access: { count: 0, usedAt: null },
    content: "externalfilemarker",
    addedUntouched: true,
  });
  check(
    "Filesystem edits, deletions and additions refresh the knowledge index without rewriting sources or renewing search retention",
  );
  result.geometry = { wide, narrow };
  result.researchRequests = researchRequests;
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = String(error);
  if (instance.rdp) {
    result.ui = await evaluate(
      `return {error:d?.querySelector('.confucius-knowledge-error')?.textContent,detail:d?.querySelector('.confucius-knowledge-index-detail')?.innerHTML};`,
    ).catch(() => null);
    await screen("failure").catch(() => {});
  }
  throw error;
} finally {
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  await instance.stop().catch(() => {});
  await new Promise((done) => server.close(done));
}
