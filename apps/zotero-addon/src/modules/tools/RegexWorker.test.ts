import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { Worker } from "node:worker_threads";
import { regexMatches, literalMatches, type SearchWorker } from "./RegexWorker";

const script = readFileSync(
  new URL("../../../addon/content/regex-worker.js", import.meta.url),
  "utf8",
);
function workerFactory(onTerminate: () => void = () => {}): () => SearchWorker {
  return () => {
    const worker = new Worker(
      `const { parentPort } = require('node:worker_threads'); const self = { postMessage: (message) => parentPort.postMessage(message) }; ${script}\nparentPort.on('message', (data) => self.onmessage({data}));`,
      { eval: true },
    );
    const api: SearchWorker = {
      onmessage: null,
      onerror: null,
      postMessage: (value) => worker.postMessage(value),
      terminate: () => {
        onTerminate();
        void worker.terminate();
      },
    };
    worker.on("message", (data) => api.onmessage?.({ data }));
    worker.on("error", (error) => api.onerror?.({ message: error.message }));
    return api;
  };
}
it("terminates a pathological regex without blocking the host", async () => {
  let terminated = false,
    hostResponded = false;
  setTimeout(() => {
    hostResponded = true;
  }, 10);
  await assert.rejects(
    regexMatches(
      "(a|aa)+$",
      "a".repeat(2000) + "!",
      undefined,
      workerFactory(() => {
        terminated = true;
      }),
      80,
    ),
    /timed out/,
  );
  assert.equal(terminated, true);
  assert.equal(hostResponded, true);
});
it("bounds empty regex matches and terminates on cancellation", async () => {
  const matches = await regexMatches(
    "(?=a)",
    "a".repeat(50),
    undefined,
    workerFactory(),
  );
  assert.equal(matches.length, 21); // One extra hit tells the host that the visible 20 were truncated.
  const abort = new AbortController();
  abort.abort();
  let terminated = false;
  await assert.rejects(
    regexMatches(
      "a",
      "abc",
      abort.signal,
      workerFactory(() => {
        terminated = true;
      }),
    ),
    /cancelled/,
  );
  assert.equal(terminated, true);
});
it("keeps literal metacharacters literal", () => {
  assert.equal(literalMatches("(a+)+$", "a".repeat(1000)).length, 0);
  assert.equal(literalMatches("[", "a[b")[0].index, 1);
});
