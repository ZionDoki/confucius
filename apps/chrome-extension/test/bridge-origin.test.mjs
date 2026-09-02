import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../bridge-origin.js", import.meta.url),
  "utf8",
);

function loadBridge(fetch, seed = {}) {
  const values = new Map(Object.entries(seed));
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const context = { fetch, localStorage };
  context.window = context;
  vm.runInNewContext(source, context, { filename: "bridge-origin.js" });
  return { bridge: context.ConfuciusBridge, values };
}

test("falls back from the packaged port to the development Zotero port", async () => {
  const calls = [];
  const { bridge, values } = loadBridge(async (url) => {
    calls.push(url);
    if (url.includes(":23119/")) throw new TypeError("connection refused");
    return { status: 200, ok: true };
  });

  const response = await bridge.request("/confucius/v1/pair", {
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "http://127.0.0.1:23119/confucius/v1/pair",
    "http://127.0.0.1:23124/confucius/v1/pair",
  ]);
  assert.equal(values.get("confuciusOrigin"), "http://127.0.0.1:23124");
});

test("retries a 404 but treats 401 as a discovered Zotero bridge", async () => {
  const notFoundCalls = [];
  const fallback = loadBridge(async (url) => {
    notFoundCalls.push(url);
    return url.includes(":23119/")
      ? { status: 404, ok: false }
      : { status: 200, ok: true };
  });
  assert.equal((await fallback.bridge.request("confucius/v1/rpc")).status, 200);
  assert.equal(notFoundCalls.length, 2);

  const unauthorizedCalls = [];
  const unauthorized = loadBridge(async (url) => {
    unauthorizedCalls.push(url);
    return { status: 401, ok: false };
  });
  assert.equal(
    (await unauthorized.bridge.request("/confucius/v1/rpc")).status,
    401,
  );
  assert.equal(unauthorizedCalls.length, 1);
  assert.equal(
    unauthorized.values.get("confuciusOrigin"),
    "http://127.0.0.1:23119",
  );
});

test("tries the last successful origin first on later requests", async () => {
  const calls = [];
  const { bridge } = loadBridge(
    async (url) => {
      calls.push(url);
      return { status: 200, ok: true };
    },
    { confuciusOrigin: "http://127.0.0.1:23124" },
  );
  await bridge.request("/confucius/v1/rpc");
  assert.equal(calls[0], "http://127.0.0.1:23124/confucius/v1/rpc");
});
