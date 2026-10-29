/** Installed add-on acceptance with deterministic OpenAlex responses and durable child archives. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IsolatedZotero } from "./lib/zotero-live.mjs";
import { resolveZoteroExecutable } from "../apps/zotero-addon/src/development/zoteroExecutable.ts";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_RANKING_OUTPUT ??
    join(root, "output/literature-ranking-live"),
);
await mkdir(join(output, "apps/zotero-addon/.scaffold"), { recursive: true });
const instance = await IsolatedZotero.create({
  root: output,
  binary: resolveZoteroExecutable().path,
  xpi: join(root, "apps/zotero-addon/.scaffold/build/confucius.xpi"),
  prefix: "isolated-",
});
const report = { checks: [] };
const evaluate = (source) =>
  instance.rdp.evaluate(
    `const host=Zotero.Confucius.hooks.host,q=Zotero.__rankingQA;${source}`,
    30000,
  );
const check = (name, value) => {
  assert.ok(value, name);
  report.checks.push(name);
  console.log(name);
};
try {
  await instance.launch();
  report.environment = instance.environment;
  await evaluate(`Zotero.__rankingQA={serial:0};const qa=Zotero.__rankingQA;
    qa.raw=(i,extra={})=>({id:'https://openalex.org/W'+(1000+i),title:'Paper '+i,publication_year:2024,authorships:[],abstract_inverted_index:{evidence:[0]},...extra});
    qa.task=host.sessionNew({title:'Literature ranking acceptance'});qa.provider=host.literatureTools(host.requireSession(qa.task.id));
    host.openAlex.transport=async()=>({status:200,data:{results:[qa.raw(++qa.serial)],meta:{count:1}}});
    return true;`);
  const refresh =
    await evaluate(`const a=await q.provider.call('literature_search',{query:'refresh'}),b=await q.provider.call('literature_search',{query:'refresh',refresh:true}),c=await q.provider.call('literature_search',{query:'refresh'});
    return {first:a.data.queryId,refreshed:b.data.queryId,cached:c.data.queryId,requests:q.serial};`);
  check(
    "Refresh supersedes the older cached query",
    refresh.first !== refresh.refreshed &&
      refresh.cached === refresh.refreshed &&
      refresh.requests === 2,
  );
  const rerank =
    await evaluate(`let calls=0;await host.rpc('literature/configure',{key:'synthetic-fixture'});
    host.openAlex.transport=async()=>++calls===1?{status:200,data:{results:[q.raw(10,{relevance_score:10,rerank_score:0.1}),q.raw(11,{relevance_score:1,rerank_score:0.9})],meta:{count:101,next_cursor:'page2',reranked:true}}}:{status:200,data:{results:[q.raw(12,{relevance_score:999})],meta:{count:101,reranked:false}}};
    const first=await q.provider.call('literature_search',{query:'rerank',rerank:true});const page=await q.provider.call('literature_search',{queryId:first.data.queryId});return page;`);
  check(
    "Later cursor pages preserve the reranked cohort",
    rerank.ok &&
      rerank.data.ranking.reranked &&
      rerank.data.items.map((w) => w.id).join() === "W1011,W1010,W1012",
  );
  const impact = await evaluate(
    `host.openAlex.transport=async()=>({status:200,data:{results:[q.raw(20,{relevance_score:1,fwci:10,citation_normalized_percentile:{value:0.99}}),q.raw(21,{relevance_score:1,fwci:1})],meta:{count:2}}});return q.provider.call('literature_search',{query:'impact'});`,
  );
  check(
    "FWCI and percentile units are not mixed",
    impact.ok && impact.data.items[0].id === "W1020",
  );
  const cancellation =
    await evaluate(`let release;const gate=new Promise(resolve=>release=resolve);host.openAlex.transport=async()=>{await gate;return {status:200,data:{results:[q.raw(30)],meta:{count:1}}};};
    const first=q.provider.call('literature_search',{query:'cancel'});const abort=new AbortController();const second=q.provider.call('literature_search',{query:'cancel'},abort.signal);abort.abort();release();await first;return second;`);
  check("Cancelled queued cache readers stay cancelled", !cancellation.ok);
  const child =
    await evaluate(`let calls=0;host.openAlex.transport=async()=>{const base=100*(++calls);return {status:200,data:{results:Array.from({length:20},(_,i)=>q.raw(base+i,{relevance_score:i})),meta:{count:20}}};};
    const path=${JSON.stringify(join(instance.profile, "ranking-child.json"))};
    const run={document:{record:{parentTaskId:q.task.id,allowSearch:true,sourceIds:[],evidence:[]},archive:{}},task:{id:'ranking-child',lockedContext:{items:[]}},abort:new AbortController(),save:async()=>IOUtils.writeJSON(path,run.document)};
    const make=()=>host.subagents().options.tools(run);let tools=make();
    const first=await tools.call('literature_search',{query:'child first'}),second=await tools.call('literature_search',{query:'child second',limit:12});
    const pool=await host.literature.load(q.task.id);pool.works.find(w=>w.id===first.data.items[0].id).acquisition={status:'available',attachmentKey:'PARENT_NEW'};await host.literature.save(pool);
    const repeated=await tools.call('literature_search',{query:'child first'});
    run.document=await IOUtils.readJSON(path);tools=make();
    const listed=await tools.call('literature_list',{queryId:second.data.queryId,limit:12});
    const metadata=await tools.call('literature_list',{queryId:second.data.queryId,view:'metadata',offset:10,limit:5});
    const foreign=await tools.call('literature_list',{queryId:${JSON.stringify(refresh.refreshed)}});
    return {same:JSON.stringify(listed.data.items)===JSON.stringify(second.data.items),count:listed.data.items.length,next:listed.data.nextOffset,metadata:metadata.data.items.length,total:metadata.data.total,frozen:repeated.data.items[0].acquisition.status,foreign:foreign.code};`);
  check(
    "Child shortlist is query-scoped after archive reload",
    child.same && child.count === 12 && child.next === null,
  );
  check(
    "Child metadata pagination stays within its query",
    child.metadata === 5 && child.total === 20,
  );
  check(
    "Repeated child searches retain frozen acquisition state",
    child.frozen === "missing",
  );
  check(
    "Child cannot list a parent-only query",
    child.foreign === "permission_denied",
  );
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await instance.stop({ graceful: true });
}
