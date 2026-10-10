# Knowledge and memory

English · [简体中文](knowledge.zh-CN.md)

[User guide](README.md)

## Find your research material

Open **Research knowledge base**, search for a keyword and select a result. It searches Zotero
notes, research topics, preferences, ordinary memory and legacy knowledge files.

The library is an index: it reads the actual source. Edit notes in Zotero using
**Open in Zotero**. Updated text is used on the next read; trashed notes, or notes
whose parent is trashed, disappear until restored. The index does not recreate
deleted sources.

## Save reports and export files

[Save a report as a Zotero note](reading-and-annotations.md); later saves update
the same associated note. Drafts and report revisions remain in the task.

**Export file** writes a standalone HTML copy:

- A report revision already saved to a note exports that note's current content.
- An unsaved revision exports its own task content.
- A knowledge entry exports the source currently being read.

The copy does not sync back. Formulas, tables and source links are retained;
images and external embedded resources are not bundled. Legacy knowledge files
remain readable/exportable in place; new reports do not create legacy copies.

## Remember a research topic

In **Settings → Memory**, enable **Maintain work memory automatically**. After a
successful ordinary conversation, the Agent can keep explicitly stated topics
and preferences, updating a topic's findings, open questions and next steps.

For example: “My current project compares small-sample learning methods. Keep
track of the remaining questions across our conversations.”

One question about a paper is not automatically a long-term interest. Extraction
uses your words as evidence but can still be wrong. Source-restricted presets
and selection questions do not perform this cross-topic extraction.

Maintenance uses the current model and a shared allowance. It happens after
conversations; it is **not scheduled monitoring or proactive reminders**. Failed
or skipped maintenance does not erase the conversation or report. Turning it off
stops new automatic extraction and distillation, not access to existing records.

## Correct or forget

Select a memory, then choose **Correct memory** or **Forget**.
A saved correction is protected from automatic replacement. Forget removes the
memory while keeping source notes and conversations; it also blocks late
automatic work from recreating the same normalized topic name.

Suppression matches names, not all semantically similar rewordings. You can
explicitly ask to remember something again. Changes to protected memory require
individual confirmation; a general tool grant does not replace it.

## Retention and backup

Ordinary memory has a shared limit of **200 records and about 16k body tokens**.
Unused ordinary records may expire after 90 days. Active research topics and
protected records are exempt from ordinary inactivity expiry, but still count
toward capacity. Full capacity can stop new memory.

The index is not a backup. See [tasks and data](tasks-and-data.md) for the folders
to preserve.
