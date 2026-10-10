# Versioning and releases

English · [简体中文](releases.zh-CN.md)

This governs versions, update channels, release notes, and GitHub Releases. [AGENTS.md](../../AGENTS.md) requires it for release-related changes. The root `package.json` owns the product version; [CHANGELOG.md](../../CHANGELOG.md) owns release-note bodies.

## Versions and channels

| Channel | Package example | Git tag         | GitHub Release                                                             |
| ------- | --------------- | --------------- | -------------------------------------------------------------------------- |
| Stable  | `0.4.0`         | `v0.4.0`        | `prerelease: false`; Latest for a newer release on the current stable line |
| Beta    | `0.4.0-beta.2`  | `v0.4.0-beta.2` | `prerelease: true`; `make_latest: false`                                   |

- Compare numeric SemVer components, not strings or publication dates. No leading zeroes; Beta numbering starts at 1. Public versions use only stable or `beta.N`, without `latest`, dates, `-dev`, build metadata, or temporary suffixes.
- Increment PATCH for compatible fixes and usually MINOR for features. Breaking public APIs increment MAJOR after 1.0. During 0.x, increment MINOR and document migration.
- Advance Betas for one target version: `0.4.0-beta.1 → 0.4.0-beta.2 → 0.4.0`. `beta.10` is newer than `beta.2`; stable is newer than every Beta with the same base.
- Changed published code or XPI bytes require a new version. Never move published tags, replace same-version XPIs, or treat changed bytes under one version as an automatic update. Typo-only release-note corrections must preserve original facts.
- During development, maintain Unreleased without bumping every change. Align versions when preparing a candidate. A stable release after Beta uses the same base version. Check remote versions first; never copy an example blindly.

`releases/latest`, README download links, and badges represent the stable channel. A patch for an older stable line must not replace the current line's Latest. Verify the result if changing workflow Latest behavior.

## Updater and Beta preference

The entry is **Confucius Settings → Update → Include prereleases**.

| State                                               | Behavior                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Prereleases off                                     | Compare public stable versions only                                                   |
| Prereleases on                                      | Offer the highest stable or Beta version newer than the installed version             |
| Beta user turns prereleases off                     | Keep the installed version and wait for a newer stable; never downgrade automatically |
| No higher version                                   | Show up to date only after a successful fetch and comparison                          |
| Network, rate-limit, asset, or verification failure | Show an error/retry state, never up to date                                           |

Automatic checks are independent: about 30 seconds after startup, then every six hours. Installation requires the user's Download and install action. Disabling automatic checks preserves manual checks and the Beta choice.

Explicit channel selection lives in `extensions.zotero.confucius.updateChannel`: `stable` means off and `beta` means on. Initial `auto` follows the installed package: stable defaults off, a manually installed Beta defaults on. Upgrades must preserve an explicit choice regardless of package type.

Confucius reads GitHub Releases directly, excluding drafts and ineligible channels. It downloads `confucius.xpi` through the asset API, verifies size and SHA-256, then checks addon ID, package version, and Zotero compatibility. Zotero supplies the final installation interface; checks and timers do not depend on Zotero's global automatic-update setting.

If the highest eligible version lacks an uploaded XPI in the release list, query this repository's separate assets endpoint using that release's numeric ID. Apply the same URL, size, and SHA-256 checks. Query only the selected release, not every historical one. Failure remains an error: do not choose an older version or report up to date. List and asset requests share one overall check deadline.

Old installed packages still run old updater code. Publication must preserve their anonymous list/download contract. Testing only the new fallback, or lowering the new updater's reported current version, does not establish compatibility. Use an unchanged public old XPI and its own check/download/verify/install flow. A manual-install workaround or temporary `npm start` addon does not replace ordinary-package upgrade and restart acceptance.

## Release notes

Record development changes under `## Unreleased`. At release, create exactly one `## <full-version> - YYYY-MM-DD` entry using the release day's UTC date, newest first. Unreleased is excluded from GitHub Release bodies.

Beta notes describe changes since the previous public version. Stable notes summarize verified user-facing changes since the previous stable, not just the last Beta increment. Full Changelog compares the previous stable for stable releases and the previous public version for Betas.

CHANGELOG stays in English as the single release-body source. Chinese instructions live in this guide's Chinese counterpart and the Chinese README. Describe the user's situation and resulting behavior. Include internals only when they explain compatibility, migration, or limits. Do not paste commit lists or present historical checks as new validation.

Each new release entry includes:

1. User-visible additions, changes, and fixes; optional Added/Changed/Fixed groups, omitting empty groups.
2. Upgrade notes: channel, Beta enrollment, any restart/reconfiguration, migration, and rollback limits. Explicitly say when no migration is required.
3. Validation and known limits: checks actually run, OS/Zotero environment, results, and evidence. Explicitly list unrun or failed acceptance checks, especially for Betas.

This is a format example, not evidence that its checks ran:

```markdown
## 0.4.0-beta.2 - 2026-09-06

### Fixed

- Confucius can discover newer releases when Zotero's global automatic updates
  are disabled. The Beta switch controls whether preview releases are offered.

### Upgrade notes

- This is a Beta release. Enable Include prereleases in Confucius Settings →
  Update. Older packages without that switch require a manual XPI installation.
- State whether this release migrates data and describe any rollback limits.

### Validation and known limits

- Record the checks actually run, their results and the tested environments.
- List remaining limitations and link to the corresponding acceptance records.
```

`npm run release:check -- v<version>` checks version consistency, exact tag, unique entry, real date, and nonempty/non-placeholder content. Maintainers must still assess accuracy and sufficient validation.

Generate the GitHub body with `node scripts/release-notes.mjs v<version>`; it adds the Full Changelog link. Do not write a separate competing body. Use the title `Confucius v<version>`. Tag, title, notes, and XPI must agree. Repository documentation links in published entries must be full GitHub URLs pinned to that release tag, not relative paths or changing `master` pages.

## Prepare and check locally

Run from the repository root. `0.4.0-beta.2` below is only an example.

1. Inspect `git status`, synchronize remote information, and inspect tags/releases. Verify the version is unused and the commit scope is correct. Preserve unrelated user changes.
2. Align root and workspace package versions:

   ```sh
   npm version 0.4.0-beta.2 --workspaces --include-workspace-root --no-git-tag-version
   ```

   Update `CONFUCIUS_VERSION` in `packages/protocol/src/version.ts`. Check the lockfile's top-level version, `packages[""]`, and every local workspace version. Run `npm run versions:check`.

3. Prepare the CHANGELOG entry and affected README, migration, and acceptance documents.
4. Run all checks:

   ```sh
   npm run release:check -- v0.4.0-beta.2
   npm run sync-skills:check
   npm test
   npm run typecheck
   npm run lint
   npm run build
   ```

5. Inspect artifacts below and test installation/upgrades in an isolated Zotero profile. Record commit, XPI digest, environment, and results. A build is not an installation test. Local and CI builds may differ in timestamps; do not assume identical binary digests.

### Required artifact checks

Build directory: `apps/zotero-addon/.scaffold/build/`.

| Artifact or field         | Requirement                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `confucius.xpi`           | Fixed filename; includes `manifest.json`; addon ID `confucius@zotero.plugin`              |
| XPI manifest `version`    | Root package version, without `v`                                                         |
| Zotero compatibility      | Manifest and update files agree; declared range has supporting validation                 |
| Beta update files         | `update-beta.json` exists; no Beta in stable `update.json`                                |
| Stable update files       | `update.json` exists; current scaffold also creates `update-beta.json`                    |
| Update record `version`   | Full release version                                                                      |
| `update_link`             | `https://github.com/ZionDoki/confucius/releases/download/v<version>/confucius.xpi`        |
| Update file `update_hash` | SHA-512 of the actual release XPI                                                         |
| GitHub XPI asset          | `state: uploaded`, correct nonzero `size`, and a matching `sha256:<64 hex digits>` digest |

JSON update files serve Zotero's native update-address compatibility; Confucius uses GitHub release/asset metadata. Both must be correct. Uploading JSON without the XPI is insufficient. Start with clean build output so a previous stable `update.json` cannot leak into a Beta.

## Publish and verify

After preparation, tag the release commit with the exact version. Pushing the commit and tag triggers `.github/workflows/ci.yml`; act within the release authorization already given for the task. Preparing code/docs alone is not publication.

CI verifies on Node.js 22 and 24, then builds and uploads artifacts. Betas remain prereleases and cannot become Latest. Generate notes from CHANGELOG.

The workflow checks that the target is not already public, then uploads into a draft without replacing same-name assets. Publish only after the assets endpoint matches verified filenames, uploaded states, sizes, and SHA-256 digests. After publication, obtain three consecutive successful anonymous reads of the same release list used by old clients; a missing-package response resets the streak. Download the XPI through both the old client's asset API URL and the browser download URL and verify digests. Authenticated visibility alone is not public acceptance.

Keep asset display names as `confucius.xpi` and the actual update filenames, including extensions. If public acceptance fails, return the release to draft so it leaves update lists. Preserve the original tag, source, and package; do not overwrite or rebuild published same-version artifacts. Do not deliver the version as an available updater fix until publication issues and old-client online upgrade checks pass.

For read-only rechecks, point at saved original public artifacts, never substitute a fresh build:

```sh
node scripts/release-assets.mjs v<version> --public output/release-<version>/public
node scripts/live-legacy-update.mjs output/release-<old>/public/confucius.xpi output/release-<new>/public/confucius.xpi output/release-<new>/legacy-<old>.json
```

The second command normally installs the old package in isolated Zotero and upgrades through public endpoints without replacing updater code, reported version, or network responses. It checks pre/post-install digests, version after restart, task drafts, channel persistence, and no downgrade. Data migrations still need full upgrade acceptance.

| Scenario                                            | Expected result                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Old stable, prereleases off                         | No Betas; discover a higher stable                                                                                    |
| Same installation, prereleases on                   | Discover, download, verify, and install a higher Beta                                                                 |
| Beta 1 → Beta 2                                     | Correct numeric sequence comparison                                                                                   |
| Beta → stable with the same base                    | Stable upgrade available                                                                                              |
| Beta user disables prereleases                      | No downgrade; choice survives restart                                                                                 |
| Zotero global automatic updates off                 | Confucius manual and automatic checks still work                                                                      |
| Network interruption, rate limit, incomplete assets | Clear failure/retry state, never false up to date                                                                     |
| Install from open workspace settings                | Reload addon/workspace; retain selected task, draft, layout, settings page; show new version without manual reopening |
| Repeated hot updates; workspace already closed      | Later checks/channel changes still work; do not reopen a previously closed workspace                                  |
| Restart after installation                          | Actual version changed; settings, tasks, and data satisfy migration contracts                                         |

A restart is additional persistence validation, not a requirement for every update. Test completed installation and staged-until-restart outcomes separately. Instructions must reflect the actual state.

For data/runtime migration, create a new version-specific record using the historical [upgrade acceptance method (Chinese original)](acceptance/upgrade-acceptance.md). Windows scenarios are in the historical [Windows checklist (Chinese original)](acceptance/windows-acceptance.md). Old passing results apply only to their recorded versions and environments.

Retry an unfinished upload from the same source commit when appropriate, but never replace an already downloadable same-version XPI with new code. A defective public version needs a higher patch or next Beta; if needed, annotate the original release with the defect and replacement version.
