# Tasks and data

English · [简体中文](tasks-and-data.zh-CN.md)

[User guide](README.md)

## Sources and conversations

A new task starts without a paper. Add sources with `@`, a Zotero item entry,
file drop or confirmed literature candidates. Switching PDF tabs does not attach
the current PDF.

The sidebar offers **By time** and **By article**. Article groups reflect where
a conversation was created; later source additions do not duplicate it under
every paper. Research started from a blank conversation appears under literature
research.

## Continue an interrupted task

1. Reopen the task and check its saved report and progress.
2. Click **Continue** or send a continuation request.
3. State any changed requirements and ask the Agent to verify important citations
   or numbers before proceeding.

Restart does not automatically execute old requests. Continue keeps the consumed
step/tool budget. Recoverable network errors use bounded retries; authentication
errors, rejection and user cancellation are not ordinary automatic retries.

Successful writes remain saved. If a write result is uncertain, check the actual
Zotero state or the provided status check before retrying. Task drafts do not
require library write approval; notes and other library changes use their own
confirmation flows. Annotation suggestions always need review.

A branch made from a reply gets an independent report snapshot and saved research
state from that point. Later revisions in the two tasks do not overwrite each other.

## Confirm changes and directory access

Read the proposed target and changes before choosing **Allow once**, **Allow for
task**, or **Deny**. A task grant covers the indicated tool in that task; it does
not automatically accept annotation suggestions or protected-memory changes.

Tasks start with **Zotero only** access. For external-runtime commands or general
file changes, select the task and open **Settings → Safety → Selected workspace**.
Enter and confirm an absolute directory. Commands and file changes still use
approval. Ordinary paper reading does not require this setting.

## Where data lives

| Data                                                                  | Location                                      |
| --------------------------------------------------------------------- | --------------------------------------------- |
| Tasks, report revisions, history, operations and annotation ownership | Local Zotero profile: `confucius/runtime-v1/` |
| Research memory                                                       | Zotero data directory: `confucius/memory/`    |
| Native notes, PDF annotations and attachments                         | Managed by Zotero                             |
| Exported HTML files                                                   | The destination you choose                    |

Settings shows the actual runtime path. **Back up the Zotero library, memory
folder and local runtime folder.** Library sync alone does not move complete
Confucius tasks to another computer.

Existing runtime data can be migrated from older locations. Original data and
recovery backups are retained until validated cleanup; newer progress is not
copied back for a downgrade. Missing-index recovery uses only records still
available on the computer. Deleted or expired history cannot be reconstructed.

For long-term retention, export important reports. See [history cleanup](context-system.md)
and [knowledge exports](knowledge.md).

## Diagnose a problem

Use the task's **··· → Export diagnostic report**. The offline HTML includes saved
events, report versions and downloadable JSON without calling a model.

Recognized credentials are redacted, but research text and source excerpts remain:
review them before sharing. Cleared history and private internals of external
runtimes cannot be recreated in the report.

Cloud-synced folders are not a substitute for a verified backup. Ensure PDFs are
downloaded locally; complete multi-device or database-in-cloud-folder workflows
are not guaranteed. See [troubleshooting](troubleshooting.md).
