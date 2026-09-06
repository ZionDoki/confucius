import assert from "node:assert/strict";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

it("loads and validates tool schemas in the Zotero bootstrap sandbox without console", async () => {
  const bundle = await build({
    entryPoints: [
      fileURLToPath(new URL("./SchemaValidate.ts", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    globalName: "HarnessSchema",
  });
  // vm otherwise supplies its own console, hiding Zotero's missing global.
  const sandbox = { console: undefined };
  const result = runInNewContext(
    `${bundle.outputFiles[0].text}\nHarnessSchema.validateValue({type:"integer",minimum:1}, "2")`,
    sandbox,
    { timeout: 2000 },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    value: 2,
    issues: [],
  });
  assert.equal(sandbox.console, undefined);
});

it("uses injected timers for adapter deadlines and HTTP retries without timer globals", async () => {
  const bundle = await build({
    entryPoints: [
      fileURLToPath(new URL("./OpenAICompatibleAdapter.ts", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    globalName: "Transport",
  });
  const scheduled: number[] = [];
  const pending = new Map<number, () => void>();
  let sequence = 0;
  let requests = 0;
  const sandbox = {
    console: undefined,
    setTimeout: undefined,
    clearTimeout: undefined,
    AbortController: undefined,
    createController: () => new AbortController(),
    schedule: (callback: () => void, ms: number) => {
      const id = sequence++;
      scheduled.push(ms);
      pending.set(id, callback);
      if (ms < 1000)
        queueMicrotask(() => {
          if (pending.delete(id)) callback();
        });
      return id;
    },
    cancel: (id: number) => {
      pending.delete(id);
    },
    fetchFixture: async () =>
      ++requests === 1
        ? new Response("retry", {
            status: 429,
            headers: { "retry-after": "0" },
          })
        : new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            }),
          ),
  };
  const turn = await runInNewContext(
    `${bundle.outputFiles[0].text}\nnew Transport.OpenAICompatibleAdapter({baseUrl:"https://example.invalid/v1",apiKey:"test",model:"fixture",stream:false,createAbortController:createController,scheduleTimeout:schedule,cancelTimeout:cancel,fetchImpl:fetchFixture}).complete({messages:[{role:"user",content:"fixture"}]})`,
    sandbox,
    { timeout: 2000 },
  );
  assert.equal(turn.text, "ok");
  assert.equal(turn.end, "stop");
  assert.equal(requests, 2);
  assert.ok(scheduled.includes(120000));
  assert.ok(scheduled.includes(600000));
  assert.ok(scheduled.includes(0));
  assert.equal(pending.size, 0);
});
