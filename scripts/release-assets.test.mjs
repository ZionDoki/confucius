import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAssets, assertRelease } from "./release-assets.mjs";

const expected = [
  { name: "confucius.xpi", size: 5, sha256: "a".repeat(64) },
  { name: "update-beta.json", size: 7, sha256: "b".repeat(64) },
];
const uploaded = () =>
  expected.map((f) => ({
    ...f,
    state: "uploaded",
    digest: `sha256:${f.sha256}`,
  }));

test("release gate accepts the complete uploaded pair regardless of ordering", () => {
  assertAssets(uploaded().reverse(), expected);
});
test("release gate rejects missing, duplicate and unexpected stable-channel files", () => {
  for (const files of [
    [],
    uploaded().slice(1),
    [...uploaded(), uploaded()[0]],
    [...uploaded(), { name: "update.json" }],
  ])
    assert.throws(() => assertAssets(files, expected));
});
test("release gate rejects unfinished uploads and differing bytes before publication", () => {
  for (const patch of [
    { state: "new" },
    { size: 0 },
    { size: 6 },
    { digest: null },
    { digest: `sha256:${"f".repeat(64)}` },
    { label: "Hidden extension" },
  ]) {
    const files = uploaded();
    Object.assign(files[0], patch);
    assert.throws(() => assertAssets(files, expected));
  }
});
test("published releases cannot enter the draft upload stage", () => {
  const release = {
    id: 42,
    tag_name: "v0.5.0-beta.6",
    prerelease: true,
    draft: false,
  };
  assert.throws(
    () => assertRelease(release, release.tag_name, true),
    /Refusing/,
  );
  assertRelease(release, release.tag_name, false);
});
test("wrong tags, channels and draft publication states fail acceptance", () => {
  const release = {
    id: 42,
    tag_name: "v0.5.0-beta.6",
    prerelease: true,
    draft: true,
  };
  assertRelease(release, release.tag_name, true);
  for (const patch of [
    { tag_name: "v0.5.0-beta.5" },
    { prerelease: false },
    { id: -1 },
  ])
    assert.throws(() =>
      assertRelease({ ...release, ...patch }, release.tag_name, true),
    );
  assert.throws(
    () => assertRelease(release, release.tag_name, false),
    /still a draft/,
  );
});
