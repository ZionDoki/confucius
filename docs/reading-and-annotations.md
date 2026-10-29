# Reports and annotations

English · [简体中文](reading-and-annotations.zh-CN.md)

[User guide](README.md)

## Read or compare papers

Add papers with `@`, from a Zotero item, or by confirming literature candidates.
Type `/` to see presets available for those sources. Choosing a preset prepares
a draft in the current conversation; send it to start.

For **Paper review**, choose layout, tone and reading focus before generating.
The default is sectioned notes, patient explanation and the paper's overall
argument. Changing style affects the next generation or revision, not an existing
report automatically. Ask follow-up questions when an explanation is unclear.

## Output language

Answers, generated progress, annotation comments, report titles and revisions
follow an explicit language request, then your current request's language, then
the recent conversation language. The interface language is only a fallback.
Bare skill commands and continuing work inherit the conversation language.
Quoted source text and annotation locations remain in the original language.

## Open and revise a report

Click the generated file in the conversation. It opens in the workspace; the back
arrow returns to the task. **Separate window** lets you read beside the PDF.

Use source links to inspect the Zotero item, PDF page or annotation. In the same
conversation, ask for a specific change, such as “Check this number and update
the summary.” Revisions keep the same report and its history. The version menu
can pin an older version; **Latest** resumes following updates.

A report marked ready is deliverable, not fact-certified. Deep-reading reports
can receive one automatic revision using the current model and remaining budget.
Failure leaves the saved report available.

## Save or export

Generating a report saves a task artifact; it does not immediately write a
Zotero note.

1. Choose **Zotero note** in the report.
2. Review the formatted preview.
3. Confirm the write. Later saves update the associated note.

The knowledge library indexes the note; no separate knowledge-base destination
or ID is needed. **Export file** creates an independent HTML copy. See
[knowledge and memory](knowledge.md) for export behavior.

## Review PDF annotation suggestions

Ask for highlights or comments, optionally specifying pages and quantity.

The automatic opening, arrival reminder and initial view defaults below apply
from 0.6.1-beta.1.

1. The first Agent batch opens review automatically. Use the **Annotations**
   capsule above the composer to reopen it.
2. Review the quoted text, comment and page in cards or the list. Fewer than ten
   entries default to cards; ten or more default to a list. You can switch views.
3. **Accept** writes the annotation to Zotero. **Reject** leaves it unwritten and
   can be undone. Search and filters help with batch review.
4. Use the page link to check the source.

General tool approval does not automatically accept Agent annotation suggestions.
Only a confirmed write receipt is shown as saved. If a result is uncertain, use
**Verify write status**; do not assume it failed and repeat the write.

The viewer preserves selection and position when minimized. Later suggestions
briefly animate the capsule and update the count without forcing it open.
Reduced motion uses the new count instead of animation. Loading history stays
minimized; saved outcomes survive a restart.

## Batches and existing annotations

New annotations receive no automatic Confucius tags. Existing Confucius and user
tags remain unchanged, including after a restart; you may remove unwanted old
tags in Zotero. Conversation batches and their times remain recorded internally,
and each Agent submission still creates its own review batch. Use Zotero's native
search and tag filters; the old custom PDF batch filter is no longer provided.

The Agent can modify or delete annotations with recorded Confucius ownership,
subject to review and permission checks. It cannot gain ownership from a matching
tag or color. Existing PDF colors are reserved when sources are attached, so a
new annotation may use a different color from the one requested.

## Organize existing annotations with Flex Annotations

This integration is available in the current source and is not yet released.
Create the outline in [Flex Annotations](https://github.com/justanotherjurastudent/zotero_FlexAnnotate)
first, then ask Confucius to organize the unassigned annotations in a named
collection. Subcollections use their top-level collection's outline and scope.
If that collection has no outline, create one before continuing.

With tool permissions set to **Ask**, the review card groups proposals by
heading and shows their quotes and sources. **Accept** and **Reject** select
which proposals to keep; **Apply** submits the accepted entries. Search and
status filters help review larger batches. Selections survive timeline refreshes.
An explicit preview request does not write tags when approved. **Allow for
session** authorizes subsequent calls to that tool in the current task; choose
Apply for a single reviewed batch.

Accepted assignments add the outline's `§Heading` tags to existing annotations.
Ask explicitly to remove assignments to delete those tags. Other tags and the
outline note remain unchanged. Removal is limited to headings in the selected
collection's outline and annotations in its scope. Confucius does not create,
rename or delete outline headings. Read-only annotations are skipped.

Confucius can read an existing stored outline when Flex Annotations is not
loaded. Use Flex Annotations itself to create or edit the outline. This workflow
organizes existing annotations; creating new PDF highlights uses the review
workflow above.
