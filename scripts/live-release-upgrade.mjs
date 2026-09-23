// Preserve real Zotero and research data across local or public package upgrades.
// CONFUCIUS_UPGRADE_OLD=old.xpi node scripts/live-release-upgrade.mjs candidate.xpi [--public]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import http from "node:http";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
const root = resolve("."),
  publicMode = process.argv.includes("--public");
const candidate = resolve(
  process.argv[2] ?? "apps/zotero-addon/.scaffold/build/confucius.xpi",
);
const old = resolve(
  process.env.CONFUCIUS_UPGRADE_OLD ??
    "output/release-0.5.0-beta.5/public/confucius.xpi",
);
const manifest = (path) =>
  JSON.parse(
    execFileSync("unzip", ["-p", path, "manifest.json"], { encoding: "utf8" }),
  );
const from = manifest(old).version,
  version = manifest(candidate).version;
const label = from.includes("beta") ? "beta" : "stable";
const channel = process.env.CONFUCIUS_UPGRADE_CHANNEL ?? label;
assert.ok(["stable", "beta"].includes(channel));
assert.notEqual(from, version);
const reportPath = resolve(
  process.env.CONFUCIUS_UPGRADE_REPORT ??
    `output/release-${version}/${publicMode ? "public" : "candidate"}-upgrade-${from}.json`,
);
assert.ok(
  reportPath.startsWith(resolve(root, "output") + "/"),
  "Keep reports in ignored output/",
);
await mkdir(resolve(reportPath, ".."), { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const report = {
  startedAt: new Date().toISOString(),
  versions: { from, to: version },
  channel,
  publicMode,
  checks: [],
  oldSha256: sha(await readFile(old)),
  candidateSha256: sha(await readFile(candidate)),
  scope:
    "Isolated Zotero, synthetic files and local deterministic Native responses; no paid model calls",
};
const check = (name, condition = true, details) => {
  assert.ok(condition, name);
  report.checks.push({ name, pass: true, ...details });
  console.log(name);
};
const z = await IsolatedZotero.create({
  root,
  binary: "/Applications/Zotero.app/Contents/MacOS/zotero",
  xpi: old,
  prefix: `release-upgrade-${label}-`,
});
const pref = join(z.profile, "user.js");
await writeFile(
  pref,
  (await readFile(pref, "utf8"))
    .split("\n")
    .filter(
      (line) =>
        !line.includes("confucius.memoryConsent") &&
        !line.includes("confucius.updateAutoCheck"),
    )
    .join("\n"),
  { mode: 0o600 },
);
const evalHost = (code) =>
  z.rdp.evaluate(
    `if(PathUtils.profileDir!==${JSON.stringify(z.profile)}||Zotero.DataDirectory.dir!==${JSON.stringify(z.data)})throw new Error('Wrong fixture');const h=Zotero.Confucius.hooks.host;${code}`,
  );
const idle = (id) =>
  until(
    async () => {
      const t = await z.rpc("task/load", { taskId: id });
      return ["completed", "failed", "interrupted"].includes(t.status)
        ? t
        : false;
    },
    30000,
    100,
  );
let requests = 0,
  hold = false,
  mode = "initial",
  replayed = false,
  target;
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const b = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests++;
    const writing = b.messages?.some(
      (m) =>
        typeof m.content === "string" &&
        m.content.includes("RELEASE_WRITE_ONCE"),
    );
    const hasResult = b.messages?.some(
      (m) => m.role === "tool" && m.tool_call_id === "release_write_once",
    );
    if (writing && mode === "initial" && hasResult) {
      hold = true;
      req.socket.on("close", () => res.destroy());
      return;
    }
    const write =
      writing &&
      ((mode === "initial" && !hasResult) || (mode === "replay" && !replayed));
    if (write && mode === "replay") replayed = true;
    const message = write
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "release_write_once",
              type: "function",
              function: {
                name: "create_note",
                arguments: JSON.stringify({
                  libraryID: target.libraryID,
                  parentKey: target.key,
                  content: "Release 0.4.3 durable write; do not duplicate.",
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: "RELEASE_TASK_DONE" };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          { index: 0, message, finish_reason: write ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 128, completion_tokens: 16, total_tokens: 144 },
      }),
    );
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { message: String(e) } }));
  }
});
const preservedLiterature = (actual, expected) => {
  // Recovery checkpoints advance the pool revision; paper and decision data must match.
  assert.ok(actual.summary.revision >= expected.summary.revision);
  const summary = { ...actual.summary, revision: expected.summary.revision };
  if (!("abstracts" in expected.summary)) delete summary.abstracts;
  assert.deepEqual({ ...actual, summary }, expected);
};
const tree = async (dir, prefix = "") => {
  const out = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + e.name;
    if (e.isDirectory())
      Object.assign(out, await tree(join(dir, e.name), name + "/"));
    else if (e.isFile() && /\.(txt|md)$/.test(name))
      out[name] = sha(await readFile(join(dir, e.name)));
  }
  return out;
};
let taskId, seed, articleDraft, unfiledDraft, literatureSeed, subagentSeed;
const snapshot = () =>
  evalHost(
    `const s=h.sessions.get(${JSON.stringify(taskId)});const parent=Zotero.Items.getByLibraryAndKey(${target?.libraryID ?? 1},${JSON.stringify(target?.key ?? "")});const notes=await Zotero.Items.getAsync(parent.getNotes());await h.memory.ensureLoaded();return {record:s.record,checkpoint:s.latestCheckpoint,notes:notes.map(n=>({key:n.key,content:n.getNote()})),artifacts:(await h.rpc('artifact/list',{taskId:s.record.id})).artifacts,memory:await h.memory.list(),proposal:h.memoryProposals.get('release-pending'),working:await h.history.readNote(s.record.id,'progress'),historyRoot:h.history.root};`,
  );
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  await z.launch();
  report.instance = z.publicState();
  check(
    "Published old XPI is a normal installation",
    z.environment.version === from && !z.environment.temporary,
  );
  await z.rpc("config/set", {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "release-fixture-only",
    model: "release-local-fixture",
    streamResponses: false,
    contextWindowTokens: 32768,
    maxTokens: 1024,
    maxIterations: 12,
    maxToolCalls: 8,
    memoryConsent: "off",
  });
  target = await evalHost(
    `const item=new Zotero.Item('journalArticle');item.libraryID=Zotero.Libraries.userLibraryID;item.setField('title','Release upgrade fixture');await item.saveTx();const pdf=await Zotero.Attachments.importFromFile({file:${JSON.stringify(join(root, "scripts/fixtures/confucius-tool-e2e-fixture.pdf"))},parentItemID:item.id});const mark=await Zotero.Annotations.saveFromJSON(pdf,{key:Zotero.DataObjectUtilities.generateKey(),type:'highlight',color:'#ffd400',text:'Original annotation',comment:'Preserve original annotation',pageLabel:'1',sortIndex:'00000|000000|00000',position:{pageIndex:0,rects:[[10,10,40,30]]}});return {libraryID:item.libraryID,key:item.key,pdfKey:pdf.key,markKey:mark.key};`,
  );
  const task = await z.rpc("task/new", {
    backend: "native",
    title: "Release upgrade task",
    titleState: "fixed",
    context: {
      version: 1,
      capturedAt: Date.now(),
      items: [
        {
          id: "item:" + target.libraryID + ":" + target.key,
          libraryID: target.libraryID,
          key: target.key,
          title: "Release upgrade fixture",
          source: "library",
          attachmentKey: target.pdfKey,
        },
      ],
    },
  });
  taskId = task.id;
  report.taskId = taskId;
  articleDraft = await z.rpc("task/new", {
    backend: "native",
    title: "Old unsent article draft",
    context: {
      version: 1,
      capturedAt: Date.now(),
      items: [
        {
          id: "item:" + target.libraryID + ":" + target.key,
          libraryID: target.libraryID,
          key: target.key,
          title: "Release upgrade fixture",
          source: "library",
          attachmentKey: target.pdfKey,
        },
      ],
    },
  });
  unfiledDraft = await z.rpc("task/new", {
    backend: "native",
    title: "Old empty draft",
    context: { version: 1, capturedAt: Date.now(), items: [] },
  });
  await z.rpc("task/draft", {
    taskId: articleDraft.id,
    text: "旧版未发送草稿 😀",
  });

  if (label === "beta") {
    literatureSeed = await evalHost(
      `const t=await h.rpc('task/new',{title:'Preserved Beta 5 literature',titleState:'fixed',backend:'native',context:{version:1,capturedAt:Date.now(),items:[]}});const original=h.openAlex.transport;try{h.openAlex.transport=async()=>({status:200,data:{results:[1,2].map(n=>({id:'https://openalex.org/W98000'+n,doi:'https://doi.org/10.1234/release-upgrade-'+n,title:'Preserved paper '+n,publication_year:2024,authorships:[],cited_by_count:n,open_access:{is_oa:false}})),meta:{count:2000,next_cursor:null}}});await h.rpc('literature/search',{taskId:t.id,query:'preserved research query'});await h.rpc('literature/updateCandidates',{taskId:t.id,candidateRevision:0,changes:[{id:'W980001',selected:true,reason:'Keep this candidate across the UI change'}]});await h.persistNow();return {taskId:t.id,page:await h.rpc('literature/list',{taskId:t.id})};}finally{h.openAlex.transport=original;}`,
    );
    check(
      "Old research version saves a deduplicated literature pool, query history and candidate decision",
      literatureSeed.page.summary.pool === 2 &&
        literatureSeed.page.summary.candidates === 1,
    );
  }
  await z.rpc("task/setPermissions", { taskId, permissionMode: "auto_allow" });
  await z.rpc("task/draft", {
    taskId,
    text: "Preserve latest user draft across upgrade.",
  });
  seed = await evalHost(
    `const s=h.sessions.get(${JSON.stringify(taskId)});await h.history.writeNote(s.record.id,'progress','Original phase');await h.history.writeNote(s.record.id,'progress','Revised phase with RELEASE_EVIDENCE');const ref=await h.history.append({taskId:s.record.id,windowId:s.record.contextWindow.id,itemId:'release_evidence',role:'tool',toolName:'get_pages',content:'Irrelevant preface '.repeat(1300)+'RELEASE_EVIDENCE_中文_FINAL',sourceIds:[${JSON.stringify(`${target.libraryID}:${target.key}`)}]});await h.memory.save({title:'Preserved release memory',content:'Do not lose this user memory',type:'fact'});h.memoryProposals.set('release-pending',{id:'release-pending',op:'add',title:'Preserve pending review',content:'Requires an explicit decision',type:'fact',taskId:s.record.id,status:'pending',createdAt:Date.now()});Zotero.Prefs.set('extensions.zotero.confucius.updateChannel',${JSON.stringify(channel)},true);Zotero.Prefs.set('extensions.zotero.confucius.updateAutoCheck',false,true);Services.prefs.savePrefFile(null);await h.persistNow();return {ref,historyRoot:h.history.root};`,
  );
  await z.rpc("task/prompt", {
    taskId,
    text: "RELEASE_READ_ONLY: reply RELEASE_TASK_DONE only.",
  });
  assert.equal((await idle(taskId)).status, "completed");
  const a = (
    await z.rpc("artifact/upsert", {
      taskId,
      kind: "report",
      title: "Release report",
      status: "ready",
      body: { type: "markdown", markdown: "# Report\nOriginal" },
    })
  ).artifact;
  await z.rpc("artifact/upsert", {
    id: a.id,
    taskId,
    kind: "report",
    title: "Release report",
    status: "ready",
    body: { type: "markdown", markdown: "# Report\nRevision two" },
  });
  await z.rpc("task/new-context", { taskId });
  await z.rpc("task/prompt", {
    taskId,
    text: "RELEASE_WRITE_ONCE: create the authorized fixture note once, then finish after restart.",
  });
  await until(() => hold, 30000, 100);
  if (label === "beta") {
    const child = await evalHost(
      `return h.subagents().spawn(${JSON.stringify(taskId)},{title:'Preserved research child',goal:'Summarize only the synthetic fixture. Return RELEASE_TASK_DONE.',sourceIds:[]});`,
    );
    await until(
      async () => {
        const page = await z.rpc("subagent/read", { taskId, id: child.id });
        return page.record.status === "completed";
      },
      30000,
      100,
    );
    subagentSeed = await z.rpc("subagent/read", {
      taskId,
      id: child.id,
      limit: 100,
    });
    check(
      "Old research version saves a completed child with public events",
      subagentSeed.record.result.includes("RELEASE_TASK_DONE") &&
        subagentSeed.events.length > 0,
    );
  }
  await evalHost("await h.persistNow();return true;");
  const before = await snapshot();
  report.before = {
    window: before.record.contextWindow.number,
    budget: before.record.run.budget,
    noteKeys: before.notes.map((n) => n.key),
    artifactRevision: before.artifacts[0].revision,
  };
  check(
    "Old version writes a real note and saves multiple history windows",
    before.notes.length === 1 &&
      before.artifacts[0].revision === 2 &&
      before.record.contextWindow.number === 2,
  );
  await z.stop({ graceful: false });
  await z.launch();
  const restored = await snapshot();
  check(
    "Old package restores the interrupted task without repeating writes",
    restored.record.status === "interrupted" && restored.notes.length === 1,
  );
  await evalHost("await h.persistNow();return true;");
  const originals = await tree(seed.historyRoot),
    beforeUpgradeRequests = requests;
  if (publicMode) {
    const normal = await z.rpc("update/setPrerelease", { enabled: false });
    check(
      "Stable-only channel excludes Beta releases",
      normal.state !== "error" && !normal.availableVersion?.includes("-"),
    );
    if (!version.includes("-"))
      check(
        "Stable target is offered with Betas disabled",
        normal.state === "available" &&
          normal.availableVersion === version &&
          normal.canInstall,
      );
    const available = await z.rpc("update/setPrerelease", {
      enabled: channel === "beta",
    });
    report.discovery = available;
    console.log(JSON.stringify(available));
    check(
      "Original updater discovers the target release",
      available.state === "available" &&
        available.availableVersion === version &&
        available.canInstall,
    );
    const installed = await z.rpc("update/install", {}, 180000);
    check(
      "Confucius downloads, verifies and installs the public XPI",
      installed.state === "ready" &&
        typeof installed.restartRequired === "boolean",
    );
  } else
    await evalHost(
      `const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');const file=Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);file.initWithPath(${JSON.stringify(candidate)});const install=await AddonManager.getInstallForFile(file);await install.install();return true;`,
    );
  await until(() =>
    evalHost(
      `return Zotero.Confucius?.data.initialized&&h.health().version===${JSON.stringify(version)};`,
    ),
  );
  await z.stop({ graceful: true });
  await z.launch();
  report.environment = z.environment;
  check(
    "Candidate restarts as a normal target-version installation",
    z.environment.version === version && !z.environment.temporary,
  );

  if (literatureSeed) {
    preservedLiterature(
      await z.rpc("literature/list", { taskId: literatureSeed.taskId }),
      literatureSeed.page,
    );
    check(
      "Upgrade preserves every saved paper, query and candidate decision from the old version",
    );
  }
  if (subagentSeed) {
    const child = await z.rpc("subagent/read", {
      taskId,
      id: subagentSeed.record.id,
      limit: 100,
    });
    assert.deepEqual(child.record, subagentSeed.record);
    assert.deepEqual(child.events, subagentSeed.events);
    check("Upgrade preserves the child identity, result and public events");
    const report = await z.rpc("task/trace", { taskId });
    check(
      "Diagnostic export now includes the old child trace",
      report.sections.subagents.data.some(
        (c) =>
          c.record?.id === child.record.id &&
          c.events.length === child.events.length,
      ),
    );
  }
  const after = await snapshot();
  check(
    "Upgrade preserves request, draft, sources and context identity",
    after.record.run.request === restored.record.run.request &&
      JSON.stringify(after.record.lockedContext) ===
        JSON.stringify(restored.record.lockedContext) &&
      after.record.draft.text === restored.record.draft.text &&
      after.record.contextWindow.id === restored.record.contextWindow.id,
  );
  assert.deepEqual(after.notes, restored.notes);
  assert.deepEqual(after.artifacts, restored.artifacts);
  check(
    "Zotero note, report revision and working note content survive",
    after.working.content === restored.working.content &&
      after.working.revision === 2,
  );
  check(
    "Upgrade never restarts model execution",
    requests === beforeUpgradeRequests,
  );
  for (const [name, hash] of Object.entries(originals))
    assert.equal(sha(await readFile(join(seed.historyRoot, name))), hash, name);
  check(
    "Every original history and working-note body is byte-identical",
    true,
    { files: Object.keys(originals).length },
  );
  const metadata = await evalHost(
    `const s=h.sessions.get(${JSON.stringify(taskId)});await h.history.search({taskId:s.record.id,query:'RELEASE_EVIDENCE'});const info=await h.history.retentionInfo(s.record.id);const ref=${JSON.stringify(seed.ref)};const body=await h.history.read(ref,23000,3000);return {info,body:body.content,manifestBackup:await IOUtils.exists(h.history.root+'/'+s.record.id+'/index.pre-archive.json'),stateBackup:await IOUtils.exists(h.statePath()+'.pre-context-archive-backup'),memoryCount:h.memory.stats().total,proposal:h.memoryProposals.get('release-pending').status,mark:Zotero.Items.getByLibraryAndKey(${target.libraryID},${JSON.stringify(target.markKey)}).annotationComment,consent:Zotero.Prefs.get('extensions.zotero.confucius.memoryConsent',true),cleanup:Zotero.Prefs.get('extensions.zotero.confucius.historyAutoCleanup',true),channel:Zotero.Prefs.get('extensions.zotero.confucius.updateChannel',true),automatic:Zotero.Prefs.get('extensions.zotero.confucius.updateAutoCheck',true)};`,
  );
  report.upgradeMetadata = metadata;
  check(
    "Existing evidence references remain readable",
    metadata.body.includes("RELEASE_EVIDENCE_中文_FINAL"),
  );
  check(
    "Explicitly disabled automatic memory remains disabled",
    metadata.consent === "off",
  );

  check(
    "Original annotations, memory and pending review survive",
    metadata.mark === "Preserve original annotation" &&
      metadata.memoryCount === 1 &&
      metadata.proposal === "pending",
  );
  check(
    "Channel and disabled automatic update preferences survive",
    metadata.channel === channel && metadata.automatic === false,
  );
  const migratedArticle = await z.rpc("task/load", { taskId: articleDraft.id }),
    migratedEmpty = await z.rpc("task/load", { taskId: unfiledDraft.id });
  report.migratedDrafts = { article: migratedArticle, unfiled: migratedEmpty };
  check(
    "Unsent legacy drafts gain stable article or unfiled associations without losing Chinese text",
    migratedArticle.createdFrom?.some((a) => a.key === target.key) &&
      migratedArticle.draft.text === "旧版未发送草稿 😀" &&
      Array.isArray(migratedEmpty.createdFrom) &&
      migratedEmpty.createdFrom.length === 0,
  );
  const changed = await z.rpc("task/setContext", {
    taskId: articleDraft.id,
    context: { version: 1, capturedAt: Date.now(), items: [] },
  });
  assert.deepEqual(changed.createdFrom, migratedArticle.createdFrom);
  assert.deepEqual(changed.lockedContext.items, []);
  check("Removing current sources preserves the creation grouping and draft");
  await evalHost(
    "Zotero.Prefs.set('extensions.zotero.confucius.workspaceTaskOrganization','time',true);Services.prefs.savePrefFile(null);await h.persistNow();return true;",
  );
  check(
    "Consumed run budget is preserved",
    after.record.run.budget.iterationsUsed >=
      restored.record.run.budget.iterationsUsed &&
      after.record.run.budget.toolCallsUsed >=
        restored.record.run.budget.toolCallsUsed,
  );
  mode = "replay";
  await z.rpc("task/continue", { taskId });
  assert.equal((await idle(taskId)).status, "completed");
  const completed = await snapshot();
  assert.deepEqual(completed.notes, before.notes);
  check(
    "Continue reuses the completed write and consumes the existing budget",
    replayed &&
      completed.record.run.budget.iterationsUsed >
        after.record.run.budget.iterationsUsed,
  );
  check(
    "Resume preserves maintenance usage without creating a new allowance",
    completed.record.maintenanceBudget.attempts ===
      (after.record.maintenanceBudget?.attempts ?? 2) &&
      completed.record.maintenanceBudget.handoffAttempts ===
        (after.record.maintenanceBudget?.handoffAttempts ?? 1),
  );
  await z.stop({ graceful: true });
  await z.launch();
  const final = await snapshot();
  assert.deepEqual(final.notes, before.notes);
  assert.deepEqual(final.artifacts, before.artifacts);
  check(
    "Second restart preserves completion, originals and report revisions",
    final.record.status === "completed",
  );
  check(
    "Creation origin, unsent drafts and organization mode survive another restart",
    await evalHost(
      `return h.sessions.get(${JSON.stringify(articleDraft.id)}).record.createdFrom.some(item=>item.key===${JSON.stringify(target.key)})&&h.sessions.get(${JSON.stringify(articleDraft.id)}).record.draft.text==='旧版未发送草稿 😀'&&Zotero.Prefs.get('extensions.zotero.confucius.workspaceTaskOrganization',true)==='time';`,
    ),
  );

  if (literatureSeed) {
    preservedLiterature(
      await z.rpc("literature/list", { taskId: literatureSeed.taskId }),
      literatureSeed.page,
    );
    check(
      "Existing literature survives another full restart without changing its counts",
    );
  }
  const trace = await z.rpc("task/trace", { taskId });
  check(
    "Diagnostic export retains both working-note revisions",
    trace.issues.length === 0 && trace.sections.history.data.notes.length === 2,
  );
  if (publicMode) {
    check(
      "Installed file matches the public release asset",
      sha(
        await readFile(
          join(z.profile, "extensions/confucius@zotero.plugin.xpi"),
        ),
      ) === report.candidateSha256,
    );
    const current = await z.rpc("update/check");
    check(
      "Already-current release is not offered again",
      current.state === "up-to-date" && !current.canInstall,
    );
    const stable = await z.rpc("update/setPrerelease", { enabled: false });
    check(
      "Disabling Beta does not downgrade or reinstall",
      stable.state === "up-to-date" && !stable.canInstall,
    );
    await z.stop({ graceful: true });
    await z.launch();
    check(
      "Stable channel choice survives restart",
      await evalHost(
        "return Zotero.Prefs.get('extensions.zotero.confucius.updateChannel',true)==='stable';",
      ),
    );
  }
  report.pass = true;
  report.final = {
    taskStatus: final.record.status,
    window: final.record.contextWindow.number,
    budget: final.record.run.budget,
    maintenance: final.record.maintenanceBudget,
    modelRequests: requests,
    rawFiles: Object.keys(originals).length,
  };
} catch (e) {
  report.pass = false;
  report.error = String(e);
  console.error(String(e));
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await z
    .stop({ graceful: true })
    .catch(() => z.stop({ graceful: false }).catch(() => {}));
  z.rdp?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
