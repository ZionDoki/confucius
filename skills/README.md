# Built-in skills

These `SKILL.md` packages ship with Confucius and are loaded at addon startup.

| Slug                   | Use                              |
| ---------------------- | -------------------------------- |
| `paper-deep-reading`   | Review one paper                 |
| `claim-evidence-audit` | Check claims vs evidence         |
| `related-work-map`     | Map library neighbors            |
| `library-triage`       | Search, file, tag                |
| `annotation-pass`      | Propose highlights, then confirm |

Skills use the [Agent Skills](https://agentskills.io) format:

1. The agent always sees each skill's `name`, `description`, and `triggers`.
2. The full `SKILL.md` body is loaded when you type `/slug` in the composer, or when the agent calls the `skill` tool.
3. `allowed-tools` lists preferred tools for that procedure. It does not strip the rest of the tool set.

Type `/` in the workspace composer to browse skills. Arrow keys move the highlight; Enter, Tab, or a click runs the selected skill. Extra text after `/slug` is the prompt.
