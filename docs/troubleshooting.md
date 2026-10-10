# Troubleshooting

English · [简体中文](troubleshooting.zh-CN.md)

[User guide](README.md)

Start by checking the installed version in Settings. The guides describe current
source code, so older releases may show different controls.

| Symptom                                                                                  | What to do                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The model does not reply                                                                 | Check the selected runtime/model and endpoint credentials. For CLI status, see [CLI connections](runtime-discovery.md).                                              |
| A model or thinking level is rejected                                                    | Confirm account access and your provider's exact model ID and parameter format. See [model setup](model-selection.md).                                               |
| A long task stops                                                                        | Inspect saved progress, then Continue. Restate important constraints. See [tasks and data](tasks-and-data.md).                                                       |
| A paper has no PDF                                                                       | Continue with abstracts/current results, or download in your browser and drop onto that paper. See [literature research](literature-research.md).                    |
| A dropped PDF is rejected                                                                | Check that it is the target paper, not a supplement, and under 100 MiB. Scans or unusual metadata may need manual handling in Zotero.                                |
| A note is missing from Knowledge                                                         | Check the note and its parent are not trashed. Search again after editing/restoring the source.                                                                      |
| Saving asks for a knowledge-base ID or says “knowledge base or existing entry not found” | That is an old save path. In the current implementation, save the report as a Zotero note; no knowledge-base ID is needed. See [knowledge and memory](knowledge.md). |
| Memory was not updated                                                                   | Check the automatic-memory setting. Maintenance can be skipped, fail or exhaust its allowance; the conversation remains saved.                                       |
| An annotation may already have been written                                              | Use Verify write status and inspect the PDF before repeating. See [reports and annotations](reading-and-annotations.md).                                             |
| An update fails or shows an old version                                                  | Follow [update troubleshooting](updates.md).                                                                                                                         |
| Task index is missing after moving data                                                  | Current recovery uses surviving local history and backups. Do not fabricate an index; restore your full backup if the old runtime folder is absent.                  |

## Collect useful diagnostics

In the affected task, choose **··· → Export diagnostic report**. Include the plugin
version, Zotero version, operating system, selected runtime, steps to reproduce and
exact error when reporting a problem.

Review exported research content before sharing. Do not include API keys or
pairing tokens. The export redacts recognized credentials but is not a guarantee
that every piece of private research text is removed.

Optional MCP servers may report a connection error without blocking workspace
startup. Check the MCP configuration and restart the plugin after changing it.
