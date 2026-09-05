#!/usr/bin/env node
// Fail (exit 1) unless every workspace package carries the root package's
// version. Run via `npm run versions:check` in CI.
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
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
  "apps/agent-sidecar/package.json",
  "apps/zotero-addon/package.json",
  "package-lock.json",
];

let failed = false;
function checkVersion(relative, actual) {
  if (actual === expected) return;
  console.error(`${relative}: version ${actual} != ${expected} (root)`);
  failed = true;
}
for (const relative of targets) {
  const parsed = JSON.parse(readFileSync(join(root, relative), "utf8"));
  checkVersion(relative, parsed.version);
  if (relative === "package-lock.json") {
    for (const workspace of [
      "",
      ...targets
        .filter((path) => path !== relative)
        .map((path) => posix.dirname(path)),
    ]) {
      checkVersion(
        `${relative} packages[${JSON.stringify(workspace)}]`,
        parsed.packages?.[workspace]?.version,
      );
    }
  }
}
const versionSource = readFileSync(
  join(root, "packages/protocol/src/version.ts"),
  "utf8",
);
checkVersion(
  "CONFUCIUS_VERSION",
  versionSource.match(/CONFUCIUS_VERSION\s*=\s*"([^"]+)"/)?.[1],
);
if (failed) {
  process.exit(1);
}
console.log(`All workspaces at version ${expected}.`);
