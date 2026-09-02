#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { format } from "prettier";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "apps", "chrome-extension", "markdown.js");
const check = process.argv.includes("--check");
const result = await build({
  entryPoints: [join(root, "packages", "protocol", "src", "markdown.ts")],
  bundle: true,
  format: "iife",
  globalName: "ConfuciusMarkdown",
  logLevel: "silent",
  platform: "browser",
  target: "chrome114",
  write: false,
});
const generated = await format(result.outputFiles[0].text, {
  endOfLine: "lf",
  filepath: target,
  printWidth: 80,
  tabWidth: 2,
});
const current = readFileSync(target, "utf8").replace(/\r\n/g, "\n");

if (check) {
  if (current !== generated) {
    console.error(
      "apps/chrome-extension/markdown.js is stale; run npm run sync-chrome-markdown",
    );
    process.exit(1);
  }
  console.log("Chrome Markdown bundle is up to date.");
} else if (current !== generated) {
  writeFileSync(target, generated, "utf8");
  console.log("Updated apps/chrome-extension/markdown.js.");
}
