#!/usr/bin/env node
// Print the tagged version's curated notes; fail before publishing on a mismatch.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const tag = process.argv[2];
const releaseVersion = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;
if (!releaseVersion.test(version) || tag !== `v${version}`) {
  throw new Error(`Release tag ${tag ?? "(missing)"} must match v${version}.`);
}
const sections = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(
  /^## /m,
);
const current = sections.find((section) => section.startsWith(`${version} - `));
if (!current) throw new Error(`CHANGELOG.md has no entry for ${version}.`);
const newline = current.indexOf("\n");
const body = current.slice(newline + 1).trim();
const date = current.slice(0, newline).trim().slice(`${version} - `.length);
if (!body || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  throw new Error(
    `CHANGELOG.md entry for ${version} needs a date and release notes.`,
  );
}
const previous = sections
  .slice(sections.indexOf(current) + 1)
  .map(
    (section) =>
      section.match(/^(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?) - /)?.[1],
  )
  .find(Boolean);
process.stdout.write(`${body}\n`);
if (previous) {
  process.stdout.write(
    `\n**Full Changelog**: https://github.com/ZionDoki/confucius/compare/v${previous}...${tag}\n`,
  );
}
