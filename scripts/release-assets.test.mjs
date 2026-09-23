import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  assertAssets,
  assertRelease,
  verifyPublicAssets,
} from "./release-assets.mjs";

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

function publicFixture(sequence, { corruptAPI = false, badURL = false } = {}) {
  const bytes = Buffer.from("validated XPI fixture");
  const file = {
    name: "confucius.xpi",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const calls = [];
  let reads = 0;
  return {
    file,
    calls,
    get reads() {
      return reads;
    },
    request: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/releases?per_page=100")) {
        const complete = sequence[Math.min(reads++, sequence.length - 1)];
        return Response.json([
          {
            id: 42,
            tag_name: "v0.5.0-beta.7",
            prerelease: true,
            draft: false,
            assets: complete
              ? [
                  {
                    ...file,
                    state: "uploaded",
                    digest: `sha256:${file.sha256}`,
                    url: badURL
                      ? "https://example.invalid/package"
                      : "https://api.github.com/repos/ZionDoki/confucius/releases/assets/43",
                  },
                ]
              : [],
          },
        ]);
      }
      return new Response(
        corruptAPI && url.includes("api.github.com")
          ? Buffer.alloc(bytes.length)
          : bytes,
      );
    },
  };
}
const verifyFixture = (fixture, attempts = 7) =>
  verifyPublicAssets("v0.5.0-beta.7", [fixture.file], {
    request: fixture.request,
    pause: async () => {},
    attempts,
  });

test("public gate requires consecutive complete lists after a stale response", async () => {
  const fixture = publicFixture([true, false, true, true, true]);
  await verifyFixture(fixture);
  assert.equal(fixture.reads, 5);
  assert.equal(fixture.calls.length, 7);
  assert.ok(
    fixture.calls.every(({ options }) => !options.headers.Authorization),
  );
  assert.ok(
    fixture.calls
      .slice(-2)
      .every(
        ({ options }) => options.headers.Accept === "application/octet-stream",
      ),
  );
});
test("one good response cannot hide a persistently incomplete legacy list", async () => {
  const fixture = publicFixture([false, true, false]);
  await assert.rejects(verifyFixture(fixture, 4), /Release files/);
  assert.equal(fixture.calls.length, 4);
});
test("public gate rejects an API download that differs from the validated package", async () => {
  const fixture = publicFixture([true], { corruptAPI: true });
  await assert.rejects(verifyFixture(fixture, 3), /checksum mismatch/);
  assert.ok(
    !fixture.calls.some(({ url }) => url.includes("/releases/download/")),
  );
});
test("public gate refuses download addresses that installed old clients reject", async () => {
  const fixture = publicFixture([true], { badURL: true });
  await assert.rejects(verifyFixture(fixture, 3), /asset API download address/);
  assert.equal(fixture.calls.length, 3);
});
