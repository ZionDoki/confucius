# Selection questions

English · [简体中文](selection-questions.zh-CN.md)

[User guide](README.md)

## Ask while reading

Select text in a PDF, report or conversation. Type in the input near the selection
and press **Enter**. The answer appears there, and you can ask follow-up questions.
Enter used to confirm an input-method composition does not send the question.

Click outside or press **Escape** to return to reading. Closing the popup does
not stop an answer; selecting text again can reopen the saved side conversation.

## What context is available?

| Selection    | Available material                                                                 |
| ------------ | ---------------------------------------------------------------------------------- |
| PDF          | Selected text, the paper and relevant completed conversations linked to that paper |
| Report       | The selected report revision and its task's completed history                      |
| Conversation | Completed history from that task                                                   |

PDF side conversations belong to the paper within its library; standalone
attachments are separate. A task's reports and conversation share its side
conversation. Each question keeps the selection, source and version from when it
was sent.

This mode is read-only. It does not search the web, read global memory or other
side conversations, change notes/annotations/reports, or add its content to the
main task or automatic memory extraction.

## Model and saved history

A task side conversation initially inherits its task's runtime and external model
settings. A PDF side conversation uses the most recently updated linked task's
runtime, or Native if none exists. It keeps a separate model session.

Side conversations save under the runtime data directory's `btw/`.
Restart interrupts unfinished answers and preserves saved content without
resending. Deleting the parent task removes its task side conversation; deleting
or trashing a paper cleans up its PDF side conversation.

Automatic history cleanup also applies to side conversations. See
[context and history](context-system.md). A scanned PDF needs selectable text in
Zotero before the selection input can appear.
