#!/usr/bin/env node
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { startSidecar } from "./server.js";
import type { SidecarDescriptor } from "./types.js";

const descriptorPath =
  process.env.CONFUCIUS_SIDECAR_DESCRIPTOR ||
  join(homedir(), ".confucius", "sidecar.json");
const running = await startSidecar();
const descriptor: SidecarDescriptor = {
  protocol: 1,
  pid: process.pid,
  baseUrl: running.baseUrl,
  token: running.token,
  version: "0.3.1",
  startedAt: Date.now(),
};

await mkdir(dirname(descriptorPath), { recursive: true, mode: 0o700 });
const temporary = `${descriptorPath}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(descriptor, null, 2), {
  mode: 0o600,
});
await rename(temporary, descriptorPath);

process.stdout.write(`Confucius agent sidecar ready at ${running.baseUrl}\n`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await running.close().catch(() => undefined);
  try {
    const current = JSON.parse(
      await readFile(descriptorPath, "utf8"),
    ) as SidecarDescriptor;
    if (current.pid === process.pid && current.token === descriptor.token) {
      await rm(descriptorPath, { force: true });
    }
  } catch {
    // A newer sidecar owns the descriptor, or it has already been removed.
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void stop().then(() => process.exit(0)));
}
process.on("exit", () => {
  if (!stopping) removeOwnedDescriptorSync();
});

function removeOwnedDescriptorSync(): void {
  try {
    const current = JSON.parse(
      readFileSync(descriptorPath, "utf8"),
    ) as SidecarDescriptor;
    if (current.pid === process.pid && current.token === descriptor.token) {
      unlinkSync(descriptorPath);
    }
  } catch {
    // The descriptor is gone or belongs to a newer sidecar.
  }
}
