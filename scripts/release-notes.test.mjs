import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseNotes } from "./release-notes-lib.mjs";

function changelog(
  version = "0.4.0-beta.2",
  date = "2026-09-06",
  body = "- Fixed update discovery.",
) {
  return `# Changelog\n\n## Unreleased\n\n- Not published yet.\n\n## ${version} - ${date}\n\n${body}\n\n## 0.4.0-beta.1 - 2026-09-05\n\n- Earlier preview.\n\n## 0.3.8 - 2026-09-04\n\n- Earlier stable release.\n`;
}

test("extracts only the matching Beta notes and compares against the previous release", () => {
  assert.equal(
    releaseNotes("0.4.0-beta.2", "v0.4.0-beta.2", changelog()),
    "- Fixed update discovery.\n\n**Full Changelog**: https://github.com/ZionDoki/confucius/compare/v0.4.0-beta.1...v0.4.0-beta.2\n",
  );
});

test("compares stable releases against the preceding stable release and accepts CRLF", () => {
  const result = releaseNotes(
    "0.4.0",
    "v0.4.0",
    changelog("0.4.0").replaceAll("\n", "\r\n"),
  );
  assert.match(result, /Fixed update discovery/);
  assert.match(result, /v0\.3\.8\.\.\.v0\.4\.0/);
  assert.doesNotMatch(result, /Not published yet/);
});

test("rejects missing, different and unprefixed tags", () => {
  for (const tag of [undefined, "0.4.0-beta.2", "v0.4.0", "v0.4.0-beta.1"]) {
    assert.throws(
      () => releaseNotes("0.4.0-beta.2", tag, changelog()),
      /Release tag/,
    );
  }
});

test("rejects public versions outside the stable and numbered Beta policy", () => {
  for (const version of [
    "01.4.0",
    "0.4.0-beta.0",
    "0.4.0-beta.02",
    "0.4.0-beta",
    "0.4.0-alpha.1",
    "0.4.0-rc.1",
    "0.4.0+build.1",
    "9007199254740992.0.0",
  ]) {
    assert.throws(
      () => releaseNotes(version, `v${version}`, changelog(version)),
      /use X.Y.Z/,
    );
  }
});

test("rejects missing or duplicate version entries", () => {
  assert.throws(() => releaseNotes("0.4.0", "v0.4.0", changelog()), /found 0/);
  assert.throws(
    () =>
      releaseNotes(
        "0.4.0-beta.2",
        "v0.4.0-beta.2",
        changelog() + "\n## 0.4.0-beta.2 - 2026-09-06\n\n- Duplicate.\n",
      ),
    /found 2/,
  );
});

test("rejects impossible dates as well as malformed date strings", () => {
  for (const date of [
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-9-6",
    "TBD",
  ]) {
    assert.throws(
      () =>
        releaseNotes(
          "0.4.0-beta.2",
          "v0.4.0-beta.2",
          changelog(undefined, date),
        ),
      /valid YYYY-MM-DD/,
    );
  }
  assert.match(
    releaseNotes(
      "0.4.0-beta.2",
      "v0.4.0-beta.2",
      changelog(undefined, "2028-02-29"),
    ),
    /Fixed update discovery/,
  );
});

test("rejects empty, headings-only, comment-only and placeholder release notes", () => {
  for (const body of [
    "",
    "### Fixed\n\n### Upgrade notes",
    "<!-- Draft only -->",
    "- TODO: write release notes",
    "TBD",
    "待补充",
  ]) {
    assert.throws(
      () =>
        releaseNotes(
          "0.4.0-beta.2",
          "v0.4.0-beta.2",
          changelog(undefined, undefined, body),
        ),
      /needs release notes/,
    );
  }
  assert.throws(
    () => releaseNotes("0.4.0", "v0.4.0", "## 0.4.0 - 2026-09-06"),
    /needs release notes/,
  );
});

test("keeps curated Markdown and omits the compare link for the first release", () => {
  const body =
    "### Added\n\n- Added **Confucius**.\n\n### Upgrade notes\n\n- No data migration.\n\n### Validation and known limits\n\n- Verified startup in the stated environment.";
  assert.equal(
    releaseNotes(
      "0.1.0",
      "v0.1.0",
      `# Changelog\n\n## 0.1.0 - 2026-09-06\n\n${body}\n`,
    ),
    `${body}\n`,
  );
});
