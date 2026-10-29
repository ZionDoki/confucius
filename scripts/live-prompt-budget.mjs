/** Real Zotero write/recovery with a deterministic model and an injected crash checkpoint. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IsolatedZotero, until } from "./lib/zotero-live.mjs";
import { resolveZoteroExecutable } from "../apps/zotero-addon/src/development/zoteroExecutable.ts";

const root = resolve(import.meta.dirname, "..");
const output = resolve(
  process.env.CONFUCIUS_BUDGET_OUTPUT ??
    join(root, "output/prompt-budget-live"),
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
    `const host=Zotero.Confucius.hooks.host,q=Zotero.__budgetQA;${source}`,
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
  await instance.rpc("config/set", {
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "synthetic-fixture",
    model: "budget-fixture",
    contextWindowTokens: 131072,
    maxTokens: 4096,
    maxIterations: 8,
    maxToolCalls: 4,
    historyAutoCleanup: false,
  });
  const task = await instance.rpc("task/new", {
    title: "Prompt budget recovery",
  });
  await instance.rpc("task/setPermissions", {
    taskId: task.id,
    permissionMode: "auto_allow",
  });
  await evaluate(`Zotero.__budgetQA={taskId:${JSON.stringify(task.id)},calls:0,waiting:false};const qa=Zotero.__budgetQA;
    host.openaiAdapter=()=>({complete:async(request,signal)=>{await request.onAttempt?.();
      if(++qa.calls===1)return {end:'tool_calls',usage:{promptTokens:20,completionTokens:10,totalTokens:30},toolCalls:[{id:'original-write',name:'create_collection',args:{name:'Budget recovery collection'}}]};
      qa.waiting=true;return new Promise(resolve=>{const stop=()=>resolve({end:'stop',text:'Interrupted fixture'});signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();});}});return true;`);
  await instance.rpc("task/prompt", {
    taskId: task.id,
    text: "Create the Budget recovery collection.",
  });
  await until(() => evaluate("return q.waiting;"), 30000);
  await instance.rpc("task/abort", { taskId: task.id });
  await until(
    () => evaluate("return !host.sessions.get(q.taskId).activeTurnId;"),
    30000,
  );
  const seeded =
    await evaluate(`const s=host.sessions.get(q.taskId),cp=JSON.parse(JSON.stringify(s.latestCheckpoint));
    const write=cp.toolExecutions.find(x=>x.toolName==='create_collection');if(!write?.result?.ok)throw new Error('Native write did not succeed');
    const operation=await host.execution.getOperation(s.record.id+':'+cp.turnId+':'+write.callId);
    if(operation?.result?.effect!=='applied')throw new Error('Missing durable applied receipt');
    write.status='started';delete write.result;
    cp.iteration=8;cp.toolCallsUsed=4;Object.assign(cp.budget,{iterationsUsed:8,modelAttempts:8,toolCallsUsed:4});
    s.latestCheckpoint=cp;s.safeCheckpoint=undefined;s.record.run.status='interrupted';Object.assign(s.record.run.budget,{iterationsUsed:8,toolCallsUsed:4,executorStarts:8});
    q.beforeTokens=s.record.run.budget.totalTokens;q.checkpoint=cp;q.calls=0;
    host.openaiAdapter=()=>({complete:async request=>{await request.onAttempt?.();const n=++q.calls;
      if(n===1)return {end:'tool_calls',toolCalls:[{id:'repeated-write',name:'create_collection',args:{name:'Budget recovery collection'}}]};
      if(n===2)return {end:'tool_calls',toolCalls:[{id:'fresh-read',name:'get_collections',args:{}}]};
      return {end:'stop',text:'Collection verified',usage:{promptTokens:2,completionTokens:1,totalTokens:3}};}});
    return {tokens:q.beforeTokens,receipt:operation.result.effect};`);
  check(
    "Interrupted native write has a durable applied receipt",
    seeded.receipt === "applied",
  );
  await instance.rpc("task/continue", { taskId: task.id });
  await until(
    () => evaluate("return !host.sessions.get(q.taskId).activeTurnId;"),
    30000,
  );
  check(
    "Automatic continuation does not renew exhausted allowance",
    await evaluate("return q.calls===0;"),
  );
  // The automatic budget stop may save another checkpoint; restore the injected crash boundary.
  await evaluate(
    "const s=host.sessions.get(q.taskId);s.latestCheckpoint=q.checkpoint;return true;",
  );
  await instance.rpc("task/prompt", { taskId: task.id, text: "继续" });
  await until(
    () => evaluate("return !host.sessions.get(q.taskId).activeTurnId;"),
    30000,
  );
  const result =
    await evaluate(`const s=host.sessions.get(q.taskId),rows=await Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID);
    return {count:rows.filter(c=>c.name==='Budget recovery collection').length,calls:q.calls,budget:s.record.run.budget,status:s.record.run.status,read:s.latestCheckpoint?.toolExecutions.some(c=>c.toolName==='get_collections'&&c.result?.ok),checkpointUnchanged:q.checkpoint.toolExecutions.find(c=>c.toolName==='create_collection').status==='started'};`);
  report.result = result;
  check(
    "Typed continuation renews execution allowance and finishes",
    result.status === "completed" && result.calls >= 3,
  );
  check(
    "Recovered write is not applied twice to the real library",
    result.count === 1,
  );
  check("Renewed prompt can perform a fresh native read", result.read);
  check(
    "Cumulative tokens survive renewal",
    result.budget.totalTokens >= seeded.tokens + 3,
  );
  check(
    "Recovery leaves the input checkpoint unchanged",
    result.checkpointUnchanged,
  );
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await instance.stop({ graceful: true });
}
