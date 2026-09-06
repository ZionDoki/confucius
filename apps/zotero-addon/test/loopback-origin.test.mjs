import assert from "node:assert/strict";
import { test } from "node:test";
import { zoteroLoopbackOrigin } from "../src/modules/bridge/LoopbackOrigin.ts";

test("external tools use the running profile's listener, not the default or pending preference", () => {
  const previous = globalThis.Zotero;
  try {
    globalThis.Zotero = {
      Server: { port: 55831 },
      Prefs: { get: () => 23119 },
    };
    assert.equal(zoteroLoopbackOrigin(), "http://127.0.0.1:55831");
    for (const port of [undefined, 0, -1, 65536, "23119"]) {
      globalThis.Zotero.Server.port = port;
      assert.throws(() => zoteroLoopbackOrigin(), /not listening/);
    }
  } finally {
    globalThis.Zotero = previous;
  }
});
