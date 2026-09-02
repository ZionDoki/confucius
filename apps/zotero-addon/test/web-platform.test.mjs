import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("Zotero sandbox installs AbortController and fetch from the main window", () => {
  const index = read("src/index.ts");
  const platform = read("src/utils/webPlatform.ts");
  assert.equal(index.includes("installWebPlatform"), true);
  assert.equal(platform.includes("createAbortController"), true);
  assert.equal(platform.includes("SandboxAbortController"), true);
  assert.equal(platform.includes("hostFetch"), true);
  assert.equal(platform.includes("Zotero.HTTP"), true);
  assert.equal(platform.includes("zoteroBufferedFetch"), true);
  assert.equal(platform.includes("xhrStreamFetch"), true);
  assert.equal(platform.includes("hostFetchCanStream"), true);
  assert.equal(platform.includes("onprogress"), true);
  assert.equal(platform.includes("mozBackgroundRequest"), true);
  assert.equal(platform.includes("mixed content"), true);
});

test("sending a prompt does not construct the missing sandbox AbortController", () => {
  const host = read("src/modules/host/AgentHost.ts");
  assert.equal(host.includes("new AbortController("), false);
  assert.equal(host.includes("createAbortController("), true);
  assert.equal(host.includes("fetchImpl: hostFetch"), true);
  assert.equal(host.includes("hostFetchCanStream"), true);
  assert.equal(host.includes("errorMessage"), true);
});

test("MCP client uses the sandbox-safe fetch", () => {
  const mcp = read("src/modules/host/McpToolProvider.ts");
  assert.equal(mcp.includes("hostFetch"), true);
});
