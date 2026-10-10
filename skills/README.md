# Built-in skills

English · [简体中文](README.zh-CN.md)

[User guide](../docs/README.md) · [Development](../.github/maintainers/development.md)

Skills are reusable instructions bundled with Confucius. In the composer, type
`/`, select a skill, add your request, then **Send**. Arrow keys browse; Enter,
Tab, or a click selects. Selecting a skill fills the draft; it does not run it.

| Skill                     | Use                                                                  |
| ------------------------- | -------------------------------------------------------------------- |
| `paper-deep-reading`      | Review a paper's claims, evidence, assumptions, and limits           |
| `claim-evidence-audit`    | Check claims against experiments and figures                         |
| `related-work-map`        | Map related papers and research gaps                                 |
| `library-triage`          | Search, organize, and tag papers                                     |
| `annotation-pass`         | Propose PDF annotations for review                                   |
| `mind-map`                | Create an editable Markdown mind map                                 |
| `research-knowledge-base` | Find research context and maintain notes through the knowledge index |

Presets in the same menu prepare a task draft. For Paper review, choose sources
and report style before sending. See [reading and annotations](../docs/reading-and-annotations.md).

## How skills load

The Agent receives skill names, descriptions, and triggers. It loads the full
body when a submitted request invokes `/slug` or it calls the `skill` tool.
Text after `/slug` is your request. `allowed-tools` lists preferred tools;
it neither removes other tools nor grants write permission.

Skills can be invoked in every turn, including an existing Codex or Kimi session.
Put `/slug` at the beginning of the request (leading whitespace is allowed).
Loaded skills remain available; the current explicit invocation takes precedence
where their instructions conflict. A bare `/slug` uses the current Zotero context
and inherits the conversation language. Attachments and paper text do not invoke
skills. Escape closes the menu without changing your draft.

Notes use the normal confirmation flow. Annotation proposals still require
review. The knowledge skill uses the shared source index; it does not ask users
to create a knowledge container or enter an internal ID.

## Maintain a skill

Edit its `skills/<slug>/SKILL.md`, then run from the repository root:

```sh
npm run sync-skills
npm run sync-skills:check
npm test
npm run typecheck
```

The generated bundle is `apps/zotero-addon/src/modules/skills/builtin.ts`.
Do not edit that file directly. Keep each executable skill in one package;
translate this guide rather than duplicating skills by language.
