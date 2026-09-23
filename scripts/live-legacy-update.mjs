/** Upgrade an unmodified published XPI through its own updater, in an empty profile. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { IsolatedZotero } from "./lib/zotero-live.mjs";

const [oldPath, targetPath, outputPath, requestedChannel] =
  process.argv.slice(2);
assert.ok(
  oldPath && targetPath && outputPath,
  "Usage: node scripts/live-legacy-update.mjs old.xpi target.xpi report.json [stable|beta]",
);
const root = resolve(import.meta.dirname, "..");
const old = resolve(oldPath),
  target = resolve(targetPath),
  output = resolve(outputPath);
assert.ok(
  output.startsWith(resolve(root, "output") + "/"),
  "Keep reports in ignored output/",
);
const manifest = (path) =>
  JSON.parse(
    execFileSync("unzip", ["-p", path, "manifest.json"], { encoding: "utf8" }),
  );
const from = manifest(old).version,
  to = manifest(target).version;
const channel = requestedChannel ?? (to.includes("-beta.") ? "beta" : "stable");
assert.ok(["stable", "beta"].includes(channel), "Invalid update channel");
assert.ok(
  !to.includes("-beta.") || channel === "beta",
  "Betas require the beta channel",
);
assert.notEqual(from, to, "Use an actual older installed version");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  startedAt: new Date().toISOString(),
  from,
  to,
  channel,
  checks: [],
  oldSha256: sha(await readFile(old)),
  targetSha256: sha(await readFile(target)),
  scope:
    "Unmodified published updater and real GitHub; isolated profile, synthetic draft, no model calls",
};
const instance = await IsolatedZotero.create({
  root,
  xpi: old,
  prefix: "legacy-update-",
  binary:
    process.env.ZOTERO_BIN ?? "/Applications/Zotero.app/Contents/MacOS/zotero",
});
const check = (name, condition, detail) => {
  assert.ok(condition, `${name}${detail ? ": " + JSON.stringify(detail) : ""}`);
  report.checks.push(name);
  console.log("PASS", from, name);
};
const evaluate = (code) =>
  instance.rdp.evaluate(
    `if(PathUtils.profileDir!==${JSON.stringify(instance.profile)}||Zotero.DataDirectory.dir!==${JSON.stringify(instance.data)})throw new Error('Wrong isolated profile');${code}`,
  );
try {
  report.before = await instance.launch();
  check(
    "Original package is normally installed",
    instance.environment.version === from && !instance.environment.temporary,
  );
  check(
    "Installed old bytes match the published XPI",
    sha(
      await readFile(
        join(instance.profile, "extensions/confucius@zotero.plugin.xpi"),
      ),
    ) === report.oldSha256,
  );
  const task = await instance.rpc("task/new", {
    title: "Legacy update acceptance",
    backend: "native",
    context: { version: 1, capturedAt: Date.now(), items: [] },
  });
  const draft = "升级前保存的中文草稿 😀";
  await instance.rpc("task/draft", { taskId: task.id, text: draft });
  const stable = await instance.rpc("update/setPrerelease", { enabled: false });
  check(
    "Stable-only channel does not offer a Beta",
    stable.state !== "error" && !stable.availableVersion?.includes("-"),
    stable,
  );
  if (!to.includes("-beta."))
    check(
      "Stable target is available with Betas disabled",
      stable.state === "available" &&
        stable.availableVersion === to &&
        stable.canInstall,
      stable,
    );
  report.discovery =
    channel === "stable"
      ? stable
      : await instance.rpc("update/setPrerelease", { enabled: true });
  check(
    "Old updater discovers the published target",
    report.discovery.state === "available" &&
      report.discovery.availableVersion === to &&
      report.discovery.currentVersion === from &&
      report.discovery.canInstall,
    report.discovery,
  );
  report.install = await instance.rpc("update/install", {}, 180_000);
  check(
    "Old updater downloads, verifies and installs",
    report.install.state === "ready",
    report.install,
  );
  await instance.stop({ graceful: true });
  report.after = await instance.launch();
  check(
    "Target version survives a full restart",
    instance.environment.version === to && !instance.environment.temporary,
  );
  check(
    "Installed bytes match the target public package",
    sha(
      await readFile(
        join(instance.profile, "extensions/confucius@zotero.plugin.xpi"),
      ),
    ) === report.targetSha256,
  );
  check(
    "Task and Chinese draft survive",
    (await instance.rpc("task/load", { taskId: task.id })).draft.text === draft,
  );
  check(
    "Explicit channel selection survives upgrade",
    await evaluate(
      `return Zotero.Prefs.get('extensions.zotero.confucius.updateChannel',true)===${JSON.stringify(channel)};`,
    ),
  );
  const current = await instance.rpc("update/check");
  check(
    "Current version is not offered again",
    current.state === "up-to-date" && !current.canInstall,
    current,
  );
  const disabled = await instance.rpc("update/setPrerelease", {
    enabled: false,
  });
  check(
    "Disabling Betas cannot downgrade",
    disabled.state === "up-to-date" &&
      !disabled.canInstall &&
      disabled.currentVersion === to,
    disabled,
  );
  await instance.stop({ graceful: true });
  await instance.launch();
  check(
    "Channel and independent automatic-check settings survive restart",
    await evaluate(
      "return Zotero.Prefs.get('extensions.zotero.confucius.updateChannel',true)==='stable'&&Zotero.Prefs.get('extensions.zotero.confucius.updateAutoCheck',true)===false;",
    ),
  );
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  await instance.stop({ graceful: true });
  instance.rdp?.close();
}
