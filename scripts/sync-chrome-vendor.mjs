#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "apps", "chrome-extension", "vendor");
mkdirSync(vendor, { recursive: true });

const candidates = [
  join(root, "node_modules", "katex", "dist", "katex.min.js"),
  join(
    root,
    "apps",
    "zotero-addon",
    "node_modules",
    "katex",
    "dist",
    "katex.min.js",
  ),
];
const katex = candidates.find((path) => existsSync(path));
if (katex) {
  copyFileSync(katex, join(vendor, "katex.min.js"));
}
