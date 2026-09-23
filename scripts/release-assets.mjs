#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repository = "ZionDoki/confucius";
const addonId = "confucius@zotero.plugin";
const digest = (bytes, kind = "sha256") =>
  createHash(kind).update(bytes).digest("hex");

export function assertAssets(actual, expected) {
  assert.ok(Array.isArray(actual), "Release assets must be an array");
  assert.deepEqual(
    actual.map((a) => a.name).sort(),
    expected.map((a) => a.name).sort(),
    "Release files must match the validated build",
  );
  for (const file of expected) {
    const asset = actual.find((a) => a.name === file.name);
    assert.equal(asset.state, "uploaded", `${file.name} is not uploaded`);
    assert.equal(asset.size, file.size, `${file.name} size mismatch`);
    assert.ok(asset.size > 0);
    assert.equal(
      asset.digest,
      `sha256:${file.sha256}`,
      `${file.name} checksum mismatch`,
    );
    assert.ok(
      !asset.label || asset.label === asset.name,
      "Keep filenames visible",
    );
  }
}

export function assertRelease(release, tag, draft) {
  assert.equal(release.tag_name, tag, "Release tag mismatch");
  assert.equal(
    release.draft,
    draft,
    draft
      ? "Refusing to modify a published release"
      : "Release is still a draft",
  );
  assert.equal(
    release.prerelease,
    tag.includes("-beta."),
    "Release channel mismatch",
  );
  assert.ok(
    Number.isSafeInteger(release.id) && release.id > 0,
    "Invalid release ID",
  );
}

export function localAssets(directory, version) {
  const tag = `v${version}`;
  const files = [
    "confucius.xpi",
    "update-beta.json",
    ...(version.includes("-beta.") ? [] : ["update.json"]),
  ];
  assert.deepEqual(
    readdirSync(directory)
      .filter((n) => n.endsWith(".xpi") || /^update.*\.json$/.test(n))
      .sort(),
    [...files].sort(),
  );
  const bytes = readFileSync(resolve(directory, "confucius.xpi"));
  const manifest = JSON.parse(
    execFileSync(
      "unzip",
      ["-p", resolve(directory, "confucius.xpi"), "manifest.json"],
      { encoding: "utf8" },
    ),
  );
  assert.equal(manifest.version, version);
  assert.equal(manifest.applications.zotero.id, addonId);
  for (const file of files.filter((n) => n.endsWith(".json"))) {
    const updates = JSON.parse(readFileSync(resolve(directory, file), "utf8"))
      .addons[addonId].updates;
    assert.equal(updates.length, 1);
    const update = updates[0];
    assert.equal(update.version, version);
    assert.equal(
      update.update_link,
      `https://github.com/${repository}/releases/download/${tag}/confucius.xpi`,
    );
    assert.equal(update.update_hash, `sha512:${digest(bytes, "sha512")}`);
    for (const key of ["strict_min_version", "strict_max_version"])
      assert.equal(
        update.applications.zotero[key],
        manifest.applications.zotero[key],
      );
  }
  return files.map((name) => {
    const bytes = readFileSync(resolve(directory, name));
    return { name, size: bytes.length, sha256: digest(bytes) };
  });
}
function api(path, missing = false) {
  const result = spawnSync("gh", ["api", `repos/${repository}/${path}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (missing && /HTTP 404/.test(result.stderr)) return undefined;
    throw new Error(result.stderr || "GitHub API request failed");
  }
  return JSON.parse(result.stdout);
}

/** Verify the contract used by already installed, list-only updaters. */
export async function verifyPublicAssets(
  tag,
  expected,
  { request = fetch, pause = delay, attempts = 12, consecutive = 3 } = {},
) {
  let last;
  let complete = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await request(
        `https://api.github.com/repos/${repository}/releases?per_page=100`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "Cache-Control": "no-cache",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      assert.equal(response.status, 200, "Public release list unavailable");
      const releases = await response.json();
      const release = releases.find((r) => r.tag_name === tag);
      assert.ok(release, "Release is not yet in the public update list");
      assertRelease(release, tag, false);
      assertAssets(release.assets, expected);
      const asset = release.assets.find((a) => a.name === "confucius.xpi");
      assert.match(
        asset.url,
        /^https:\/\/api\.github\.com\/repos\/ZionDoki\/confucius\/releases\/assets\/[1-9]\d*$/,
        "Old clients require a valid asset API download address",
      );
      complete++;
      if (complete >= consecutive) {
        const xpi = expected.find((f) => f.name === "confucius.xpi");
        // The in-app updater downloads via the asset API, while the release page
        // uses the browser URL. Both must deliver the same validated package.
        for (const url of [
          asset.url,
          `https://github.com/${repository}/releases/download/${tag}/confucius.xpi`,
        ]) {
          const download = await request(url, {
            headers: {
              Accept: "application/octet-stream",
              "Cache-Control": "no-cache",
            },
            signal: AbortSignal.timeout(30_000),
          });
          assert.equal(download.status, 200, "Public XPI download failed");
          const bytes = Buffer.from(await download.arrayBuffer());
          assert.equal(bytes.length, xpi.size, "Public XPI size mismatch");
          assert.equal(
            digest(bytes),
            xpi.sha256,
            "Public XPI checksum mismatch",
          );
        }
        return;
      }
    } catch (error) {
      last = error;
      complete = 0;
    }
    if (attempt < attempts - 1) await pause(10_000);
  }
  throw last ?? new Error("Public release list did not remain complete");
}

async function main() {
  const [tag, mode, argument] = process.argv.slice(2);
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(tag, `v${version}`, "Tag must match the product version");
  if (mode === "--guard") {
    const existing = api(`releases/tags/${tag}`, true);
    if (existing) assertRelease(existing, tag, true);
    console.log("Published-release overwrite guard passed");
    return;
  }
  const expected = localAssets(
    mode === "--public" && argument
      ? argument
      : "apps/zotero-addon/.scaffold/build",
    version,
  );
  if (mode === "--draft") {
    const id = Number(argument);
    assert.ok(Number.isSafeInteger(id) && id > 0, "Invalid release ID");
    assertRelease(api(`releases/${id}`), tag, true);
    assertAssets(api(`releases/${id}/assets?per_page=100`), expected);
    console.log("Draft assets match the validated build; safe to publish");
    return;
  }
  assert.equal(
    mode,
    "--public",
    "Expected --guard, --draft ID or --public [directory]",
  );
  // Use the same anonymous list as installed clients, not an authenticated asset
  // endpoint that can succeed while ordinary users still see an empty release.
  await verifyPublicAssets(tag, expected);
  console.log(
    "Consecutive anonymous discovery and both XPI download paths verified",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
