import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const addonRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(addonRoot, "..", "..");

test("builtin skills are generated from skills/ and not drifting", () => {
  const output = execFileSync(
    process.execPath,
    [join(repoRoot, "scripts", "sync-skills.mjs"), "--check"],
    { encoding: "utf8" },
  );
  assert.match(output, /in sync/);
});

test("every skills/ directory ships in the generated module", () => {
  const generated = readFileSync(
    join(addonRoot, "src", "modules", "skills", "builtin.ts"),
    "utf8",
  );
  const entries = readdirSync(join(repoRoot, "skills"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(entries.length >= 5);
  for (const slug of entries) {
    assert.ok(generated.includes(JSON.stringify(slug)), slug);
  }
});
