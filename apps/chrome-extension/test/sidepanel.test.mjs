import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../sidepanel.js", import.meta.url),
  "utf8",
);

function loadSidepanel({ chrome, workspace }) {
  const elements = {
    token: { value: "" },
    pair: {},
    "push-tab": { disabled: false },
  };
  const values = new Map();
  const alerts = [];
  const warnings = [];
  const context = {
    alert: (message) => alerts.push(message),
    chrome,
    console: { warn: (...args) => warnings.push(args) },
    document: { getElementById: (id) => elements[id] },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
  };
  context.window = {
    ConfuciusBridge: { request: async () => ({ ok: true }) },
    ConfuciusWorkspace: workspace,
  };
  vm.runInNewContext(source, context, { filename: "sidepanel.js" });
  return { alerts, elements, values, warnings };
}

test("This tab dynamically injects the extractor on unlisted sites", async () => {
  const messages = [];
  const injections = [];
  const rpcCalls = [];
  const chrome = {
    tabs: {
      query: async () => [{ id: 42 }],
      sendMessage: async (tabId, message) => {
        messages.push({ tabId, message });
        if (messages.length === 1) {
          throw new Error("Receiving end does not exist");
        }
        return { title: "Example", url: "https://example.com" };
      },
    },
    scripting: {
      executeScript: async (input) => injections.push(input),
    },
  };
  const workspace = {
    getSessionId: () => "",
    rpc: async (method, params) => {
      rpcCalls.push({ method, params });
      return method === "session/new" ? { id: "session-1" } : {};
    },
  };
  const loaded = loadSidepanel({ chrome, workspace });

  await loaded.elements["push-tab"].onclick();

  assert.equal(messages.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(injections)), [
    { target: { tabId: 42 }, files: ["content-script.js"] },
  ]);
  assert.equal(rpcCalls[0].method, "session/new");
  assert.equal(rpcCalls[1].method, "session/setContext");
  assert.equal(rpcCalls[1].params.context.browserTab.tabId, 42);
  assert.equal(loaded.elements["push-tab"].disabled, false);
  assert.deepEqual(loaded.alerts, []);
});

test("This tab reports restricted pages and always restores the button", async () => {
  const chrome = {
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async () => {
        throw new Error("Receiving end does not exist");
      },
    },
    scripting: {
      executeScript: async () => {
        throw new Error("Cannot access chrome:// URL");
      },
    },
  };
  const loaded = loadSidepanel({ chrome, workspace: {} });

  await loaded.elements["push-tab"].onclick();

  assert.equal(loaded.alerts.length, 1);
  assert.equal(loaded.warnings.length, 1);
  assert.equal(loaded.elements["push-tab"].disabled, false);
});
