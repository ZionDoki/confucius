#!/usr/bin/env node
// Built-XPI acceptance in an isolated Zotero profile. All content is synthetic.
// node --import tsx scripts/live-context-memory.mjs [--codex PATH] [--kimi PATH]
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { serializeMemory } from "@confucius/memory";
import { contextTextTokens } from "@confucius/protocol";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
import { resolveZoteroExecutable } from "../apps/zotero-addon/src/development/zoteroExecutable.ts";

const { values } = parseArgs({
  options: {
    codex: { type: "string" },
    kimi: { type: "string" },
    output: { type: "string" },
  },
});
const root = resolve(import.meta.dirname, "..");
const output = resolve(
  values.output ??
    join(
      root,
      "output/context-memory-acceptance",
      new Date().toISOString().replaceAll(":", "-"),
    ),
);
await mkdir(join(output, "apps/zotero-addon/.scaffold"), { recursive: true });
const xpi = join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi");
const report = {
  startedAt: new Date().toISOString(),
  xpiSha256: createHash("sha256")
    .update(await readFile(xpi))
    .digest("hex"),
  checks: [],
  models: [],
  environment: null,
};
const save = () =>
  writeFile(join(output, "results.json"), JSON.stringify(report, null, 2));
const check = async (name, condition, details) => {
  report.checks.push({ name, pass: Boolean(condition), details });
  await save();
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  assert.ok(condition, name);
};
let mode = "valid";
let failRequests = 0;
const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const prompt = body.messages.map((m) => m.content ?? "").join("\n");
  const maintenance = prompt.includes("Distill ordinary research work");
  requests.push({
    maintenance,
    inputEstimate: contextTextTokens(JSON.stringify(body.messages)),
    maxTokens: body.max_tokens ?? body.max_completion_tokens,
    mode,
  });
  res.setHeader("content-type", "application/json");
  if (maintenance && failRequests-- > 0) {
    res.statusCode = 503;
    res.setHeader("retry-after", "2");
    res.end(
      JSON.stringify({ error: { message: "Injected transient failure" } }),
    );
    return;
  }
  const text = maintenance
    ? mode === "invalid"
      ? "[{truncated"
      : JSON.stringify([
          {
            op: "add",
            type: "note",
            title: "Retained controlled experiment",
            content: `Retained conclusion ${prompt.match(/CASE_[A-Z0-9_]+/)?.[0] ?? "CASE_DEFAULT"}: use threshold 0.72 only with dataset revision B; pending validation on revision C. Source: fixture://study/revision-B.`,
          },
        ])
    : "This controlled test turn is complete.";
  res.end(
    JSON.stringify({
      id: `fixture_${requests.length}`,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }),
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const z = await IsolatedZotero.create({
  root: output,
  binary: resolveZoteroExecutable().path,
  xpi,
  prefix: "isolated-",
});
// The shared harness disables automatic memory through user.js. This test owns
// that preference through the actual settings RPC; a startup override would
// invalidate both persistence checks and post-restart maintenance.
const userPrefs = join(z.profile, "user.js");
await writeFile(
  userPrefs,
  (await readFile(userPrefs, "utf8"))
    .split("\n")
    .filter(
      (line) => !line.includes('"extensions.zotero.confucius.memoryConsent"'),
    )
    .join("\n"),
  { mode: 0o600 },
);
const memoryRoot = join(z.data, "confucius/memory");
const legacyAt = Date.now() - 400 * 86400000;
await mkdir(join(memoryRoot, "memories"), { recursive: true });
for (const [id, tags] of [
  ["legacy_user", []],
  ["legacy_automatic", ["promoted-from-log"]],
]) {
  await writeFile(
    join(memoryRoot, "memories", `${id}.md`),
    serializeMemory({
      id,
      type: "note",
      title: id,
      content: `Legacy synthetic ${id}`,
      tags,
      createdAt: legacyAt,
      updatedAt: legacyAt,
      lastAccessedAt: legacyAt,
      accessCount: 999,
      confidence: 1,
      history: [],
    }),
  );
}
const evaluate = (source) =>
  z.rdp.evaluate(
    `if(PathUtils.profileDir!==${JSON.stringify(z.profile)}||Zotero.DataDirectory.dir!==${JSON.stringify(z.data)})throw new Error("Wrong isolated profile");const h=Zotero.Confucius.hooks.host;${source}`,
    60000,
  );
const bootstrap = () =>
  evaluate(`
  globalThis.cmMaintenanceTurn=null;
  const schedule=h.scheduleContextMaintenance.bind(h);
  h.scheduleContextMaintenance=async(...args)=>{try{return await schedule(...args);}finally{globalThis.cmMaintenanceTurn=args[1];}};
  return true;
`);
const configure = () =>
  z.rpc("config/set", {
    memoryConsent: "review",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: "context-acceptance-fixture",
    apiKey: "fixture-only",
    streamResponses: false,
    maxTokens: 1000,
    contextWindowTokens: 32768,
    maxIterations: 8,
    maxToolCalls: 20,
  });
const tool = async (taskId, name, args) => {
  const result = await z.rpc("task/toolCall", {
    taskId,
    name,
    arguments: args,
  });
  return JSON.parse(result.content.find((c) => c.type === "text").text);
};
const task = async (title, backend = "native") => {
  const record = await z.rpc("task/new", { title, backend, mode: "agent" });
  await evaluate(
    `const s=h.sessions.get(${JSON.stringify(record.id)});s.record.titleState="fixed";await h.persistNow();return true;`,
  );
  return record.id;
};
const memory = (id) =>
  evaluate(
    `await h.memory.ensureLoaded();return h.memory.get(${JSON.stringify(id)})??null;`,
  );
const maintenanceCalls = () => requests.filter((r) => r.maintenance).length;
const finish = async (taskId) => {
  const sent = await z.rpc("task/prompt", {
    taskId,
    text: "Complete this controlled short test. Do not call tools.",
  });
  await until(
    () =>
      evaluate(
        `const s=h.sessions.get(${JSON.stringify(taskId)});return !s.activeTurnId&&s.record.status==="completed"&&globalThis.cmMaintenanceTurn===${JSON.stringify(sent.turnId)};`,
      ),
    30000,
    100,
  );
  await evaluate("await h.maintenanceQueue;await h.persistNow();return true;");
  return sent;
};
const oldTask = async (
  label,
  days = 40,
  evidence = { threshold: "0.72", revision: "B", pending: "C" },
) => {
  const id = await task(label);
  const raw = `RAW_DELETE_${label}`;
  const content = `${raw}\nCASE_${label}: use threshold ${evidence.threshold} only with dataset revision ${evidence.revision}; pending validation on revision ${evidence.pending}. Source fixture://study/revision-${evidence.revision}.`;
  const saved = await tool(id, "context_save", {
    target: "note",
    name: "progress",
    content,
  });
  assert.ok(saved.ok, `Preparing ${label}: ${saved.message}`);
  await evaluate(`
    const s=h.sessions.get(${JSON.stringify(id)}), content=${JSON.stringify(content)};
    await h.history.writeNote(s.record.id,"progress",content+"\\nSecond revision");
    await h.history.append({taskId:s.record.id,windowId:s.record.contextWindow.id,itemId:"body",role:"user",content,sourceIds:[]});
    await h.logs.appendTurn({sessionId:s.record.id,title:s.record.title,turnId:"seed",userText:content,assistantText:"Finished controlled work"});
    s.messages=[{role:"user",content},{role:"assistant",content:"Finished controlled work"}];
    s.record.status="completed";s.record.updatedAt=Date.now()-${days}*86400000;s.activeTurnId=null;
    await h.persistNow();return true;
  `);
  return {
    id,
    raw,
    ref: `h:${id}:${(await z.rpc("task/load", { taskId: id })).contextWindow.id}:body`,
  };
};
const retired = (id) =>
  evaluate(
    `return Boolean(h.sessions.get(${JSON.stringify(id)})?.record.historyClearedAt);`,
  );
const jobs = (id) =>
  evaluate(
    `return h.sessions.get(${JSON.stringify(id)}).record.postProcessing??[];`,
  );
const drain = async (owner) => {
  await z.rpc("task/retryPostProcessing", { taskId: owner });
  await evaluate("await h.persistNow();return true;");
};
async function diskFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await diskFiles(path)));
    else if (/\.(json|md|txt)$/.test(path)) files.push(path);
  }
  return files;
}
async function rawCopies(raw) {
  const paths = [
    ...new Set([
      ...(await diskFiles(join(z.profile, "confucius"))),
      ...(await diskFiles(join(z.data, "confucius"))),
    ]),
  ];
  const matches = [];
  for (const path of paths)
    if ((await readFile(path, "utf8")).includes(raw))
      matches.push(path.replace(output, "<output>"));
  return matches;
}
const openTask = async (id) => {
  await evaluate(
    `const w=Zotero.getMainWindow();if(!w.document.getElementById("confucius-root"))w.document.getElementById("confucius-toolbar-button").dispatchEvent(new w.Event("command"));return true;`,
  );
  await until(
    () =>
      evaluate(
        `const d=Zotero.Confucius.data.workspaceWindow?.document??Zotero.getMainWindow().document;const b=d.querySelector('[data-task-id="${id}"] .confucius-task-open');if(!b)return false;b.click();return true;`,
      ),
    15000,
    150,
  );
};
const approveInUI = async (proposal, verdict) => {
  await until(
    () =>
      evaluate(
        `const d=Zotero.Confucius.data.workspaceWindow?.document??Zotero.getMainWindow().document;const c=d.querySelector('[data-entry-id="memory-proposal:${proposal.id}"]');const b=c&&[...c.querySelectorAll("button")].find(b=>b.textContent.trim()===${JSON.stringify(verdict === "accept" ? "√" : "×")});if(!b)return false;b.click();return true;`,
      ),
    15000,
    150,
  );
  return until(
    async () => {
      const rows = await z.rpc("memory/proposal/list");
      const result = rows.proposals.find((p) => p.id === proposal.id);
      return result?.status === (verdict === "accept" ? "accepted" : "rejected")
        ? result
        : false;
    },
    10000,
    100,
  );
};

try {
  report.environment = await z.launch();
  await save();
  await configure();
  await bootstrap();
  const migrated = await evaluate(
    "return [h.memory.get('legacy_user'),h.memory.get('legacy_automatic')];",
  );
  await check(
    "Legacy IDs, protection and fresh unread retention survive real Markdown migration",
    migrated[0]?.protection === "user" &&
      migrated[1]?.protection === "none" &&
      migrated.every(
        (m) =>
          m.accessCount === 0 &&
          !m.lastUsedAt &&
          m.retentionStartedAt > legacyAt,
      ),
    migrated,
  );
  const usageTask = await task("Memory operations");
  const first = await tool(usageTask, "context_save", {
    target: "memory",
    title: "Read retention",
    content: "ACTIVE_READ_SENTINEL reading renews retention.",
  });
  assert.ok(first.ok);
  const mid = first.data.ref.slice(2);
  const beforeSearch = await memory(mid);
  for (let i = 0; i < 8; i++)
    await tool(usageTask, "context_search", { query: "ACTIVE_READ_SENTINEL" });
  await z.rpc("memory/list");
  await check(
    "Searching and opening the memory list do not renew actual use",
    (await memory(mid)).lastUsedAt === beforeSearch.lastUsedAt &&
      (await memory(mid)).accessCount === 0,
  );
  assert.ok(
    (await tool(usageTask, "context_read", { ref: first.data.ref })).ok,
  );
  const used = await memory(mid);
  await tool(usageTask, "context_read", {
    ref: first.data.ref,
    offset: 999999,
  });
  await check(
    "Successful explicit read renews retention; EOF does not",
    used.lastUsedAt > 0 && (await memory(mid)).accessCount === 1,
  );

  const unicode = "中文🧪abc".repeat(230);
  const paged = await tool(usageTask, "context_save", {
    target: "memory",
    content: unicode,
  });
  assert.ok(paged.ok, paged.message);
  let assembled = "",
    offset = 0,
    pages = 0;
  do {
    const read = await tool(usageTask, "context_read", {
      ref: paged.data.ref,
      offset,
      maxTokens: 170,
    });
    assert.ok(read.ok);
    assert.ok(read.data.tokens <= 170);
    assembled += read.data.content;
    offset = read.data.nextOffset;
    pages++;
  } while (offset !== null);
  await check(
    "Native host tool pagination preserves Chinese and emoji exactly",
    assembled === unicode && pages > 1,
    { pages },
  );
  const proposed = await tool(usageTask, "context_save", {
    target: "memory",
    protected: true,
    title: "Protected user preference",
    content: "PRESERVE_USER_MEMORY explicit preference",
  });
  assert.ok(proposed.ok && proposed.data.requiresApproval);
  await openTask(usageTask);
  await approveInUI(proposed.data.proposal, "accept");
  const protectedId = `mem_${proposed.data.proposal.id}`;
  const removal = await tool(usageTask, "context_save", {
    target: "memory",
    id: protectedId,
    delete: true,
  });
  await approveInUI(removal.data.proposal, "reject");
  await check(
    "Real approval controls protect content and rejecting deletion keeps it",
    (await memory(protectedId))?.protection === "user",
  );
  const unprotect = await z.rpc("memory/protect", {
    taskId: usageTask,
    id: protectedId,
    protected: false,
  });
  await check(
    "Unprotect is pending and cannot change protection before confirmation",
    (await memory(protectedId)).protection === "user",
  );
  await approveInUI(unprotect.proposal, "accept");
  await check(
    "Accepting unprotect changes the stored protection",
    (await memory(protectedId)).protection === "none",
  );

  const ttl = await evaluate(`
    const clock=h.memory.now, base=clock();h.memory.now=()=>base;
    for(const id of ['ttl_cold','ttl_warm','ttl_protected'])await h.memory.save({id,content:id+" independent experiment",protection:id==='ttl_protected'?'user':'none'});
    h.memory.now=()=>base+89*86400000;await h.memory.search({query:'ttl_cold'});await h.memory.read('ttl_warm');await h.memory.update({id:'ttl_cold',content:'ttl_cold revised independent experiment'},true);
    h.memory.now=()=>base+91*86400000;const removed=await h.memory.maintain();h.memory.now=clock;
    return {removed:removed.map(x=>x.id),cold:h.memory.get('ttl_cold')??null,warm:h.memory.get('ttl_warm'),protected:h.memory.get('ttl_protected')};
  `);
  await check(
    "Advancing the memory clock expires search-only and background-merged work, keeping explicit reads and protected records",
    !ttl.cold && ttl.warm && ttl.protected && ttl.removed.includes("ttl_cold"),
  );
  await check(
    "Expired body and its Markdown overview copy disappear from disk",
    !(
      await Promise.all(
        (await diskFiles(memoryRoot)).map((p) => readFile(p, "utf8")),
      )
    ).some((s) => s.includes("ttl_cold")),
  );

  const kb = await z.rpc("knowledge/create", {
    title: "Persistent acceptance knowledge",
  });
  await z.rpc("knowledge/saveEntry", {
    knowledgeBaseId: kb.knowledgeBase.id,
    kind: "note",
    title: "Keep",
    content: "PRESERVE_KNOWLEDGE_ENTRY",
  });
  const capacity = await evaluate(`
    for(const m of await h.memory.list({limit:10000}))if(!m.tags.some(t=>t.startsWith('kb:')||t==='knowledge-base'))await h.memory.delete(m.id);
    for(let i=0;i<200;i++)await h.memory.save({id:'capacity_'+i,content:'Protected capacity '+i,protection:'user'});
    return h.memory.retentionStats();
  `);
  const overflow = await tool(usageTask, "context_save", {
    target: "memory",
    content: "Ordinary overflow must be refused",
  });
  await check(
    "200 protected entries refuse new ordinary memory without evicting protection",
    !overflow.ok &&
      /capacity/i.test(overflow.message) &&
      capacity.entries === 200,
    { capacity, message: overflow.message },
  );
  await evaluate(
    "for(let i=0;i<200;i++)await h.memory.delete('capacity_'+i);return true;",
  );
  const lru = await evaluate(`
    const clock=h.memory.now, base=clock();
    for(let i=0;i<200;i++){h.memory.now=()=>base+i;await h.memory.save({id:'lru_'+i,content:'Ordinary LRU entry '+i,protection:'none'});}
    h.memory.now=()=>base+1000;await h.memory.read('lru_0');
    h.memory.now=()=>base+2000;await h.memory.save({id:'lru_new',content:'Newest ordinary LRU entry',protection:'none'});h.memory.now=clock;
    const result={warm:!!h.memory.get('lru_0'),oldest:!!h.memory.get('lru_1'),stats:h.memory.retentionStats()};
    for(let i=0;i<200;i++)await h.memory.delete('lru_'+i);await h.memory.delete('lru_new');return result;
  `);
  await check(
    "Entry capacity evicts the least recently used ordinary record and keeps a recently read record",
    lru.warm && !lru.oldest && lru.stats.entries === 200,
    lru,
  );
  const tokenCapacity = await evaluate(`
    for(let i=0;i<5;i++)await h.memory.save({id:'token_'+i,content:'数'.repeat(2600)+i,protection:'none'});
    const result=h.memory.retentionStats();for(let i=0;i<5;i++)await h.memory.delete('token_'+i);return result;
  `);
  await check(
    "Body-token capacity evicts before the entry-count limit is reached",
    tokenCapacity.tokens <= 16000 && tokenCapacity.entries < 5,
    tokenCapacity,
  );

  const owner = await task("Maintenance owner");
  const callsBeforeShort = maintenanceCalls();
  await finish(owner);
  await check(
    "An ordinary completed short turn triggers no memory model request",
    maintenanceCalls() === callsBeforeShort,
  );
  const batch = [];
  for (let i = 0; i < 12; i++) batch.push(await oldTask(`COUNT_${i}`, 0));
  const artifact = await tool(batch[0].id, "artifact_upsert", {
    kind: "report",
    title: "Saved acceptance report",
    body: { type: "markdown", markdown: "PRESERVE_USER_REPORT" },
    status: "ready",
    citations: [],
  });
  assert.ok(artifact.ok);
  // Saving a report advances timestamps; give the controlled oldest task its intended age.
  await evaluate(
    `h.sessions.get(${JSON.stringify(batch[0].id)}).record.updatedAt=Date.now()-86400000;await h.persistNow();return true;`,
  );
  const originalsBefore = await rawCopies(batch[0].raw);
  const countBefore = maintenanceCalls();
  await finish(owner);
  const retiredFirst = [];
  for (const old of batch) if (await retired(old.id)) retiredFirst.push(old.id);
  await check(
    "Task-count overflow spends at most two maintenance attempts and defers the remaining work",
    maintenanceCalls() - countBefore === 2 &&
      retiredFirst.length === 2 &&
      (await jobs(owner)).length > 0,
    {
      attempts: maintenanceCalls() - countBefore,
      retired: retiredFirst.length,
      pending: (await jobs(owner)).length,
    },
  );
  await finish(owner);
  let retiredSecond = 0;
  for (const old of batch) if (await retired(old.id)) retiredSecond++;
  await check(
    "The next user turn grants a fresh allowance and reaches the ten-task retention target",
    retiredSecond === 3,
  );
  await check(
    "Successful distillation removes raw text from state, notes, history, logs and operation copies",
    originalsBefore.length >= 4 && (await rawCopies(batch[0].raw)).length === 0,
    {
      copiesBefore: originalsBefore.length,
      copiesAfter: (await rawCopies(batch[0].raw)).length,
    },
  );
  const unavailable = await tool(owner, "context_read", { ref: batch[0].ref });
  await check(
    "Cleared refs explicitly report unavailable",
    !unavailable.ok && /cleared|unavailable/i.test(unavailable.message),
  );
  await check(
    "Saved report and knowledge entry survive raw-context retirement",
    (await rawCopies("PRESERVE_USER_REPORT")).length > 0 &&
      (await rawCopies("PRESERVE_KNOWLEDGE_ENTRY")).length > 0,
  );

  // Isolate later boundary cases from the count-threshold scenario.
  for (const old of batch)
    if (!(await retired(old.id)))
      await z.rpc("task/delete", { taskId: old.id });
  const invalid = await oldTask("INVALID");
  mode = "invalid";
  const beforeInvalid = maintenanceCalls();
  await finish(owner);
  await drain(owner);
  await drain(owner);
  await check(
    "Malformed summary and repeated manual retry exhaust the same two-attempt allowance while retaining originals",
    maintenanceCalls() - beforeInvalid === 2 &&
      !(await retired(invalid.id)) &&
      (await rawCopies(invalid.raw)).length >= 4,
  );
  mode = "valid";
  await finish(owner);
  await check(
    "A new turn safely completes a previously invalid batch",
    await retired(invalid.id),
  );

  const failedSave = await oldTask("SAVE_FAILURE");
  await evaluate(
    `const fs=h.memory.store.fs;globalThis.cmWrite=fs.writeFile;fs.writeFile=async function(path,text){if(path.includes('/memories/mem_distill_'))throw new Error('Injected disk write failure');return globalThis.cmWrite.call(this,path,text);};return true;`,
  );
  const beforeSave = maintenanceCalls();
  await finish(owner);
  await check(
    "A real memory filesystem write failure preserves all raw work",
    !(await retired(failedSave.id)) &&
      (await rawCopies(failedSave.raw)).length >= 4 &&
      (await jobs(owner)).some(
        (j) => j.maintenanceOps && !j.maintenanceApplied,
      ),
  );
  await evaluate("h.memory.store.fs.writeFile=globalThis.cmWrite;return true;");
  await drain(owner);
  await check(
    "Retrying a committed model result after disk recovery does not call the model again",
    (await retired(failedSave.id)) &&
      maintenanceCalls() - beforeSave === 1 &&
      (await rawCopies(failedSave.raw)).length === 0,
  );

  const retry = await oldTask("RETRY");
  failRequests = 1;
  await openTask(owner);
  const running = finish(owner);
  const loading = await until(
    () =>
      evaluate(
        `const d=Zotero.Confucius.data.workspaceWindow?.document??Zotero.getMainWindow().document;const e=d.querySelector('.tui-waiting');const text=e?.textContent??'';return /提炼|Distilling/.test(text)&&/重试|retry/i.test(text)?{text,visible:e.getBoundingClientRect().width>0}:false;`,
      ),
    15000,
    100,
  );
  await running;
  await check(
    "Post-reply distillation retries appear in the actual loading indicator",
    loading.visible && (await retired(retry.id)),
    loading,
  );

  const off = await oldTask("OFF");
  await z.rpc("config/set", { memoryConsent: "off" });
  const beforeOff = maintenanceCalls();
  await finish(owner);
  await z.stop({ graceful: true });
  await z.launch();
  await bootstrap();
  const offConfig = await z.rpc("config/get");
  await check(
    "Explicit automatic-memory off survives restart and prevents paid maintenance and raw cleanup",
    offConfig.memoryConsent === "off" &&
      maintenanceCalls() === beforeOff &&
      !(await retired(off.id)),
  );
  await configure();
  await finish(owner);
  await check(
    "Re-enabling automatic memory drains the deferred old task",
    await retired(off.id),
  );

  const crash = await oldTask("CRASH");
  await evaluate(
    // Flush setup preferences before killing the process so this case targets
    // interrupted history cleanup, independent of Gecko's delayed pref flush.
    `Services.prefs.savePrefFile(null);const fs=h.history.fs;globalThis.cmDelete=fs.deleteFile;globalThis.cmDeletionReached=false;fs.deleteFile=async function(path){const result=await globalThis.cmDelete.call(this,path);if(path.includes(${JSON.stringify(crash.id)})&&path.endsWith('.txt')&&!globalThis.cmDeletionReached){globalThis.cmDeletionReached=true;await new Promise(()=>{});}return result;};return true;`,
  );
  const crashBefore = maintenanceCalls();
  const promptReceipt = await z.rpc("task/prompt", {
    taskId: owner,
    text: "Complete this controlled crash-recovery test without tools.",
  });
  await until(
    () => evaluate("return globalThis.cmDeletionReached;"),
    15000,
    100,
  );
  const beforeCrash = await jobs(owner);
  await check(
    "Crash is injected after summary commit and partial physical deletion",
    beforeCrash.some(
      (j) => j.maintenanceTarget === crash.id && j.maintenanceApplied,
    ) && (await rawCopies(crash.raw)).length > 0,
    { turnId: promptReceipt.turnId },
  );
  await z.stop();
  await z.launch();
  await bootstrap();
  await check(
    "SIGKILL during cleanup resumes on startup without another model request",
    (await retired(crash.id)) &&
      maintenanceCalls() - crashBefore === 1 &&
      (await rawCopies(crash.raw)).length === 0,
  );

  for (const backend of ["codex", "kimi"]) {
    if (!values[backend]) continue;
    await z.rpc("runtime/configure", { backend, executable: values[backend] });
    // Give each real engine new evidence: an identical second case may correctly
    // produce [] because the first engine already retained the same conclusion.
    const evidence =
      backend === "codex"
        ? { threshold: "0.64", revision: "F", pending: "G" }
        : { threshold: "0.83", revision: "D", pending: "E" };
    const old = await oldTask(`REAL_${backend.toUpperCase()}`, 40, evidence);
    const externalOwner = await task(`Real ${backend} distillation`, backend);
    const startedAt = Date.now();
    await evaluate(
      `globalThis.cmRealDone=false;globalThis.cmRealError=null;const s=h.sessions.get(${JSON.stringify(externalOwner)});h.scheduleContextMaintenance(s,'real-maintenance').then(()=>globalThis.cmRealDone=true,e=>{globalThis.cmRealError=String(e);globalThis.cmRealDone=true;});return true;`,
    );
    await until(() => evaluate("return globalThis.cmRealDone;"), 90000, 500);
    const retained = await evaluate(
      `return (await h.memory.list({limit:1000})).filter(m=>m.sourceRefs?.includes(${JSON.stringify(`task:${old.id}`)}));`,
    );
    const ok =
      (await retired(old.id)) &&
      retained.some(
        (m) =>
          m.content.includes(evidence.threshold) &&
          new RegExp(
            `revision\\s*${evidence.revision}|版本\\s*${evidence.revision}|修订.*${evidence.revision}`,
            "i",
          ).test(m.content) &&
          new RegExp(
            `revision\\s*${evidence.pending}|版本\\s*${evidence.pending}|修订.*${evidence.pending}`,
            "i",
          ).test(m.content) &&
          /pending|待.*验证|尚未验证|未完成|unvalidated/i.test(m.content) &&
          m.content.includes(`fixture://study/revision-${evidence.revision}`),
      );
    const result = {
      backend,
      evidence,
      elapsedMs: Date.now() - startedAt,
      retired: await retired(old.id),
      memories: retained.map((m) => ({
        id: m.id,
        content: m.content,
        sourceRefs: m.sourceRefs,
      })),
      jobs: await jobs(externalOwner),
      budget: await evaluate(
        `return h.sessions.get(${JSON.stringify(externalOwner)}).record.maintenanceBudget;`,
      ),
      error: await evaluate("return globalThis.cmRealError;"),
    };
    report.models.push(result);
    await check(
      `Real ${backend} distillation retains the numeric condition, dataset version, pending work and source`,
      ok,
      result,
    );
  }
  // Inject an unknown write last: the real write barrier correctly blocks later
  // context_save calls until the owning domain reconciles its outcome.
  const active = await oldTask("ACTIVE");
  const uncertain = await oldTask("UNCERTAIN");
  await evaluate(`
    const active=h.sessions.get(${JSON.stringify(active.id)});active.record.status='running';active.activeTurnId='injected-active-turn';
    await h.execution.importLegacyOperation({id:'injected-unknown-write',name:'context_save',args:{content:'UNCONFIRMED_WRITE'},resources:['memory:unknown'],context:{taskId:${JSON.stringify(uncertain.id)}},startedAt:Date.now(),result:{ok:false,toolName:'context_save',effect:'unknown',code:'unavailable',message:'Injected uncertain receipt'}});
    await h.persistNow();return true;
  `);
  const beforeProtectedWork = maintenanceCalls();
  await finish(owner);
  await check(
    "Active tasks and unknown writes remain exempt even past the age limit",
    maintenanceCalls() === beforeProtectedWork &&
      !(await retired(active.id)) &&
      !(await retired(uncertain.id)) &&
      (await rawCopies(active.raw)).length > 0 &&
      (await rawCopies(uncertain.raw)).length > 0,
  );
  report.requests = requests;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  console.error(error.stack ?? report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  report.requests = requests;
  await save();
  await z.stop({ graceful: !report.error }).catch(() => {});
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  console.log(`Results: ${join(output, "results.json")}`);
}
