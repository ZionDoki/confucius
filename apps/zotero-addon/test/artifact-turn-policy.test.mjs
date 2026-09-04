import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

describe("artifact turn policy", () => {
  it("does not wrap completed replies as fallback report artifacts", () => {
    const host = source("src/modules/host/AgentHost.ts");
    assert.equal(host.includes("saveFallbackArtifact"), false);
    assert.equal(host.includes("producedArtifactTurnIds"), false);
    assert.equal(host.includes("Before completing, call"), false);
    assert.equal(host.includes("Required artifact kind:"), false);
    assert.match(host, /artifactUpsertGuidance/);
  });

  it("tells Codex and Kimi not to upsert just to finish a turn", () => {
    const plugin = source("src/modules/host/PluginRuntimeHost.ts");
    assert.equal(
      plugin.includes("Before completing, call artifact_upsert"),
      false,
    );
    assert.match(plugin, /artifactUpsertGuidance/);
  });

  it("no longer claims every successful turn leaves an artifact", () => {
    const en = source("addon/locale/en-US/addon.ftl");
    const zh = source("addon/locale/zh-CN/addon.ftl");
    assert.match(en, /Ordinary replies stay in the activity stream/);
    assert.equal(en.includes("A successful turn always leaves"), false);
    assert.match(zh, /不会自动变成产物/);
    assert.equal(zh.includes("成功完成的任务会在这里留下可修订产物"), false);
  });
});
