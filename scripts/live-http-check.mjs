import assert from "node:assert/strict";

const origin =
  process.env.CONFUCIUS_ORIGIN || "http://127.0.0.1:23124";

async function getJson(path) {
  const response = await fetch(`${origin}${path}`);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, text };
}

const health = await getJson("/confucius/v1/health");
assert.equal(health.status, 200, `health HTTP ${health.status}: ${health.text}`);
assert.equal(health.body.ok, true);
assert.equal(health.body.name, "confucius");
console.log("health", health.body);

const rpc = await fetch(`${origin}/confucius/v1/rpc`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/list" }),
});
assert.equal(rpc.status, 401, `unauthenticated rpc should be 401, got ${rpc.status}`);

console.log("live HTTP check passed");
