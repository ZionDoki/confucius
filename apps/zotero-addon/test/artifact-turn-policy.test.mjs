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

  it("keeps write-tool consent inside the deep-reading research phase", () => {
    const prompt = source("../../packages/protocol/src/artifactPrompt.ts");
    const skill = source("../../skills/paper-deep-reading/SKILL.md");
    const host = source("src/modules/host/AgentHost.ts");
    const workflow = source("src/modules/host/PresetWorkflow.ts");
    assert.doesNotMatch(prompt, /commit_annotations/);
    assert.match(workflow, /commit_annotations approval dialog/);
    assert.match(workflow, /This stage must not draft/);
    assert.match(workflow, /Do not restart broad reading/);
    assert.match(skill, /immediately call `commit_annotations`/);
    assert.match(skill, /Do not ask the user to approve in chat/);
    assert.match(host, /toolWasRequested\(messages, "commit_annotations"\)/);
    assert.match(host, /new PresetResearchToolProvider/);
    assert.match(host, /presetResearchToolNames\(workflow\)/);
    assert.match(host, /presetResearchToolCallInScope/);
    assert.match(host, /new Set\(\[ARTIFACT_UPSERT_TOOL\]\)/);
    assert.match(host, /startExternalPresetWorkflow/);
    assert.match(host, /buildWorkflowHandoffFromEvents/);
    assert.match(host, /externalToolNames/);
  });

  it("removes recall content and recall tools from both preset phases", () => {
    const host = source("src/modules/host/AgentHost.ts");
    const workflow = source("src/modules/host/PresetWorkflow.ts");
    assert.match(host, /includeRecallContext: !workflow/);
    assert.match(host, /includeRecallContext: false/);
    assert.match(host, /ISOLATED WORKFLOW CONTEXT/);
    assert.match(workflow, /Preset research is deliberately narrower/);
    assert.doesNotMatch(workflow, /"memory_search"/);
    assert.match(workflow, /presetResearchToolNames/);
  });
});
