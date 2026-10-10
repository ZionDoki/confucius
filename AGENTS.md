# AGENTS.md

English · [简体中文](AGENTS.zh-CN.md)

These instructions bind AI agents working in this repository. Read the whole file before making changes.

After code changes, run `npm test` and `npm run typecheck`.

For a local Zotero workspace preview, run `npm start` in `apps/zotero-addon` with Zotero 7+ installed. Open the workspace with the Confucius toolbar button. Preferences are in Zotero → Settings → Confucius.

## Versions, updates, and releases

Before changing versions, update behavior, CHANGELOG, Git tags, or GitHub Releases, read the [release rules](.github/maintainers/releases.md) and follow their preparation, validation, publication, and acceptance steps.

- Public stable versions use `MAJOR.MINOR.PATCH`; Betas use `MAJOR.MINOR.PATCH-beta.N`, with N starting at 1 and increasing. Tags are `v<full-version>`. Betas must be prereleases and cannot be Latest.
- The root `package.json` is the product-version authority. All workspace versions, root/workspace lockfile versions, and `CONFUCIUS_VERSION` in `packages/protocol/src/version.ts` must agree. Built XPI manifests and update files must use the same version. Never hand-edit generated artifacts to make versions match.
- Never reuse or overwrite published tags, versions, or packages. Fix a published release with a higher version. Record unpublished changes under CHANGELOG's Unreleased; do not add new capabilities to old released entries.
- `CHANGELOG.md` is the only release-body source. Use one `## <version> - YYYY-MM-DD` entry describing user-visible changes, upgrade/migration notes, actual validation, and known limits. Commit lists, placeholders, and unrun checks are not substitutes.
- Confucius checks, compares, downloads, and verifies updates itself. Keep the Include prereleases preference and preserve explicit choices. Off accepts only stable versions; on compares stable and Beta versions. Offer only higher versions; turning it off cannot trigger a downgrade. Automatic checks and channel selection are independent.
- Before publication run `npm run release:check -- v<version>`, `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`, then inspect artifacts and upgrade scenarios under the release rules. Preparing code/docs, tagging, publishing a Release, and testing an installed package are distinct states; report the actual completion level.

## Interface design

Before any UI change, read and follow the [interface design rules](docs/design.md), using the app workspace toolbar, timeline, and composer as the baseline. Use shared color variables and toolbar button styles, and follow regular/compact spacing and sizing. Artifact readers have no decorative dividers. Update the design document when shared visual rules change; do not create a separate reader palette or button size system. Complete its checklist, run `npm test` and `npm run typecheck`, and state the scope of real-device testing.

## Documentation scope

- `docs/` contains user instructions, settings, troubleshooting, known limits, and shared `docs/design.md` rules. Its entry is `docs/README.md`. Do not put implementation drafts, agent plans, temporary test logs, or sequential development diaries there.
- Maintained architecture, release procedures, and acceptance records belong in `.github/maintainers/`. Raw traces, machine paths, test libraries, and temporary output belong in ignored `output/`. Never commit credentials or personal library contents.
- When removing obsolete designs, repair current documentation links. Preserve historical Release evidence URLs pinned to old tags; do not rewrite new test results as old-version capabilities.
- Current user/developer guides have separate English and Chinese versions: default files are English and Chinese files use `*.zh-CN.md`. Normal navigation stays in the current language; language switches are explicit. Historical records retain their original language with a label. Follow the [documentation rules](.github/maintainers/documentation.md).
