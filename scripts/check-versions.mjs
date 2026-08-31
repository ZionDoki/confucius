#!/usr/bin/env node
// Fail (exit 1) unless every workspace package and the Chrome manifest carry
// the root package's version. Run via `npm run versions:check` in CI.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;

const targets = [
  "packages/harness/package.json",
  "packages/mcp-client/package.json",
  "packages/memory/package.json",
  "packages/protocol/package.json",
  "packages/skill-format/package.json",
  "packages/zotero-tools/package.json",
  "apps/zotero-addon/package.json",
  "apps/chrome-extension/package.json",
  "apps/chrome-extension/manifest.json",
];

let failed = false;
for (const relative of targets) {
  const parsed = JSON.parse(readFileSync(join(root, relative), "utf8"));
  if (parsed.version !== expected) {
    console.error(
      `${relative}: version ${parsed.version} != ${expected} (root)`,
    );
    failed = true;
  }
}
if (failed) {
  process.exit(1);
}
console.log(`All workspaces at version ${expected}.`);
