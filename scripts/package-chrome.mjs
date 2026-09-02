#!/usr/bin/env node
// Zip the Chrome extension into dist/confucius-chrome-<version>.zip for
// release. Preserve extension subdirectories so icons and vendored assets are
// available after installation.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import AdmZip from "adm-zip";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "apps", "chrome-extension");
const version = JSON.parse(
  readFileSync(join(source, "manifest.json"), "utf8"),
).version;
const dist = join(root, "dist");
const target = join(dist, `confucius-chrome-${version}.zip`);

await import(
  pathToFileURL(join(root, "scripts", "sync-chrome-vendor.mjs")).href
);
await import(
  pathToFileURL(join(root, "scripts", "sync-chrome-markdown.mjs")).href
);

for (const required of [
  "manifest.json",
  "sidepanel.html",
  "bridge-origin.js",
  "workspace-app.js",
  "markdown.js",
]) {
  if (!existsSync(join(source, required))) {
    console.error(`missing ${required} in apps/chrome-extension`);
    process.exit(1);
  }
}

mkdirSync(dist, { recursive: true });
rmSync(target, { force: true });

const archive = new AdmZip();
const excludedTopLevel = new Set(["package.json", "README.md", "test"]);
function addDirectory(absolute, relative = "") {
  for (const name of readdirSync(absolute).sort()) {
    if (!relative && excludedTopLevel.has(name)) continue;
    const path = join(absolute, name);
    const childRelative = relative ? `${relative}/${name}` : name;
    if (statSync(path).isDirectory()) {
      addDirectory(path, childRelative);
    } else {
      archive.addLocalFile(path, relative);
    }
  }
}
addDirectory(source);

const entries = new Set(archive.getEntries().map((entry) => entry.entryName));
for (const required of [
  "manifest.json",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "vendor/katex.min.js",
]) {
  if (!entries.has(required)) {
    console.error(`missing ${required} in Chrome release archive`);
    process.exit(1);
  }
}
archive.writeZip(target);
console.log(`Wrote ${target}`);
