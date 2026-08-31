#!/usr/bin/env node
// Zip the Chrome extension into dist/confucius-chrome-<version>.zip for
// release. Uses the system `zip` when available, else PowerShell on Windows.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "apps", "chrome-extension");
const version = JSON.parse(
  readFileSync(join(source, "manifest.json"), "utf8"),
).version;
const dist = join(root, "dist");
const target = join(dist, `confucius-chrome-${version}.zip`);

for (const required of ["manifest.json", "sidepanel.html", "workspace-app.js"]) {
  if (!existsSync(join(source, required))) {
    console.error(`missing ${required} in apps/chrome-extension`);
    process.exit(1);
  }
}

mkdirSync(dist, { recursive: true });
try {
  execFileSync("zip", ["-j", target, join(source, "*")], { stdio: "inherit" });
} catch {
  const psCommand = [
    "$ErrorActionPreference='Stop'",
    `Compress-Archive -Path '${join(source, "*").replace(/\\/g, "\\")}' -DestinationPath '${target.replace(/\\/g, "\\")}' -Force`,
  ].join("; ");
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", psCommand],
    { stdio: "inherit" },
  );
}
console.log(`Wrote ${target}`);
