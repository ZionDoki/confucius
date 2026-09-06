#!/usr/bin/env node
// Actual Windows Zotero tools. Fault injections are identified in each check.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { attachIsolated } from "./lib/zotero-live.mjs";
const real = JSON.parse(
  await readFile("output/windows-acceptance/real-engines.json", "utf8"),
);
const z = await attachIsolated(real.instance);
const report = {
  startedAt: new Date().toISOString(),
  instance: real.instance,
  checks: [],
  calls: [],
  fixtures: {},
};
const save = () =>
  writeFile(
    "output/windows-acceptance/platform.json",
    JSON.stringify(report, null, 2),
  );
async function check(name, work) {
  try {
    const evidence = await work();
    report.checks.push({ name, status: "pass", evidence });
    console.log("PASS", name);
  } catch (e) {
    report.checks.push({ name, status: "fail", error: String(e) });
    console.log("FAIL", name, String(e));
  }
  await save();
}
let task;
async function call(name, args) {
  const operationId = `win_${Date.now()}_${report.calls.length}`;
  const start = Date.now();
  const response = await z.rpc("task/toolCall", {
    taskId: task.id,
    callId: operationId,
    operationId,
    name,
    arguments: args,
  });
  const result = JSON.parse(
    response.content.find((c) => c.type === "text").text,
  );
  report.calls.push({ name, args, result, elapsedMs: Date.now() - start });
  await save();
  return result;
}
try {
  for (const name of ["blank", "scanned", "ambiguous"]) {
    report.fixtures[name] = await z.rdp.evaluate(
      `const p=new Zotero.Item("journalArticle");p.libraryID=1;p.setField("title","Windows ${name} PDF fixture");await p.saveTx();const a=await Zotero.Attachments.importFromFile({file:${JSON.stringify(resolve(`output/windows-acceptance/papers/${name}.pdf`))},parentItemID:p.id});return {libraryID:1,key:p.key,attachmentKey:a.key,attachmentId:a.id};`,
    );
  }
  task = await z.rpc("task/new", {
    title: "Windows platform tools and recovery",
    backend: "native",
    lockedContext: {
      version: 1,
      capturedAt: Date.now(),
      fingerprint: "windows-platform",
      items: Object.values(report.fixtures).map((f) => ({
        id: `item:1:${f.key}`,
        libraryID: 1,
        key: f.key,
        attachmentKey: f.attachmentKey,
        title: "Windows fixture",
        source: "library",
      })),
    },
  });
  report.taskId = task.id;
  await z.rpc("task/setPermissions", {
    taskId: task.id,
    permissionMode: "auto_allow",
  });
  for (const name of ["blank", "scanned"])
    await check(`${name}_physical_page_preserved`, async () => {
      const r = await call("get_pages", {
        ...report.fixtures[name],
        start: 1,
        end: 1,
      });
      assert.equal(r.ok, true);
      assert.equal(r.data.pages.length, 1);
      assert.equal(r.data.pages[0].text.trim(), "");
      assert.equal(r.data.pageSource, "pdf_physical");
      return r.data;
    });
  const f = report.fixtures.ambiguous;
  await check("ambiguous_quote_is_not_written", async () => {
    const p = await call("propose_annotations", {
      ...f,
      annotations: [
        {
          id: "ambiguous",
          type: "highlight",
          page: 1,
          quote: "The repeated evidence sentence must be disambiguated.",
          comment: "Ambiguity acceptance",
        },
      ],
    });
    const r = await call("commit_annotations", {
      ...f,
      proposalId: p.data.proposalId,
    });
    const actual = await call("get_annotations", f);
    assert.equal(actual.data.annotations.length, 0);
    assert.ok(r.data?.skipped?.length || !r.ok);
    return r;
  });
  const entries = Array.from({ length: 10 }, (_, i) => ({
    id: `entry_${i + 1}`,
    type: "highlight",
    page: 1,
    quote: `Evidence entry ${String(i + 1).padStart(2, "0")} has a unique grounded passage.`,
    comment: `Windows partial recovery entry ${i + 1}`,
  }));
  let proposal, firstKeys;
  await check("partial_eight_of_ten", async () => {
    const first = entries.map((e, i) => ({
      ...e,
      quote: i < 8 ? e.quote : `Missing quote ${i}`,
    }));
    const p = await call("propose_annotations", { ...f, annotations: first });
    const r = await call("commit_annotations", {
      ...f,
      proposalId: p.data.proposalId,
    });
    assert.equal(r.data.committed.length, 8);
    assert.equal(r.data.skipped.length, 2);
    firstKeys = r.data.committed.map((e) => e.annotationKey);
    return r;
  });
  await check("repair_only_two_and_no_read_repeat", async () => {
    const p = await call("propose_annotations", { ...f, annotations: entries });
    proposal = p.data.proposalId;
    const r = await call("commit_annotations", { ...f, proposalId: proposal });
    assert.equal(r.data.committed.length, 2);
    assert.equal(r.data.alreadyPresent.length, 8);
    assert.deepEqual(
      r.data.alreadyPresent.map((e) => e.annotationKey).sort(),
      firstKeys.sort(),
    );
    const repeat = await call("commit_annotations", {
      ...f,
      proposalId: proposal,
    });
    assert.equal(repeat.data.committed.length, 0);
    assert.equal(repeat.data.alreadyPresent.length, 10);
    return { repaired: r, repeated: repeat };
  });
  await check("unrelated_metadata_and_manual_removal", async () => {
    await z.rdp.evaluate(
      `const p=Zotero.Items.getByLibraryAndKey(1,${JSON.stringify(f.key)});p.setField("title","Windows fixture with human title edit");await p.saveTx();const a=Zotero.Items.getByLibraryAndKey(1,${JSON.stringify(firstKeys[0])});await a.eraseTx();return true;`,
    );
    const r = await call("commit_annotations", { ...f, proposalId: proposal });
    const actual = await call("get_annotations", f);
    assert.equal(r.data.committed.length, 0);
    assert.equal(actual.data.annotations.length, 9);
    return r;
  });
  await check("multiple_attachments_require_selection", async () => {
    await z.rdp.evaluate(
      `const p=Zotero.Items.getByLibraryAndKey(1,${JSON.stringify(f.key)});await Zotero.Attachments.importFromFile({file:${JSON.stringify(resolve("output/windows-acceptance/papers/replacement.pdf"))},parentItemID:p.id});return true;`,
    );
    const r = await call("get_pages", {
      libraryID: 1,
      key: f.key,
      start: 1,
      end: 1,
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /multiple|attachment|多个/i);
    const explicit = await call("get_pages", { ...f, start: 1, end: 1 });
    assert.equal(explicit.ok, true);
    assert.match(explicit.data.pages[0].text, /Evidence entry/);
    return { ambiguous: r, explicit: explicit.data };
  });
  await check("replaced_pdf_rejects_old_quote", async () => {
    const p = await call("propose_annotations", {
      ...f,
      annotations: [
        {
          id: "replace-check",
          type: "highlight",
          page: 1,
          quote: entries[0].quote,
          comment: "Replacement safety check",
        },
      ],
    });
    await z.rdp.evaluate(
      `const a=Zotero.Items.getByLibraryAndKey(1,${JSON.stringify(f.attachmentKey)});for(const r of Zotero.Reader._readers.filter(r=>r.itemID===a.id))await r.close();const path=await a.getFilePathAsync();await IOUtils.copy(${JSON.stringify(resolve("output/windows-acceptance/papers/replacement.pdf"))},path);return true;`,
    );
    const r = await call("commit_annotations", {
      ...f,
      proposalId: p.data.proposalId,
    });
    assert.equal(r.data?.committed?.length ?? 0, 0);
    return r;
  });
  const paper = real.engines.native.fixture;
  await check("packaged_regex_worker_normal_and_deadline", async () => {
    const r = await call("search_with_regex", { ...paper, pattern: "28\\.4" });
    assert.equal(r.ok, true);
    assert.ok(r.data.hits.length > 0);
    const start = Date.now();
    const slow = await call("search_with_regex", {
      ...paper,
      pattern: ".*.*.*.*.*UNMATCHABLE_WINDOWS_SENTINEL",
    });
    assert.equal(slow.ok, false);
    assert.equal(slow.code, "timeout");
    assert.ok(Date.now() - start < 10000);
    return { normal: r.data, slow, elapsedMs: Date.now() - start };
  });
  await check("cancel_during_reader_initialization", async () =>
    z.rdp.evaluate(
      `const tools=Zotero.Confucius.hooks.host.tools;const open=Zotero.Reader.open;const win=Zotero.getMainWindow();const c=new win.AbortController();const updates=[];let beats=0;const timer=win.setInterval(()=>beats++,50);Zotero.Reader.open=()=>new Promise(()=>{});const cancel=win.setTimeout(()=>c.abort(),350);try{const start=Date.now();const result=await tools.execute("get_pages",${JSON.stringify({ ...paper, start: 1, end: 1 })},c.signal,{onProgress:p=>updates.push(p)});if(result.ok||Date.now()-start>3000||beats<3)throw new Error(JSON.stringify({result,beats}));return {result,updates,beats,elapsedMs:Date.now()-start};}finally{Zotero.Reader.open=open;win.clearInterval(timer);win.clearTimeout(cancel);}`,
    ),
  );
} finally {
  await save();
  z.rdp.close();
}
