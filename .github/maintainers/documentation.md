# Documentation rules

English · [简体中文](documentation.zh-CN.md)

[Maintainer guide](README.md)

## Audience and location

| Content                                                    | Location                                     |
| ---------------------------------------------------------- | -------------------------------------------- |
| Install and first task                                     | Root README pair                             |
| Usage, settings, troubleshooting and limits                | `docs/`                                      |
| Shared interface rules                                     | `docs/design.md` and its Chinese translation |
| Current architecture and development/release contracts     | `.github/maintainers/`                       |
| Dated release and acceptance evidence                      | `.github/maintainers/acceptance/`            |
| Raw traces, machine paths, temporary plans and test output | Ignored `output/`                            |

Do not bury setup instructions in implementation history. Give the next action
first; keep technical detail in the maintainer guide. Describe current behavior
from code and label unreleased features without claiming they have shipped.

## Languages and links

- Current guides use English in `name.md` and Simplified Chinese in
  `name.zh-CN.md`. Both versions cover the same behavior and limitations.
- Each page starts with an explicit link to its other language.
- Normal navigation stays in the current language, including the root README,
  user index, related guides and developer entry.
- Historical records keep their original language and dates. Their archive
  indexes label the language. A direct link from another language must say so.
- `CHANGELOG.md` remains the single English source for release bodies. Chinese
  guides label links to it as English release notes; do not create a competing
  release-body source.
- `SKILL.md` files are executable skill instructions, not translated user guides.
  Their paired README explains usage; do not duplicate skill packages by language.

## Before finishing

1. Check described controls, defaults, storage paths and permission boundaries
   against implementation.
2. Update both language versions and their index entries together.
3. Check local file links, heading anchors and language destinations.
4. Run Prettier on changed Markdown.
5. Keep historical facts and fixed-tag release evidence intact. Moving evidence
   to the archive may repair relative links, but must not alter the recorded outcome.
6. State what was verified. Documentation edits do not establish new live-test,
   installation or release results.
