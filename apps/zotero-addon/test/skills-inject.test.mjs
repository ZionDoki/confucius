import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("agent loads skills by catalog + skill tool, not exclusive allowed-tools", () => {
  const host = readFileSync(
    join(root, "src/modules/host/AgentHost.ts"),
    "utf8",
  );
  const provider = readFileSync(
    join(root, "src/modules/host/SkillToolProvider.ts"),
    "utf8",
  );
  assert.equal(host.includes("formatSkillPromptSection"), true);
  assert.equal(host.includes("parseSkillInvocation"), true);
  assert.equal(host.includes("SkillToolProvider"), true);
  assert.equal(host.includes("SKILL_TOOL_NAME"), true);
  assert.equal(host.includes("loadedSkills"), true);
  assert.equal(host.includes("skill?.allowedTools"), false);
  assert.equal(host.includes("Active skill:"), false);
  assert.equal(provider.includes("name: SKILL_TOOL_NAME"), true);
  assert.equal(provider.includes("does not remove other tools"), true);
});
