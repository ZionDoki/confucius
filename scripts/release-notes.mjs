#!/usr/bin/env node
// Print the tagged version's curated notes; fail before publishing on a mismatch.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseNotes } from "./release-notes-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
process.stdout.write(
  releaseNotes(
    version,
    process.argv[2],
    readFileSync(join(root, "CHANGELOG.md"), "utf8"),
  ),
);
